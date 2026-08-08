import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { channelConnections, channelExternalIdentities } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0035_channel_token_preview_cleanup.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(
  new URL('../migrations/meta/0034_snapshot.json', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0035_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));
const API_SOURCE = fileURLToPath(new URL('../../../apps/api/src/', import.meta.url));

interface SnapshotTable {
  columns: Record<string, unknown>;
  [key: string]: unknown;
}

interface Snapshot {
  id: string;
  prevId: string;
  tables: Record<string, SnapshotTable>;
}

describe('channel token preview cleanup migration (DEBT-014)', () => {
  it('scrubs every legacy preview before dropping the column', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const scrub = migration.indexOf(
      'UPDATE "channel_connections"\nSET "token_preview" = NULL\nWHERE "token_preview" IS NOT NULL;',
    );
    const drop = migration.indexOf(
      'ALTER TABLE "channel_connections" DROP COLUMN "token_preview";',
    );

    expect(scrub).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(scrub);
    expect(migration.match(/UPDATE "channel_connections"/g)).toHaveLength(1);
    expect(migration.match(/DROP COLUMN "token_preview"/g)).toHaveLength(1);
    expect(migration).not.toMatch(/\b(?:delete|truncate)\b/i);
  });

  it('changes only channel_connections.token_preview and preserves peer_preview', async () => {
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as Snapshot;
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Snapshot;

    expect(Object.keys(next.tables).sort()).toEqual(Object.keys(previous.tables).sort());
    const expectedConnections = structuredClone(previous.tables['public.channel_connections']);
    expect(expectedConnections).toBeDefined();
    delete expectedConnections!.columns.token_preview;
    expect(next.tables['public.channel_connections']).toEqual(expectedConnections);

    for (const [name, table] of Object.entries(previous.tables)) {
      if (name !== 'public.channel_connections') expect(next.tables[name]).toEqual(table);
    }
    expect(next.tables['public.channel_external_identities']?.columns).toHaveProperty(
      'peer_preview',
    );
  });

  it('chains 0035 exactly onto the notification migration 0034', async () => {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries.forEach((entry, position) => expect(entry.idx).toBe(position));
    expect(journal.entries.find((entry) => entry.idx === 35)?.tag).toBe(
      '0035_channel_token_preview_cleanup',
    );
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as Snapshot;
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Snapshot;
    expect(next.prevId).toBe(previous.id);
  });

  it('removes the credential preview from schema and all production SQL', async () => {
    expect(getTableConfig(channelConnections).columns.map((column) => column.name)).not.toContain(
      'token_preview',
    );
    expect(getTableConfig(channelExternalIdentities).columns.map((column) => column.name)).toContain(
      'peer_preview',
    );

    const entries = await readdir(API_SOURCE, { recursive: true, withFileTypes: true });
    const sourceFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));
    const matches: string[] = [];
    for (const entry of sourceFiles) {
      const path = `${entry.parentPath}/${entry.name}`;
      if ((await readFile(path, 'utf8')).includes('token_preview')) matches.push(path);
    }
    expect(matches).toEqual([]);
  });
});
