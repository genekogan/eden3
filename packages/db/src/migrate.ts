import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as runDrizzleMigrations } from 'drizzle-orm/postgres-js/migrator';

import {
  catalogLockTimeoutMs,
  withCatalogAdvisoryLock,
} from './catalog-lock';
import { loadRootEnv } from './env';

const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../migrations', import.meta.url),
);

export interface RunDatabaseMigrationsOptions {
  databaseUrl: string;
  expectedDatabaseName?: string;
  migrationsFolder?: string;
  lockTimeoutMs?: number;
}

/**
 * PostgreSQL treats an absent/empty URL pathname as "connect to the database
 * named after the login role". That implicit fallback is unsafe for migration
 * commands because a malformed scratch URL can silently select a protected
 * database. Require one literal, unambiguous database pathname before opening
 * the catalog-lock connection, and bind it to EDEN3_DATABASE_NAME when the
 * caller supplies that independent attestation.
 */
export function assertMigrationDatabaseBoundary(
  databaseUrl: string,
  expectedDatabaseName?: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('migration requires an explicit safe database pathname');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('migration requires an explicit safe database pathname');
  }
  const authorityStart = databaseUrl.indexOf('://') + 3;
  const firstDelimiterOffset = databaseUrl.slice(authorityStart).search(/[/?#]/);
  if (firstDelimiterOffset < 0) {
    throw new Error('migration requires an explicit safe database pathname');
  }
  const pathStart = authorityStart + firstDelimiterOffset;
  if (databaseUrl[pathStart] !== '/') {
    throw new Error('migration requires an explicit safe database pathname');
  }
  const pathTail = databaseUrl.slice(pathStart);
  const pathEndOffset = pathTail.search(/[?#]/);
  const rawPathname = pathEndOffset < 0 ? pathTail : pathTail.slice(0, pathEndOffset);
  const match = /^\/([A-Za-z_][A-Za-z0-9_-]{0,62})$/.exec(rawPathname);
  if (!match) {
    throw new Error('migration requires an explicit safe database pathname');
  }
  const databaseName = match[1]!;
  if (expectedDatabaseName !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(expectedDatabaseName)) {
      throw new Error('EDEN3_DATABASE_NAME must name one explicit safe database');
    }
    if (databaseName !== expectedDatabaseName) {
      throw new Error('migration database does not match EDEN3_DATABASE_NAME');
    }
  }
  return databaseName;
}

/**
 * Drizzle 0.45.2 reads/creates its journal outside the DDL transaction, then
 * executes every pending migration statement and journal insert in one
 * transaction. Keeping its client on this reserved session makes the
 * advisory lease cover both phases without replacing Drizzle's runner.
 */
export async function runDatabaseMigrations(
  options: RunDatabaseMigrationsOptions,
): Promise<void> {
  assertMigrationDatabaseBoundary(options.databaseUrl, options.expectedDatabaseName);
  await withCatalogAdvisoryLock(
    {
      databaseUrl: options.databaseUrl,
      timeoutMs: options.lockTimeoutMs ?? catalogLockTimeoutMs(),
    },
    async (sql) => {
      await runDrizzleMigrations(drizzle(sql as never), {
        migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
      });
    },
  );
}

async function main(): Promise<void> {
  loadRootEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set (expected in the environment or the repo-root .env)');
  }
  await runDatabaseMigrations({
    databaseUrl,
    expectedDatabaseName: process.env.EDEN3_DATABASE_NAME,
  });
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entryPoint && pathToFileURL(entryPoint).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'database migration failed');
    process.exitCode = 1;
  });
}
