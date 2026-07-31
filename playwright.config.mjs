import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, 'var/playwright-browsers');
const browserName = process.env.PLAYWRIGHT_BROWSER ?? 'firefox';
const channel = process.env.PLAYWRIGHT_CHANNEL;
const forceEvidence = process.env.PLAYWRIGHT_FORCE_EVIDENCE === '1';
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'var/acceptance/artifacts';
const reportDir = process.env.PLAYWRIGHT_REPORT_DIR ?? 'var/acceptance/report';
const browserHome = path.join(ROOT, 'var/chrome-home');
mkdirSync(browserHome, { recursive: true });
const chromiumLaunchOptions = {
  env: { ...process.env, HOME: browserHome },
  args: [
    '--disable-crash-reporter',
    '--disable-crashpad',
    `--crash-dumps-dir=${path.join(ROOT, 'var/chrome-crashes')}`,
  ],
};

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
  reporter: [['list'], ['html', { outputFolder: reportDir, open: 'never' }]],
  outputDir,
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:4300',
    browserName,
    ...(browserName === 'chromium' && channel ? { channel } : {}),
    headless: process.env.PLAYWRIGHT_HEADLESS !== '0',
    ...(browserName === 'chromium' ? { launchOptions: chromiumLaunchOptions } : {}),
    screenshot: 'on',
    video: forceEvidence ? 'on' : 'retain-on-failure',
    trace: forceEvidence ? 'on' : 'retain-on-failure',
    actionTimeout: 30_000,
  },
});
