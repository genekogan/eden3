import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/manna.test.ts', 'src/permalinks.test.ts'],
    setupFiles: ['./test/setup-required-database-boundary.ts'],
    fileParallelism: false,
  },
});
