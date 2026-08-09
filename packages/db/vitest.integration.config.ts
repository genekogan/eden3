import { defineConfig } from 'vitest/config';

import { assertDbIntegrationDatabaseBoundary } from './test/fixtures/db-integration-database-boundary';
import { DB_SCRATCH_INTEGRATION_FILES } from './test/fixtures/db-postgres-test-files';

assertDbIntegrationDatabaseBoundary(process.env, 'scratch');

// Scratch-only integration tests. DATABASE_URL must explicitly select the
// local :5433 `postgres` maintenance database; every test then owns and drops
// only its closed-name disposable database.
export default defineConfig({
  test: {
    include: [...DB_SCRATCH_INTEGRATION_FILES],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
