import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { storageUploadPartAuthorizations } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0032_storage_upload_part_authorizations.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(
  new URL('../migrations/meta/0031_snapshot.json', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0032_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('storage upload part authorizations migration (T21b-U01/U02)', () => {
  it('is additive DDL only and includes the two approved storage hardening tables', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const executable = migration
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(executable.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(executable).toContain('CREATE TABLE "storage_upload_part_authorizations"');
    expect(executable).toContain('CREATE TABLE "storage_policy_events"');
    expect(executable).toContain(
      'CREATE OR REPLACE FUNCTION "storage_upload_part_authorization_guard"',
    );
    expect(executable).toContain('CREATE TRIGGER "storage_upload_part_authorizations_guard"');
    expect(executable).not.toMatch(/\b(drop|truncate)\b/i);
    expect(executable).not.toMatch(/\binsert\s+into\b/i);
    expect(executable).not.toMatch(/\bdelete\s+from\b/i);
    expect(executable).not.toMatch(/\bupdate\s+"?[a-z_]+"?\s+set\b/i);
  });

  it('snapshot delta is exactly the two 0032 storage hardening tables', async () => {
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const previousNames = new Set(Object.keys(previous.tables));
    const nextNames = new Set(Object.keys(next.tables));

    expect([...nextNames].filter((name) => !previousNames.has(name)).sort()).toEqual(
      ['public.storage_policy_events', 'public.storage_upload_part_authorizations'].sort(),
    );
    expect([...previousNames].filter((name) => !nextNames.has(name))).toEqual([]);
    for (const name of previousNames) expect(next.tables[name]).toEqual(previous.tables[name]);
  });

  it('journal stays contiguous and 0032 chains onto 0031', async () => {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries.forEach((entry, position) => expect(entry.idx).toBe(position));
    expect(journal.entries.find((entry) => entry.idx === 32)?.tag).toBe(
      '0032_storage_upload_part_authorizations',
    );
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as { id: string };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as { prevId: string };
    expect(next.prevId).toBe(previous.id);
  });

  it('persists only immutable authorization claims, never a bearer token', () => {
    const config = getTableConfig(storageUploadPartAuthorizations);
    const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));

    expect(Object.keys(columns).sort()).toEqual(
      [
        'checksum_sha256',
        'created_at',
        'expires_at',
        'part_number',
        'size_bytes',
        'updated_at',
        'upload_id',
      ].sort(),
    );
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'upload_id',
      'part_number',
    ]);
    expect(columns.checksum_sha256?.notNull).toBe(true);
    expect(columns.expires_at?.notNull).toBe(true);
  });

  it('pins every scalar boundary and the cascading parent relation', () => {
    const config = getTableConfig(storageUploadPartAuthorizations);

    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'storage_upload_part_authorizations_number_check',
        'storage_upload_part_authorizations_checksum_check',
        'storage_upload_part_authorizations_size_check',
        'storage_upload_part_authorizations_expiry_check',
      ]),
    );
    const foreign = config.foreignKeys[0]?.reference();
    expect(foreign?.columns.map((column) => column.name)).toEqual(['upload_id']);
    expect(foreign?.foreignColumns.map((column) => column.name)).toEqual(['id']);
  });

  it('derives exact part count and byte geometry from the declared object', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    expect(migration).toContain("parent_state NOT IN ('initiated', 'uploading')");
    expect(migration).toContain('declared_size <= 0');
    expect(migration).toContain('(declared_size + parent_part_size - 1) / parent_part_size');
    expect(migration).toContain('NEW."part_number" > declared_part_count');
    expect(migration).toContain('NEW."size_bytes" IS DISTINCT FROM expected_part_size');
    expect(migration).toContain(
      'NEW."expires_at" > LEAST(parent_expires_at, parent_capability_expires_at)',
    );
  });

  it('allows same-checksum expiry refresh only forward while the parent is active', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    for (const column of ['upload_id', 'part_number', 'checksum_sha256', 'size_bytes']) {
      expect(migration).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
    expect(migration).toContain('NEW."expires_at" < OLD."expires_at"');
    expect(migration).toContain("TG_OP = 'UPDATE'");
    expect(migration).toContain('FOR UPDATE');
  });

  it('freezes terminal parents while preserving FK-cascade cleanup', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    expect(migration).toContain("parent_state IN ('completed', 'aborted', 'expired')");
    expect(migration).toContain("TG_OP = 'DELETE' AND pg_trigger_depth() > 1");
    expect(migration).toContain(
      'ON DELETE cascade',
    );
    expect(migration).toContain('BEFORE INSERT OR UPDATE OR DELETE');
  });

  it('fences concurrent different-checksum claims with one PK and immutable digest', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    expect(migration).toContain(
      'PRIMARY KEY("upload_id","part_number")',
    );
    expect(migration).toContain(
      'NEW."checksum_sha256" IS DISTINCT FROM OLD."checksum_sha256"',
    );
    const table = migration.slice(
      migration.indexOf('CREATE TABLE "storage_upload_part_authorizations"'),
      migration.indexOf(');'),
    );
    expect(table).not.toMatch(/"(?:token|bearer|capability)"/i);
  });
});
