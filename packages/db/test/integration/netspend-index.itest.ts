import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { loadRootEnv } from '../../src/env';
import {
  localDisposableDatabaseUrl,
  localSourceDatabaseName,
} from '../fixtures/disposable-database';

/**
 * T08-U01 integration proofs for the `idx_manna_tx_refunds_tx` migration
 * (RUNBOOK §12 "Missing ledger index" codification).
 *
 * Every case runs on a scratch database this file creates and drops itself;
 * every scratch connection is verified with current_database() before use.
 * Protected read-only verification has its own explicit config and file.
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
const scratchPattern = /^t08u01_mig_[a-f0-9]{8}$/;

function sourceDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set');
  localSourceDatabaseName(raw);
  return raw;
}

/**
 * Build a clean connection URL carrying ONLY user/password/host/port and the
 * given database as the pathname. Query parameters from DATABASE_URL are
 * deliberately dropped: postgres.js lets `?database=` override the pathname,
 * which would let a connection approved for a scratch name actually target a
 * protected shared DB.
 */
function urlForDb(dbName: string): string {
  return localDisposableDatabaseUrl(sourceDatabaseUrl(), dbName, scratchPattern);
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

/**
 * Guarded client factory: scratch DBs only — never the shared databases. The
 * connection's actual current_database() is asserted before it is handed out.
 */
async function scratchClient(dbName: string) {
  if (PROTECTED_DBS.has(dbName) || !scratchPattern.test(dbName)) {
    throw new Error(`refusing DDL connection to non-scratch database "${dbName}"`);
  }
  // max:1 so session-level statements (BEGIN/LOCK, SET lock_timeout) share the
  // exact connection that runs the migration statement under test.
  const client = postgres(urlForDb(dbName), { max: 1, onnotice: () => {} });
  const [row] = await client`select current_database() as db`;
  if (row?.db !== dbName) {
    await client.end();
    throw new Error(`connected to "${row?.db}", expected scratch "${dbName}"`);
  }
  return client;
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
  return client`
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
}

async function migrationSql(): Promise<string> {
  return readFile(MIGRATION_FILE, 'utf8');
}

function migrationHash(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function journalHasMigration(client: postgres.Sql): Promise<boolean> {
  const hash = migrationHash(await migrationSql());
  const rows = await client`
    select 1 as one from drizzle.__drizzle_migrations where hash = ${hash}`;
  return rows.length === 1;
}

/**
 * Build a temp migrations folder containing only migrations with idx < 27 —
 * the exact prod-box state before this tranche (0000–0026 applied, the index
 * created live outside the journal). Running the FULL folder afterwards
 * exercises 0027's guard plus every later migration fresh, which is what the
 * box will actually do. (Replaces U01's single-row journal rewind, which the
 * growing chain made unsound — the tail-fragility its own checkpoint #1
 * flagged; journaled test edit, T08-U02.)
 */
async function buildPreBoxMigrationsDir(): Promise<string> {
  const { mkdtemp, cp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const source = fileURLToPath(new URL('../../migrations', import.meta.url));
  const target = await mkdtemp(path.join(tmpdir(), 't08u02-premig-'));
  const journal = JSON.parse(await readFile(path.join(source, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = journal.entries.filter((e) => e.idx < 27);
  await cp(path.join(source, 'meta'), path.join(target, 'meta'), { recursive: true });
  await writeFile(
    path.join(target, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: kept }, null, 2),
  );
  for (const entry of kept) {
    await cp(path.join(source, `${entry.tag}.sql`), path.join(target, `${entry.tag}.sql`));
  }
  return target;
}

describe('scratch-DB migration paths (DDL confined to self-created, verified databases)', () => {
  it('fresh database: full drizzle chain creates the index; rerun and replay are no-ops', async () => {
    const name = await createScratchDb();
    const client = await scratchClient(name);
    try {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      let rows = await indexRow(client);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef).toBe(EXPECTED_INDEXDEF);
      expect(rows[0]?.indisvalid).toBe(true);
      const oid = rows[0]?.oid;
      expect(await journalHasMigration(client)).toBe(true);

      // Re-running the migrator is a journal-level no-op.
      const before = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      const after = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(after[0]?.n).toBe(before[0]?.n);

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

  it('box path through the real migrator: pre-existing correct index → journaled success, index untouched, no table lock', async () => {
    const name = await createScratchDb();
    const client = await scratchClient(name);
    const observer = await scratchClient(name);
    try {
      const db = drizzle(client);
      // Prod-box state: chain through 0026 applied, then the index created
      // live (CREATE INDEX CONCURRENTLY produces an identical relation).
      await migrate(db, { migrationsFolder: await buildPreBoxMigrationsDir() });
      await client.unsafe(
        'create index idx_manna_tx_refunds_tx on public.manna_transactions (refunds_transaction_id) where refunds_transaction_id is not null',
      );
      const before = await indexRow(client);
      expect(before).toHaveLength(1);
      expect(await journalHasMigration(client)).toBe(false);

      // The full folder now runs 0027 (guard no-op) + every later migration.
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      expect(await journalHasMigration(client)).toBe(true); // journaled success
      const after = await indexRow(client);
      expect(after[0]?.oid).toBe(before[0]?.oid); // untouched, not rebuilt

      // Lock proof: run the exists-path inside an open transaction and inspect
      // pg_locks from a second connection before commit — the migration
      // backend must hold NO lock of any mode on manna_transactions.
      const tableOid = (await client`select 'public.manna_transactions'::regclass::oid as oid`)[0]
        ?.oid;
      await client.begin(async (tx) => {
        const pid = (await tx`select pg_backend_pid() as pid`)[0]?.pid;
        await tx.unsafe(await migrationSql());
        const pidLocks = await observer`
          select l.relation::int as relation from pg_locks l where l.pid = ${pid}`;
        expect(pidLocks.length).toBeGreaterThan(0); // right backend, mid-transaction
        const tableLocks = pidLocks.filter((l) => l.relation === Number(tableOid));
        expect(tableLocks).toEqual([]);
      });

      // Same exists-path under a session with quote_all_identifiers=on — the
      // deparser pin keeps the definition comparison stable.
      await client.unsafe(`set quote_all_identifiers = on`);
      await client.unsafe(await migrationSql());
      await client.unsafe(`set quote_all_identifiers = off`);

      // And under a concurrent writer holding ROW EXCLUSIVE (the lock class
      // every INSERT/UPDATE takes), with a short lock_timeout: completes.
      await observer.unsafe('begin; lock table manna_transactions in row exclusive mode');
      try {
        await client.unsafe(`set lock_timeout = '1s'`);
        await client.unsafe(await migrationSql());
      } finally {
        await client.unsafe(`set lock_timeout = 0`).catch(() => {});
        await observer.unsafe('rollback').catch(() => {});
      }
    } finally {
      await observer.end().catch(() => {});
      await client.end();
    }
  });

  it('negative control: a plain CREATE INDEX IF NOT EXISTS would block behind a writer (why the DO guard exists)', async () => {
    const name = await createScratchDb();
    const client = await scratchClient(name);
    const writer = await scratchClient(name);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
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

  it('anomaly paths through the real migrator: wrong or invalid index → migration raises and is NOT journaled', async () => {
    const name = await createScratchDb();
    const client = await scratchClient(name);
    try {
      const db = drizzle(client);
      // Pre-box chain (through 0026), then a same-named WRONG index — the
      // full migrator must refuse at 0027 and journal nothing.
      await migrate(db, { migrationsFolder: await buildPreBoxMigrationsDir() });

      // Wrong definition: same name, missing partial predicate.
      await client.unsafe(
        'create index idx_manna_tx_refunds_tx on manna_transactions (refunds_transaction_id)',
      );
      await expect(migrate(db, { migrationsFolder: MIGRATIONS_DIR })).rejects.toThrow(
        /does not match the expected definition/,
      );
      expect(await journalHasMigration(client)).toBe(false); // failure not journaled

      // Invalid index: correct definition, indisvalid flipped (the state a
      // failed CONCURRENTLY build leaves behind).
      await client.unsafe(`drop index "${INDEX_NAME}"`);
      await client.unsafe(BOX_DDL);
      const oid = (await indexRow(client))[0]?.oid;
      await client`update pg_index set indisvalid = false where indexrelid = ${oid}`;
      await expect(migrate(db, { migrationsFolder: MIGRATIONS_DIR })).rejects.toThrow(
        /does not match the expected definition/,
      );
      expect(await journalHasMigration(client)).toBe(false);
    } finally {
      await client.end();
    }
  });
});
