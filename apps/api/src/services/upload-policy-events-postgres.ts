import { pg } from '@eden3/db';

import type {
  ClaimedPolicyEvent,
  PolicyEventMetrics,
  UploadPolicyEventStore,
} from './upload-repository';

function safeCount(raw: string | number | null | undefined): number {
  const value = Number(raw ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid policy event metric');
  return value;
}

function safeAge(raw: string | number | null | undefined): number {
  const value = Number(raw ?? 0);
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid policy event age metric');
  }
  return Math.floor(value);
}

interface EventRow {
  id: string;
  object_id: string;
  owner_account_id: string;
  policy_code: string;
  state: ClaimedPolicyEvent['state'];
  attempt_count: number;
  claim_token: string;
}
function event(row: EventRow): ClaimedPolicyEvent {
  return {
    id: row.id,
    objectId: row.object_id,
    ownerAccountId: row.owner_account_id,
    policyCode: row.policy_code,
    state: 'delivering',
    attemptCount: row.attempt_count,
    claimToken: row.claim_token,
  };
}

export class PostgresUploadPolicyEventStore implements UploadPolicyEventStore {
  async recoverExpiredPolicyEvents(input: {
    now: Date;
    limit: number;
    maxAttempts: number;
  }): Promise<{ requeued: number; failed: number }> {
    const rows = await pg<Array<{ state: 'pending' | 'failed' }>>`
      with expired as (
        select id from storage_policy_events
        where state = 'delivering' and claim_expires_at <= statement_timestamp()
        order by claim_expires_at, id
        for update skip locked
        limit ${input.limit}
      )
      update storage_policy_events e
      set state = case when e.attempt_count >= ${input.maxAttempts} then 'failed' else 'pending' end,
          next_attempt_at = case when e.attempt_count >= ${input.maxAttempts}
            then null else statement_timestamp() end,
          claim_token = null, claim_expires_at = null, updated_at = statement_timestamp(),
          last_error_code = case when e.attempt_count >= ${input.maxAttempts}
            then 'attempts_exhausted' else 'claim_expired' end
      from expired where e.id = expired.id
      returning e.state
    `;
    return {
      requeued: rows.filter((row) => row.state === 'pending').length,
      failed: rows.filter((row) => row.state === 'failed').length,
    };
  }

  async claimDuePolicyEvents(input: {
    now: Date;
    limit: number;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ClaimedPolicyEvent[]> {
    return pg.begin(async (tx) => {
      const rows = await tx<EventRow[]>`
        with due as (
          select id from storage_policy_events
          where state = 'pending' and next_attempt_at <= statement_timestamp()
            and attempt_count < ${input.maxAttempts}
          order by next_attempt_at, id
          for update skip locked
          limit ${input.limit}
        )
        update storage_policy_events e
        set state = 'delivering', attempt_count = e.attempt_count + 1,
            next_attempt_at = null, claim_token = gen_random_uuid(),
            claim_expires_at = statement_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
            updated_at = statement_timestamp()
        from due where e.id = due.id
        returning e.id, e.object_id, e.owner_account_id, e.policy_code,
                  e.state, e.attempt_count, e.claim_token
      `;
      return rows.map(event);
    });
  }

  async markPolicyEventDelivered(eventId: string, claimToken: string, _now: Date): Promise<boolean> {
    const rows = await pg<{ id: string }[]>`
      update storage_policy_events set state = 'delivered', delivered_at = statement_timestamp(),
        next_attempt_at = null, claim_token = null, claim_expires_at = null,
        last_error_code = null, updated_at = statement_timestamp()
      where id = ${eventId} and state = 'delivering' and claim_token = ${claimToken}
      returning id
    `;
    return rows.length === 1;
  }

  async retryPolicyEvent(input: {
    eventId: string;
    claimToken: string;
    now: Date;
    retryDelayMs: number;
    maxAttempts: number;
    errorCode: string;
  }): Promise<'pending' | 'failed' | 'stale'> {
    const rows = await pg<Array<{ state: 'pending' | 'failed' }>>`
      update storage_policy_events
      set state = case when attempt_count >= ${input.maxAttempts} then 'failed' else 'pending' end,
          next_attempt_at = case when attempt_count >= ${input.maxAttempts}
            then null else statement_timestamp() + (${input.retryDelayMs} * interval '1 millisecond') end,
          claim_token = null, claim_expires_at = null, last_error_code = ${input.errorCode},
          updated_at = statement_timestamp()
      where id = ${input.eventId} and state = 'delivering' and claim_token = ${input.claimToken}
      returning state
    `;
    return rows[0]?.state ?? 'stale';
  }

  async policyEventMetrics(_now: Date): Promise<PolicyEventMetrics> {
    const rows = await pg<Array<{
      pending: string | number;
      claimed: string | number;
      failed: string | number;
      oldest_pending_age_ms: string | number;
      max_attempt_count: string | number;
    }>>`
      select count(*) filter (where state = 'pending') as pending,
             count(*) filter (where state = 'delivering') as claimed,
             count(*) filter (where state = 'failed') as failed,
             coalesce(greatest(0, extract(epoch from (statement_timestamp() - min(created_at)
               filter (where state = 'pending'))) * 1000), 0) as oldest_pending_age_ms,
             coalesce(max(attempt_count) filter (where state <> 'delivered'), 0) as max_attempt_count
      from storage_policy_events
    `;
    const row = rows[0];
    return {
      pending: safeCount(row?.pending),
      claimed: safeCount(row?.claimed),
      failed: safeCount(row?.failed),
      oldestPendingAgeMs: safeAge(row?.oldest_pending_age_ms),
      maxAttemptCount: safeCount(row?.max_attempt_count),
    };
  }
}
