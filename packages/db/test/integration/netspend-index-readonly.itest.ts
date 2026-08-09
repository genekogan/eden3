import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { localSourceDatabaseName } from '../fixtures/disposable-database';

const MIGRATION_FILE = path.join(
  fileURLToPath(new URL('../../migrations', import.meta.url)),
  '0027_netspend_refunds_index.sql',
);
const INDEX_NAME = 'idx_manna_tx_refunds_tx';
const EXPECTED_INDEXDEF =
  'CREATE INDEX idx_manna_tx_refunds_tx ON public.manna_transactions USING btree (refunds_transaction_id) WHERE (refunds_transaction_id IS NOT NULL)';

function exactProtectedDatabaseUrl(): { databaseName: string; url: string } {
  const url = process.env.DATABASE_URL;
  if (!url || process.env.EDEN3_DB_READONLY_AUDIT !== '1') {
    throw new Error('protected catalog audit requires explicit authorization');
  }
  const databaseName = localSourceDatabaseName(url);
  if (databaseName !== 'eden3' && databaseName !== 'eden3_stg') {
    throw new Error('protected catalog audit requires an exact protected target');
  }
  return { databaseName, url };
}

describe('explicit protected-DB read-only index verification', () => {
  it('uses a read-only transaction and verifies the exact index and migration hash', async () => {
    const target = exactProtectedDatabaseUrl();
    const client = postgres(target.url, { max: 1, onnotice: () => {} });
    await client.unsafe('begin transaction read only');
    try {
      const [identity] = await client<{
        database: string;
        read_only: string;
      }[]>`
        select current_database() as database,
               current_setting('transaction_read_only') as read_only`;
      expect(identity).toEqual({ database: target.databaseName, read_only: 'on' });

      const rows = await client`
        select pg_get_indexdef(ix.indexrelid) as indexdef,
               ix.indisvalid as indisvalid
          from pg_index ix
          join pg_class i on i.oid = ix.indexrelid
          join pg_class t on t.oid = ix.indrelid
          join pg_namespace n on n.oid = t.relnamespace
         where i.relname = ${INDEX_NAME}
           and t.relname = 'manna_transactions'
           and n.nspname = 'public'`;
      expect(rows, `index missing on ${target.databaseName}`).toHaveLength(1);
      expect(rows[0]?.indexdef).toBe(EXPECTED_INDEXDEF);
      expect(rows[0]?.indisvalid).toBe(true);

      const hash = createHash('sha256').update(await readFile(MIGRATION_FILE, 'utf8')).digest('hex');
      const journal = await client`
        select 1 as one from drizzle.__drizzle_migrations where hash = ${hash}`;
      expect(journal, `migration 0027 not journaled on ${target.databaseName}`).toHaveLength(1);
    } finally {
      await client.unsafe('rollback').catch(() => {});
      await client.end();
    }
  });
});
