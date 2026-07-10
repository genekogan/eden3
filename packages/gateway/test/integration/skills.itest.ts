import { randomUUID } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { readOpenClawConfig, setAgentSkills } from '../../src/config-gen';
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

const AGENT_ID = 'itest-skill-probe';
const SKILL_SLUG = 'itest-skill-marker';
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

async function validateOpenClawConfig(): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await cli.exec(['config', 'validate'], { timeoutMs: 30_000 });
      return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(last);
}

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

describe('agent skills (live gateway)', () => {
  it('uses only enabled workspace skills during an agent turn', async () => {
    const marker = `EDEN3_SKILL_${randomUUID().slice(0, 8)}`;
    await provisioner.provisionAgent(
      {
        openclawId: AGENT_ID,
        name: 'Itest Skill Probe',
        username: AGENT_ID,
        description: 'Throwaway integration-test agent for skill allowlist projection.',
        persona:
          'You are a short-answer test agent. Do not invent secret markers. If a visible skill gives an exact marker instruction, follow it exactly.',
        greeting: 'ready',
        model: MODEL,
      },
      { force: true },
    );

    const skillDir = path.join(DATA_DIR, `workspace-${AGENT_ID}`, 'skills', SKILL_SLUG);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        `name: ${SKILL_SLUG}`,
        'description: Responds with a unique integration-test marker.',
        '---',
        '',
        '# Itest Skill Marker',
        '',
        `When the user asks "skill marker?", answer exactly "${marker}".`,
        'Do not add explanation, punctuation, or surrounding text.',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    await setAgentSkills(AGENT_ID, [], { dataDir: DATA_DIR });
    await validateOpenClawConfig();
    const disabled = await ask(
      'skill marker? If you do not have an enabled skill with an exact marker, reply with NO_SKILL.',
    );
    expect(disabled).not.toContain(marker);

    await setAgentSkills(AGENT_ID, [SKILL_SLUG], { dataDir: DATA_DIR });
    const toolsPath = path.join(DATA_DIR, `workspace-${AGENT_ID}`, 'TOOLS.md');
    const toolsBase = await fs.readFile(toolsPath, 'utf8');
    await fs.writeFile(
      toolsPath,
      [
        toolsBase.trimEnd(),
        '',
        '<!-- EDEN3_SKILLS_BEGIN -->',
        '## Enabled Eden Skills',
        '',
        'Follow these approved skill instructions when relevant to the user request.',
        '',
        `### Itest Skill Marker (${SKILL_SLUG})`,
        '',
        'Description: Responds with a unique integration-test marker.',
        '',
        `When the user asks "skill marker?", answer exactly "${marker}".`,
        'Do not add explanation, punctuation, or surrounding text.',
        '<!-- EDEN3_SKILLS_END -->',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    await validateOpenClawConfig();
    const config = await readOpenClawConfig(DATA_DIR);
    const entry = (config.agents as { list?: Record<string, unknown>[] }).list?.find(
      (item) => item.id === AGENT_ID,
    );
    expect(entry?.skills).toEqual([SKILL_SLUG]);

    const enabled = await ask('skill marker? Reply with only the marker from your enabled skill.');
    expect(enabled).toContain(marker);
  }, 240_000);
});
