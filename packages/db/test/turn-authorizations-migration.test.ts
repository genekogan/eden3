import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { turnAuthorizations } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0028_turn_authorizations.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(
  new URL('../migrations/meta/0027_snapshot.json', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0028_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('turn_authorizations migration (T08-U02, MVP gap 42, D-003)', () => {
  it('is additive DDL only: one new table, its FKs, its index — nothing else', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    const executable = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    // Every statement is CREATE TABLE / ALTER TABLE ADD CONSTRAINT / CREATE
    // INDEX aimed at the NEW table. No statement touches any existing table's
    // shape or data.
    const statements = executable
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThanOrEqual(3);
    for (const statement of statements) {
      expect(statement).toMatch(
        /^(CREATE TABLE "turn_authorizations"|ALTER TABLE "turn_authorizations" ADD CONSTRAINT|CREATE INDEX "turn_authorizations_state_created_idx" ON "turn_authorizations")/,
      );
      // Additive-only verbs; no destructive DDL/DML anywhere. FK referential
      // actions ("ON DELETE no action ON UPDATE no action") are constraint
      // modifiers, not statements — strip them before the scan.
      const withoutReferentialActions = statement.replace(
        /ON (?:DELETE|UPDATE) no action/gi,
        '',
      );
      expect(withoutReferentialActions).not.toMatch(/\b(drop|truncate|delete|update|insert)\b/i);
    }
    // Exactly one table create, one index, three FKs (accounts ×2 + ledger).
    expect(statements.filter((s) => s.startsWith('CREATE TABLE'))).toHaveLength(1);
    expect(statements.filter((s) => s.startsWith('CREATE INDEX'))).toHaveLength(1);
    expect(statements.filter((s) => s.includes('ADD CONSTRAINT'))).toHaveLength(3);
  });

  it('snapshot delta vs 0027 is exactly the one new table', async () => {
    const prev = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const prevNames = new Set(Object.keys(prev.tables));
    const nextNames = new Set(Object.keys(next.tables));
    const added = [...nextNames].filter((n) => !prevNames.has(n));
    const removed = [...prevNames].filter((n) => !nextNames.has(n));
    expect(added).toEqual(['public.turn_authorizations']);
    expect(removed).toEqual([]);
    // Every pre-existing table is byte-identical between snapshots.
    for (const name of prevNames) {
      expect(next.tables[name]).toEqual(prev.tables[name]);
    }
  });

  it('journal stays contiguous and 0028 chains onto 0027', async () => {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries.forEach((entry, position) => {
      expect(entry.idx).toBe(position);
    });
    const entry = journal.entries.find((e) => e.idx === 28);
    expect(entry?.tag).toBe('0028_turn_authorizations');
    const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      id: string;
      prevId: string;
    };
    const prevSnapshot = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as { id: string };
    expect(snapshot.prevId).toBe(prevSnapshot.id);
  });

  it('schema config exposes the state machine the kernel relies on', () => {
    const config = getTableConfig(turnAuthorizations);
    expect(config.name).toBe('turn_authorizations');
    const columns = Object.fromEntries(config.columns.map((c) => [c.name, c]));
    expect(columns['turn_id']!.primary).toBe(true);
    expect(columns['state']!.enumValues).toEqual(['reserved', 'settled', 'reversed', 'reaped']);
    expect(columns['authorized_max_manna']!.notNull).toBe(true);
    expect(columns['reserved_subscription_manna']!.notNull).toBe(true);
    expect(columns['reservation_tx_id']!.notNull).toBe(true);
    const index = config.indexes.find(
      (i) => i.config.name === 'turn_authorizations_state_created_idx',
    );
    expect(index).toBeDefined();
  });
});
