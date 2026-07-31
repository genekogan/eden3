import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { OpenClawCompatClient } from '../../src/compat-client';
import { OpenClawCli } from '../../src/docker';
import { AgentProvisioner } from '../../src/provisioner';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const envFile = path.join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides real env

const BASE_URL = (process.env.OPENCLAW_BASE_URL ?? 'http://127.0.0.1:18789').replace(/\/+$/, '');
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
const DATA_DIR =
  process.env.OPENCLAW_DATA_DIR !== undefined && process.env.OPENCLAW_DATA_DIR !== ''
    ? path.resolve(process.env.OPENCLAW_DATA_DIR)
    : path.join(REPO_ROOT, 'infra', 'openclaw', 'data');

const AGENT_ID = 'itest-persona-probe';
const MODEL = 'anthropic/claude-haiku-4-5';
const COMPOSE_WRAPPER = path.join(REPO_ROOT, 'scripts', 'compose.mjs');

const cli = new OpenClawCli();
const compat = new OpenClawCompatClient({ baseUrl: BASE_URL, token: TOKEN });
const provisioner = new AgentProvisioner({
  gateway: { baseUrl: BASE_URL, token: TOKEN },
  cli,
  dataDir: DATA_DIR,
});

function personaFor(marker: string): string {
  return [
    'You are Itest Persona Probe.',
    `When the user asks "persona marker?", answer exactly "${marker}".`,
    'For all other messages, answer briefly.',
  ].join(' ');
}

async function askMarker(): Promise<string> {
  let completedText: string | undefined;
  for await (const event of compat.chatTurn({
    agentId: AGENT_ID,
    sessionKey: `eden3:s:${randomUUID()}`,
    userMessage: 'persona marker? Reply with only the marker.',
  })) {
    if (event.type === 'error') throw new Error(`persona turn failed: ${event.message}`);
    if (event.type === 'turn.completed') completedText = event.text;
  }
  if (completedText === undefined) throw new Error('persona turn ended without turn.completed');
  return completedText.trim();
}

async function restartOpenClaw(): Promise<void> {
  // The wrapper derives the exact Compose database selector from DATABASE_URL.
  // Raw Compose is deliberately invalid so a restart cannot silently point
  // the credential sidecars at a different logical database than the API.
  await execFileAsync(process.execPath, [COMPOSE_WRAPPER, 'restart', 'openclaw'], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  // Solo restart-to-healthy is ~25s, but under suite load with a large
  // provisioned fleet (200 agents on the staging DB) boot can exceed 60s —
  // observed 2026-07-30. Generous budget; the assertion is durability, not speed.
  const deadline = Date.now() + 180_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      last = `${response.status} ${response.statusText}`.trim();
      if (response.ok) return;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`eden3-openclaw /healthz did not recover after restart; last=${last}`);
}

beforeAll(() => {
  if (TOKEN === '') {
    throw new Error(
      'OPENCLAW_GATEWAY_TOKEN is not set (env or repo-root .env) — cannot reach the gateway',
    );
  }
});

describe('persona runtime (live gateway)', () => {
  it('uses hot-edited persona on the next turn and keeps it across OpenClaw restart', async () => {
    const alpha = `EDEN3_ALPHA_${randomUUID().slice(0, 8)}`;
    const bravo = `EDEN3_BRAVO_${randomUUID().slice(0, 8)}`;

    await provisioner.provisionAgent(
      {
        openclawId: AGENT_ID,
        name: 'Itest Persona Probe',
        username: AGENT_ID,
        description: 'Throwaway integration-test agent for persona hot-edit/restart proof.',
        persona: personaFor(alpha),
        greeting: 'ready',
        model: MODEL,
      },
      { force: true },
    );
    expect(await askMarker()).toContain(alpha);

    await provisioner.updateAgentPersona({
      openclawId: AGENT_ID,
      name: 'Itest Persona Probe',
      username: AGENT_ID,
      description: 'Throwaway integration-test agent for persona hot-edit/restart proof.',
      persona: personaFor(bravo),
      greeting: 'ready',
    });

    const hot = await askMarker();
    expect(hot).toContain(bravo);
    expect(hot).not.toContain(alpha);

    await restartOpenClaw();

    const afterRestart = await askMarker();
    expect(afterRestart).toContain(bravo);
    expect(afterRestart).not.toContain(alpha);
  }, 240_000);
});
