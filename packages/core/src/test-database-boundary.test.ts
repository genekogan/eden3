import {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CORE_TEST_DATABASE_SENTINEL,
  assertCoreTestDatabaseBoundary,
  isCoreVitestConfigName,
} from '../test/fixtures/core-test-database-boundary';

const scratch = 'eden3_core_pg_deadbeef';

describe('Core Vitest database boundary', () => {
  it('classifies every Vitest config filename and guards all discovered configs', async () => {
    const coreRoot = new URL('../', import.meta.url);
    for (const name of [
      'vitest.config.ts',
      'vitest.security.pg.config.ts',
      'vitest_signup.config.ts',
      'vitest-new.config.ts',
    ]) {
      expect(isCoreVitestConfigName(name), name).toBe(true);
    }
    for (const name of ['vite.config.ts', 'vitest.config.mts', 'my-vitest.config.ts']) {
      expect(isCoreVitestConfigName(name), name).toBe(false);
    }

    const configs = readdirSync(coreRoot).filter(isCoreVitestConfigName).sort();
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      const setup = config === 'vitest.config.ts'
        ? './test/setup-database-boundary.ts'
        : './test/setup-required-database-boundary.ts';
      const loaded = await import(new URL(config, coreRoot).href) as {
        default: { test?: { setupFiles?: string[] } };
      };
      expect(loaded.default.test?.setupFiles, config).toEqual([setup]);
    }
  });

  it('keeps the two live-Postgres files out of the ordinary suite and in the required suite', async () => {
    const unit = (await import('../vitest.config')).default;
    const integration = (await import('../vitest.integration.config')).default;
    const dbFiles = ['src/manna.test.ts', 'src/permalinks.test.ts'];
    expect(unit.test?.exclude).toEqual(dbFiles);
    expect(integration.test?.include).toEqual(dbFiles);
  });

  it('seals DB-free collection before a late env load', () => {
    const environment: Record<string, string | undefined> = {};
    expect(assertCoreTestDatabaseBoundary(environment)).toBeUndefined();
    expect(environment.DATABASE_URL).toBe(CORE_TEST_DATABASE_SENTINEL);
    expect(assertCoreTestDatabaseBoundary(environment)).toBeUndefined();

    const directory = mkdtempSync(path.join(tmpdir(), 'eden3-core-test-env-'));
    const envPath = path.join(directory, '.env');
    writeFileSync(envPath, 'DATABASE_URL=postgres://user@127.0.0.1:5433/eden3\n', { mode: 0o600 });
    const original = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = environment.DATABASE_URL;
      process.loadEnvFile(envPath);
      expect(process.env.DATABASE_URL).toBe(CORE_TEST_DATABASE_SENTINEL);
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires one exact local Core scratch database for the DB-backed suite', () => {
    expect(() => assertCoreTestDatabaseBoundary({}, { required: true }))
      .toThrow(/Core tests require a local disposable database/i);
    expect(assertCoreTestDatabaseBoundary({
      DATABASE_URL: `postgres://user:password@127.0.0.1:5433/${scratch}`,
    }, { required: true })).toBe(scratch);
    expect(assertCoreTestDatabaseBoundary({
      DATABASE_URL: `postgresql://user@localhost:5433/${scratch}`,
    }, { required: true })).toBe(scratch);
  });

  it('refuses protected, remote, redirected, normalized, and wrong-namespace targets', () => {
    for (const databaseUrl of [
      'postgres://user@127.0.0.1:5433/eden3',
      'postgres://user@127.0.0.1:5433/eden3_stg',
      'postgres://user@127.0.0.1:5433/postgres',
      `postgres://user@remote.example:5433/${scratch}`,
      `postgres://user@127.0.0.1:5432/${scratch}`,
      `postgres://user@127.0.0.1:5433/${scratch}?database=eden3`,
      `postgres://user@127.0.0.1:5433/${scratch}#eden3`,
      `postgres://user@127.0.0.1:5433/scratch/../${scratch}`,
      'postgres://user@127.0.0.1:5433/%65den3_core_pg_deadbeef',
      'postgres://user@127.0.0.1:5433/eden3_core_pg_nothex12',
    ]) {
      expect(() => assertCoreTestDatabaseBoundary({ DATABASE_URL: databaseUrl }, { required: true }), databaseUrl)
        .toThrow(/Core tests require a local disposable database/i);
    }
  });

  it('never discloses credentials in a refusal', () => {
    const credential = 'never-print-core-test-password';
    let message = '';
    try {
      assertCoreTestDatabaseBoundary({
        DATABASE_URL: `postgres://user:${credential}@remote.example:5433/${scratch}`,
      }, { required: true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/local disposable database/i);
    expect(message).not.toContain(credential);
  });
});
