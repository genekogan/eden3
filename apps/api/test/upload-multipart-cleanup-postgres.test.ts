import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const STORE = fileURLToPath(
  new URL('../src/services/upload-multipart-cleanup-postgres.ts', import.meta.url),
);

describe('Postgres multipart cleanup lease contract', () => {
  it('claims bounded due work with row locks and database-issued claim tokens', async () => {
    const source = await readFile(STORE, 'utf8');
    expect(source).toContain('with expired as (');
    expect(source).toContain('cleanup_claim_expires_at <= statement_timestamp()');
    expect(source).toContain('limit ${input.limit}');
    expect(source).toContain('for update skip locked');
    expect(source).toContain('cleanup_attempt_count = u.cleanup_attempt_count + 1');
    expect(source).toContain('cleanup_claim_token = gen_random_uuid()');
    expect(source).toContain("statement_timestamp() + (${input.leaseMs} * interval '1 millisecond')");
    expect(source).toContain("cleanup_attempt_count < ${input.maxAttempts}");
    expect(source).not.toContain('input.now.toISOString()');
    expect(source).toContain("${input.retryDelayMs} * interval '1 millisecond'");
  });

  it('derives tenant and provider locators from durable joined rows', async () => {
    const source = await readFile(STORE, 'utf8');
    expect(source).toContain('c.owner_account_id, o.backing_key');
    expect(source).toContain('c.backend_multipart_id as backend_upload_id');
    expect(source).toContain('from claimed c join storage_objects o on o.id = c.object_id');
    expect(source).not.toContain('input.ownerAccountId');
  });

  it('fences every completion/retry write by the database-issued claim token', async () => {
    const source = await readFile(STORE, 'utf8');
    const claimComparisons = source.match(/cleanup_claim_token = \$\{/g) ?? [];
    expect(claimComparisons).toHaveLength(2);
    expect(source).toContain("then 'attempts_exhausted'");
    expect(source).toContain('cleanup_claim_expires_at <= statement_timestamp()');
  });
});
