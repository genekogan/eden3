import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { turnProviderRuns } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0036_turn_provider_runs.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(
  new URL('../migrations/meta/0035_snapshot.json', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0036_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('turn provider runs migration (DEBT-004)', () => {
  it('is additive DDL only and introduces exactly the one-shot provider table', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const executable = migration
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(executable.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(executable).toContain('CREATE TABLE "turn_provider_runs"');
    expect(executable).toContain('CREATE OR REPLACE FUNCTION "turn_provider_run_guard"');
    expect(executable).toContain('CREATE TRIGGER "turn_provider_runs_guard"');
    expect(executable).not.toMatch(/\b(drop|truncate)\b/i);
    expect(executable).not.toMatch(/\binsert\s+into\b/i);
    expect(executable).not.toMatch(/\bdelete\s+from\b/i);
  });

  it('snapshot delta is exactly turn_provider_runs', async () => {
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const previousNames = new Set(Object.keys(previous.tables));
    const nextNames = new Set(Object.keys(next.tables));

    expect([...nextNames].filter((name) => !previousNames.has(name))).toEqual([
      'public.turn_provider_runs',
    ]);
    expect([...previousNames].filter((name) => !nextNames.has(name))).toEqual([]);
    for (const name of previousNames) expect(next.tables[name]).toEqual(previous.tables[name]);
  });

  it('journal stays contiguous and 0036 chains onto 0035', async () => {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries.forEach((entry, position) => expect(entry.idx).toBe(position));
    expect(journal.entries.find((entry) => entry.idx === 36)?.tag).toBe(
      '0036_turn_provider_runs',
    );
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as { id: string };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as { prevId: string };
    expect(next.prevId).toBe(previous.id);
  });

  it('stores only the exclusive start and one-way usable-output checkpoint', () => {
    const config = getTableConfig(turnProviderRuns);
    const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));

    expect(Object.keys(columns).sort()).toEqual(
      ['provider_started_at', 'turn_id', 'usable_output_at'].sort(),
    );
    expect(columns.turn_id?.primary).toBe(true);
    expect(columns.provider_started_at?.notNull).toBe(true);
    expect(columns.usable_output_at?.notNull).toBe(false);
    const foreign = config.foreignKeys[0]?.reference();
    expect(foreign?.columns.map((column) => column.name)).toEqual(['turn_id']);
    expect(foreign?.foreignColumns.map((column) => column.name)).toEqual(['turn_id']);
  });

  it('row-locks a reserved parent for both start and usable-output promotion', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    expect(migration.match(/FROM "turn_authorizations"/g)).toHaveLength(2);
    expect(migration.match(/FOR UPDATE/g)).toHaveLength(2);
    expect(migration.match(/parent_state IS DISTINCT FROM 'reserved'/g)).toHaveLength(2);
    expect(migration).toContain("TG_OP = 'INSERT'");
    expect(migration).toContain(
      'OLD."usable_output_at" IS NULL AND NEW."usable_output_at" IS NOT NULL',
    );
  });

  it('makes identity/start immutable and usable output monotonic NULL-to-one', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    expect(migration).toContain('NEW."turn_id" IS DISTINCT FROM OLD."turn_id"');
    expect(migration).toContain(
      'NEW."provider_started_at" IS DISTINCT FROM OLD."provider_started_at"',
    );
    expect(migration).toContain(
      'OLD."usable_output_at" IS NOT NULL\n     AND NEW."usable_output_at" IS DISTINCT FROM OLD."usable_output_at"',
    );
    expect(migration).toContain('ON DELETE cascade');
  });
});
