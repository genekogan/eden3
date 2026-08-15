import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(new URL('../migrations/0047_voice_backend.sql', import.meta.url));
const journalPath = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('0047 voice backend custody', () => {
  it('binds assignments, quotes, executions, consent clips, and erasure targets durably', async () => {
    const migration = await readFile(migrationPath, 'utf8');
    for (const table of ['agent_voice_assignments', 'voice_clones', 'voice_clone_clips', 'voice_quotes', 'voice_executions']) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
    expect(migration).toContain("purpose='voice-clip'");
    expect(migration).toContain("'voice_clone'");
    expect(migration).toContain("provider_create_ambiguous");
    expect(migration).toContain("provider_delete_failed");
    expect(migration).toContain('"provider_request_id" text');
    expect(migration).toContain("OLD.status='revoked' AND NEW.status IN ('provider_delete_pending','deleted')");
    expect(migration).toContain('voice_account_erasure_write_fence');
    expect(migration).toContain("account_erasure_target_claim_matches(v_owner,'voice_clone'");
    expect(migration).toContain("account_erasure_target_claim_matches(v_owner,'voice_output'");
    expect(migration).toContain('account_erasure_unclaimed_seal_matches(v_owner)');
    expect(migration).toContain('"attempt_count" between 0 and 1');
    expect(migration).toContain('"duration_ms" between 3000 and 10000');
    expect(migration).toContain('"size_bytes" between 1 and 20971520');
    expect(migration).toContain('account_erasure_assert_no_open_work');
    expect(migration).toContain("v.status IN ('pending_validation','cloning','provider_create_ambiguous','provider_delete_pending','provider_delete_failed')");
  });

  it('keeps migration timestamps strictly increasing so 0047 cannot be skipped after 0046', async () => {
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index]!.when, `${entries[index]!.tag} must follow ${entries[index - 1]!.tag}`)
        .toBeGreaterThan(entries[index - 1]!.when);
    }
  });
});
