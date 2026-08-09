import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const journal = JSON.parse(
  readFileSync(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries?: Array<{ tag?: unknown }> };
const migrations = readMigrationFiles({ migrationsFolder });
const expectedHashes = migrations.map((migration) => migration.hash);
const expectedTag = journal.entries?.at(-1)?.tag;

if (
  migrations.length === 0 ||
  typeof expectedTag !== 'string' ||
  journal.entries?.length !== migrations.length
) {
  throw new Error('migration catalog is empty or inconsistent');
}
const expectedMigration: string = expectedTag;

export interface SchemaReadiness {
  status: 'ready' | 'missing_migrations' | 'unexpected_migrations' | 'database_unavailable';
  expectedMigration: string;
  expectedCount: number;
  appliedCount: number | null;
  missingCount: number | null;
  unexpectedCount: number | null;
}

export type AppliedMigrationReader = () => Promise<readonly string[]>;

async function readAppliedMigrationHashes(): Promise<readonly string[]> {
  // Keep the deterministic catalog/readiness classifier importable without a
  // database. Only the production default reader loads the environment-bound
  // client; tests and offline tooling inject their own applied-hash reader.
  const { pg } = await import('./client');
  const rows = await pg<{ hash: string }[]>`
    select hash from drizzle.__drizzle_migrations
  `;
  return rows.map((row) => row.hash);
}

/** Fail-closed readiness for the exact checked-in migration catalog. */
export async function checkSchemaReadiness(
  readApplied: AppliedMigrationReader = readAppliedMigrationHashes,
): Promise<SchemaReadiness> {
  try {
    const applied = new Set(await readApplied());
    const expected = new Set(expectedHashes);
    const missingCount = expectedHashes.reduce(
      (count, hash) => count + (applied.has(hash) ? 0 : 1),
      0,
    );
    const unexpectedCount = [...applied].reduce(
      (count, hash) => count + (expected.has(hash) ? 0 : 1),
      0,
    );
    return {
      status:
        missingCount > 0
          ? 'missing_migrations'
          : unexpectedCount > 0
            ? 'unexpected_migrations'
            : 'ready',
      expectedMigration,
      expectedCount: expectedHashes.length,
      appliedCount: applied.size,
      missingCount,
      unexpectedCount,
    };
  } catch {
    return {
      status: 'database_unavailable',
      expectedMigration,
      expectedCount: expectedHashes.length,
      appliedCount: null,
      missingCount: null,
      unexpectedCount: null,
    };
  }
}
