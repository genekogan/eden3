import { runDatabaseMigrations } from '../../src/migrate';
import {
  CatalogLockTimeoutError,
  withCatalogAdvisoryLock,
} from '../../src/catalog-lock';

const databaseUrl = process.env.TEST_DATABASE_URL;
const mode = process.env.TEST_CATALOG_LOCK_MODE;
const timeoutMs = Number(process.env.TEST_CATALOG_LOCK_TIMEOUT_MS);

if (!databaseUrl || !mode || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error('catalog-lock process fixture is missing safe test configuration');
}

try {
  if (mode === 'runner') {
    const migrationsFolder = process.env.TEST_MIGRATIONS_FOLDER;
    if (!migrationsFolder) throw new Error('runner fixture requires TEST_MIGRATIONS_FOLDER');
    await runDatabaseMigrations({ databaseUrl, migrationsFolder, lockTimeoutMs: timeoutMs });
  } else if (mode === 'ddl') {
    await withCatalogAdvisoryLock(
      { databaseUrl, timeoutMs },
      async (sql) => {
        await sql`
          create table operational_ddl_probe (
            id integer primary key,
            note text not null
          )`;
      },
    );
  } else {
    throw new Error(`unsupported fixture mode ${mode}`);
  }
  process.exitCode = 0;
} catch (error) {
  if (error instanceof CatalogLockTimeoutError) {
    process.exitCode = 2;
  } else {
    console.error(error instanceof Error ? error.message : 'unknown fixture failure');
    process.exitCode = 1;
  }
}
