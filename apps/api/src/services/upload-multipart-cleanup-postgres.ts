import { pg } from '@eden3/db';

import type {
  ClaimedMultipartCleanup,
  MultipartCleanupMetrics,
  MultipartCleanupStore,
} from './upload-multipart-cleanup';

function safeNumber(raw: string | number | null | undefined): number {
  const value = Number(raw ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid multipart cleanup metric');
  return value;
}

function safeAge(raw: string | number | null | undefined): number {
  const value = Number(raw ?? 0);
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid multipart cleanup age metric');
  }
  return Math.floor(value);
}

interface ClaimRow {
  upload_id: string;
  owner_account_id: string;
  backing_key: string;
  backend_upload_id: string;
  attempt_count: number;
  claim_token: string;
  enqueued_at: Date | string;
}

/** Lease-fenced SQL adapter for storage_uploads cleanup metadata. */
export class PostgresUploadMultipartCleanupStore implements MultipartCleanupStore {
  async enqueueExpiredUploads(_now: Date, limit: number): Promise<number> {
    return pg.begin(async (tx) => {
      const rows = await tx<Array<{ id: string; object_id: string }>>`
        with due as (
          select id from storage_uploads
          where state in ('initiated', 'uploading') and expires_at <= statement_timestamp()
          order by expires_at, id
          for update skip locked
          limit ${limit}
        )
        update storage_uploads u
        set state = 'expired', updated_at = statement_timestamp()
        from due where u.id = due.id
        returning u.id, u.object_id
      `;
      if (rows.length > 0) {
        const objectIds = rows.map((row) => row.object_id);
        await tx`
          update storage_objects set state = 'failed', updated_at = statement_timestamp()
          where id = any(${objectIds}::uuid[]) and state = 'pending'
        `;
      }
      return rows.length;
    });
  }

  async recoverExpiredClaims(input: {
    limit: number;
    maxAttempts: number;
  }): Promise<{ requeued: number; failed: number }> {
    const rows = await pg<Array<{ cleanup_state: 'pending' | 'failed' }>>`
      with expired as (
        select id from storage_uploads
        where cleanup_state = 'claimed'
          and cleanup_claim_expires_at <= statement_timestamp()
        order by cleanup_claim_expires_at, id
        for update skip locked
        limit ${input.limit}
      )
      update storage_uploads u
      set cleanup_state = case when u.cleanup_attempt_count >= ${input.maxAttempts} then 'failed' else 'pending' end,
          cleanup_next_attempt_at = case when u.cleanup_attempt_count >= ${input.maxAttempts}
            then null else statement_timestamp() end,
          cleanup_claim_token = null,
          cleanup_claim_expires_at = null,
          cleanup_last_error_code = case when u.cleanup_attempt_count >= ${input.maxAttempts}
            then 'attempts_exhausted' else 'claim_expired' end,
          updated_at = statement_timestamp()
      from expired where u.id = expired.id
      returning u.cleanup_state
    `;
    return {
      requeued: rows.filter((row) => row.cleanup_state === 'pending').length,
      failed: rows.filter((row) => row.cleanup_state === 'failed').length,
    };
  }

