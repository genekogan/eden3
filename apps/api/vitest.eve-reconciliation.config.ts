import { defineConfig } from 'vitest/config';

// This fixture temporarily creates the exact @eve collision in a disposable
// database. Keep it isolated from the ordinary parallel suite, whose
// default-assistant tests legitimately assume the reserved handle is free.
export default defineConfig({
  test: {
    include: ['test/eve-reconciliation.itest.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
