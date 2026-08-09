import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { loadRootEnv } from '../../src/env';
import { localDisposableDatabaseUrl } from '../fixtures/disposable-database';

loadRootEnv();

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const scratchDatabases: string[] = [];
const scratchPattern = /^t20t21b_m3_[a-f0-9]{8}$/;

function urlForDatabase(database: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for disposable storage integration proof');
  return localDisposableDatabaseUrl(source, database, scratchPattern);
}

async function createScratchDatabase(): Promise<string> {
  const name = `t20t21b_m3_${randomUUID().slice(0, 8)}`;
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  scratchDatabases.push(name);
  console.info(`storage kernel scratch database: ${name}`);
  return name;
}

afterAll(async () => {
  if (scratchDatabases.length === 0) return;
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => undefined });
  try {
    for (const name of scratchDatabases) {
      if (!scratchPattern.test(name)) throw new Error(`refusing to drop ${name}`);
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('0030-0033 storage/share kernel on a disposable PostgreSQL database', () => {
  it('applies the chain and enforces tenant, lifecycle, capability, outbox, and cascade guards', async () => {
    const database = await createScratchDatabase();
    const sql = postgres(urlForDatabase(database), { max: 1, onnotice: () => undefined });
    try {
      const [connected] = await sql<{ database: string }[]>`select current_database() as database`;
      expect(connected?.database).toBe(database);
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });

      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name in (
          'storage_objects', 'storage_uploads', 'storage_upload_parts',
          'storage_upload_part_authorizations', 'storage_policy_events',
          'channel_onboarding_intents', 'session_share_links'
        )`;
      expect(new Set(tables.map((row) => row.table_name))).toEqual(new Set([
        'storage_objects', 'storage_uploads', 'storage_upload_parts',
        'storage_upload_part_authorizations', 'storage_policy_events',
        'channel_onboarding_intents', 'session_share_links',
      ]));

      const [owner] = await sql<{ id: string }[]>`
        insert into accounts (type, username) values ('user', ${`storage_owner_${randomUUID()}`}) returning id`;
      const [other] = await sql<{ id: string }[]>`
        insert into accounts (type, username) values ('user', ${`storage_other_${randomUUID()}`}) returning id`;
      const objectId = randomUUID();
      const sha = 'a'.repeat(64);
      await sql`
        insert into storage_objects
          (id, owner_account_id, purpose, declared_mime, declared_size_bytes, declared_sha256,
           backing_store, backing_key)
        values (${objectId}, ${owner!.id}, 'chat', 'text/plain', 6, ${sha}, 'local',
                ${`objects/${objectId.slice(0, 2)}/${objectId}`})`;

      const uploadId = randomUUID();
      const uploadInsert = (accountId: string, id = uploadId) => sql`
        insert into storage_uploads
          (id, object_id, owner_account_id, backend_multipart_id, part_size_bytes,
           expires_at, capability_expires_at)
        values (${id}, ${objectId}, ${accountId}, ${`local-${id}`}, 4,
                now() + interval '1 hour', now() + interval '30 minutes')`;
      await expect(uploadInsert(other!.id)).rejects.toThrow(/storage_uploads_object_owner_fk/);
      await uploadInsert(owner!.id);
      await expect(sql`update storage_objects set declared_mime = 'image/png' where id = ${objectId}`)
        .rejects.toThrow(/immutable/);
      await expect(sql`update storage_objects set state = 'available' where id = ${objectId}`)
        .rejects.toThrow(/illegal storage object lifecycle/);

      await sql`
        insert into storage_upload_part_authorizations
          (upload_id, part_number, checksum_sha256, size_bytes, expires_at)
        values (${uploadId}, 1, ${'b'.repeat(64)}, 4, now() + interval '10 minutes')`;
      await expect(sql`
        update storage_upload_part_authorizations set checksum_sha256 = ${'c'.repeat(64)}
        where upload_id = ${uploadId} and part_number = 1`)
        .rejects.toThrow(/claims are immutable/);
      await expect(sql`
        insert into storage_upload_part_authorizations
          (upload_id, part_number, checksum_sha256, size_bytes, expires_at)
        values (${uploadId}, 3, ${'d'.repeat(64)}, 1, now() + interval '10 minutes')`)
        .rejects.toThrow(/exceeds declared object geometry/);
      await sql`
        insert into storage_upload_parts
          (upload_id, part_number, backend_etag, checksum_sha256, size_bytes)
        values (${uploadId}, 1, 'etag-1', ${'b'.repeat(64)}, 4)`;
      await sql`update storage_uploads set state = 'uploading' where id = ${uploadId}`;
      await sql`update storage_uploads set state = 'completed', completed_at = now() where id = ${uploadId}`;
      await expect(sql`
        update storage_upload_parts set backend_etag = 'mutated'
        where upload_id = ${uploadId} and part_number = 1`)
        .rejects.toThrow(/terminal storage upload/);

      await sql`update storage_objects set state = 'uploaded' where id = ${objectId}`;
      await sql`
        update storage_objects set state = 'verified', verified_mime = declared_mime,
          verified_size_bytes = declared_size_bytes, verified_sha256 = declared_sha256
        where id = ${objectId}`;
      await sql`update storage_objects set state = 'available' where id = ${objectId}`;
      const [available] = await sql<{ available_at: string | null }[]>`
        select available_at from storage_objects where id = ${objectId}`;
      expect(available?.available_at).toBeTruthy();
      await expect(sql`update storage_objects set state = 'failed' where id = ${objectId}`)
        .rejects.toThrow(/illegal storage object lifecycle/);

      const quarantineId = randomUUID();
      await sql`
        insert into storage_objects
          (id, owner_account_id, purpose, declared_mime, declared_size_bytes, declared_sha256,
           backing_store, backing_key)
        values (${quarantineId}, ${owner!.id}, 'chat', 'application/zip', 1, ${'e'.repeat(64)},
                'local', ${`objects/${quarantineId.slice(0, 2)}/${quarantineId}`})`;
      await sql`
        update storage_objects set state = 'quarantined', quarantine_reason = 'archive_rejected'
        where id = ${quarantineId}`;
      const [policyEvent] = await sql<{ id: string }[]>`
        insert into storage_policy_events
          (object_id, owner_account_id, event_type, policy_code, next_attempt_at)
        values (${quarantineId}, ${owner!.id}, 'quarantine_required', 'archive_rejected', now())
        returning id`;
      const claim = randomUUID();
      await sql`
        update storage_policy_events set state = 'delivering', attempt_count = 1,
          next_attempt_at = null, claim_token = ${claim}, claim_expires_at = now() + interval '1 minute'
        where id = ${policyEvent!.id}`;
      await sql`
        update storage_policy_events set state = 'delivered', claim_token = null,
          claim_expires_at = null, delivered_at = now()
        where id = ${policyEvent!.id}`;
      await expect(sql`delete from storage_objects where id = ${quarantineId}`)
        .rejects.toThrow(/storage_policy_events/);

      const connectionId = randomUUID();
      await sql`
        insert into channel_connections
          (id, account_id, channel, token_ciphertext, token_iv, token_auth_tag, token_sha256)
        values (${connectionId}, ${owner!.id}, 'telegram', 'cipher', 'iv', 'tag', 'hash')`;
      const intentId = randomUUID();
      await sql`
        insert into channel_onboarding_intents
          (id, account_id, intent_secret_hash, expires_at)
        values (${intentId}, ${owner!.id}, ${'1'.repeat(64)}, now() + interval '1 hour')`;
      await sql`
        update channel_onboarding_intents set state = 'awaiting_bot', provider_owner_id_hash = ${'2'.repeat(64)}
        where id = ${intentId}`;
      await sql`update channel_onboarding_intents set state = 'exchanging' where id = ${intentId}`;
      const wrongConnectionId = randomUUID();
      await sql`
        insert into channel_connections
          (id, account_id, channel, token_ciphertext, token_iv, token_auth_tag, token_sha256)
        values (${wrongConnectionId}, ${other!.id}, 'telegram', 'cipher', 'iv', 'tag', 'hash')`;
      await expect(sql`
        update channel_onboarding_intents set state = 'stored', connection_id = ${wrongConnectionId}
        where id = ${intentId}`)
        .rejects.toThrow(/owner\/channel mismatch/);
      await sql`
        update channel_onboarding_intents set state = 'stored', connection_id = ${connectionId}
        where id = ${intentId}`;
      await sql`delete from channel_connections where id = ${connectionId}`;
      const [intent] = await sql<{ state: string; connection_id: string | null }[]>`
        select state, connection_id from channel_onboarding_intents where id = ${intentId}`;
      expect(intent).toEqual({ state: 'stored', connection_id: null });
      await expect(sql`update channel_onboarding_intents set state = 'failed' where id = ${intentId}`)
        .rejects.toThrow(/terminal channel onboarding/);

      const [session] = await sql<{ id: string }[]>`
        insert into sessions (owner_id, title) values (${owner!.id}, 'Share proof') returning id`;
      const shareId = randomUUID();
      await sql`
        insert into session_share_links
          (id, session_id, created_by, token_hash, mode, title, snapshot_payload)
        values (${shareId}, ${session!.id}, ${owner!.id}, ${'3'.repeat(64)}, 'snapshot',
                'Proof', ${JSON.stringify({ session: { id: session!.id }, messages: [] })}::jsonb)`;
      await expect(sql`
        update session_share_links set snapshot_payload = ${JSON.stringify({ changed: true })}::jsonb
        where id = ${shareId}`)
        .rejects.toThrow(/identity and snapshot are immutable/);
      await sql`update session_share_links set revoked_at = now() where id = ${shareId}`;
      await expect(sql`update session_share_links set revoked_at = null where id = ${shareId}`)
        .rejects.toThrow(/revocation is immutable/);

      const [cascadeSession] = await sql<{ id: string }[]>`
        insert into sessions (owner_id, title) values (${owner!.id}, 'Cascade proof') returning id`;
      const cascadeShareId = randomUUID();
      await sql`
        insert into session_share_links
          (id, session_id, created_by, token_hash, mode, snapshot_payload)
        values (${cascadeShareId}, ${cascadeSession!.id}, ${owner!.id}, ${'4'.repeat(64)}, 'live', ${JSON.stringify({})}::jsonb)`;
      await sql`delete from sessions where id = ${cascadeSession!.id}`;
      const [cascadeCount] = await sql<{ count: number }[]>`
        select count(*)::int as count from session_share_links where id = ${cascadeShareId}`;
      expect(cascadeCount?.count).toBe(0);

      const cascadeObjectId = randomUUID();
      const cascadeUploadId = randomUUID();
      await sql`
        insert into storage_objects
          (id, owner_account_id, purpose, declared_mime, declared_size_bytes, declared_sha256,
           backing_store, backing_key)
        values (${cascadeObjectId}, ${owner!.id}, 'chat', 'text/plain', 1, ${'5'.repeat(64)},
                'local', ${`objects/${cascadeObjectId.slice(0, 2)}/${cascadeObjectId}`})`;
      await sql`
        insert into storage_uploads
          (id, object_id, owner_account_id, backend_multipart_id, part_size_bytes,
           expires_at, capability_expires_at)
        values (${cascadeUploadId}, ${cascadeObjectId}, ${owner!.id}, 'cascade', 1,
                now() + interval '1 hour', now() + interval '30 minutes')`;
      await sql`
        insert into storage_upload_part_authorizations
          (upload_id, part_number, checksum_sha256, size_bytes, expires_at)
        values (${cascadeUploadId}, 1, ${'6'.repeat(64)}, 1, now() + interval '10 minutes')`;
      await sql`delete from storage_objects where id = ${cascadeObjectId}`;
      const [uploadCascade] = await sql<{ count: number }[]>`
        select count(*)::int as count from storage_upload_part_authorizations
        where upload_id = ${cascadeUploadId}`;
      expect(uploadCascade?.count).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
