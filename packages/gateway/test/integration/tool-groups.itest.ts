import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { OpenClawCli } from '../../src/docker';
import { readOpenClawConfig, setAgentToolGroups } from '../../src/config-gen';
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

const AGENT_ID = 'itest-tool-groups';
const MODEL = 'anthropic/claude-haiku-4-5';

const cli = new OpenClawCli();
const provisioner = new AgentProvisioner({
  gateway: { baseUrl: BASE_URL, token: TOKEN },
  cli,
  dataDir: DATA_DIR,
});

async function validateOpenClawConfig(): Promise<string> {
  let last = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const validation = await cli.exec(['config', 'validate'], { timeoutMs: 30_000 });
      return validation.stdout + validation.stderr;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(last);
}

beforeAll(() => {
  if (TOKEN === '') {
    throw new Error(
      'OPENCLAW_GATEWAY_TOKEN is not set (env or repo-root .env) — cannot reach the gateway',
    );
  }
});

describe('agent tool groups (live gateway)', () => {
  it('writes a per-agent tools.allow list without invalidating OpenClaw config', async () => {
    await provisioner.provisionAgent(
      {
        openclawId: AGENT_ID,
        name: 'Itest Tool Groups',
        username: AGENT_ID,
        description: 'Throwaway integration-test agent for tool allowlist projection.',
        persona: 'You are a short-answer test agent.',
        greeting: 'ready',
        model: MODEL,
      },
      { force: true },
    );

    await setAgentToolGroups(AGENT_ID, ['group:runtime', 'group:media'], { dataDir: DATA_DIR });

    const config = await readOpenClawConfig(DATA_DIR);
    const agents = config.agents as { list?: Record<string, unknown>[] } | undefined;
    const entry = agents?.list?.find((item) => item.id === AGENT_ID);
    expect(entry).toBeDefined();
    expect((entry!.tools as Record<string, unknown>).allow).toEqual([
      'group:runtime',
      'group:media',
      'tts',
    ]);

    expect(await validateOpenClawConfig()).toMatch(/valid/i);
  }, 120_000);
});
