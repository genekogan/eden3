import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  API_TEST_DATABASE_SENTINEL,
  assertApiTestDatabaseBoundary,
  isApiVitestConfigName,
} from './fixtures/api-test-database-boundary';

const scratch = 'eden3_m3_floor_deadbeef';

describe('API Vitest database boundary', () => {
  it('runs before collection in every API Vitest entrypoint', () => {
    const apiRoot = new URL('../', import.meta.url);
    const configs = readdirSync(apiRoot)
      .filter(isApiVitestConfigName)
      .sort();
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      const source = readFileSync(new URL(config, apiRoot), 'utf8');
      const setup = config === 'vitest.config.ts'
        ? './test/setup-database-boundary.ts'
        : './test/setup-required-database-boundary.ts';
      expect(source, config).toContain(`setupFiles: ['${setup}']`);
    }
  });

  it('classifies every valid Vitest config filename shape without narrowing separators', () => {
    for (const name of [
      'vitest.config.ts',
      'vitest.security.pg.config.ts',
      'vitest_signup.config.ts',
      'vitest-new.config.ts',
    ]) {
      expect(isApiVitestConfigName(name), name).toBe(true);
    }
    for (const name of ['vite.config.ts', 'vitest.config.mts', 'vitest.ts', 'my-vitest.config.ts']) {
      expect(isApiVitestConfigName(name), name).toBe(false);
    }
  });

  it('seals DB-free collection to an unreachable sentinel before a late env load', () => {
    const environment: Record<string, string | undefined> = {};
    expect(assertApiTestDatabaseBoundary(environment)).toBeUndefined();
    expect(environment.DATABASE_URL).toBe(API_TEST_DATABASE_SENTINEL);
    expect(assertApiTestDatabaseBoundary(environment)).toBeUndefined();

    const directory = mkdtempSync(path.join(tmpdir(), 'eden3-api-test-env-'));
    const envPath = path.join(directory, '.env');
    writeFileSync(envPath, 'DATABASE_URL=postgres://user@127.0.0.1:5433/eden3\n', { mode: 0o600 });
    const original = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = environment.DATABASE_URL;
      process.loadEnvFile(envPath);
      expect(process.env.DATABASE_URL).toBe(API_TEST_DATABASE_SENTINEL);
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires an explicit database for every DB-backed config', () => {
    expect(() => assertApiTestDatabaseBoundary({}, { required: true }))
      .toThrow(/API tests require a local disposable database/i);
  });

  it('allows one literal local nonprotected scratch database', () => {
    expect(assertApiTestDatabaseBoundary({
      DATABASE_URL: `postgres://user:password@127.0.0.1:5433/${scratch}`,
    })).toBe(scratch);
    expect(assertApiTestDatabaseBoundary({
      DATABASE_URL: `postgresql://user@localhost:5433/t12u03_runtime_0041_deadbeef`,
    })).toBe('t12u03_runtime_0041_deadbeef');
  });

  it('refuses protected, remote, redirected, normalized, and non-scratch targets', () => {
    for (const databaseUrl of [
      'postgres://user@127.0.0.1:5433/eden3',
      'postgres://user@127.0.0.1:5433/eden3_stg',
      'postgres://user@127.0.0.1:5433/postgres',
      'postgres://user@remote.example:5433/eden3_m3_floor_deadbeef',
      'postgres://user@127.0.0.1/eden3_m3_floor_deadbeef',
      'postgres://user@127.0.0.1:5432/eden3_m3_floor_deadbeef',
      'postgres://user@127.0.0.1:5433/eden3_m3_floor_deadbeef?database=eden3',
      'postgres://user@127.0.0.1:5433/eden3_m3_floor_deadbeef#eden3',
      'postgres://user@127.0.0.1:5433/scratch/../eden3_m3_floor_deadbeef',
      'postgres://user@127.0.0.1:5433/%65den3_m3_floor_deadbeef',
      'postgres://user@127.0.0.1:5433/other_noncanonical_database',
      'postgres://user@127.0.0.1:5433/eden3_app_test',
    ]) {
      expect(() => assertApiTestDatabaseBoundary({ DATABASE_URL: databaseUrl }), databaseUrl)
        .toThrow(/API tests require a local disposable database/i);
    }
  });

  it('never discloses database credentials in its refusal', () => {
    const credential = 'never-print-api-test-password';
    let message = '';
    try {
      assertApiTestDatabaseBoundary({
        DATABASE_URL: `postgres://user:${credential}@remote.example:5433/${scratch}`,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/local disposable database/i);
    expect(message).not.toContain(credential);
  });
});
