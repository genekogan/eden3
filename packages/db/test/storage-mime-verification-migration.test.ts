import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0038_octet_stream_verified_mime.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(new URL('../migrations/meta/0037_snapshot.json', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('../migrations/meta/0038_snapshot.json', import.meta.url));
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('generic declaration verified-MIME migration (DEBT-019)', () => {
  it('changes only the storage object lifecycle check and chains after 0037', async () => {
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

    const previousStorage = structuredClone(previous.tables['public.storage_objects']) as {
      checkConstraints: Record<string, { value: string }>;
    };
    const nextStorage = structuredClone(next.tables['public.storage_objects']) as {
      checkConstraints: Record<string, { value: string }>;
    };
    delete previousStorage.checkConstraints.storage_objects_lifecycle_shape_check;
    delete nextStorage.checkConstraints.storage_objects_lifecycle_shape_check;
    expect(nextStorage).toEqual(previousStorage);
    for (const name of Object.keys(previous.tables)) {
      if (name !== 'public.storage_objects') expect(next.tables[name]).toEqual(previous.tables[name]);
    }

    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 38,
      tag: '0038_octet_stream_verified_mime',
    });
  });

  it('pins the exact closed canonical exception without weakening ordinary declarations', async () => {
    const query = await readFile(SNAPSHOT, 'utf8');
    expect(query).toContain('application/octet-stream');
    expect(query).toContain("declared_mime\\\" <> 'application/octet-stream'");
    for (const mime of [
      'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
      'video/webm', 'video/mp4', 'audio/wav', 'audio/mpeg', 'application/json', 'text/plain',
    ]) expect(query).toContain(mime);
    expect(query).not.toMatch(/heic|heif|avif|zip/i);
  });

  it('fails before DROP when the installed named constraint drifted', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const guard = migration.indexOf('pg_get_expr(c.conbin, c.conrelid, true)');
    const comparison = migration.indexOf('actual_definition IS DISTINCT FROM expected_definition');
    const drop = migration.indexOf(
      'ALTER TABLE "storage_objects" DROP CONSTRAINT "storage_objects_lifecycle_shape_check"',
    );
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(comparison).toBeGreaterThan(guard);
    expect(drop).toBeGreaterThan(comparison);
    expect(migration).toContain('pg_my_temp_schema()');
    expect(migration).toContain('c.convalidated');
    expect(migration).toContain('c.connoinherit');
    expect(migration).toContain('storage_objects_lifecycle_shape_check drifted before 0038');
  });

  it('adds no column, table, token, URL, or payload storage', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    expect(migration).not.toMatch(/ADD COLUMN|CREATE TABLE "public"/i);
    expect(migration).not.toMatch(/bearer|credential|secret|signed_url|payload/i);
  });
});
