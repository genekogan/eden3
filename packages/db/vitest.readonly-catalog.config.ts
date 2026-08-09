import { defineConfig } from 'vitest/config';

import { assertDbIntegrationDatabaseBoundary } from './test/fixtures/db-integration-database-boundary';
import { DB_PROTECTED_READONLY_FILES } from './test/fixtures/db-postgres-test-files';

assertDbIntegrationDatabaseBoundary(process.env, 'protected-readonly');

export default defineConfig({
  test: {
    include: [...DB_PROTECTED_READONLY_FILES],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
