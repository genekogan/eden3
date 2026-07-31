import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0024_runtime_recovery_hardening.sql', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0024_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(
  new URL('../migrations/meta/_journal.json', import.meta.url),
);

describe('runtime recovery hardening migration', () => {
  it('adds only additive durable identities plus the delivery-pending index', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    expect(sql).toContain('"runtime_sync_version" integer DEFAULT 0 NOT NULL');
    expect(sql).toContain('"runtime_synced_version" integer DEFAULT 0 NOT NULL');
    expect(sql).toContain('"runtime_sync_claim_token" uuid');
    expect(sql).toContain('"runtime_sync_lease_expires_at" timestamp with time zone');
    expect(sql).toContain('"pending_occurrence_id" uuid');
    expect(sql).toContain('"pending_occurrence_kind" text');
    expect(sql).toContain('"pending_occurrence_at" timestamp with time zone');
    expect(sql).toContain('"agents_runtime_sync_versions_check"');
    expect(sql).toContain('"triggers_pending_occurrence_shape_check"');
    expect(sql).toContain('CREATE UNIQUE INDEX "memory_dream_runs_live_agent_uq"');
    expect(sql).toContain("'delivery_pending'");
    expect(sql).not.toMatch(/^\s*(?:truncate|delete|update)\b/im);
  });

  it('keeps snapshot and journal aligned at 0024', async () => {
    const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>;
    };
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(snapshot.tables['public.agents']?.columns).toMatchObject({
      runtime_sync_version: expect.any(Object),
      runtime_synced_version: expect.any(Object),
      runtime_sync_claim_token: expect.any(Object),
      runtime_sync_lease_expires_at: expect.any(Object),
      runtime_sync_error: expect.any(Object),
    });
    expect(snapshot.tables['public.triggers']?.columns).toMatchObject({
      pending_occurrence_id: expect.any(Object),
      pending_occurrence_kind: expect.any(Object),
      pending_occurrence_at: expect.any(Object),
    });
    expect(snapshot.tables['public.channel_turns']?.indexes).toHaveProperty(
      'channel_turns_open_updated_idx',
    );
    expect(journal.entries.find((entry) => entry.idx === 24)).toMatchObject({
      idx: 24,
      tag: '0024_runtime_recovery_hardening',
    });
  });
});
