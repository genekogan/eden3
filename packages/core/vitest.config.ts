import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/manna.test.ts', 'src/permalinks.test.ts'],
    setupFiles: ['./test/setup-database-boundary.ts'],
  },
});
