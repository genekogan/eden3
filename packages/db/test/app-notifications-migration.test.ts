import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { agentProvisionJobs, appNotifications } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0034_app_notifications.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(
  new URL('../migrations/meta/0033_snapshot.json', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0034_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('app notifications and async provisioning migration', () => {
  it('is additive and changes exactly the two empty recovery tables', async () => {
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const previousNames = new Set(Object.keys(previous.tables));
    const nextNames = new Set(Object.keys(next.tables));
    expect([...nextNames].filter((name) => !previousNames.has(name)).sort()).toEqual([
      'public.agent_provision_jobs',
      'public.app_notifications',
    ]);
    expect([...previousNames].filter((name) => !nextNames.has(name))).toEqual([]);
    for (const name of previousNames) expect(next.tables[name]).toEqual(previous.tables[name]);

    const migration = await readFile(MIGRATION, 'utf8');
    expect(migration.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(migration).not.toMatch(/\b(drop|truncate)\b/i);
    expect(migration).not.toMatch(/\binsert\s+into\b/i);
    expect(migration).not.toMatch(/ALTER TABLE "(accounts|agents)"/i);
  });

  it('chains 0034 exactly onto 0033', async () => {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries.forEach((entry, position) => expect(entry.idx).toBe(position));
    expect(journal.entries.find((entry) => entry.idx === 34)?.tag).toBe(
      '0034_app_notifications',
    );
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as { id: string };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as { prevId: string };
    expect(next.prevId).toBe(previous.id);
  });

  it('stores only typed notification identity and one-way read/dismiss state', async () => {
    const config = getTableConfig(appNotifications);
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
    expect(config.columns.find((column) => column.name === 'kind')?.enumValues).toEqual([
      'agent_build_ready',
      'agent_build_failed',
      'scheduled_task_completed',
    ]);
    const migration = await readFile(MIGRATION, 'utf8');
    const start = migration.indexOf('CREATE TABLE "app_notifications"');
    const table = migration.slice(start, migration.indexOf(');', start));
    expect(table).not.toMatch(/"(?:payload|body|content|secret|token|url)"/i);
    expect(migration).toContain('notification source agent must belong to recipient');
    expect(migration).toContain('notification read state is irreversible');
    expect(migration).toContain('notification dismissal is irreversible');
  });

  it('keeps only durable claim state in the provisioning table', async () => {
    const config = getTableConfig(agentProvisionJobs);
    expect(config.columns.map((column) => column.name).sort()).toEqual(
      [
        'agent_account_id',
        'attempt_count',
        'claim_expires_at',
        'claim_token',
        'completed_at',
        'created_at',
        'last_error_code',
        'next_attempt_at',
        'state',
        'updated_at',
      ].sort(),
    );
    expect(config.columns.find((column) => column.name === 'state')?.enumValues).toEqual([
      'pending',
      'running',
      'succeeded',
      'failed',
    ]);
    const migration = await readFile(MIGRATION, 'utf8');
    const start = migration.indexOf('CREATE TABLE "agent_provision_jobs"');
    const table = migration.slice(start, migration.indexOf(');', start));
    expect(table).not.toMatch(/"(?:persona|greeting|voice|model|tool_groups|payload|secret)"/i);
    expect(migration).toContain('active provision claim cannot be replaced');
    expect(migration).toContain('terminal provision job is immutable');
  });
});
