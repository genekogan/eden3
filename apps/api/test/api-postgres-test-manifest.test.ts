import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  API_ALL_POSTGRES_TEST_FILES,
  API_GATED_POSTGRES_TEST_FILES,
  API_POSTGRES_TEST_FILES,
  assertApiUnitTestSelectors,
  postgresFileMatchingUnitSelector,
} from './fixtures/api-postgres-test-files';

describe('API Postgres test manifest', () => {
  it('is sorted, unique, and points only to existing test files', () => {
    expect(API_POSTGRES_TEST_FILES).toEqual([...API_POSTGRES_TEST_FILES].sort());
    expect(API_GATED_POSTGRES_TEST_FILES).toEqual([...API_GATED_POSTGRES_TEST_FILES].sort());
    expect(new Set(API_ALL_POSTGRES_TEST_FILES).size).toBe(API_ALL_POSTGRES_TEST_FILES.length);
    expect(API_ALL_POSTGRES_TEST_FILES.length).toBeGreaterThan(0);
    for (const file of API_ALL_POSTGRES_TEST_FILES) {
      expect(file).toMatch(/^test\/[a-z0-9-]+(?:-pg)?\.test\.ts$/);
      expect(existsSync(new URL(`../${file}`, import.meta.url)), file).toBe(true);
    }
  });

  it('is the exact include set for the required config and excluded from the unit config', async () => {
    const unit = (await import('../vitest.config')).default;
    const postgres = (await import('../vitest.postgres.config')).default;
    expect(postgres.test?.include).toEqual(API_POSTGRES_TEST_FILES);
    const notification = (await import('../vitest.agent-provision-notification-pg.config')).default;
    const e2eFixture = (await import('../vitest.e2e-scratch-fixture-pg.config')).default;
    expect(notification.test?.include).toEqual([API_GATED_POSTGRES_TEST_FILES[0]]);
    expect(e2eFixture.test?.include).toEqual([API_GATED_POSTGRES_TEST_FILES[1]]);
    for (const file of API_ALL_POSTGRES_TEST_FILES) {
      expect(unit.test?.exclude, file).toContain(file);
    }
  });

  it('refuses exact, abbreviated, broad, and absolute selectors for excluded Postgres files', () => {
    for (const selector of [
      'test/channels-routes.test.ts',
      'channels-routes.test.ts',
      'channels-routes',
      'test',
      '/tmp/work/apps/api/test/channels-routes.test.ts',
      'agent-provisioning-notification-pg',
    ]) {
      expect(postgresFileMatchingUnitSelector(['run', selector]), selector).toBeDefined();
      expect(() => assertApiUnitTestSelectors(['run', selector]), selector)
        .toThrow(/test:postgres.*test:full/i);
    }
    expect(() => assertApiUnitTestSelectors(['run', 'src', '--reporter', 'dot'])).not.toThrow();
  });

  it('defines one aggregate gate that invokes every API database tranche', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['test:full']).toBe(
      'pnpm test && pnpm test:postgres && pnpm test:agent-provision-notification-pg && pnpm test:e2e-scratch-fixture-pg',
    );
    expect(pkg.scripts?.['test:agent-provision-notification-pg'])
      .toContain('EDEN3_AGENT_PROVISION_NOTIFICATION_PG=1');
    expect(pkg.scripts?.['test:e2e-scratch-fixture-pg'])
      .toContain('EDEN3_E2E_FIXTURE_PG=1');
    const root = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(root.scripts?.['test:api-full']).toBe('pnpm --filter @eden3/api test:full');
  });
});
