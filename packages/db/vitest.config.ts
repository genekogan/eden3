import { defineConfig } from 'vitest/config';

import {
  DB_ALL_POSTGRES_TEST_FILES,
  assertDbUnitTestSelectors,
} from './test/fixtures/db-postgres-test-files';

assertDbUnitTestSelectors(process.argv.slice(2));

// Unit tests only — pure file/schema assertions, no live database. Integration
// tests (test/integration/*.itest.ts) exercise real Postgres DDL on scratch
// databases and run via `pnpm test:integration` — the explicit exclude matters
// because the default `*.test.ts` glob would also match `*.itest.ts` (`*`
// matches dots).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.itest.ts', ...DB_ALL_POSTGRES_TEST_FILES],
    passWithNoTests: true,
  },
});
