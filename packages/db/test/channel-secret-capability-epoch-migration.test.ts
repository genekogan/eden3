import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { channelConnections } from '../src/schema';

const MIGRATION = fileURLToPath(new URL(
  '../migrations/0042_channel_secret_capability_epoch.sql', import.meta.url,
));
const PREVIOUS = fileURLToPath(new URL('../migrations/meta/0041_snapshot.json', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('../migrations/meta/0042_snapshot.json', import.meta.url));
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('0042 channel SecretRef capability epoch', () => {
  it('is the exact additive journal successor with one dedicated bounded epoch column', async () => {
    const previous = JSON.parse(await readFile(PREVIOUS, 'utf8')) as {
      id: string;
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      prevId: string;
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    expect(next.prevId).toBe(previous.id);
    expect(new Set(Object.keys(next.tables))).toEqual(new Set(Object.keys(previous.tables)));
    const oldColumns = previous.tables['public.channel_connections']!.columns;
    const newColumns = next.tables['public.channel_connections']!.columns;
    expect(Object.keys(newColumns).filter((name) => !(name in oldColumns))).toEqual([
      'capability_epoch',
    ]);
    expect(
      getTableConfig(channelConnections).columns.find((column) => column.name === 'capability_epoch'),
    ).toMatchObject({ notNull: true, default: 1 });
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: Array<{ idx: number; version: string; tag: string; breakpoints: boolean }>;
    };
    expect(journal.entries.find((entry) => entry.idx === 42)).toEqual({
      idx: 42,
      version: '7',
      when: expect.any(Number),
      tag: '0042_channel_secret_capability_epoch',
      breakpoints: true,
    });
  });

  it('pins monotonic credential-generation semantics outside mutable metadata', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    expect(sql).toContain('ADD COLUMN "capability_epoch" integer DEFAULT 1 NOT NULL');
    expect(sql).toContain('CHECK ("capability_epoch" BETWEEN 1 AND 999999)');
    expect(sql).toContain('channel_secret_capability_epoch_guard');
    for (const column of [
      'token_ciphertext',
      'token_iv',
      'token_auth_tag',
      'token_sha256',
      'key_version',
    ]) {
      expect(sql).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    expect(sql).toContain('NEW.capability_epoch<>OLD.capability_epoch+1');
    expect(sql).toContain('credential rotation must advance capability epoch exactly once');
    expect(sql).toContain('NEW.capability_epoch<>OLD.capability_epoch');
    expect(sql).toContain('capability epoch cannot change without credential rotation');
    expect(sql).toContain('capability epoch exhausted');
    expect(sql).not.toMatch(/metadata[^\n]*capability_epoch|capability_epoch[^\n]*metadata/i);
    expect(sql).not.toMatch(/token_sha256[^\n]*::.*capability_epoch|capability_epoch[^\n]*token_sha256/i);
  });
});
