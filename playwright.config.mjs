import { defineConfig } from '@playwright/test';

// Runs e2e/acceptance.spec.mjs against the already-running dev stack
// (web :4300, api :4301, gateway :18789). Boot the stack first with
// `bash scripts/dev-stack.sh`. Proof bundle (screenshots/video/trace) in var/acceptance.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'acceptance.spec.mjs',
  timeout: 240_000, // agent turns + media gen are slow
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'var/acceptance/report', open: 'never' }]],
  outputDir: 'var/acceptance/artifacts',
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:4300',
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 30_000,
  },
});
