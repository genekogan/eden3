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
  migrationsFolder?: string;
  lockTimeoutMs?: number;
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
  await runDatabaseMigrations({ databaseUrl });
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entryPoint && pathToFileURL(entryPoint).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'database migration failed');
    process.exitCode = 1;
  });
}
