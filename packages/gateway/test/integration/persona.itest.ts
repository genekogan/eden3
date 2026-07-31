import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

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
const DOCKER_COMPOSE = existsSync('/usr/local/bin/docker-compose')
  ? '/usr/local/bin/docker-compose'
  : 'docker-compose';

const cli = new OpenClawCli();
const provisioner = new AgentProvisioner({
  gateway: { baseUrl: BASE_URL, token: TOKEN },
  cli,
  dataDir: DATA_DIR,
});

type AgentCliResult = {
  status?: string;
  result?: {
    payloads?: Array<{ text?: string | null }>;
  };
};

function personaFor(marker: string): string {
  return [
    'You are Itest Persona Probe.',
    `When the user asks "persona marker?", answer exactly "${marker}".`,
    'For all other messages, answer briefly.',
  ].join(' ');
}

async function askMarker(): Promise<string> {
  const result = await cli.execJson<AgentCliResult>(
    [
      'agent',
      '--agent',
      AGENT_ID,
      '--session-key',
      `agent:${AGENT_ID}:eden3:s:${randomUUID()}`,
      '--message',
      'persona marker? Reply with only the marker.',
      '--json',
      '--timeout',
      '120',
    ],
    { timeoutMs: 130_000 },
  );
  expect(result.status).toBe('ok');
  return (result.result?.payloads ?? []).map((p) => p.text ?? '').join('\n').trim();
}

async function restartOpenClaw(): Promise<void> {
  await execFileAsync(DOCKER_COMPOSE, ['-f', path.join(REPO_ROOT, 'infra/docker-compose.yml'), 'restart', 'openclaw'], {
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
      const { stdout } = await execFileAsync(
        'docker',
        ['inspect', '-f', '{{.State.Health.Status}}', 'eden3-openclaw'],
        {
          cwd: REPO_ROOT,
          env: process.env,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        },
      );
      last = stdout.trim();
      if (last === 'healthy') return;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`eden3-openclaw did not become healthy after restart; last=${last}`);
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
