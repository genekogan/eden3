import { defineConfig } from 'vitest/config';

// Integration tests against the LIVE stack: Postgres (localhost:5433) and the
// OpenClaw gateway (http://127.0.0.1:18789). Requires OPENCLAW_GATEWAY_TOKEN
// (env or repo-root .env). media.itest.ts performs ONE real image generation
// (fal via the gateway, ~cents) and waits for the async file to land on disk
// (~10-120s), so timeouts are deliberately generous.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.itest.ts'],
    setupFiles: ['./test/setup-required-database-boundary.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
