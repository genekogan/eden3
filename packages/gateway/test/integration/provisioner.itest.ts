import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { CronSync, scheduleToCron } from '../../src/cron-sync';
import { OpenClawCli, OpenClawCliError } from '../../src/docker';
import { AgentProvisioner, BOOTSTRAP_FILENAME, WORKSPACE_STATE_FILENAME } from '../../src/provisioner';

/**
 * Integration test against the LIVE OpenClaw gateway (docker eden3-openclaw,
 * http://127.0.0.1:18789). Provisions the throwaway agent "itest-scratch"
 * (haiku — cheap) and leaves it provisioned on purpose (harmless, and makes
 * reruns exercise the idempotent path).
 *
 * The cron section needs the container CLI device to hold the
 * `operator.admin` scope (gateway WS write ops). When the gateway reports a
 * pending scope upgrade instead, those tests SKIP with the unblock command:
 *   docker exec eden3-openclaw openclaw devices list
 *   docker exec eden3-openclaw openclaw devices approve <requestId>
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const envFile = path.join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides real env

const BASE_URL = (process.env.OPENCLAW_BASE_URL ?? 'http://127.0.0.1:18789').replace(/\/+$/, '');
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
const DATA_DIR =
  process.env.OPENCLAW_DATA_DIR !== undefined && process.env.OPENCLAW_DATA_DIR !== ''
    ? path.resolve(process.env.OPENCLAW_DATA_DIR)
    : path.join(REPO_ROOT, 'infra', 'openclaw', 'data');

const AGENT_ID = 'itest-scratch';
const MODEL = 'anthropic/claude-haiku-4-5';
const TRIGGER_ID = 'itest-dummy';

const SCOPE_BLOCK_RE = /scope upgrade|pairing required/i;

const cli = new OpenClawCli();
const provisioner = new AgentProvisioner({
  gateway: { baseUrl: BASE_URL, token: TOKEN },
  cli,
  dataDir: DATA_DIR,
});
const cronSync = new CronSync({ cli });

beforeAll(() => {
  if (TOKEN === '') {
    throw new Error(
      'OPENCLAW_GATEWAY_TOKEN is not set (env or repo-root .env) — cannot reach the gateway',
    );
  }
});

describe('provisioner (live gateway)', () => {
  it('provisions itest-scratch: workspace rendered, registered, routable', async () => {
    const result = await provisioner.provisionAgent(
      {
        openclawId: AGENT_ID,
        name: 'Itest Scratch',
        username: 'itest-scratch',
        description: 'Throwaway integration-test agent (safe to ignore)',
        persona:
          'You are Itest Scratch, a minimal test agent. Answer as briefly as possible; one word when possible.',
        greeting: 'ready',
        model: MODEL,
        memorySeed: '- Provisioned by provisioner.itest.ts.',
      },
      { force: true },
    );

    expect(['added', 'existing']).toContain(result.registration);
    expect(result.filesWritten.length).toBeGreaterThanOrEqual(6); // content template set (state marker reported separately)
    expect(result.filesSkipped).toEqual([]);
    expect(result.bootstrapSuppressed).toBe(true);

    // host workspace: OUR persona rendered over the seed, no placeholder leakage,
    // no leftover generic default from `agents add`.
    const soul = await fs.readFile(path.join(result.hostWorkspaceDir, 'SOUL.md'), 'utf8');
    expect(soul).toContain('# Itest Scratch');
    expect(soul).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(soul).not.toContain("You're not a chatbot"); // OpenClaw's seeded default persona

    // bootstrap-suppression marker present with the load-bearing setupCompletedAt key
    const state = JSON.parse(
      await fs.readFile(path.join(result.hostWorkspaceDir, WORKSPACE_STATE_FILENAME), 'utf8'),
    ) as { version: number; setupCompletedAt: string };
    expect(state.version).toBe(1);
    expect(typeof state.setupCompletedAt).toBe('string');
    expect(new Date(state.setupCompletedAt).getTime()).toBeGreaterThan(0);

    // the seeded first-run ritual file is gone (belt-and-suspenders suppression)
    await expect(
      fs.access(path.join(result.hostWorkspaceDir, BOOTSTRAP_FILENAME)),
    ).rejects.toThrow();

    // registered with the CLI (canonical agents.list view)
    const agents = await cli.execJson<{ id: string; model?: string }[]>(['agents', 'list']);
    const entry = agents.find((a) => a.id === AGENT_ID);
    expect(entry).toBeDefined();
    expect(entry!.model).toBe(MODEL);
  });

  it('lists openclaw/itest-scratch in /v1/models (raw fetch)', async () => {
    const res = await fetch(`${BASE_URL}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((m) => m.id)).toContain(`openclaw/${AGENT_ID}`);
  });

  it('re-provisioning without force skips existing files', async () => {
    const result = await provisioner.provisionAgent({
      openclawId: AGENT_ID,
      name: 'Itest Scratch',
      username: 'itest-scratch',
      description: 'Throwaway integration-test agent (safe to ignore)',
      persona: 'You are Itest Scratch, a minimal test agent.',
      greeting: 'ready',
      model: MODEL,
    });
    expect(result.registration).toBe('existing');
    expect(result.filesWritten).toEqual([]); // content untouched (idempotent)
    expect(result.filesSkipped.length).toBeGreaterThanOrEqual(6);
    expect(result.bootstrapSuppressed).toBe(true); // marker re-asserted even on skip
    const state = JSON.parse(
      await fs.readFile(path.join(result.hostWorkspaceDir, WORKSPACE_STATE_FILENAME), 'utf8'),
    ) as { setupCompletedAt?: string };
    expect(typeof state.setupCompletedAt).toBe('string');
  });

  it('answers one cheap chat turn (raw fetch, non-stream)', async () => {
    const sessionKey = `agent:${AGENT_ID}:eden3:s:${randomUUID()}`;
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-openclaw-session-key': sessionKey,
      },
      body: JSON.stringify({
        model: `openclaw/${AGENT_ID}`,
        user: sessionKey,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices?: { message?: { role?: string; content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    expect(typeof content).toBe('string');
    expect(content!.length).toBeGreaterThan(0);
    expect(content).toMatch(/pong/i);
  }, 120_000);
});

describe('cron sync (live gateway)', () => {
  const { cron, tz } = scheduleToCron({ hour: 5, minute: 0, timezone: 'UTC' });
  const trigger = {
    triggerId: TRIGGER_ID,
    openclawAgentId: AGENT_ID,
    cronExpr: cron, // "0 5 * * *"
    ...(tz !== undefined ? { tz } : {}),
    prompt: 'Integration-test dummy trigger — reply with one word.',
    enabled: true,
  };

  it('cron list works (read scope)', async () => {
    const jobs = await cronSync.listJobs();
    expect(Array.isArray(jobs)).toBe(true);
  });

  it('add + list + rm round-trip for a dummy trigger', async (ctx) => {
    let created;
    try {
      created = await cronSync.syncTrigger(trigger);
    } catch (err) {
      if (err instanceof OpenClawCliError && SCOPE_BLOCK_RE.test(err.message)) {
        console.warn(
          '[provisioner.itest] SKIPPED cron add/rm: the container CLI device lacks the ' +
            'operator.admin scope (gateway reports a pending scope-upgrade request). Unblock once with:\n' +
            '  docker exec eden3-openclaw openclaw devices list\n' +
            '  docker exec eden3-openclaw openclaw devices approve <requestId>\n' +
            'then rerun pnpm --filter @eden3/gateway test:integration',
        );
        ctx.skip();
        return;
      }
      throw err;
    }

    expect(['created', 'replaced']).toContain(created.action);

    // visible in the list under the eden3: prefix
    const jobs = await cronSync.listEdenJobs();
    const names = jobs.map((j) => j.name);
    expect(names).toContain(`eden3:${TRIGGER_ID}`);

    // second sync converges (unchanged or replaced — never a duplicate)
    await cronSync.syncTrigger(trigger);
    const dupes = (await cronSync.listEdenJobs()).filter(
      (j) => j.name === `eden3:${TRIGGER_ID}`,
    );
    expect(dupes).toHaveLength(1);

    // disable → removed from the gateway
    const removed = await cronSync.syncTrigger({ ...trigger, enabled: false });
    expect(removed.action).toBe('removed');
    const after = (await cronSync.listEdenJobs()).map((j) => j.name);
    expect(after).not.toContain(`eden3:${TRIGGER_ID}`);
  }, 120_000);
});
