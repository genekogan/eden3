import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import {
  localDisposableDatabaseUrl,
  localSourceDatabaseName,
} from '../fixtures/disposable-database';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const scratchDatabases: string[] = [];
const scratchPattern = /^t12u03_erase_[a-f0-9]{8}$/;

function sourceDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for account-erasure scratch proof');
  if (localSourceDatabaseName(raw) !== 'postgres') {
    throw new Error('account-erasure proof requires the disposable PostgreSQL admin database');
  }
  return raw;
}

function urlForDatabase(database: string): string {
  return localDisposableDatabaseUrl(sourceDatabaseUrl(), database, scratchPattern);
}

async function createScratchDatabase(): Promise<{ name: string; url: string }> {
  const name = process.env.ACCOUNT_ERASURE_SCRATCH_NAME
    ?? `t12u03_erase_${randomUUID().slice(0, 8)}`;
  if (!scratchPattern.test(name)) throw new Error(`refusing non-disposable database ${name}`);
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  scratchDatabases.push(name);
  return { name, url: urlForDatabase(name) };
}

function digest(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

async function expectDatabaseRejection(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(run()).rejects.toMatchObject({ message: expect.stringMatching(pattern) });
}

afterAll(async () => {
  if (scratchDatabases.length === 0) return;
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => undefined });
  try {
    for (const name of scratchDatabases.splice(0)) {
      if (!scratchPattern.test(name)) throw new Error(`refusing to drop ${name}`);
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      const [remaining] = await admin<{ count: number }[]>`
        select count(*)::int as count from pg_database where datname = ${name}`;
      expect(remaining?.count).toBe(0);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('0040 account-erasure lifecycle against disposable PostgreSQL', () => {
  it('serializes admission, rejects kind mutants, fences claims, and proves storage disposal/replay', async () => {
    const scratch = await createScratchDatabase();
    const migrationClient = postgres(scratch.url, { max: 1, onnotice: () => undefined });
    await migrate(drizzle(migrationClient), { migrationsFolder: MIGRATIONS_DIR });
    await migrationClient.end({ timeout: 5 });

    const sql = postgres(scratch.url, { max: 4, onnotice: () => undefined });
    const writer = postgres(scratch.url, { max: 1, onnotice: () => undefined });
    const contender = postgres(scratch.url, { max: 1, onnotice: () => undefined });
    const humanId = randomUUID();
    const otherId = randomUUID();
    const agentId = randomUUID();
    const jobId = randomUUID();
    const backupTargetId = randomUUID();
    const readyObjectId = randomUUID();
    const blockedObjectId = randomUUID();
    const foreignObjectId = randomUUID();
    const frozenObjectId = randomUUID();
    const agentObjectId = randomUUID();
    const readyUploadId = randomUUID();
    const blockedUploadId = randomUUID();
    const readyTargetId = randomUUID();
    const blockedTargetId = randomUUID();
    const frozenTargetId = randomUUID();
    const agentObjectTargetId = randomUUID();
    const foreignSessionId = randomUUID();
    const foreignMessageId = randomUUID();
    const foreignMediaId = randomUUID();
    const mixedMediaId = randomUUID();
    const ownedMessageId = randomUUID();
    const foreignCreationId = randomUUID();
    const channelId = randomUUID();
    const channelSessionId = randomUUID();
    const channelTargetId = randomUUID();
    const onboardingIntentId = randomUUID();
    const channelTurnId = randomUUID();

    try {
      await sql`
        insert into accounts (id, type, username) values
          (${humanId}, 'user', ${`erase_${humanId.slice(0, 8)}`}),
          (${otherId}, 'user', ${`other_${otherId.slice(0, 8)}`}),
          (${agentId}, 'agent', ${`agent_${agentId.slice(0, 8)}`})`;
      await sql`insert into agents (account_id, owner_id, name) values (${agentId}, ${humanId}, 'owned agent')`;
      for (const [id, owner] of [
        [readyObjectId, humanId], [blockedObjectId, humanId], [foreignObjectId, otherId],
        [frozenObjectId, humanId], [agentObjectId, agentId],
      ] as const) {
        await sql`
          insert into storage_objects
            (id, owner_account_id, purpose, declared_mime, declared_size_bytes,
             declared_sha256, state, backing_store, backing_key)
          values (${id}, ${owner}, 'chat', 'text/plain', 1, ${digest(id)},
            'pending', 'local', ${`objects/${id.slice(0, 2)}/${id}`})`;
      }
      await sql`
        insert into storage_uploads
          (id, object_id, owner_account_id, backend_multipart_id, state, part_size_bytes,
           expires_at, capability_expires_at, completed_at)
        values (${readyUploadId}, ${readyObjectId}, ${humanId}, 'ready-provider-id',
          'completed', 1, statement_timestamp() + interval '1 day',
          statement_timestamp() + interval '1 hour', statement_timestamp())`;
      await sql`
        insert into storage_uploads
          (id, object_id, owner_account_id, backend_multipart_id, state, part_size_bytes,
           expires_at, capability_expires_at, cleanup_state, cleanup_attempt_count,
           cleanup_enqueued_at, cleanup_last_error_code)
        values (${blockedUploadId}, ${blockedObjectId}, ${humanId}, 'blocked-provider-id',
          'aborted', 1, statement_timestamp() + interval '1 day',
          statement_timestamp() + interval '1 hour', 'failed', 1,
          statement_timestamp(), 'attempts_exhausted')`;
      await sql`
        insert into sessions (id, owner_id, title) values
          (${foreignSessionId}, ${otherId}, 'foreign shared'),
          (${channelSessionId}, ${humanId}, 'channel owned')`;
      await sql`insert into session_users (session_id, user_account_id) values (${foreignSessionId}, ${humanId})`;
      await sql`
        insert into messages (id, session_id, sender_id, content)
        values (${foreignMessageId}, ${foreignSessionId}, ${otherId}, 'foreign survives'),
          (${ownedMessageId}, ${channelSessionId}, ${humanId}, 'owned content')`;
      await sql`
        insert into creations (id, user_id, filename)
        values (${foreignCreationId}, ${otherId}, 'foreign.png')`;
      await sql`
        insert into media_assets (id, session_id, message_id, sha256)
        values (${foreignMediaId}, ${foreignSessionId}, ${foreignMessageId}, ${digest('foreign-media')})`;
      await sql`
        insert into media_assets (id, message_id, creation_id, sha256)
        values (${mixedMediaId}, ${ownedMessageId}, ${foreignCreationId}, ${digest('mixed-media')})`;
      await sql`
        insert into channel_connections
          (id, account_id, channel, token_ciphertext, token_iv, token_auth_tag, token_sha256)
        values (${channelId}, ${humanId}, 'telegram', 'ciphertext', 'iv', 'tag', ${digest('channel-token')})`;
      await sql`update sessions set channel_connection_id = ${channelId} where id = ${channelSessionId}`;
      await sql`
        insert into channel_onboarding_intents
          (id, account_id, intent_secret_hash, expires_at)
        values (${onboardingIntentId}, ${humanId}, ${digest('intent')}, statement_timestamp() + interval '1 hour')`;
      await sql`
        update channel_onboarding_intents set state = 'awaiting_bot',
          provider_owner_id_hash = ${digest('provider-owner')} where id = ${onboardingIntentId}`;
      await sql`update channel_onboarding_intents set state = 'exchanging' where id = ${onboardingIntentId}`;
      await sql`
        update channel_onboarding_intents set state = 'stored', connection_id = ${channelId}
        where id = ${onboardingIntentId}`;
      await sql`
        insert into channel_turns
          (turn_id, connection_id, account_id, status, reserved_manna, completed_at)
        values (${channelTurnId}, ${channelId}, ${humanId}, 'delivered', 0, statement_timestamp())`;

      let releaseWriter!: () => void;
      let writerLocked!: () => void;
      const writerReady = new Promise<void>((resolve) => { writerLocked = resolve; });
      const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
      const heldWriter = writer.begin(async (tx) => {
        await tx`select id from accounts where id = ${humanId} for update`;
        writerLocked();
        await writerRelease;
        await tx`insert into collections (user_id, name) values (${humanId}, 'pre-intent')`;
        throw new Error('rollback-held-writer');
      }).catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback-held-writer') throw error;
      });
      await writerReady;
      await contender`set lock_timeout = '150ms'`;
      await expectDatabaseRejection(
        () => contender.begin(async (tx) => {
          await tx`select account_erasure_begin_operation()`;
          await tx`insert into account_erasure_jobs (id, account_id) values (${jobId}, ${humanId})`;
        }),
        /lock timeout/i,
      );
      releaseWriter();
      await heldWriter;

      let releaseExclusive!: () => void;
      let exclusiveLocked!: () => void;
      const exclusiveReady = new Promise<void>((resolve) => { exclusiveLocked = resolve; });
      const exclusiveRelease = new Promise<void>((resolve) => { releaseExclusive = resolve; });
      const heldExclusive = writer.begin(async (tx) => {
        await tx`select account_erasure_begin_operation()`;
        exclusiveLocked();
        await exclusiveRelease;
        throw new Error('rollback-held-exclusive');
      }).catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback-held-exclusive') throw error;
      });
      await exclusiveReady;
      await expectDatabaseRejection(
        () => contender.begin(async (tx) => {
          await tx`select account_erasure_begin_operation()`;
        }),
        /lock timeout/i,
      );
      releaseExclusive();
      await heldExclusive;

      await sql.begin(async (tx) => {
        await tx`select account_erasure_begin_operation()`;
        await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
        await tx`select set_config('eden3.erasure_inventory_mode', 'accept_intent', true)`;
        await tx`insert into account_erasure_jobs (id, account_id) values (${jobId}, ${humanId})`;
        await tx`
          insert into account_erasure_targets (id, job_id, kind, resource_id)
          values (${backupTargetId}, ${jobId}, 'backup_tombstone', ${jobId})`;
      });
      await expectDatabaseRejection(
        () => sql`insert into collections (user_id, name) values (${humanId}, 'post-intent')`,
        /active erasure job/i,
      );
      await expectDatabaseRejection(
        () => sql`
          insert into account_erasure_targets (job_id, kind, resource_id)
          values (${jobId}, 'storage_object', ${foreignObjectId})`,
        /kind ownership mismatch/i,
      );
      await expectDatabaseRejection(
        () => sql.begin(async (tx) => {
          await tx`select account_erasure_begin_operation()`;
          await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
          await tx`select set_config('eden3.erasure_inventory_mode', 'seal_inventory', true)`;
          await tx`
            insert into account_erasure_targets (job_id, kind, resource_id)
            values (${jobId}, 'legacy_media_asset', ${mixedMediaId})`;
        }),
        /kind ownership mismatch/i,
      );
      await sql`delete from storage_objects where id = ${foreignObjectId}`;
      await expectDatabaseRejection(
        () => sql.begin(async (tx) => {
          await tx`select account_erasure_begin_operation()`;
          await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
          await tx`select set_config('eden3.erasure_inventory_mode', 'seal_inventory', true)`;
          await tx`
            insert into account_erasure_message_tombstones
              (job_id, session_id, message_id, author_principal_id)
            values (${jobId}, ${foreignSessionId}, ${foreignMessageId}, ${humanId})`;
        }),
        /source author\/session mismatch/i,
      );
      await expectDatabaseRejection(
        () => sql.begin(async (tx) => {
          await tx`select account_erasure_begin_operation()`;
          await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
          await tx`select set_config('eden3.erasure_inventory_mode', 'seal_inventory', true)`;
          await tx`
            insert into account_erasure_targets (job_id, kind, resource_id)
            values (${jobId}, 'legacy_media_asset', ${foreignMediaId})`;
        }),
        /kind ownership mismatch/i,
      );

      await sql.begin(async (tx) => {
        await tx`select account_erasure_begin_operation()`;
        await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
        await tx`select set_config('eden3.erasure_inventory_mode', 'seal_inventory', true)`;
        await tx`
          insert into account_erasure_targets (id, job_id, kind, resource_id) values
            (${readyTargetId}, ${jobId}, 'storage_object', ${readyObjectId}),
            (${blockedTargetId}, ${jobId}, 'storage_object', ${blockedObjectId}),
            (${frozenTargetId}, ${jobId}, 'storage_object', ${frozenObjectId}),
            (${agentObjectTargetId}, ${jobId}, 'storage_object', ${agentObjectId}),
            (${channelTargetId}, ${jobId}, 'channel_runtime', ${channelId})`;
        await tx`
          update account_erasure_targets set state = 'succeeded', next_attempt_at = null,
            completed_at = statement_timestamp(), updated_at = statement_timestamp()
          where id = ${backupTargetId}`;
        await tx`
          update accounts set deleted = true, updated_at = statement_timestamp()
          where id in (${humanId}, ${agentId})`;
        await tx`
          update account_erasure_jobs set state = 'manifest_pending',
            ledger_confirmed_at = statement_timestamp(), ledger_sha256 = ${digest('ledger')},
            ledger_mac_sha256 = ${digest('ledger-mac')}, inventoried_at = statement_timestamp(),
            inventory_sha256 = ${digest('inventory')}, updated_at = statement_timestamp()
          where id = ${jobId}`;
      });
      await sql.begin(async (tx) => {
        await tx`select account_erasure_begin_operation()`;
        await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
        await tx`select set_config('eden3.erasure_inventory_mode', 'confirm_manifest', true)`;
        await tx`
          update account_erasure_jobs set state = 'pending', next_attempt_at = null,
            recovery_manifest_confirmed_at = statement_timestamp(),
            recovery_ciphertext_sha256 = ${digest('ciphertext')},
            recovery_mac_sha256 = ${digest('recovery-mac')}, recovery_key_version = 1,
            updated_at = statement_timestamp()
          where id = ${jobId}`;
      });
      await expectDatabaseRejection(
        () => sql.begin(async (tx) => {
          await tx`select account_erasure_begin_operation()`;
          await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
          await tx`select set_config('eden3.erasure_inventory_mode', 'seal_inventory', true)`;
          await tx`
            insert into account_erasure_targets (job_id, kind, resource_id)
            values (${jobId}, 'storage_object', ${frozenObjectId})`;
        }),
        /kind ownership mismatch/i,
      );

      await expectDatabaseRejection(
        () => sql`
          update account_erasure_targets set state = 'claimed', attempt_count = 1,
            next_attempt_at = null, claim_token = ${randomUUID()},
            claim_expires_at = statement_timestamp() + interval '1 minute'
          where id = ${blockedTargetId}`,
        /invalid erasure target claim/i,
      );
      await sql`
        update account_erasure_targets set state = 'attention', attempt_count = attempt_count + 1,
          next_attempt_at = null, last_error_code = 'multipart_cleanup_failed',
          updated_at = statement_timestamp()
        where id = ${blockedTargetId}`;
      const requeueId = randomUUID();
      await sql`
        insert into account_erasure_target_requeues
          (id, job_id, target_id, prior_attempt_count, operator_id, reason_code)
        values (${requeueId}, ${jobId}, ${blockedTargetId}, 1, 'operator.test',
          'multipart_cleanup_requeue')`;
      await sql.begin(async (tx) => {
        await tx`select account_erasure_begin_operation()`;
        await tx`select set_config('eden3.erasure_requeue_id', ${requeueId}, true)`;
        await tx`select set_config('eden3.erasure_target_kind', 'storage_object', true)`;
        await tx`select set_config('eden3.erasure_target_resource_id', ${blockedObjectId}, true)`;
        await tx`
          update storage_uploads set cleanup_state = 'pending',
            cleanup_next_attempt_at = statement_timestamp(), cleanup_last_error_code = null,
            updated_at = statement_timestamp() where id = ${blockedUploadId}`;
        await tx`
          update account_erasure_targets set state = 'pending',
            next_attempt_at = statement_timestamp(), last_error_code = null,
            updated_at = statement_timestamp() where id = ${blockedTargetId}`;
      });
      const cleanupClaim = randomUUID();
      await sql`
        update storage_uploads set cleanup_state = 'claimed', cleanup_attempt_count = 2,
          cleanup_next_attempt_at = null, cleanup_claim_token = ${cleanupClaim},
          cleanup_claim_expires_at = statement_timestamp() + interval '1 minute',
          updated_at = statement_timestamp() where id = ${blockedUploadId}`;
      await sql`
        update storage_uploads set cleanup_state = 'succeeded', cleanup_claim_token = null,
          cleanup_claim_expires_at = null, cleanup_succeeded_at = statement_timestamp(),
          cleanup_last_error_code = null, updated_at = statement_timestamp()
        where id = ${blockedUploadId}`;

      const staleClaimToken = randomUUID();
      const [staleClaim] = await sql<{ claim_expires_at: string }[]>`
        update account_erasure_targets set state = 'claimed', attempt_count = attempt_count + 1,
          next_attempt_at = null, claim_token = ${staleClaimToken},
          claim_expires_at = statement_timestamp() + interval '25 milliseconds',
          last_error_code = null, updated_at = statement_timestamp()
        where id = ${readyTargetId} returning claim_expires_at::text as claim_expires_at`;
      await sql`select pg_sleep(0.05)`;
      await sql.begin(async (tx) => {
        await tx`select account_erasure_begin_operation()`;
        await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
        await tx`select set_config('eden3.erasure_target_kind', 'storage_object', true)`;
        await tx`select set_config('eden3.erasure_target_resource_id', ${readyObjectId}, true)`;
        await tx`select set_config('eden3.erasure_target_claim_token', ${staleClaimToken}, true)`;
        await tx`select set_config('eden3.erasure_target_claim_expires_at', ${staleClaim!.claim_expires_at}, true)`;
        await tx`
          update account_erasure_targets set state = 'pending', next_attempt_at = statement_timestamp(),
            claim_token = null, claim_expires_at = null, last_error_code = 'claim_expired',
            updated_at = statement_timestamp() where id = ${readyTargetId}`;
      });
      const replacementClaimToken = randomUUID();
      const [replacementClaim] = await sql<{ claim_expires_at: string }[]>`
        update account_erasure_targets set state = 'claimed', attempt_count = attempt_count + 1,
          next_attempt_at = null, claim_token = ${replacementClaimToken},
          claim_expires_at = statement_timestamp() + interval '1 minute',
          last_error_code = null, updated_at = statement_timestamp()
        where id = ${readyTargetId} returning claim_expires_at::text as claim_expires_at`;
      await expectDatabaseRejection(
        () => sql.begin(async (tx) => {
          await tx`select account_erasure_begin_operation()`;
          await tx`select set_config('eden3.erasure_target_claim_token', ${staleClaimToken}, true)`;
          await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
          await tx`select set_config('eden3.erasure_target_kind', 'storage_object', true)`;
          await tx`select set_config('eden3.erasure_target_resource_id', ${readyObjectId}, true)`;
          await tx`select set_config('eden3.erasure_target_claim_expires_at', ${staleClaim!.claim_expires_at}, true)`;
          await tx`
            update account_erasure_targets set state = 'pending', next_attempt_at = statement_timestamp(),
              claim_token = null, claim_expires_at = null, last_error_code = 'late_worker',
              updated_at = statement_timestamp() where id = ${readyTargetId}`;
        }),
        /late or mismatched erasure target claim/i,
      );

      for (const [targetId, objectId, existingClaim] of [
        [readyTargetId, readyObjectId, { token: replacementClaimToken, expiresAt: replacementClaim!.claim_expires_at }],
        [blockedTargetId, blockedObjectId, null],
        [frozenTargetId, frozenObjectId, null],
        [agentObjectTargetId, agentObjectId, null],
      ] as const) {
        const claimToken = existingClaim?.token ?? randomUUID();
        let claimExpiresAt = existingClaim?.expiresAt;
        if (!existingClaim) {
        const [newClaim] = await sql<{ claim_expires_at: string }[]>`
          update account_erasure_targets set state = 'claimed', attempt_count = attempt_count + 1,
            next_attempt_at = null, claim_token = ${claimToken},
            claim_expires_at = statement_timestamp() + interval '1 minute',
            last_error_code = null, updated_at = statement_timestamp()
          where id = ${targetId} returning claim_expires_at::text as claim_expires_at`;
        claimExpiresAt = newClaim!.claim_expires_at;
        }
        await expectDatabaseRejection(
          () => sql`delete from storage_objects where id = ${objectId}`,
          /exact live erasure target claim/i,
        );
        await sql.begin(async (tx) => {
          await tx`select account_erasure_begin_operation()`;
          await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
          await tx`select set_config('eden3.erasure_target_kind', 'storage_object', true)`;
          await tx`select set_config('eden3.erasure_target_resource_id', ${objectId}, true)`;
          await tx`select set_config('eden3.erasure_target_claim_token', ${claimToken}, true)`;
          await tx`select set_config('eden3.erasure_target_claim_expires_at', ${claimExpiresAt!}, true)`;
          await tx`select set_config('eden3.erasure_external_absence_id', ${objectId}, true)`;
          await tx`delete from storage_objects where id = ${objectId}`;
          await tx`
            update account_erasure_targets set state = 'succeeded', next_attempt_at = null,
              claim_token = null, claim_expires_at = null, completed_at = statement_timestamp(),
              last_error_code = null, updated_at = statement_timestamp()
            where id = ${targetId}`;
        });
      }

      const [channelClaim] = await sql<{ claim_token: string; claim_expires_at: string }[]>`
        update account_erasure_targets set state = 'claimed', attempt_count = attempt_count + 1,
          next_attempt_at = null, claim_token = ${randomUUID()},
          claim_expires_at = statement_timestamp() + interval '1 minute',
          updated_at = statement_timestamp()
        where id = ${channelTargetId}
        returning claim_token, claim_expires_at::text as claim_expires_at`;
      await sql.begin(async (tx) => {
        await tx`select account_erasure_begin_operation()`;
        await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
        await tx`select set_config('eden3.erasure_target_kind', 'channel_runtime', true)`;
        await tx`select set_config('eden3.erasure_target_resource_id', ${channelId}, true)`;
        await tx`select set_config('eden3.erasure_target_claim_token', ${channelClaim!.claim_token}, true)`;
        await tx`select set_config('eden3.erasure_target_claim_expires_at', ${channelClaim!.claim_expires_at}, true)`;
        await tx`delete from channel_connections where id = ${channelId}`;
        await tx`
          update account_erasure_targets set state = 'succeeded', next_attempt_at = null,
            claim_token = null, claim_expires_at = null, completed_at = statement_timestamp(),
            updated_at = statement_timestamp() where id = ${channelTargetId}`;
      });
      const [channelSession] = await sql<{ channel_connection_id: string | null }[]>`
        select channel_connection_id from sessions where id = ${channelSessionId}`;
      expect(channelSession!.channel_connection_id).toBeNull();
      const [channelReferences] = await sql<{
        intent_connection_id: string | null;
        turn_connection_id: string | null;
      }[]>`
        select i.connection_id as intent_connection_id, t.connection_id as turn_connection_id
        from channel_onboarding_intents i cross join channel_turns t
        where i.id = ${onboardingIntentId} and t.turn_id = ${channelTurnId}`;
      expect(channelReferences).toEqual({ intent_connection_id: null, turn_connection_id: null });

      await sql`
        update account_erasure_jobs set state = 'succeeded', completed_at = statement_timestamp(),
          updated_at = statement_timestamp() where id = ${jobId}`;
      const [terminal] = await sql<{ job_state: string; remaining_objects: number; remaining_uploads: number }[]>`
        select j.state as job_state,
          (select count(*)::int from storage_objects where id in (${readyObjectId}, ${blockedObjectId}, ${frozenObjectId}, ${agentObjectId})) as remaining_objects,
          (select count(*)::int from storage_uploads where id in (${readyUploadId}, ${blockedUploadId})) as remaining_uploads
        from account_erasure_jobs j where j.id = ${jobId}`;
      expect(terminal).toEqual({ job_state: 'succeeded', remaining_objects: 0, remaining_uploads: 0 });

      await expectDatabaseRejection(
        () => sql.begin(async (tx) => {
          await tx`select account_erasure_begin_operation()`;
          await tx`select set_config('eden3.erasure_restore_mode', 'verified_offline', true)`;
          await tx`
            insert into account_erasure_jobs (id, account_id, state, next_attempt_at,
              completed_at, ledger_confirmed_at, ledger_sha256, ledger_mac_sha256,
              inventoried_at, inventory_sha256, recovery_manifest_confirmed_at,
              recovery_ciphertext_sha256, recovery_mac_sha256, recovery_key_version)
            values (${randomUUID()}, ${randomUUID()}, 'succeeded', null, statement_timestamp(),
              statement_timestamp(), ${digest('restore-ledger')}, ${digest('restore-ledger-mac')},
              statement_timestamp(), ${digest('restore-inventory')}, statement_timestamp(),
              ${digest('restore-ciphertext')}, ${digest('restore-mac')}, 1)`;
        }),
        /new erasure job must start intent_pending/i,
      );
    } finally {
      await Promise.all([
        sql.end({ timeout: 5 }), writer.end({ timeout: 5 }), contender.end({ timeout: 5 }),
      ]);
    }
  });
});
