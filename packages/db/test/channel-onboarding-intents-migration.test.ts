import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { channelOnboardingIntents } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0031_channel_onboarding_intents.sql', import.meta.url),
);
const SNAPSHOT_PREV = fileURLToPath(
  new URL('../migrations/meta/0030_snapshot.json', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0031_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('channel onboarding intents migration (T10-U04)', () => {
  it('is additive DDL only and introduces exactly one table', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const executable = migration
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(executable.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(executable).toContain('CREATE TABLE "channel_onboarding_intents"');
    expect(executable).toContain(
      'CREATE OR REPLACE FUNCTION "channel_onboarding_intent_guard"',
    );
    expect(executable).toContain('CREATE TRIGGER "channel_onboarding_intents_guard"');
    expect(executable).not.toMatch(/\b(drop|truncate)\b/i);
    expect(executable).not.toMatch(/\binsert\s+into\b/i);
    expect(executable).not.toMatch(/\bdelete\s+from\b/i);
    expect(executable).not.toMatch(/\bupdate\s+"?[a-z_]+"?\s+set\b/i);
  });

  it('snapshot delta is exactly channel_onboarding_intents', async () => {
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const previousNames = new Set(Object.keys(previous.tables));
    const nextNames = new Set(Object.keys(next.tables));

    expect([...nextNames].filter((name) => !previousNames.has(name))).toEqual([
      'public.channel_onboarding_intents',
    ]);
    expect([...previousNames].filter((name) => !nextNames.has(name))).toEqual([]);
    for (const name of previousNames) expect(next.tables[name]).toEqual(previous.tables[name]);
  });

  it('journal stays contiguous and 0031 chains onto 0030', async () => {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries.forEach((entry, position) => expect(entry.idx).toBe(position));
    expect(journal.entries.find((entry) => entry.idx === 31)?.tag).toBe(
      '0031_channel_onboarding_intents',
    );
    const previous = JSON.parse(await readFile(SNAPSHOT_PREV, 'utf8')) as { id: string };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as { prevId: string };
    expect(next.prevId).toBe(previous.id);
  });

  it('stores only hashed provider identity and exact lifecycle states', () => {
    const config = getTableConfig(channelOnboardingIntents);
    const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));

    expect(config.name).toBe('channel_onboarding_intents');
    expect(Object.keys(columns).sort()).toEqual(
      [
        'account_id',
        'channel',
        'connection_id',
        'created_at',
        'expires_at',
        'id',
        'intent_secret_hash',
        'last_error_code',
        'provider_owner_id_hash',
        'state',
        'suggested_bot_username',
        'updated_at',
      ].sort(),
    );
    expect(columns.state?.enumValues).toEqual([
      'pending_owner',
      'awaiting_bot',
      'exchanging',
      'stored',
      'expired',
      'failed',
    ]);
    expect(columns.intent_secret_hash?.notNull).toBe(true);
    expect(columns.expires_at?.notNull).toBe(true);
  });

  it('pins all hash, channel, expiry, username, error, and state-shape checks', () => {
    const config = getTableConfig(channelOnboardingIntents);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'channel_onboarding_intents_channel_check',
        'channel_onboarding_intents_state_check',
        'channel_onboarding_intents_intent_hash_check',
        'channel_onboarding_intents_owner_hash_check',
        'channel_onboarding_intents_expiry_check',
        'channel_onboarding_intents_username_check',
        'channel_onboarding_intents_error_code_check',
        'channel_onboarding_intents_owner_state_check',
        'channel_onboarding_intents_connection_state_check',
      ]),
    );
  });

  it('has every approved uniqueness and lookup fence', () => {
    const config = getTableConfig(channelOnboardingIntents);
    const names = config.indexes.map((index) => index.config.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'channel_onboarding_intents_secret_uq',
        'channel_onboarding_intents_active_account_uq',
        'channel_onboarding_intents_active_owner_uq',
        'channel_onboarding_intents_active_expiry_idx',
        'channel_onboarding_intents_connection_idx',
      ]),
    );
    expect(config.indexes.find((index) => index.config.name === 'channel_onboarding_intents_secret_uq')?.config.unique).toBe(true);
    expect(config.indexes.find((index) => index.config.name === 'channel_onboarding_intents_active_account_uq')?.config.unique).toBe(true);
    expect(config.indexes.find((index) => index.config.name === 'channel_onboarding_intents_active_owner_uq')?.config.unique).toBe(true);
  });

  it('enforces immutable identity, monotonic owner binding, and exact CAS transitions', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    for (const column of [
      'id',
      'account_id',
      'channel',
      'intent_secret_hash',
      'expires_at',
    ]) {
      expect(migration).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
    expect(migration).toContain(
      'OLD."provider_owner_id_hash" IS NOT NULL AND NEW."provider_owner_id_hash" IS DISTINCT FROM OLD."provider_owner_id_hash"',
    );
    expect(migration).toContain(
      "OLD.\"state\" = 'pending_owner' AND NEW.\"state\" IN ('awaiting_bot', 'expired', 'failed')",
    );
    expect(migration).toContain(
      "OLD.\"state\" = 'awaiting_bot' AND NEW.\"state\" IN ('exchanging', 'expired', 'failed')",
    );
    expect(migration).toContain(
      "OLD.\"state\" = 'exchanging' AND NEW.\"state\" IN ('stored', 'expired', 'failed')",
    );
    expect(migration).toContain("OLD.\"state\" IN ('stored', 'expired', 'failed')");
  });

  it('rejects cross-account/wrong-channel connections but permits FK SET NULL cleanup', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    expect(migration).toContain('FROM "channel_connections"');
    expect(migration).toContain('"id" = NEW."connection_id"');
    expect(migration).toContain('"account_id" = NEW."account_id"');
    expect(migration).toContain("\"channel\" = 'telegram'");
    expect(migration).toContain(
      "NEW.\"state\" = 'stored' AND NEW.\"connection_id\" IS NULL",
    );
    expect(migration).toContain(
      "OLD.\"state\" = 'stored' AND OLD.\"connection_id\" IS NOT NULL AND NEW.\"connection_id\" IS NULL",
    );
    expect(migration).toContain('ON DELETE set null');
  });

  it('persists no raw nonce, provider identity, Telegram id, or token', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const table = migration.slice(
      migration.indexOf('CREATE TABLE "channel_onboarding_intents"'),
      migration.indexOf(');'),
    );

    expect(table).not.toMatch(/"(?:nonce|token|telegram_id|provider_owner_id)"/i);
    expect(table).toContain('"intent_secret_hash"');
    expect(table).toContain('"provider_owner_id_hash"');
  });
});
