import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { mannaTransactions } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0027_netspend_refunds_index.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(
  new URL('../migrations/meta/0026_snapshot.json', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0027_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(
  new URL('../migrations/meta/_journal.json', import.meta.url),
);

export const INDEX_NAME = 'idx_manna_tx_refunds_tx';

describe('netspend refunds-correlation index migration (T08-U01, RUNBOOK §12)', () => {
  it('is a single catalog-guarded DO statement creating exactly the live-box index', async () => {
    const sql = await readFile(MIGRATION, 'utf8');

    // One statement only — no breakpoints, and (comments stripped) exactly one
    // mutating statement anywhere in the file: the guarded CREATE INDEX inside
    // the DO body. Nothing outside the block, nothing extra inside it.
    expect(sql).not.toContain('--> statement-breakpoint');
    const executableSql = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    // Outside SQL string literals no mutating verb may appear at all (the only
    // DDL is the EXECUTE'd literal); and every literal that does contain a
    // mutating verb may speak only of our index, only via CREATE.
    const literals = executableSql.match(/'(?:[^']|'')*'/g) ?? [];
    const outsideLiterals = executableSql.replace(/'(?:[^']|'')*'/g, "''");
    expect(outsideLiterals).not.toMatch(/\b(create|alter|drop|truncate|delete|update|insert)\b/i);
    const mutatingLiterals = literals.filter((literal) =>
      /\b(create|alter|drop|truncate|delete|update|insert)\b/i.test(literal),
    );
    expect(mutatingLiterals.length).toBeGreaterThan(0);
    for (const literal of mutatingLiterals) {
      expect(literal).toMatch(/create index/i);
      expect(literal).toContain('idx_manna_tx_refunds_tx');
      expect(literal).not.toMatch(/\b(alter|drop|truncate|delete|update|insert)\b/i);
    }
    // Exactly one of them is executed.
    expect(executableSql.match(/EXECUTE '/g)).toHaveLength(1);

    // The guarded create matches the live-box definition verbatim (name, column,
    // btree, partial predicate) — schema-qualified so search_path can never aim
    // it at a shadow table while the guard inspects public.
    expect(sql).toContain(
      'CREATE INDEX "idx_manna_tx_refunds_tx" ON public."manna_transactions" USING btree ("refunds_transaction_id") WHERE "refunds_transaction_id" IS NOT NULL',
    );

    // The exists-and-correct path returns without executing CREATE (no table
    // lock), and the wrong/invalid path fails loudly instead of journaling.
    expect(sql).toMatch(/pg_index/);
    expect(sql).toMatch(/indisvalid/);
    expect(sql).toMatch(/RAISE EXCEPTION/);

    // Drizzle runs migrations transactionally; a concurrent build here would be
    // broken. The concurrent path lives outside the migration (ops runbook).
    // Comments are stripped first — the file may (should) explain this rule.
    expect(executableSql).not.toMatch(/concurrently/i);
  });

  it('changes the snapshot by exactly one index and is journaled as idx 27', async () => {
    const prev = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as Record<string, unknown>;
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Record<string, unknown>;

    type Tables = Record<string, { indexes: Record<string, unknown> }>;
    const nextTables = structuredClone(next.tables) as Tables;
    const added = nextTables['public.manna_transactions']?.indexes?.[INDEX_NAME] as
      | { columns: Array<{ expression: string }>; where?: string; isUnique: boolean }
      | undefined;

    expect(added).toBeDefined();
    expect(added?.isUnique).toBe(false);
    expect(added?.columns?.map((c) => c.expression)).toEqual(['refunds_transaction_id']);
    expect(added?.where).toMatch(/refunds_transaction_id.* is not null/i);

    // Remove the one expected addition; everything else must be identical to
    // 0026 (no generator drift riding along).
    delete nextTables['public.manna_transactions']?.indexes[INDEX_NAME];
    expect(nextTables).toEqual(prev.tables);
    for (const key of Object.keys(next)) {
      if (key === 'tables' || key === 'id' || key === 'prevId') continue;
      expect(next[key], `snapshot key ${key}`).toEqual(prev[key]);
    }

    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    // Located by idx on purpose — never by tail position (future migrations
    // must not break this test).
    expect(journal.entries.find((entry) => entry.idx === 27)).toMatchObject({
      idx: 27,
      tag: '0027_netspend_refunds_index',
    });
    // Ordering coverage (replaces the tail assertion this unit re-anchored):
    // journal indices are unique, contiguous, and ascending from 0, and the
    // snapshot chain links 0026 -> 0027.
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, position) => position),
    );
    expect(next.prevId).toBe(prev.id);
  });

  it('is declared in the drizzle schema with the verbatim live-box name', () => {
    const config = getTableConfig(mannaTransactions);
    const index = config.indexes.find((idx) => idx.config.name === INDEX_NAME);
    expect(index).toBeDefined();
    expect(index?.config.unique).toBeFalsy();
    const columns = index?.config.columns.map((column) =>
      'name' in column ? (column as { name: string }).name : String(column),
    );
    expect(columns).toEqual(['refunds_transaction_id']);
    const where = index?.config.where;
    expect(where).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(where!);
    expect(rendered.sql).toContain('refunds_transaction_id');
    expect(rendered.sql).toMatch(/is not null/i);
  });
});
