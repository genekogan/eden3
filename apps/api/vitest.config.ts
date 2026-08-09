import { defineConfig } from 'vitest/config';

import {
  API_ALL_POSTGRES_TEST_FILES,
  assertApiUnitTestSelectors,
} from './test/fixtures/api-postgres-test-files';

assertApiUnitTestSelectors(process.argv.slice(2));

// Deterministic, database-free tests only. PostgreSQL-backed tests are owned by
// the exact manifest below and run through `test:postgres` / `test:full` on a
// leased disposable database. Gateway integration tests (*.itest.ts) remain a
// separately authorized live-stack ceremony.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.itest.ts', ...API_ALL_POSTGRES_TEST_FILES],
    setupFiles: ['./test/setup-database-boundary.ts'],
    testTimeout: 30_000, // watcher tests poll real (tmp) filesystems
  },
});
