import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0023_data_plane_reconciliation.sql', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0023_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(
  new URL('../migrations/meta/_journal.json', import.meta.url),
);

describe('data-plane reconciliation migration', () => {
  it('adds the durable Claude/social surfaces and fenced memory recovery columns', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    expect(sql).toContain('CREATE TABLE "claude_session_turn_claims"');
    expect(sql).toContain('"session_key" text PRIMARY KEY NOT NULL');
    expect(sql).toContain('"lease_expires_at" timestamp with time zone NOT NULL');
    expect(sql).toContain('UNIQUE("turn_id")');
    expect(sql).toContain('CREATE TABLE "etl_social_edges"');
    expect(sql).toContain('"last_seen_run_id" uuid NOT NULL');
    expect(sql).toContain(
      'PRIMARY KEY("source_collection","source_external_id","edge_kind","user_id","target_id")',
    );
    expect(sql).toContain('"etl_social_edges_source_run_idx"');
    expect(sql).toContain('"etl_social_edges_target_idx"');
    expect(sql).toContain('ALTER TABLE "memory_dream_runs" ADD COLUMN "claim_token" uuid');
    expect(sql).toContain(
      'ALTER TABLE "memory_dream_runs" ADD COLUMN "lease_expires_at" timestamp with time zone',
    );
    expect(sql).toContain(
      'ALTER TABLE "memory_dream_runs" ADD COLUMN "provider_status" text DEFAULT \'not_started\' NOT NULL',
    );
    expect(sql).toContain(
      'ALTER TABLE "memory_dream_sweeps" ADD COLUMN "claim_token" uuid',
    );
    expect(sql).toContain('"memory_dream_runs_lease_idx"');
    expect(sql).toContain('"memory_dream_sweeps_lease_idx"');
    expect(sql).not.toMatch(/^\s*(?:drop|truncate|delete|update)\b/im);
  });

  it('keeps the generated snapshot and journal aligned with migration 0023', async () => {
    const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(snapshot.tables['public.claude_session_turn_claims']).toBeDefined();
    expect(snapshot.tables['public.etl_social_edges']).toBeDefined();
    expect(snapshot.tables['public.memory_dream_runs']?.columns).toMatchObject({
      claim_token: expect.any(Object),
      lease_expires_at: expect.any(Object),
      provider_status: expect.any(Object),
      provider_started_at: expect.any(Object),
    });
    expect(snapshot.tables['public.memory_dream_sweeps']?.columns).toMatchObject({
      claim_token: expect.any(Object),
      lease_expires_at: expect.any(Object),
    });
    expect(journal.entries.find((entry) => entry.idx === 23)).toMatchObject({
      idx: 23,
      tag: '0023_data_plane_reconciliation',
    });
  });
});
