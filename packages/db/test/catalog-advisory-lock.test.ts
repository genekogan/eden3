import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { ReservedSql } from 'postgres';

import {
  CATALOG_ADVISORY_LOCK,
  CatalogLockTimeoutError,
  adaptReservedSqlForDrizzle,
  boundedCatalogCleanup,
  catalogLockTimeoutMs,
} from '../src/catalog-lock';
import { assertMigrationDatabaseBoundary } from '../src/migrate';

const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));
const MIGRATION_RUNNER = fileURLToPath(new URL('../src/migrate.ts', import.meta.url));
const DRIZZLE_CONFIG = fileURLToPath(new URL('../drizzle.config.ts', import.meta.url));

describe('shared PostgreSQL catalog advisory-lock convention', () => {
  it('pins one explicit two-int lock identity without database-side hashing', () => {
    expect(CATALOG_ADVISORY_LOCK).toEqual({
      classId: 1_162_102_094,
      objectId: 1_145_326_641,
      label: 'EDEN/DDL1',
    });
  });

  it('parses a bounded fail-closed acquisition timeout', () => {
    expect(catalogLockTimeoutMs(undefined)).toBe(30_000);
    expect(catalogLockTimeoutMs('1')).toBe(1);
    expect(catalogLockTimeoutMs('300000')).toBe(300_000);
    for (const value of ['', '0', '-1', '1.5', '300001', 'nope']) {
      expect(() => catalogLockTimeoutMs(value), value).toThrow(/catalog lock timeout/i);
    }
  });

  it('exposes a stable timeout error without database URL material', () => {
    const error = new CatalogLockTimeoutError(123);
    expect(error.name).toBe('CatalogLockTimeoutError');
    expect(error.message).toBe('catalog advisory lock acquisition timed out after 123ms');
  });

  it('routes the repository migration command through the locked runner', async () => {
    const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.migrate).toBe('tsx src/migrate.ts');
    expect(pkg.scripts.push).toBeUndefined();

    const source = await readFile(MIGRATION_RUNNER, 'utf8');
    expect(source).toContain('withCatalogAdvisoryLock');
    expect(source).toContain('runDrizzleMigrations');
    expect(source).not.toContain('drizzle-kit migrate');
    expect(source.indexOf('assertMigrationDatabaseBoundary(options.databaseUrl'))
      .toBeLessThan(source.indexOf('await withCatalogAdvisoryLock'));

    const drizzleConfig = await readFile(DRIZZLE_CONFIG, 'utf8');
    expect(drizzleConfig).toContain(
      'assertMigrationDatabaseBoundary(databaseUrl, process.env.EDEN3_DATABASE_NAME)',
    );
    expect(drizzleConfig).toContain(
      "throw new Error('DATABASE_URL is required for Drizzle tooling')",
    );
    expect(drizzleConfig).not.toMatch(/postgres:\/\/eden3:eden3@localhost:5433\/eden3/);
  });

  it('refuses implicit-login and ambiguous migration database targets before connection', () => {
    expect(assertMigrationDatabaseBoundary(
      'postgresql://eden3:secret@127.0.0.1:5433/eden3',
      'eden3',
    )).toBe('eden3');
    expect(assertMigrationDatabaseBoundary(
      'postgres://eden3:secret@127.0.0.1:5433/t12u03_runtime_0041_deadbeef?sslmode=disable',
      't12u03_runtime_0041_deadbeef',
    )).toBe('t12u03_runtime_0041_deadbeef');

    for (const url of [
      'postgresql://eden3:secret@127.0.0.1:5433',
      'postgresql://eden3:secret@127.0.0.1:5433/',
      'postgresql://eden3:secret@127.0.0.1:5433/%65den3',
      'postgresql://eden3:secret@127.0.0.1:5433/eden3/extra',
      'postgresql://eden3:secret@127.0.0.1:5433/.',
      'postgresql://eden3:secret@127.0.0.1:5433/scratch/../eden3',
      'postgresql://eden3:secret@127.0.0.1:5433/scratch/%2e%2e/eden3',
      'postgresql://eden3:secret@127.0.0.1:5433/./eden3',
    ]) {
      expect(() => assertMigrationDatabaseBoundary(url), url).toThrow(
        /explicit safe database pathname/i,
      );
    }
    expect(() => assertMigrationDatabaseBoundary(
      'postgresql://eden3:secret@127.0.0.1:5433/eden3',
      'different_database',
    )).toThrow(/does not match EDEN3_DATABASE_NAME/i);
    expect(() => assertMigrationDatabaseBoundary(
      'postgresql://eden3:secret@127.0.0.1:5433/eden3',
      '',
    )).toThrow(/EDEN3_DATABASE_NAME/i);
  });

  it('adapts only callback transactions on the same ReservedSql handle', async () => {
    const events: string[] = [];
    const connection = Object.assign(
      (() => undefined) as unknown as ReservedSql,
      {
        unsafe: async (statement: string) => { events.push(statement); },
      },
    );
    const rootOptions = { parsers: {}, serializers: {} };
    const adapted = adaptReservedSqlForDrizzle(
      connection,
      { options: rootOptions } as never,
    );
    expect(adapted.options).toBe(rootOptions);

    await expect(adapted.begin(async (transaction) => {
      expect(transaction).toBe(connection);
      events.push('work');
      return 17;
    })).resolves.toBe(17);
    expect(events).toEqual(['begin', 'work', 'commit']);

    events.length = 0;
    await expect(adapted.begin(async () => {
      events.push('failing-work');
      throw new Error('synthetic transaction failure');
    })).rejects.toThrow('synthetic transaction failure');
    expect(events).toEqual(['begin', 'failing-work', 'rollback']);

    await expect((adapted.begin as unknown as (options: string, callback: () => void) => Promise<void>)(
      'read only',
      () => undefined,
    )).rejects.toThrow(/callback-only/);
  });

  it('bounds cleanup even when the unlock operation never settles', async () => {
    const never = new Promise<never>(() => undefined);
    const startedAt = Date.now();
    await expect(boundedCatalogCleanup(never, 10)).rejects.toThrow(
      'catalog advisory unlock timed out after 10ms',
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('pins Drizzle DDL and its journal insert inside the same transaction', async () => {
    const dialect = new PgDialect();
    const events: string[] = [];
    const render = (query: unknown) => dialect.sqlToQuery(query as never).sql;
    const session = {
      execute: async (query: unknown) => { events.push(`outside:${render(query)}`); },
      all: async (query: unknown) => {
        events.push(`outside:${render(query)}`);
        return [];
      },
      transaction: async (operation: (tx: { execute(query: unknown): Promise<void> }) => Promise<void>) => {
        events.push('transaction:begin');
        await operation({
          execute: async (query: unknown) => { events.push(`inside:${render(query)}`); },
        });
        events.push('transaction:commit');
      },
    };

    await dialect.migrate(
      [{ sql: ['select 101', 'select 202'], folderMillis: 1, hash: 'probe', bps: true }],
      session as never,
      { migrationsFolder: 'unused' },
    );

    const transactionStart = events.indexOf('transaction:begin');
    const transactionCommit = events.indexOf('transaction:commit');
    expect(transactionStart).toBeGreaterThan(0);
    expect(transactionCommit).toBeGreaterThan(transactionStart);
    expect(events.slice(transactionStart + 1, transactionCommit)).toEqual([
      'inside:select 101',
      'inside:select 202',
      expect.stringMatching(/^inside:insert into "drizzle"\."__drizzle_migrations"/),
    ]);
    expect(events.slice(0, transactionStart).join('\n')).toContain(
      'select id, hash, created_at from "drizzle"."__drizzle_migrations"',
    );
  });
});
