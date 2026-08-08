import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const STORE = fileURLToPath(
  new URL('../src/services/upload-policy-events-postgres.ts', import.meta.url),
);
const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const CLEANUP_STORE = fileURLToPath(
  new URL('../src/services/upload-multipart-cleanup-postgres.ts', import.meta.url),
);

describe('Postgres policy outbox time and lease contract', () => {
  it('uses database time and bounded SKIP LOCKED recovery without text timestamp CASE values', async () => {
    const source = await readFile(STORE, 'utf8');
    expect(source).not.toContain('.toISOString()');
    expect(source).toContain("next_attempt_at = case when e.attempt_count >= ${input.maxAttempts}");
    expect(source).toContain("then null else statement_timestamp() end");
    expect(source).toContain("then null else statement_timestamp() + (${input.retryDelayMs} * interval '1 millisecond') end");
    expect(source).toContain('for update skip locked');
    expect(source).toContain('limit ${input.limit}');
    expect(source).toContain('claim_expires_at <= statement_timestamp()');
  });

  it('keeps success/retry metrics claim-token-CAS-derived and exposes durable backlog truth', async () => {
    const source = await readFile(STORE, 'utf8');
    expect(source).toContain('state = \'delivering\' and claim_token = ${claimToken}');
    expect(source).toContain('state = \'delivering\' and claim_token = ${input.claimToken}');
    expect(source).toContain("return rows[0]?.state ?? 'stale'");
    expect(source).toContain("count(*) filter (where state = 'pending') as pending");
    expect(source).toContain("count(*) filter (where state = 'delivering') as claimed");
    expect(source).toContain("count(*) filter (where state = 'failed') as failed");
    expect(source).toContain("max(attempt_count) filter (where state <> 'delivered')");
  });

  it('runs policy and multipart loops through the same awaited shutdown-safe scheduler', async () => {
    const source = await readFile(SERVER, 'utf8');
    expect(source.match(/startBackgroundWorkerLoop\(\{/g)).toHaveLength(2);
    expect(source).toContain("const context = { policyEvents: result }");
    expect(source).toContain('result.stale > 0');
    expect(source).toContain("app.log.warn(context, 'upload policy event tick requires attention')");
    expect(source).toContain("app.addHook('onClose', async () => policyLoop.stop())");
    expect(source).toContain("app.addHook('onClose', async () => cleanupLoop.stop())");
  });

  it('does not keep idle loops noisy from historical successful attempt counts', async () => {
    const policy = await readFile(STORE, 'utf8');
    const multipart = await readFile(CLEANUP_STORE, 'utf8');
    expect(policy).toContain("max(attempt_count) filter (where state <> 'delivered')");
    expect(multipart).toContain(
      "filter (where cleanup_state in ('pending', 'claimed', 'failed'))",
    );
  });
});
