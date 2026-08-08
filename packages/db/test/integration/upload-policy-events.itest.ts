import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { loadRootEnv } from '../../src/env';

loadRootEnv();

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);
const PROTECTED_DATABASES = new Set(['eden3', 'eden3_stg']);
const sourceDatabaseUrl = process.env.DATABASE_URL;
if (!sourceDatabaseUrl) throw new Error('DATABASE_URL is required for disposable policy integration proof');
const scratchDatabases: string[] = [];
let closeStoreClient: (() => Promise<void>) | undefined;

function urlForDatabase(database: string): string {
  if (database !== 'postgres' && !/^debt020_policy_[a-f0-9]{8}$/.test(database)) {
    throw new Error(`refusing non-disposable database ${database}`);
  }
  if (PROTECTED_DATABASES.has(database)) throw new Error(`refusing protected database ${database}`);
  const source = new URL(sourceDatabaseUrl!);
  const url = new URL(`${source.protocol}//${source.host}`);
  url.username = source.username;
  url.password = source.password;
  url.pathname = `/${database}`;
  return url.toString();
}

async function createScratchDatabase(): Promise<string> {
  const name = `debt020_policy_${randomUUID().slice(0, 8)}`;
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  scratchDatabases.push(name);
  console.info(`created disposable database ${name}`);
  return name;
}

afterAll(async () => {
  await closeStoreClient?.();
  process.env.DATABASE_URL = sourceDatabaseUrl;
  if (scratchDatabases.length === 0) return;
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => undefined });
  try {
    for (const name of scratchDatabases) {
      if (!/^debt020_policy_[a-f0-9]{8}$/.test(name)) throw new Error(`refusing to drop ${name}`);
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      const [remaining] = await admin<{ count: string }[]>`
        select count(*)::text as count from pg_database where datname = ${name}`;
      expect(remaining?.count).toBe('0');
      console.info(`dropped and verified absent disposable database ${name}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('policy outbox timestamp/CAS truth on disposable PostgreSQL', () => {
  it('runs retry, dead-lease recovery, concurrent claim, stale CAS, and metrics on the full chain', async () => {
    const database = await createScratchDatabase();
    const databaseUrl = urlForDatabase(database);
    const setup = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const ownerId = randomUUID();
    const objectId = randomUUID();
    try {
      const [connected] = await setup<{ database: string }[]>`select current_database() as database`;
      expect(connected?.database).toBe(database);
      await migrate(drizzle(setup), { migrationsFolder: MIGRATIONS_DIR });
      await setup`
        insert into accounts (id, type, username)
        values (${ownerId}, 'user', ${`debt020_${randomUUID()}`})`;
      await setup`
        insert into storage_objects
          (id, owner_account_id, purpose, declared_mime, declared_size_bytes, declared_sha256,
           state, backing_store, backing_key, quarantine_reason)
        values (${objectId}, ${ownerId}, 'chat', 'text/plain', 1, ${'a'.repeat(64)},
                'quarantined', 'local', ${`objects/${objectId.slice(0, 2)}/${objectId}`},
                'synthetic_policy_match')`;
    } finally {
      await setup.end({ timeout: 5 });
    }

    process.env.DATABASE_URL = databaseUrl;
    const { PostgresUploadPolicyEventStore } = await import(
      '../../../../apps/api/src/services/upload-policy-events-postgres'
    );
    const { pg } = await import('@eden3/db');
    closeStoreClient = async () => { await pg.end({ timeout: 5 }); };
    const store = new PostgresUploadPolicyEventStore();

    const eventId = randomUUID();
    await pg`
      insert into storage_policy_events
        (id, object_id, owner_account_id, event_type, policy_code, next_attempt_at)
      values (${eventId}, ${objectId}, ${ownerId}, 'quarantine_required',
              'synthetic_policy_match', statement_timestamp())`;

    const [claim] = await store.claimDuePolicyEvents({
      now: new Date(0),
      limit: 1,
      leaseMs: 30_000,
      maxAttempts: 5,
    });
    expect(claim?.id).toBe(eventId);

    // Reproduce the live-boot defect exactly: postgres-js binds the ISO string
    // as text, so CASE cannot resolve text against the timestamptz column.
    await expect(pg`
      update storage_policy_events
      set next_attempt_at = case when attempt_count >= ${5}
        then null else ${new Date().toISOString()} end
      where id = ${eventId} and state = 'delivering' and claim_token = ${claim!.claimToken}
    `).rejects.toThrow(/timestamp with time zone|timestamptz|text/i);

    await expect(store.retryPolicyEvent({
      eventId,
      claimToken: claim!.claimToken,
      now: new Date(0),
      retryDelayMs: 100,
      maxAttempts: 5,
      errorCode: 'delivery_failed',
    })).resolves.toBe('pending');

    await pg`
      update storage_policy_events
      set next_attempt_at = statement_timestamp() - interval '1 second'
      where id = ${eventId}`;
    const concurrent = await Promise.all([
      store.claimDuePolicyEvents({ now: new Date(0), limit: 1, leaseMs: 30_000, maxAttempts: 5 }),
      store.claimDuePolicyEvents({ now: new Date(0), limit: 1, leaseMs: 30_000, maxAttempts: 5 }),
    ]);
    expect(concurrent.flat()).toHaveLength(1);
    const current = concurrent.flat()[0]!;
    expect(await store.markPolicyEventDelivered(eventId, randomUUID(), new Date(0))).toBe(false);
    expect(await store.retryPolicyEvent({
      eventId,
      claimToken: randomUUID(),
      now: new Date(0),
      retryDelayMs: 100,
      maxAttempts: 5,
      errorCode: 'delivery_failed',
    })).toBe('stale');
    expect(await store.markPolicyEventDelivered(eventId, current.claimToken, new Date(0))).toBe(true);

    const expiredId = randomUUID();
    await pg`
      insert into storage_policy_events
        (id, object_id, owner_account_id, event_type, policy_code, next_attempt_at)
      values (${expiredId}, ${objectId}, ${ownerId}, 'quarantine_required',
              'expired_claim_probe', statement_timestamp())`;
    await pg`
      update storage_policy_events
      set state = 'delivering', attempt_count = 1, next_attempt_at = null,
          claim_token = ${randomUUID()}, claim_expires_at = statement_timestamp() - interval '1 second'
      where id = ${expiredId}`;
    await expect(store.recoverExpiredPolicyEvents({
      now: new Date(0),
      limit: 1,
      maxAttempts: 5,
    })).resolves.toEqual({ requeued: 1, failed: 0 });

    const metrics = await store.policyEventMetrics(new Date(0));
    expect(metrics).toMatchObject({
      pending: 1,
      claimed: 0,
      failed: 0,
      maxAttemptCount: 1,
    });
    expect(metrics.oldestPendingAgeMs).toBeGreaterThanOrEqual(0);
  });
});
