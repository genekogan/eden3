import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/agent-provisioning-notification-pg.test.ts'],
    setupFiles: ['./test/setup-required-database-boundary.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
