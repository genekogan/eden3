import { describe, expect, it } from 'vitest';

import { assertApiManagedPostgresBoundary } from './fixtures/api-managed-postgres-boundary';
import managedConfig from '../vitest.managed-postgres.config';

const url = 'postgres://eden3_runtime:synthetic@db.example.invalid:5432/eden3_managed_rehearsal?sslmode=verify-full';
const ownerUrl = 'postgres://eden3_owner:synthetic-owner@db.example.invalid:5432/eden3_managed_rehearsal?sslmode=verify-full';

describe('API managed PostgreSQL rehearsal boundary', () => {
  it('admits only the exact explicitly enabled disposable provider database', () => {
    const environment = {
      EDEN3_MANAGED_POSTGRES_TESTS: '1',
      MANAGED_DATABASE_URL: url,
      MANAGED_DATABASE_EXPECTED_NAME: 'eden3_managed_rehearsal',
    };
    expect(assertApiManagedPostgresBoundary(environment)).toBe('eden3_managed_rehearsal');
    expect(environment).toHaveProperty('DATABASE_URL', url);
  });

  it('admits an optional distinct owner credential only on the same provider database authority', () => {
    const environment = {
      EDEN3_MANAGED_POSTGRES_TESTS: '1',
      MANAGED_DATABASE_URL: url,
      MANAGED_DATABASE_EXPECTED_NAME: 'eden3_managed_rehearsal',
      MANAGED_OWNER_DATABASE_URL: ownerUrl,
    };
    expect(assertApiManagedPostgresBoundary(environment)).toBe('eden3_managed_rehearsal');
    expect(environment).toHaveProperty('DATABASE_URL', url);
  });

  it.each([
    url.replace('synthetic@', 'other-password@'),
    ownerUrl.replace('db.example.invalid', 'other.example.invalid'),
    ownerUrl.replace(':5432/', ':5433/'),
    ownerUrl.replace('/eden3_managed_rehearsal?', '/eden3_managed_rehearsal_other?'),
  ])('refuses a same-principal or different-authority owner credential %#', (managedOwnerDatabaseUrl) => {
    expect(() =>
      assertApiManagedPostgresBoundary({
        EDEN3_MANAGED_POSTGRES_TESTS: '1',
        MANAGED_DATABASE_URL: url,
        MANAGED_DATABASE_EXPECTED_NAME: 'eden3_managed_rehearsal',
        MANAGED_OWNER_DATABASE_URL: managedOwnerDatabaseUrl,
      }),
    ).toThrow(/managed PostgreSQL|exact credentialed/);
  });

  it('keeps the Linux-only workspace filesystem proof out of a macOS provider rehearsal', () => {
    const include = managedConfig.test?.include as string[];
    if (process.platform === 'linux') {
      expect(include).toContain('test/workspace-routes.test.ts');
    } else {
      expect(include).not.toContain('test/workspace-routes.test.ts');
    }
    expect(include).toContain('test/channels-routes.test.ts');
    expect(include).toContain('test/fg-econ-chat-media.test.ts');
    expect(managedConfig.test?.fileParallelism).toBe(false);
    expect(managedConfig.test?.testTimeout).toBeGreaterThanOrEqual(180_000);
  });

  it.each([
    {},
    { EDEN3_MANAGED_POSTGRES_TESTS: '1', MANAGED_DATABASE_URL: url },
    { EDEN3_MANAGED_POSTGRES_TESTS: '0', MANAGED_DATABASE_URL: url, MANAGED_DATABASE_EXPECTED_NAME: 'eden3_managed_rehearsal' },
    { EDEN3_MANAGED_POSTGRES_TESTS: '1', MANAGED_DATABASE_URL: url, MANAGED_DATABASE_EXPECTED_NAME: 'eden3' },
    { EDEN3_MANAGED_POSTGRES_TESTS: '1', MANAGED_DATABASE_URL: url, MANAGED_DATABASE_EXPECTED_NAME: 'eden3_managed_rehearsal', DATABASE_URL: 'postgres://other.invalid/other' },
  ])('refuses missing, protected, disabled, or split authority %#', (environment) => {
    expect(() => assertApiManagedPostgresBoundary(environment)).toThrow(/exact disposable rehearsal/);
  });
});
