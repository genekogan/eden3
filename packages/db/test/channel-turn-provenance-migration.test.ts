import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

describe('channel turn provenance corrective migration', () => {
  it('never rewrites the already-applied 0021 migration', async () => {
    const migration = await readFile(`${MIGRATIONS}0021_channel_runtime_hardening.sql`);
    expect(createHash('sha256').update(migration).digest('hex')).toBe(
      'b900527c6d95d53e243fa73c647c7afe8caa9a0dbe772ed4e2cc7418f5e546b7',
    );
  });

  it('recovers only explicit usage provenance and quarantines every unknown row', async () => {
    const migration = await readFile(
      `${MIGRATIONS}0022_channel_turn_provenance_repair.sql`,
      'utf8',
    );

    expect(migration).toContain('ADD COLUMN "provenance_status"');
    expect(migration).toContain('JOIN "usage_events" AS u');
    expect(migration).toContain("u.\"event_type\" = 'channel_chat'");
    expect(migration).toContain("u.\"metadata\" ->> 'agentRuntime'");
    expect(migration).toContain("\"provenance_status\" = 'recovered_usage_event'");
    expect(migration).toContain('SET "channel" = NULL');
    expect(migration).toContain("\"provenance_status\" = 'legacy_refund_pending'");
    expect(migration).toContain("now() - interval '46 minutes'");
    expect(migration).toContain("\"provenance_status\" = 'legacy_terminal_unknown'");
    expect(migration).not.toContain('anthropic/claude-haiku-4-5');
    expect(migration).not.toMatch(/^\s*"agent_runtime"\s*=\s*'openclaw'/m);
    expect(migration).not.toMatch(/^\s*"pricing_basis"\s*=\s*'provider-api'/m);
  });
});
