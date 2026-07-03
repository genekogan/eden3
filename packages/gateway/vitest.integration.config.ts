import { defineConfig } from 'vitest/config';

// Integration tests against the LIVE OpenClaw gateway (http://127.0.0.1:18789,
// agent "testbot"). Requires OPENCLAW_GATEWAY_TOKEN (env or repo-root .env).
// Gateway turns regularly take 5-15s (cold cache turns longer), so timeouts
// are deliberately generous.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.itest.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
