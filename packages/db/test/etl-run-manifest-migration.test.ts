import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0025_dry_hercules.sql', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0025_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(
  new URL('../migrations/meta/_journal.json', import.meta.url),
);

describe('bounded ETL run manifest migration', () => {
  it('adds only the append-only ETL manifest table and its constraints', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    expect(sql).toContain('CREATE TABLE "etl_runs"');
    expect(sql).toContain('"source_database" text NOT NULL');
    expect(sql).toContain('"selected_collections" jsonb NOT NULL');
    expect(sql).toContain('"source_cutoffs" jsonb NOT NULL');
    expect(sql).toContain('"etl_runs_terminal_shape_check"');
    expect(sql).toContain('CREATE INDEX "etl_runs_latest_idx"');
    expect(sql).not.toMatch(/^\s*(?:alter|truncate|delete|update|drop)\b/im);
  });

  it('keeps snapshot and journal aligned at 0025', async () => {
    const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>;
    };
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(snapshot.tables['public.etl_runs']?.columns).toMatchObject({
      id: expect.any(Object),
      source_database: expect.any(Object),
      selected_collections: expect.any(Object),
      source_cutoffs: expect.any(Object),
      status: expect.any(Object),
      started_at: expect.any(Object),
      finished_at: expect.any(Object),
    });
    expect(snapshot.tables['public.etl_runs']?.indexes).toHaveProperty(
      'etl_runs_latest_idx',
    );
    expect(journal.entries.find((entry) => entry.idx === 25)).toMatchObject({
      idx: 25,
      tag: '0025_dry_hercules',
    });
  });
});
