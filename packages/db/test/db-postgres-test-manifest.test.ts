import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { assertDbIntegrationDatabaseBoundary } from './fixtures/db-integration-database-boundary';
import {
  DB_ALL_POSTGRES_TEST_FILES,
  DB_PROTECTED_READONLY_FILES,
  DB_SCRATCH_INTEGRATION_FILES,
  assertDbUnitTestSelectors,
  dbPostgresFileMatchingUnitSelector,
  dbPostgresFilesMatchingUnitSelector,
  unitSelectorMatchesDbPostgresFile,
} from './fixtures/db-postgres-test-files';

describe('DB PostgreSQL test manifest', () => {
  it('is sorted, unique, and points only to existing integration files', () => {
    expect(DB_SCRATCH_INTEGRATION_FILES).toEqual([...DB_SCRATCH_INTEGRATION_FILES].sort());
    expect(DB_PROTECTED_READONLY_FILES).toEqual([...DB_PROTECTED_READONLY_FILES].sort());
    expect(new Set(DB_ALL_POSTGRES_TEST_FILES).size).toBe(DB_ALL_POSTGRES_TEST_FILES.length);
    const discovered = readdirSync(new URL('./integration', import.meta.url))
      .filter((file) => file.endsWith('.itest.ts'))
      .map((file) => `test/integration/${file}`)
      .sort();
    expect(DB_ALL_POSTGRES_TEST_FILES).toEqual(discovered);
    for (const file of DB_ALL_POSTGRES_TEST_FILES) {
      expect(file).toMatch(/^test\/integration\/[a-z0-9-]+\.itest\.ts$/);
      expect(existsSync(new URL(`../${file}`, import.meta.url)), file).toBe(true);
    }
  });

  it('rejects every file and containing directory through the ordinary command', () => {
    const packageRoot = new URL('../', import.meta.url);
    const repositoryRoot = new URL('../../../', import.meta.url);
    for (const file of DB_ALL_POSTGRES_TEST_FILES) {
      const basename = file.slice('test/integration/'.length);
      const abbreviation = basename.slice(0, -'.itest.ts'.length);
      for (const selector of [
        file,
        basename,
        abbreviation,
        new URL(file, packageRoot).pathname,
        './test/integration',
        'packages/db/test/integration',
        new URL('test/integration', packageRoot).pathname,
        new URL('packages/db/test/integration', repositoryRoot).pathname,
      ]) {
        expect(unitSelectorMatchesDbPostgresFile(selector, file), `${file}: ${selector}`).toBe(true);
        expect(dbPostgresFileMatchingUnitSelector(['run', selector]), selector).toBeDefined();
        const matches = dbPostgresFilesMatchingUnitSelector(['run', selector]);
        const includesReadonly = matches.some((match) =>
          DB_PROTECTED_READONLY_FILES.some((entry) => entry === match));
        const includesScratch = matches.some((match) =>
          DB_SCRATCH_INTEGRATION_FILES.some((entry) => entry === match));
        const refusal = includesReadonly && includesScratch
          ? /test:scratch-full.*test:catalog-readonly/i
          : includesReadonly
            ? /test:catalog-readonly.*separate operator authorization/i
            : /test:integration.*test:scratch-full.*disposable-database lease/i;
        expect(() => assertDbUnitTestSelectors(['run', selector]), selector).toThrow(refusal);
      }
      expect(unitSelectorMatchesDbPostgresFile('src', file), file).toBe(false);
    }
    expect(() => assertDbUnitTestSelectors(['run', 'src', '--reporter', 'dot'])).not.toThrow();
  });

  it('separates explicit maintenance scratch authority from protected read-only authority', () => {
    expect(assertDbIntegrationDatabaseBoundary({
      DATABASE_URL: 'postgres://user:password@127.0.0.1:5433/postgres',
    }, 'scratch')).toBe('postgres');
    expect(assertDbIntegrationDatabaseBoundary({
      DATABASE_URL: 'postgresql://user@localhost:5433/eden3',
      EDEN3_DB_READONLY_AUDIT: '1',
    }, 'protected-readonly')).toBe('eden3');

    for (const [environment, mode] of [
      [{}, 'scratch'],
      [{ DATABASE_URL: 'postgres://user@127.0.0.1:5433/eden3' }, 'scratch'],
      [{ DATABASE_URL: 'postgres://user@127.0.0.1:5433/postgres' }, 'protected-readonly'],
      [{ DATABASE_URL: 'postgres://user@127.0.0.1:5433/eden3' }, 'protected-readonly'],
      [{
        DATABASE_URL: 'postgres://user@127.0.0.1:5433/postgres?database=eden3',
      }, 'scratch'],
      [{ DATABASE_URL: 'postgres://user@remote.example:5433/postgres' }, 'scratch'],
      [{ DATABASE_URL: 'postgres://user@127.0.0.1:5432/postgres' }, 'scratch'],
      [{ DATABASE_URL: 'postgres://user@127.0.0.1:5433/%70ostgres' }, 'scratch'],
    ] as const) {
      expect(() => assertDbIntegrationDatabaseBoundary(environment, mode), JSON.stringify(environment))
        .toThrow(/explicit authorized local database target/i);
    }
  });

  it('binds each config and aggregate script to its exact authority class', () => {
    const scratchConfig = readFileSync(new URL('../vitest.integration.config.ts', import.meta.url), 'utf8');
    const readonlyConfig = readFileSync(
      new URL('../vitest.readonly-catalog.config.ts', import.meta.url),
      'utf8',
    );
    const ordinaryConfig = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');
    expect(scratchConfig).toContain("assertDbIntegrationDatabaseBoundary(process.env, 'scratch')");
    expect(scratchConfig).toContain('include: [...DB_SCRATCH_INTEGRATION_FILES]');
    expect(readonlyConfig)
      .toContain("assertDbIntegrationDatabaseBoundary(process.env, 'protected-readonly')");
    expect(readonlyConfig).toContain('include: [...DB_PROTECTED_READONLY_FILES]');
    expect(ordinaryConfig).toContain('assertDbUnitTestSelectors(process.argv.slice(2))');
    expect(ordinaryConfig).toContain('...DB_ALL_POSTGRES_TEST_FILES');

    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['test:scratch-full']).toBe('pnpm test && pnpm test:integration');
    expect(pkg.scripts?.['test:catalog-readonly'])
      .toBe('vitest run --config vitest.readonly-catalog.config.ts');
    const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(root.scripts?.['test:db-scratch-full'])
      .toBe('pnpm --filter @eden3/db test:scratch-full');

    const scratchSource = readFileSync(
      new URL('./integration/netspend-index.itest.ts', import.meta.url),
      'utf8',
    );
    const readonlySource = readFileSync(
      new URL('./integration/netspend-index-readonly.itest.ts', import.meta.url),
      'utf8',
    );
    expect(scratchSource).not.toContain('shared-DB read-only verification');
    expect(readonlySource).toContain("await client.unsafe('begin transaction read only')");
    expect(readonlySource).toContain("current_setting('transaction_read_only')");
    expect(readonlySource).not.toContain('loadRootEnv');
    const tryOffset = readonlySource.indexOf('try {');
    const beginOffset = readonlySource.indexOf("await client.unsafe('begin transaction read only')");
    const identityOffset = readonlySource.indexOf('select current_database() as database');
    const catalogOffset = readonlySource.indexOf('select pg_get_indexdef');
    const finallyOffset = readonlySource.indexOf('} finally {');
    const rollbackOffset = readonlySource.indexOf("await client.unsafe('rollback')");
    const closeOffset = readonlySource.indexOf('await client.end()');
    expect(tryOffset).toBeGreaterThanOrEqual(0);
    expect(beginOffset).toBeGreaterThan(tryOffset);
    expect(identityOffset).toBeGreaterThan(beginOffset);
    expect(catalogOffset).toBeGreaterThan(identityOffset);
    expect(finallyOffset).toBeGreaterThan(catalogOffset);
    expect(rollbackOffset).toBeGreaterThan(finallyOffset);
    expect(closeOffset).toBeGreaterThan(rollbackOffset);
  });

  it('never discloses database credentials in a boundary refusal', () => {
    const credential = 'never-print-db-integration-password';
    let message = '';
    try {
      assertDbIntegrationDatabaseBoundary({
        DATABASE_URL: `postgres://user:${credential}@remote.example:5433/postgres`,
      }, 'scratch');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/explicit authorized local database target/i);
    expect(message).not.toContain(credential);
  });
});
