import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { storageUploads } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0037_storage_multipart_cleanup.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(
  new URL('../migrations/meta/0036_snapshot.json', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0037_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('durable multipart cleanup migration (DEBT-018)', () => {
  it('adds only cleanup metadata to storage_uploads and chains after 0036', async () => {
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
      if (name !== 'public.storage_uploads') expect(next.tables[name]).toEqual(previous.tables[name]);
    }

    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    journal.entries.forEach((entry, index) => expect(entry.idx).toBe(index));
    expect(journal.entries[37]).toMatchObject({ idx: 37, tag: '0037_storage_multipart_cleanup' });
  });

  it('exposes exact bounded cleanup state and due/claim indexes', () => {
    const config = getTableConfig(storageUploads);
    const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));
    expect(columns.cleanup_state?.notNull).toBe(true);
    expect(columns.cleanup_state?.enumValues).toEqual([
      'not_required',
      'pending',
      'claimed',
      'succeeded',
      'failed',
    ]);
    expect(columns.cleanup_attempt_count?.notNull).toBe(true);
    expect(columns.cleanup_claim_token).toBeDefined();
    expect(columns.cleanup_claim_expires_at).toBeDefined();
    expect(columns.cleanup_enqueued_at).toBeDefined();
    expect(columns.cleanup_succeeded_at).toBeDefined();
    expect(columns.cleanup_last_error_code).toBeDefined();
    expect(config.indexes.map((index) => index.config.name)).toEqual(expect.arrayContaining([
      'storage_uploads_cleanup_due_idx',
      'storage_uploads_cleanup_claim_expiry_idx',
    ]));
    expect(config.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      'storage_uploads_cleanup_state_check',
      'storage_uploads_cleanup_attempt_bounds_check',
      'storage_uploads_cleanup_error_code_check',
      'storage_uploads_cleanup_shape_check',
    ]));
  });

  it('backfills old terminal sessions and fences every cleanup transition', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const snapshot = await readFile(SNAPSHOT, 'utf8');
    expect(migration).toContain('WHERE "state" IN (\'aborted\', \'expired\')');
    expect(migration).toContain('NEW."cleanup_claim_expires_at" <= statement_timestamp()');
    expect(migration).toContain("OLD.\"cleanup_state\" = 'pending' AND NEW.\"cleanup_state\" = 'claimed'");
    expect(migration).toContain("OLD.\"cleanup_state\" = 'claimed' AND NEW.\"cleanup_state\" = 'succeeded'");
    expect(migration).toContain("OLD.\"cleanup_state\" = 'claimed' AND NEW.\"cleanup_state\" = 'pending'");
    expect(migration).toContain("OLD.\"cleanup_state\" = 'claimed' AND NEW.\"cleanup_state\" = 'failed'");
    expect(migration).toContain('NEW."cleanup_attempt_count" <> OLD."cleanup_attempt_count" + 1');
    expect(migration).toContain('multipart cleanup enqueue time is immutable');
    expect(migration).toContain(
      '"cleanup_succeeded_at" >= "storage_uploads"."cleanup_enqueued_at"',
    );
    expect(snapshot).toContain(
      '\\"cleanup_succeeded_at\\" >= \\"storage_uploads\\".\\"cleanup_enqueued_at\\"',
    );
  });

  it('stores no capability, credential, URL, or provider payload', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    expect(migration).not.toMatch(/cleanup_(?:token|secret|credential|url|payload)/i);
    expect(migration).not.toMatch(/bearer/i);
  });
});
