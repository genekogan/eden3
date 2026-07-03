import { defineConfig } from 'vitest/config';

// Unit tests only (they may use live Postgres — see test/dev-routes.test.ts).
// Integration tests (test/integration/*.itest.ts) additionally hit the live
// OpenClaw gateway and run via `pnpm test:integration` — the explicit exclude
// matters because the default `*.test.ts` glob would also match `*.itest.ts`
// (`*` matches dots).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.itest.ts'],
    testTimeout: 30_000, // watcher tests poll real (tmp) filesystems
  },
});
