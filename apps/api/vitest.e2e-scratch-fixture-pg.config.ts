import { defineConfig } from 'vitest/config';

import { assertApiPostgresEvidenceFlag } from './test/fixtures/api-test-database-boundary';

assertApiPostgresEvidenceFlag(process.env, 'EDEN3_E2E_FIXTURE_PG');

export default defineConfig({
  test: {
    include: ['test/e2e-scratch-fixture-pg.test.ts'],
    setupFiles: ['./test/setup-required-database-boundary.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
