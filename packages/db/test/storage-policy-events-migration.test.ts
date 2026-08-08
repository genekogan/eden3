import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { storagePolicyEvents } from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0032_storage_upload_part_authorizations.sql', import.meta.url),
);

describe('storage policy event outbox migration (T21b-U03)', () => {
  it('exposes exactly the approved minimal outbox fields', () => {
    const config = getTableConfig(storagePolicyEvents);
    const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));

    expect(Object.keys(columns).sort()).toEqual(
      [
        'attempt_count',
        'claim_expires_at',
        'claim_token',
        'created_at',
        'delivered_at',
        'event_type',
        'id',
        'last_error_code',
        'next_attempt_at',
        'object_id',
        'owner_account_id',
        'policy_code',
        'state',
        'updated_at',
      ].sort(),
    );
    expect(columns.id?.primary).toBe(true);
    expect(columns.state?.enumValues).toEqual(['pending', 'delivering', 'delivered', 'failed']);
    expect(columns.event_type?.enumValues).toEqual(['quarantine_required']);
  });

  it('pins safe codes, state, attempts, and every delivery shape', () => {
    const config = getTableConfig(storagePolicyEvents);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'storage_policy_events_event_type_check',
        'storage_policy_events_policy_code_check',
        'storage_policy_events_state_check',
        'storage_policy_events_attempt_count_check',
        'storage_policy_events_last_error_code_check',
        'storage_policy_events_claim_shape_check',
        'storage_policy_events_schedule_shape_check',
        'storage_policy_events_delivery_shape_check',
      ]),
    );
  });

  it('binds owner to object and uses restrictive deletion semantics', async () => {
    const config = getTableConfig(storagePolicyEvents);
    const composite = config.foreignKeys.find(
      (key) => key.reference().columns.map((column) => column.name).join(',') === 'object_id,owner_account_id',
    )?.reference();

    expect(composite?.foreignColumns.map((column) => column.name)).toEqual([
      'id',
      'owner_account_id',
    ]);
    const migration = await readFile(MIGRATION, 'utf8');
    expect(migration.match(/storage_policy_events[^;]+ON DELETE restrict/g)).toHaveLength(3);
  });

  it('deduplicates delivery and indexes due/expired claims only', () => {
    const config = getTableConfig(storagePolicyEvents);
    const unique = config.indexes.find(
      (index) => index.config.name === 'storage_policy_events_object_type_policy_uq',
    );
    expect(unique?.config.unique).toBe(true);
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        'storage_policy_events_due_idx',
        'storage_policy_events_claim_expiry_idx',
      ]),
    );
  });

  it('enforces immutable event identity and exact retry lifecycle', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    for (const column of ['object_id', 'owner_account_id', 'event_type', 'policy_code']) {
      expect(migration).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
    expect(migration).toContain(
      "OLD.\"state\" = 'pending' AND NEW.\"state\" = 'delivering'",
    );
    expect(migration).toContain(
      "OLD.\"state\" = 'delivering' AND NEW.\"state\" IN ('delivered', 'pending', 'failed')",
    );
    expect(migration).toContain("OLD.\"state\" IN ('delivered', 'failed')");
    expect(migration).toContain('NEW."attempt_count" < OLD."attempt_count"');
    expect(migration).toContain('NEW."attempt_count" <> OLD."attempt_count" + 1');
  });

  it('fences active claims and supports crash recovery through pending', async () => {
    const migration = await readFile(MIGRATION, 'utf8');

    expect(migration).toContain(
      "OLD.\"state\" = 'delivering' AND NEW.\"state\" = 'delivering'",
    );
    expect(migration).toContain('NEW."claim_token" IS DISTINCT FROM OLD."claim_token"');
    expect(migration).toContain('NEW."claim_expires_at" IS DISTINCT FROM OLD."claim_expires_at"');
    expect(migration).toContain('BEFORE INSERT OR UPDATE ON "storage_policy_events"');
  });

  it('contains no detector output, content, payload, or extra hash', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const start = migration.indexOf('CREATE TABLE "storage_policy_events"');
    const table = migration.slice(start, migration.indexOf(');', start));

    expect(table).not.toMatch(/"(?:payload|content|detector_text|detector_output|sha256|hash)"/i);
    expect(table).toContain('"policy_code"');
  });
});
