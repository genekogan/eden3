import { defineConfig } from 'vitest/config';

import { API_POSTGRES_TEST_FILES } from './test/fixtures/api-postgres-test-files';

// Workspace mutation deliberately refuses non-Linux hosts because Node lacks
// descriptor-relative openat/renameat there. Keep that production filesystem
// contract in the Linux suite instead of misclassifying it as managed-DB
// provider behavior during a macOS rehearsal.
const managedPostgresFiles = process.platform === 'linux'
  ? [...API_POSTGRES_TEST_FILES]
  : API_POSTGRES_TEST_FILES.filter((file) => file !== 'test/workspace-routes.test.ts');

/** Explicit remote-provider rehearsal against one disposable managed database. */
export default defineConfig({
  test: {
    include: managedPostgresFiles,
    setupFiles: ['./test/setup-required-managed-postgres-boundary.ts'],
    fileParallelism: false,
    // Remote TLS round trips make the longest multi-boundary money/channel
    // cases legitimately exceed the local-floor timeout without hanging.
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
