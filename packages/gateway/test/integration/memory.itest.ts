import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { OpenClawCli } from '../../src/docker';
import { AgentProvisioner } from '../../src/provisioner';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const envFile = path.join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides real env

const BASE_URL = (process.env.OPENCLAW_BASE_URL ?? 'http://127.0.0.1:18789').replace(/\/+$/, '');
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
const DATA_DIR =
  process.env.OPENCLAW_DATA_DIR !== undefined && process.env.OPENCLAW_DATA_DIR !== ''
    ? path.resolve(process.env.OPENCLAW_DATA_DIR)
    : path.join(REPO_ROOT, 'infra', 'openclaw', 'data');

const AGENT_ID = 'itest-memory-probe';
const MODEL = 'anthropic/claude-haiku-4-5';

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

async function ask(message: string): Promise<string> {
  const result = await cli.execJson<AgentCliResult>(
    [
      'agent',
      '--agent',
      AGENT_ID,
      '--session-key',
      `agent:${AGENT_ID}:eden3:s:${randomUUID()}`,
      '--message',
      message,
      '--json',
      '--timeout',
      '120',
    ],
    { timeoutMs: 130_000 },
  );
  expect(result.status).toBe('ok');
  return (result.result?.payloads ?? []).map((p) => p.text ?? '').join('\n').trim();
}

beforeAll(() => {
  if (TOKEN === '') {
    throw new Error(
      'OPENCLAW_GATEWAY_TOKEN is not set (env or repo-root .env) — cannot reach the gateway',
    );
  }
});

describe('agent memory (live gateway)', () => {
  it('makes rendered MEMORY.md visible during an agent turn', async () => {
    const marker = `EDEN3_MEMORY_${randomUUID().slice(0, 8)}`;
    await provisioner.provisionAgent(
      {
        openclawId: AGENT_ID,
        name: 'Itest Memory Probe',
        username: AGENT_ID,
        description: 'Throwaway integration-test agent for memory visibility.',
        persona:
          'You are a short-answer test agent. Do not invent memory markers. If MEMORY.md contains an exact marker, report it exactly.',
        greeting: 'ready',
        model: MODEL,
        memorySeed: `- Durable runtime memory marker: ${marker}.`,
      },
      { force: true },
    );

    const answer = await ask('What exact durable runtime memory marker is in MEMORY.md? Reply only with the marker.');
    expect(answer).toContain(marker);
  }, 180_000);
});
