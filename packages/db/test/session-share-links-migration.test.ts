import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { sessionShareLinks } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0033_session_share_links.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(
  new URL('../migrations/meta/0032_snapshot.json', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0033_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('session share links migration', () => {
  it('is additive DDL only and never changes sessions visibility', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const executable = migration
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(executable.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(executable).toContain('CREATE TABLE "session_share_links"');
    expect(executable).toContain('CREATE OR REPLACE FUNCTION "session_share_link_guard"');
    expect(executable).toContain('CREATE TRIGGER "session_share_links_guard"');
    expect(executable).not.toMatch(/ALTER TABLE "sessions"/i);
    expect(executable).not.toMatch(/\b(drop|truncate)\b/i);
    expect(executable).not.toMatch(/\binsert\s+into\b/i);
    expect(executable).not.toMatch(/\bdelete\s+from\b/i);
    expect(executable).not.toMatch(/\bupdate\s+"?[a-z_]+"?\s+set\b/i);
  });

  it('snapshot delta is exactly session_share_links', async () => {
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const previousNames = new Set(Object.keys(previous.tables));
    const nextNames = new Set(Object.keys(next.tables));

    expect([...nextNames].filter((name) => !previousNames.has(name))).toEqual([
      'public.session_share_links',
    ]);
    expect([...previousNames].filter((name) => !nextNames.has(name))).toEqual([]);
    for (const name of previousNames) expect(next.tables[name]).toEqual(previous.tables[name]);
  });

  it('journal stays contiguous and 0033 chains onto 0032', async () => {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries.forEach((entry, position) => expect(entry.idx).toBe(position));
    expect(journal.entries.find((entry) => entry.idx === 33)?.tag).toBe(
      '0033_session_share_links',
    );
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as { id: string };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as { prevId: string };
    expect(next.prevId).toBe(previous.id);
  });

  it('exposes exactly the opaque share and immutable snapshot fields', () => {
    const config = getTableConfig(sessionShareLinks);
    const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));

    expect(Object.keys(columns).sort()).toEqual(
      [
        'created_at',
        'created_by',
        'id',
        'mode',
        'revoked_at',
        'session_id',
        'snapshot_boundary_message_id',
        'snapshot_payload',
        'title',
        'token_hash',
        'updated_at',
      ].sort(),
    );
    expect(columns.id?.primary).toBe(true);
    expect(columns.token_hash?.notNull).toBe(true);
    expect(columns.snapshot_payload?.notNull).toBe(true);
    expect(columns.mode?.enumValues).toEqual(['snapshot', 'live']);
  });

  it('pins hash, mode, title, payload-object, and revocation-time checks', () => {
    const config = getTableConfig(sessionShareLinks);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'session_share_links_token_hash_check',
        'session_share_links_mode_check',
        'session_share_links_title_check',
        'session_share_links_snapshot_payload_check',
        'session_share_links_revoked_at_check',
      ]),
    );
  });

  it('uses opaque-hash lookup and session history indexes', () => {
    const config = getTableConfig(sessionShareLinks);
    const token = config.indexes.find((index) => index.config.name === 'session_share_links_token_uq');
    const history = config.indexes.find(
      (index) => index.config.name === 'session_share_links_session_created_idx',
    );

    expect(token?.config.unique).toBe(true);
    expect(history).toBeDefined();
  });

  it('keeps snapshot identity immutable and title editable only while active', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    for (const column of [
      'id',
      'session_id',
      'created_by',
      'token_hash',
      'mode',
      'snapshot_boundary_message_id',
      'snapshot_payload',
      'created_at',
    ]) {
      expect(migration).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
    expect(migration).toContain('NEW."title" IS DISTINCT FROM OLD."title"');
    expect(migration).toContain('NEW."revoked_at" IS NOT NULL');
  });

  it('makes revocation one-way and terminal except for updated_at', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    expect(migration).toContain(
      'OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"',
    );
    expect(migration).toContain("IF NEW.\"revoked_at\" IS NOT NULL THEN");
    expect(migration).toContain('BEFORE INSERT OR UPDATE ON "session_share_links"');
    expect(migration).toContain("RAISE EXCEPTION 'revoked session share link is terminal'");
    expect(migration).not.toContain('NEW."updated_at" IS DISTINCT FROM OLD."updated_at"');
  });

  it('stores no raw token, sequential public id, or feed/directory marker', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const start = migration.indexOf('CREATE TABLE "session_share_links"');
    const table = migration.slice(start, migration.indexOf(');', start));

    expect(table).not.toMatch(/"(?:token|public_id|slug|is_public|feed|directory)"/i);
    expect(table).toContain('"token_hash"');
    expect(migration).not.toContain('sessions_is_public');
  });
});
