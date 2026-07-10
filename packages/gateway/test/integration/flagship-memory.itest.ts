import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { OpenClawCli } from '../../src/docker';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const envFile = path.join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides real env

const DATA_DIR =
  process.env.OPENCLAW_DATA_DIR !== undefined && process.env.OPENCLAW_DATA_DIR !== ''
    ? path.resolve(process.env.OPENCLAW_DATA_DIR)
    : path.join(REPO_ROOT, 'infra', 'openclaw', 'data');
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
const AGENT_ID = 'abraham';

const cli = new OpenClawCli();

type AgentCliResult = {
  status?: string;
  result?: {
    payloads?: Array<{ text?: string | null }>;
  };
};

async function askAbraham(message: string): Promise<string> {
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

describe('flagship memory (live gateway)', () => {
  it('abraham references a real fact from production migrated memory', async () => {
    const memoryPath = path.join(DATA_DIR, `workspace-${AGENT_ID}`, 'MEMORY.md');
    const memory = await fs.readFile(memoryPath, 'utf8');
    expect(memory).toContain('#254');
    expect(memory).toContain('The Long Table');

    const answer = await askAbraham(
      'According to your long-term memory, what is the title of Creation #254? Reply with only the title.',
    );
    expect(answer).toContain('The Long Table');
  }, 180_000);
});
