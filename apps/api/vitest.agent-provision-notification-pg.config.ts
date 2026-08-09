import { defineConfig } from 'vitest/config';

import { assertApiPostgresEvidenceFlag } from './test/fixtures/api-test-database-boundary';

assertApiPostgresEvidenceFlag(process.env, 'EDEN3_AGENT_PROVISION_NOTIFICATION_PG');

export default defineConfig({
  test: {
    include: ['test/agent-provisioning-notification-pg.test.ts'],
    setupFiles: ['./test/setup-required-database-boundary.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
