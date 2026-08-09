import { defineConfig } from 'vitest/config';

import { API_POSTGRES_TEST_FILES } from './test/fixtures/api-postgres-test-files';

/** Lease-bound API PostgreSQL proofs on one fully migrated disposable DB. */
export default defineConfig({
  test: {
    include: [...API_POSTGRES_TEST_FILES],
    setupFiles: ['./test/setup-required-database-boundary.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
