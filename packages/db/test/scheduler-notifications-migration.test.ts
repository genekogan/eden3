import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { appNotifications } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0039_scheduler_notifications.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(new URL('../migrations/meta/0038_snapshot.json', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('../migrations/meta/0039_snapshot.json', import.meta.url));
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('scheduled completion notification migration', () => {
  it('chains 0039 exactly onto 0038 and changes only app_notifications policy', async () => {
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as {
      id: string;
      tables: Record<string, unknown>;
    };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      prevId: string;
      tables: Record<string, unknown>;
    };
    expect(next.prevId).toBe(previous.id);
    expect(Object.keys(next.tables)).toEqual(Object.keys(previous.tables));
    for (const name of Object.keys(previous.tables)) {
      if (name !== 'public.app_notifications') expect(next.tables[name]).toEqual(previous.tables[name]);
    }

    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    journal.entries.forEach((entry, position) => expect(entry.idx).toBe(position));
    expect(journal.entries[39]).toMatchObject({
      idx: 39,
      tag: '0039_scheduler_notifications',
    });
  });

  it('adds only the retained kind/path/index policy and no payload surface', async () => {
    const config = getTableConfig(appNotifications);
    expect(config.columns.find((column) => column.name === 'kind')?.enumValues).toEqual([
      'agent_build_ready',
      'agent_build_failed',
      'scheduled_task_completed',
    ]);
    expect(config.columns.map((column) => column.name).sort()).toEqual(
      [
        'account_id',
        'created_at',
        'dismissed_at',
        'id',
        'kind',
        'read_at',
        'source_agent_id',
        'target_path',
      ].sort(),
    );

    const migration = await readFile(MIGRATION, 'utf8');
    expect(migration).toContain("'scheduled_task_completed'");
    expect(migration).toContain('sessions/[0-9a-f]{8}-[0-9a-f]{4}');
    expect(migration).toContain("WHERE \"app_notifications\".\"kind\" in ('agent_build_ready', 'agent_build_failed')");
    expect(migration).not.toMatch(/CREATE TABLE\s+"|ADD COLUMN|DROP TABLE\s+"|TRUNCATE|INSERT INTO/i);
    expect(migration).not.toMatch(/payload|body|content|secret|token|external_url/i);
  });

  it('fails closed on pre-0039 constraint or index drift before any DROP', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const catalogGuard = migration.indexOf('pg_get_indexdef(i.indexrelid)');
    const driftRefusal = migration.indexOf('app_notifications policy drifted before 0039');
    const firstDrop = migration.indexOf('ALTER TABLE "app_notifications" DROP CONSTRAINT');
    expect(catalogGuard).toBeGreaterThanOrEqual(0);
    expect(driftRefusal).toBeGreaterThan(catalogGuard);
    expect(firstDrop).toBeGreaterThan(driftRefusal);
    expect(migration).toContain('pg_my_temp_schema()');
    expect(migration).toContain('i.indisvalid');
    expect(migration).toContain('i.indisready');
    expect(migration).toContain('i.indisunique');
  });
});
