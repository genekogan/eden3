import { defineConfig } from 'vitest/config';

// Unit tests only. Integration tests (test/integration/*.itest.ts) hit the
// live OpenClaw gateway and run via `pnpm test:integration` — the explicit
// exclude matters because the default `*.test.ts` glob would also match
// `*.itest.ts` (`*` matches dots).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'test/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/*.itest.ts'],
  },
});
