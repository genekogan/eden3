import { fileURLToPath } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

import { checkSchemaReadiness } from '../src/readiness';

describe('schema readiness', () => {
  it('requires every checked-in migration hash', async () => {
    const folder = fileURLToPath(new URL('../migrations', import.meta.url));
    const hashes = readMigrationFiles({ migrationsFolder: folder }).map(({ hash }) => hash);
    const missing = await checkSchemaReadiness(async () => hashes.slice(0, -1));
    expect(missing).toMatchObject({
      status: 'missing_migrations',
      expectedMigration: '0041_account_erasure_reconciliation',
      expectedCount: hashes.length,
      appliedCount: hashes.length - 1,
      missingCount: 1,
      unexpectedCount: 0,
    });

    const ready = await checkSchemaReadiness(async () => hashes);
    expect(ready).toMatchObject({
      status: 'ready',
      expectedMigration: '0041_account_erasure_reconciliation',
      expectedCount: hashes.length,
      appliedCount: hashes.length,
      missingCount: 0,
      unexpectedCount: 0,
    });

    const ahead = await checkSchemaReadiness(async () => [...hashes, 'unexpected-hash']);
    expect(ahead).toMatchObject({
      status: 'unexpected_migrations',
      expectedCount: hashes.length,
      appliedCount: hashes.length + 1,
      missingCount: 0,
      unexpectedCount: 1,
    });
  });

  it('fails closed without leaking database errors', async () => {
    const result = await checkSchemaReadiness(async () => {
      throw new Error('postgresql://secret:password@example.invalid/private');
    });
    expect(result).toMatchObject({
      status: 'database_unavailable',
      appliedCount: null,
      missingCount: null,
      unexpectedCount: null,
    });
    expect(JSON.stringify(result)).not.toContain('password');
  });
});
