import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  API_ALL_POSTGRES_TEST_FILES,
  API_GATED_POSTGRES_TEST_FILES,
  API_POSTGRES_TEST_FILES,
  assertApiUnitTestSelectors,
  postgresFileMatchingUnitSelector,
  unitSelectorMatchesPostgresFile,
} from './fixtures/api-postgres-test-files';
import { assertApiPostgresEvidenceFlag } from './fixtures/api-test-database-boundary';

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
    const priorNotification = process.env.EDEN3_AGENT_PROVISION_NOTIFICATION_PG;
    const priorFixture = process.env.EDEN3_E2E_FIXTURE_PG;
    try {
      process.env.EDEN3_AGENT_PROVISION_NOTIFICATION_PG = '1';
      process.env.EDEN3_E2E_FIXTURE_PG = '1';
      const notification = (await import('../vitest.agent-provision-notification-pg.config')).default;
      const e2eFixture = (await import('../vitest.e2e-scratch-fixture-pg.config')).default;
      expect(notification.test?.include).toEqual([API_GATED_POSTGRES_TEST_FILES[0]]);
      expect(e2eFixture.test?.include).toEqual([API_GATED_POSTGRES_TEST_FILES[1]]);
    } finally {
      if (priorNotification === undefined) {
        delete process.env.EDEN3_AGENT_PROVISION_NOTIFICATION_PG;
      } else {
        process.env.EDEN3_AGENT_PROVISION_NOTIFICATION_PG = priorNotification;
      }
      if (priorFixture === undefined) {
        delete process.env.EDEN3_E2E_FIXTURE_PG;
      } else {
        process.env.EDEN3_E2E_FIXTURE_PG = priorFixture;
      }
    }
    for (const file of API_ALL_POSTGRES_TEST_FILES) {
      expect(unit.test?.exclude, file).toContain(file);
    }
  });

  it('refuses file and containing-directory selectors for every excluded Postgres file', () => {
    const apiRoot = new URL('../', import.meta.url);
    const repositoryRoot = new URL('../../../', import.meta.url);
    for (const file of API_ALL_POSTGRES_TEST_FILES) {
      const basename = file.slice('test/'.length);
      const abbreviation = basename.slice(0, -'.test.ts'.length);
      for (const selector of [
        file,
        basename,
        abbreviation,
        new URL(file, apiRoot).pathname,
        './test',
        'apps/api/test',
        new URL('test', apiRoot).pathname,
        new URL('apps/api/test', repositoryRoot).pathname,
      ]) {
        expect(unitSelectorMatchesPostgresFile(selector, file), `${file}: ${selector}`).toBe(true);
        expect(postgresFileMatchingUnitSelector(['run', selector]), selector).toBeDefined();
        expect(() => assertApiUnitTestSelectors(['run', selector]), selector)
          .toThrow(/test:postgres.*test:full/i);
      }
      expect(unitSelectorMatchesPostgresFile('src', file), file).toBe(false);
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

  it('fails closed on missing gated-proof flags instead of skipping test bodies', () => {
    for (const flag of [
      'EDEN3_AGENT_PROVISION_NOTIFICATION_PG',
      'EDEN3_E2E_FIXTURE_PG',
    ] as const) {
      expect(() => assertApiPostgresEvidenceFlag({}, flag)).toThrow(
        /explicit evidence flag/i,
      );
      expect(() => assertApiPostgresEvidenceFlag({ [flag]: '0' }, flag)).toThrow(
        /explicit evidence flag/i,
      );
      expect(() => assertApiPostgresEvidenceFlag({ [flag]: '1' }, flag)).not.toThrow();
    }

    const notificationConfig = readFileSync(
      new URL('../vitest.agent-provision-notification-pg.config.ts', import.meta.url),
      'utf8',
    );
    const fixtureConfig = readFileSync(
      new URL('../vitest.e2e-scratch-fixture-pg.config.ts', import.meta.url),
      'utf8',
    );
    const notificationProof = readFileSync(
      new URL('./agent-provisioning-notification-pg.test.ts', import.meta.url),
      'utf8',
    );
    const fixtureProof = readFileSync(
      new URL('./e2e-scratch-fixture-pg.test.ts', import.meta.url),
      'utf8',
    );
    expect(notificationConfig).toContain(
      "assertApiPostgresEvidenceFlag(process.env, 'EDEN3_AGENT_PROVISION_NOTIFICATION_PG')",
    );
    expect(fixtureConfig).toContain(
      "assertApiPostgresEvidenceFlag(process.env, 'EDEN3_E2E_FIXTURE_PG')",
    );
    expect(notificationProof).not.toMatch(/describe\.skip|enabled\s*\?\s*describe/);
    expect(fixtureProof).not.toMatch(/describe\.skip|enabled\s*\?\s*describe/);
  });
});
