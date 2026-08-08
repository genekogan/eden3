import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { storageObjects, storageUploadParts, storageUploads } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0030_storage_object_service.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(
  new URL('../migrations/meta/0029_snapshot.json', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0030_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('storage object service migration (T20-U01 / T21b-U01)', () => {
  it('is additive DDL only and never mutates populated application data', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const executable = migration
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(executable).not.toMatch(/\b(drop|truncate)\b/i);
    expect(executable).not.toMatch(/\binsert\s+into\b/i);
    expect(executable).not.toMatch(/\bdelete\s+from\b/i);
    expect(executable).not.toMatch(/\bupdate\s+"?[a-z_]+"?\s+set\b/i);
    expect(executable.match(/CREATE TABLE/g)).toHaveLength(3);
    expect(executable).toContain('CREATE TABLE "storage_objects"');
    expect(executable).toContain('CREATE TABLE "storage_uploads"');
    expect(executable).toContain('CREATE TABLE "storage_upload_parts"');
    expect(executable).toContain('CREATE OR REPLACE FUNCTION "storage_object_transition_guard"');
    expect(executable).toContain('CREATE TRIGGER "storage_objects_transition_guard"');
  });

  it('snapshot delta is exactly the three storage tables', async () => {
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const previousNames = new Set(Object.keys(previous.tables));
    const nextNames = new Set(Object.keys(next.tables));

    expect([...nextNames].filter((name) => !previousNames.has(name)).sort()).toEqual([
      'public.storage_objects',
      'public.storage_upload_parts',
      'public.storage_uploads',
    ]);
    expect([...previousNames].filter((name) => !nextNames.has(name))).toEqual([]);
    for (const name of previousNames) {
      expect(next.tables[name]).toEqual(previous.tables[name]);
    }
  });

  it('journal stays contiguous and 0030 chains onto 0029', async () => {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries.forEach((entry, position) => expect(entry.idx).toBe(position));
    expect(journal.entries.find((entry) => entry.idx === 30)?.tag).toBe(
      '0030_storage_object_service',
    );

    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as { id: string };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      prevId: string;
    };
    expect(next.prevId).toBe(previous.id);
  });

  it('exposes immutable object identity and exact serving lifecycle constraints', () => {
    const config = getTableConfig(storageObjects);
    const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));

    expect(config.name).toBe('storage_objects');
    expect(columns.id?.primary).toBe(true);
    expect(columns.owner_account_id?.notNull).toBe(true);
    expect(columns.backing_key?.notNull).toBe(true);
    expect(columns.quarantine_reason).toBeDefined();
    expect(columns.available_at).toBeDefined();
    expect(columns.state?.enumValues).toEqual([
      'pending',
      'uploaded',
      'verified',
      'available',
      'quarantined',
      'failed',
    ]);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'storage_objects_state_check',
        'storage_objects_purpose_check',
        'storage_objects_backing_check',
        'storage_objects_key_check',
        'storage_objects_checksum_check',
        'storage_objects_lifecycle_shape_check',
        'storage_objects_quarantine_reason_check',
      ]),
    );
    expect(config.indexes.some((index) => index.config.name === 'storage_objects_id_owner_uq')).toBe(
      true,
    );
  });

  it('binds each expiring upload session to one tenant-owned object', () => {
    const config = getTableConfig(storageUploads);
    const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));

    expect(config.name).toBe('storage_uploads');
    expect(columns.id?.primary).toBe(true);
    expect(columns.object_id?.notNull).toBe(true);
    expect(columns.owner_account_id?.notNull).toBe(true);
    expect(columns.backend_multipart_id?.notNull).toBe(true);
    expect(columns.expires_at?.notNull).toBe(true);
    expect(columns.capability_expires_at?.notNull).toBe(true);
    expect(columns.state?.enumValues).toEqual([
      'initiated',
      'uploading',
      'completed',
      'aborted',
      'expired',
    ]);
    expect(
      config.foreignKeys.some(
        (key) =>
          key.reference().columns.map((column) => column.name).join(',') ===
            'object_id,owner_account_id' &&
          key.reference().foreignColumns.map((column) => column.name).join(',') ===
            'id,owner_account_id',
      ),
    ).toBe(true);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'storage_uploads_state_check',
        'storage_uploads_part_bounds_check',
        'storage_uploads_expiry_check',
      ]),
    );
  });

  it('makes multipart part identity unique and bounds every persisted part', () => {
    const config = getTableConfig(storageUploadParts);
    const primaryKey = config.primaryKeys[0]!;
    const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));

    expect(primaryKey.columns.map((column) => column.name)).toEqual(['upload_id', 'part_number']);
    expect(columns.backend_etag?.notNull).toBe(true);
    expect(columns.checksum_sha256?.notNull).toBe(true);
    expect(columns.size_bytes?.notNull).toBe(true);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'storage_upload_parts_number_check',
        'storage_upload_parts_size_check',
        'storage_upload_parts_checksum_check',
      ]),
    );
  });

  it('pins identity, declarations, backing locators, and exact lifecycle transitions', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    for (const column of [
      'id',
      'owner_account_id',
      'purpose',
      'declared_mime',
      'declared_size_bytes',
      'declared_sha256',
      'backing_store',
      'backing_key',
      'legacy_source_url',
    ]) {
      expect(migration).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
    expect(migration).not.toContain('NEW."display_name" IS DISTINCT FROM OLD."display_name"');
    expect(migration).toContain("OLD.\"state\" = 'pending' AND NEW.\"state\" = 'uploaded'");
    expect(migration).toContain("OLD.\"state\" = 'uploaded' AND NEW.\"state\" = 'verified'");
    expect(migration).toContain("OLD.\"state\" = 'verified' AND NEW.\"state\" = 'available'");
    expect(migration).toContain('NEW."available_at" := now()');
    expect(migration).toContain("OLD.\"state\" IN ('quarantined', 'failed')");
  });

  it('rejects cross-account upload bindings and freezes upload capability geometry', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    expect(migration).toContain(
      'FOREIGN KEY ("object_id","owner_account_id") REFERENCES "public"."storage_objects"("id","owner_account_id")',
    );
    expect(migration.indexOf('CREATE UNIQUE INDEX "storage_objects_id_owner_uq"')).toBeLessThan(
      migration.indexOf('ADD CONSTRAINT "storage_uploads_object_owner_fk"'),
    );
    for (const column of [
      'id',
      'object_id',
      'owner_account_id',
      'backend_multipart_id',
      'part_size_bytes',
      'capability_expires_at',
    ]) {
      expect(migration).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
    expect(migration).not.toMatch(/\b(token|bearer|capability_token)\b/i);
  });

  it('rejects every part mutation after its parent upload is terminal', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("parent_state IN ('completed', 'aborted', 'expired')");
    expect(migration).toContain('BEFORE INSERT OR UPDATE OR DELETE ON "storage_upload_parts"');
    expect(migration).toContain('NEW."upload_id" IS DISTINCT FROM OLD."upload_id"');
    expect(migration).toContain('NEW."part_number" IS DISTINCT FROM OLD."part_number"');
  });

  it('pins every numeric, digest, URL, expiry, and terminal-shape boundary in DDL', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    for (const constraint of [
      'storage_objects_state_check',
      'storage_objects_purpose_check',
      'storage_objects_backing_check',
      'storage_objects_key_check',
      'storage_objects_checksum_check',
      'storage_objects_metadata_check',
      'storage_objects_lifecycle_shape_check',
      'storage_objects_quarantine_reason_check',
      'storage_uploads_state_check',
      'storage_uploads_part_bounds_check',
      'storage_uploads_expiry_check',
      'storage_uploads_terminal_shape_check',
      'storage_uploads_backend_id_check',
      'storage_upload_parts_number_check',
      'storage_upload_parts_size_check',
      'storage_upload_parts_checksum_check',
      'storage_upload_parts_etag_check',
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}" CHECK`);
    }
    expect(migration).toContain('between 1 and 10000');
    expect(migration).toContain('<= 5368709120');
    expect(migration).toContain("~ '^[0-9a-f]{64}$'");
    expect(migration).toMatch(/"capability_expires_at" <= [^\n]*"expires_at"/);
  });
});
