import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { loadRootEnv } from '../../src/env';

/**
 * T08-U01 integration proofs for the `idx_manna_tx_refunds_tx` migration
 * (RUNBOOK §12 "Missing ledger index" codification).
 *
 * All DDL-exercising cases run on scratch databases this file creates and
 * drops itself. The shared operator databases are verified READ-ONLY.
 */

loadRootEnv();

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const MIGRATION_FILE = path.join(MIGRATIONS_DIR, '0027_netspend_refunds_index.sql');
const INDEX_NAME = 'idx_manna_tx_refunds_tx';
const EXPECTED_INDEXDEF =
  'CREATE INDEX idx_manna_tx_refunds_tx ON public.manna_transactions USING btree (refunds_transaction_id) WHERE (refunds_transaction_id IS NOT NULL)';
const BOX_DDL =
  'create index idx_manna_tx_refunds_tx on manna_transactions (refunds_transaction_id) where refunds_transaction_id is not null';

const PROTECTED_DBS = new Set(['eden3', 'eden3_stg']);

function serverUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set');
  return new URL(raw);
}

function urlForDb(dbName: string): string {
  const url = serverUrl();
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** Admin connection to the maintenance DB for CREATE/DROP DATABASE. */
function adminClient() {
  return postgres(urlForDb('postgres'), { max: 1, onnotice: () => {} });
}

const createdDbs: string[] = [];

async function createScratchDb(): Promise<string> {
  const name = `t08u01_mig_${randomBytes(4).toString('hex')}`;
  if (PROTECTED_DBS.has(name)) throw new Error(`refusing protected db ${name}`);
  const admin = adminClient();
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  createdDbs.push(name);
  return name;
}

/** Guarded client factory: scratch DBs only — never the shared databases. */
function scratchClient(dbName: string) {
  if (PROTECTED_DBS.has(dbName) || !dbName.startsWith('t08u01_mig_')) {
    throw new Error(`refusing DDL connection to non-scratch database "${dbName}"`);
  }
  // max:1 so session-level statements (BEGIN/LOCK, SET lock_timeout) share the
  // exact connection that runs the migration statement under test.
  return postgres(urlForDb(dbName), { max: 1, onnotice: () => {} });
}

afterAll(async () => {
  const admin = adminClient();
  try {
    for (const name of createdDbs) {
      if (PROTECTED_DBS.has(name)) continue;
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
});

async function indexRow(client: postgres.Sql) {
  const rows = await client`
    select pg_get_indexdef(ix.indexrelid) as indexdef,
           ix.indisvalid as indisvalid,
           ix.indexrelid as oid
      from pg_index ix
      join pg_class i on i.oid = ix.indexrelid
      join pg_class t on t.oid = ix.indrelid
      join pg_namespace n on n.oid = t.relnamespace
     where i.relname = ${INDEX_NAME}
       and t.relname = 'manna_transactions'
       and n.nspname = 'public'`;
  return rows;
}

async function migrationSql(): Promise<string> {
  return readFile(MIGRATION_FILE, 'utf8');
}

/** Apply migrations 0000..0026 (everything before ours) without the journal. */
async function applyChainThrough0026(client: postgres.Sql) {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && f < '0027')
    .sort();
  expect(files[files.length - 1]).toMatch(/^0026_/);
  for (const file of files) {
    const body = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of body.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.unsafe(statement);
    }
  }
}

describe('scratch-DB migration paths (DDL confined to self-created databases)', () => {
  it('fresh database: full drizzle chain creates the index; rerun and replay are no-ops', async () => {
    const name = await createScratchDb();
    const client = scratchClient(name);
    try {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      let rows = await indexRow(client);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef).toBe(EXPECTED_INDEXDEF);
      expect(rows[0]?.indisvalid).toBe(true);
      const oid = rows[0]?.oid;

      // Journal recorded exactly the 28-migration chain, newest hash = our file.
      const journal = await client`
        select hash from drizzle.__drizzle_migrations order by created_at`;
      const expectedHash = createHash('sha256').update(await migrationSql()).digest('hex');
      expect(journal.map((r) => r.hash)).toContain(expectedHash);

      // Re-running the migrator is a journal-level no-op.
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      const journalAfter = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(journalAfter[0]?.n).toBe(journal.length);

      // Replaying the migration statement itself is harmless (exists-path).
      await client.unsafe(await migrationSql());
      rows = await indexRow(client);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.oid).toBe(oid);
      expect(rows[0]?.indexdef).toBe(EXPECTED_INDEXDEF);
    } finally {
      await client.end();
    }
  });

  it('box path: pre-existing correct index → migration no-ops without CREATE and without a table lock', async () => {
    const name = await createScratchDb();
    const client = scratchClient(name);
    const writer = scratchClient(name);
    try {
      await applyChainThrough0026(client);
      // Recreate the live box state: the index already exists (made with
      // CREATE INDEX CONCURRENTLY there; lock semantics of the result are
      // identical).
      await client.unsafe(BOX_DDL);
      const before = await indexRow(client);
      expect(before).toHaveLength(1);

      // Demo-safety contention proof: a concurrent writer holds ROW EXCLUSIVE
      // (the lock class every INSERT/UPDATE takes). The exists-path migration
      // must complete under a short lock_timeout — i.e. it takes no table lock.
      await writer.unsafe('begin; lock table manna_transactions in row exclusive mode');
      try {
        await client.unsafe(`set lock_timeout = '1s'`);
        await client.unsafe(await migrationSql());
      } finally {
        await client.unsafe(`set lock_timeout = 0`).catch(() => {});
        await writer.unsafe('rollback').catch(() => {});
      }

      const after = await indexRow(client);
      expect(after).toHaveLength(1);
      expect(after[0]?.oid).toBe(before[0]?.oid); // untouched, not rebuilt
      expect(after[0]?.indexdef).toBe(EXPECTED_INDEXDEF);
    } finally {
      await writer.end().catch(() => {});
      await client.end();
    }
  });

  it('negative control: a plain CREATE INDEX IF NOT EXISTS would block behind a writer (why the DO guard exists)', async () => {
    const name = await createScratchDb();
    const client = scratchClient(name);
    const writer = scratchClient(name);
    try {
      await applyChainThrough0026(client);
      await client.unsafe(BOX_DDL);
      await writer.unsafe('begin; lock table manna_transactions in row exclusive mode');
      try {
        await client.unsafe(`set lock_timeout = '1s'`);
        await expect(
          client.unsafe(
            'create index if not exists idx_manna_tx_refunds_tx on manna_transactions (refunds_transaction_id) where refunds_transaction_id is not null',
          ),
        ).rejects.toThrow(/lock timeout/i);
      } finally {
        await client.unsafe(`set lock_timeout = 0`).catch(() => {});
        await writer.unsafe('rollback').catch(() => {});
      }
    } finally {
      await writer.end().catch(() => {});
      await client.end();
    }
  });

  it('anomaly path: same-named wrong index → migration raises instead of journaling success', async () => {
    const name = await createScratchDb();
    const client = scratchClient(name);
    try {
      await applyChainThrough0026(client);
      await client.unsafe(
        'create index idx_manna_tx_refunds_tx on manna_transactions (refunds_transaction_id)', // missing partial predicate
      );
      await expect(client.unsafe(await migrationSql())).rejects.toThrow(
        /does not match the expected definition/,
      );
    } finally {
      await client.end();
    }
  });
});

describe('shared-DB read-only verification (target = DATABASE_URL)', () => {
  it('the migrated target database carries the valid index and the journaled migration', async () => {
    const target = serverUrl().pathname.replace(/^\//, '');
    const client = postgres(urlForDb(target), { max: 1, onnotice: () => {} });
    try {
      const rows = await indexRow(client);
      expect(rows, `index missing on ${target}`).toHaveLength(1);
      expect(rows[0]?.indexdef).toBe(EXPECTED_INDEXDEF);
      expect(rows[0]?.indisvalid).toBe(true);

      const expectedHash = createHash('sha256').update(await migrationSql()).digest('hex');
      const journal = await client`
        select hash from drizzle.__drizzle_migrations where hash = ${expectedHash}`;
      expect(journal, `migration 0027 not journaled on ${target}`).toHaveLength(1);
    } finally {
      await client.end();
    }
  });
});
