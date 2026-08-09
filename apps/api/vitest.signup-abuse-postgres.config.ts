import { defineConfig } from 'vitest/config';

/** Lease-bound, provider-free native-agent quota proof on a migrated scratch DB. */
export default defineConfig({
  test: {
    include: ['test/signup-abuse-postgres.pgtest.ts'],
    setupFiles: ['./test/setup-required-database-boundary.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