  async claimDueCleanups(input: {
    now: Date;
    limit: number;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ClaimedMultipartCleanup[]> {
    const rows = await pg<ClaimRow[]>`
      with due as (
        select id from storage_uploads
        where cleanup_state = 'pending'
          and cleanup_next_attempt_at <= statement_timestamp()
          and cleanup_attempt_count < ${input.maxAttempts}
          and state in ('aborted', 'expired')
        order by cleanup_next_attempt_at, id
        for update skip locked
        limit ${input.limit}
      ), claimed as (
        update storage_uploads u
        set cleanup_state = 'claimed',
            cleanup_attempt_count = u.cleanup_attempt_count + 1,
            cleanup_next_attempt_at = null,
            cleanup_claim_token = gen_random_uuid(),
            cleanup_claim_expires_at = statement_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
            updated_at = statement_timestamp()
        from due where u.id = due.id
        returning u.id, u.object_id, u.owner_account_id, u.backend_multipart_id,
                  u.cleanup_attempt_count, u.cleanup_claim_token, u.cleanup_enqueued_at
      )
      select c.id as upload_id, c.owner_account_id, o.backing_key,
             c.backend_multipart_id as backend_upload_id,
             c.cleanup_attempt_count as attempt_count,
             c.cleanup_claim_token as claim_token,
             c.cleanup_enqueued_at as enqueued_at
      from claimed c join storage_objects o on o.id = c.object_id
      order by c.id
    `;
    return rows.map((row) => ({
      uploadId: row.upload_id,
      ownerAccountId: row.owner_account_id,
      backingKey: row.backing_key,
      backendUploadId: row.backend_upload_id,
      attemptCount: row.attempt_count,
      claimToken: row.claim_token,
      enqueuedAt: new Date(row.enqueued_at),
    }));
  }

  async markCleanupSucceeded(uploadId: string, claimToken: string, _now: Date): Promise<boolean> {
    const rows = await pg<Array<{ id: string }>>`
      update storage_uploads
      set cleanup_state = 'succeeded', cleanup_next_attempt_at = null,
          cleanup_claim_token = null, cleanup_claim_expires_at = null,
          cleanup_succeeded_at = statement_timestamp(), cleanup_last_error_code = null,
          updated_at = statement_timestamp()
      where id = ${uploadId} and cleanup_state = 'claimed' and cleanup_claim_token = ${claimToken}
      returning id
    `;
    return rows.length === 1;
  }

  async retryCleanup(input: {
    uploadId: string;
    claimToken: string;
    now: Date;
    retryDelayMs: number;
    maxAttempts: number;
    errorCode: string;
  }): Promise<'pending' | 'failed' | 'stale'> {
    const rows = await pg<Array<{ cleanup_state: 'pending' | 'failed' }>>`
      update storage_uploads
      set cleanup_state = case when cleanup_attempt_count >= ${input.maxAttempts} then 'failed' else 'pending' end,
          cleanup_next_attempt_at = case when cleanup_attempt_count >= ${input.maxAttempts}
            then null else statement_timestamp() + (${input.retryDelayMs} * interval '1 millisecond') end,
          cleanup_claim_token = null,
          cleanup_claim_expires_at = null,
          cleanup_last_error_code = case when cleanup_attempt_count >= ${input.maxAttempts}
            then 'attempts_exhausted' else ${input.errorCode} end,
          updated_at = statement_timestamp()
      where id = ${input.uploadId} and cleanup_state = 'claimed'
        and cleanup_claim_token = ${input.claimToken}
      returning cleanup_state
    `;
    return rows[0]?.cleanup_state ?? 'stale';
  }

  async cleanupMetrics(_now: Date): Promise<MultipartCleanupMetrics> {
    const rows = await pg<Array<{
      pending: string | number;
      claimed: string | number;
      failed: string | number;
      oldest_pending_age_ms: string | number;
      max_attempt_count: string | number;
    }>>`
      select count(*) filter (where cleanup_state = 'pending') as pending,
             count(*) filter (where cleanup_state = 'claimed') as claimed,
             count(*) filter (where cleanup_state = 'failed') as failed,
             coalesce(greatest(0, extract(epoch from (statement_timestamp() - min(cleanup_enqueued_at)
               filter (where cleanup_state = 'pending'))) * 1000), 0) as oldest_pending_age_ms,
             coalesce(max(cleanup_attempt_count), 0) as max_attempt_count
      from storage_uploads
      where cleanup_state <> 'not_required'
    `;
    const row = rows[0];
    return {
      pending: safeNumber(row?.pending),
      claimed: safeNumber(row?.claimed),
      failed: safeNumber(row?.failed),
      oldestPendingAgeMs: safeAge(row?.oldest_pending_age_ms),
      maxAttemptCount: safeNumber(row?.max_attempt_count),
    };
  }
}
