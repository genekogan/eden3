import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { loadRootEnv, pg } from '@eden3/db';
import { CronSync, OpenClawCli } from '@eden3/gateway';
import type { AgentDto, TriggerDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultOpenclawDataDir } from '../../src/gateway-glue';
import { buildServer } from '../../src/server';
import { deleteFixturesByMarker, devCookie, insertUserAccount, makeMarker } from '../fixtures';

loadRootEnv();

/**
 * Integration: agents + tasks routes against the LIVE OpenClaw gateway
 * (docker eden3-openclaw, http://127.0.0.1:18789) and live Postgres.
 *
 * POST /agents provisions a REAL throwaway agent (random id, model haiku) and
 * verifies workspace render + routability; PATCH hot-re-renders SOUL.md;
 * POST/PATCH /tasks round-trip a REAL gateway cron job. Everything created is
 * torn down in afterAll (cron job, agent registration, workspace, db rows).
 *
 * Cron write ops need the container CLI device to hold the `operator.admin`
 * scope; when the gateway reports a pending scope upgrade, cron-dependent
 * assertions SKIP with the unblock command (same policy as the gateway
 * package's provisioner.itest.ts).
 */

const BASE_URL = (process.env.OPENCLAW_BASE_URL ?? 'http://127.0.0.1:18789').replace(/\/+$/, '');
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
const DATA_DIR = defaultOpenclawDataDir();

const marker = makeMarker('apigw');
const agentUsername = `apitest-${randomUUID().slice(0, 6)}`;
const SCOPE_BLOCK_RE = /scope upgrade|pairing required|operator\.admin/i;

let app: FastifyInstance;
let userId = '';
let taskId = '';

const cli = new OpenClawCli();
const cronSync = new CronSync({ cli });

beforeAll(async () => {
  if (TOKEN === '') {
    throw new Error(
      'OPENCLAW_GATEWAY_TOKEN is not set (env or repo-root .env) — cannot reach the gateway',
    );
  }
  userId = await insertUserAccount(`${marker}_user`);
  app = await buildServer(); // REAL provisioner + cron-sync (lazy defaults)
  await app.ready();
});

afterAll(async () => {
  // Best-effort teardown, most-dependent first. Failures must not mask results.
  if (taskId !== '') {
    await cronSync.removeTrigger(taskId).catch(() => {});
  }
  await cli.execJson(['agents', 'delete', agentUsername, '--force']).catch(() => {});
  await fs
    .rm(path.join(DATA_DIR, `workspace-${agentUsername}`), { recursive: true, force: true })
    .catch(() => {});
  await pg`delete from triggers where user_id = ${userId}`.catch(() => {});
  await app?.close();
  // The itest agent references the marker user via owner_id — remove it first.
  await pg`
    delete from agents where account_id in (select id from accounts where username = ${agentUsername})
  `;
  await pg`delete from accounts where username = ${agentUsername}`;
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('POST /agents (live gateway provisioning)', () => {
  it('provisions a routable agent with a fully rendered workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie: devCookie(userId) },
      payload: {
        username: agentUsername,
        name: 'Api Itest Agent',
        description: 'Throwaway api integration-test agent (safe to delete)',
        persona: 'You are Api Itest Agent. Reply with one word when possible.',
        greeting: 'ready',
      },
    });
    expect(res.statusCode).toBe(201);
    const { agent } = res.json() as { agent: AgentDto };
    expect(agent.username).toBe(agentUsername);
    expect(agent.provisionStatus).toBe('ready');

    // Workspace rendered on the host, no placeholder leakage.
    const soul = await fs.readFile(
      path.join(DATA_DIR, `workspace-${agentUsername}`, 'SOUL.md'),
      'utf8',
    );
    expect(soul).toContain('Api Itest Agent');
    expect(soul).toContain('Reply with one word when possible.');
    expect(soul).not.toMatch(/\{\{[A-Z_]+\}\}/);

    // Routable via /v1/models (raw fetch — the provisioner already polled).
    const models = await fetch(`${BASE_URL}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(models.status).toBe(200);
    const body = (await models.json()) as { data: { id: string }[] };
    expect(body.data.map((m) => m.id)).toContain(`openclaw/${agentUsername}`);

    // provision_status + workspace_path persisted.
    const [row] = await pg<{ provision_status: string; workspace_path: string | null }[]>`
      select g.provision_status, g.workspace_path
      from agents g join accounts a on a.id = g.account_id
      where a.username = ${agentUsername}
    `;
    expect(row!.provision_status).toBe('ready');
    expect(row!.workspace_path).toBe(path.join(DATA_DIR, `workspace-${agentUsername}`));
  }, 120_000);

  it('PATCH hot re-renders the persona into SOUL.md', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentUsername}`,
      headers: { cookie: devCookie(userId) },
      payload: { persona: 'You are Api Itest Agent, REVISED EDITION.' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { agent: AgentDto }).agent.persona).toBe(
      'You are Api Itest Agent, REVISED EDITION.',
    );
    const soul = await fs.readFile(
      path.join(DATA_DIR, `workspace-${agentUsername}`, 'SOUL.md'),
      'utf8',
    );
    expect(soul).toContain('REVISED EDITION');
  }, 60_000);
});

describe('POST/PATCH /tasks (live gateway cron)', () => {
  it('creates a trigger and reconciles a real cron job, then removes it', async (ctx) => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Itest daily ping',
        prompt: 'Integration-test trigger — reply with one word.',
        schedule: { hour: 5, minute: 0, timezone: 'UTC' },
      },
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json() as { task: TriggerDto };
    taskId = task.id;
    expect(task.status).toBe('active');

    const [row] = await pg<{ openclaw_job_id: string | null; last_error: string | null }[]>`
      select openclaw_job_id, last_error from triggers where id = ${task.id}
    `;
    if (row!.last_error !== null && SCOPE_BLOCK_RE.test(row!.last_error)) {
      console.warn(
        '[agents-tasks.itest] SKIPPED cron assertions: the container CLI device lacks the ' +
          'operator.admin scope. Unblock once with:\n' +
          '  docker exec eden3-openclaw openclaw devices list\n' +
          '  docker exec eden3-openclaw openclaw devices approve <requestId>\n' +
          'then rerun pnpm --filter @eden3/api test:integration',
      );
      ctx.skip();
      return;
    }
    expect(row!.last_error).toBeNull();
    expect(row!.openclaw_job_id).toBeTruthy();

    // The job is live on the gateway under the eden3: name.
    const names = (await cronSync.listEdenJobs()).map((j) => j.name);
    expect(names).toContain(`eden3:${task.id}`);

    // Pause -> job removed from the gateway.
    const paused = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { status: 'paused' },
    });
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as { task: TriggerDto }).task.status).toBe('paused');
    const afterPause = (await cronSync.listEdenJobs()).map((j) => j.name);
    expect(afterPause).not.toContain(`eden3:${task.id}`);

    // Resume -> job re-added; delete -> removed again.
    const resumed = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { status: 'active' },
    });
    expect(resumed.statusCode).toBe(200);
    const afterResume = (await cronSync.listEdenJobs()).map((j) => j.name);
    expect(afterResume).toContain(`eden3:${task.id}`);

    const deleted = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { deleted: true },
    });
    expect(deleted.statusCode).toBe(200);
    const afterDelete = (await cronSync.listEdenJobs()).map((j) => j.name);
    expect(afterDelete).not.toContain(`eden3:${task.id}`);
  }, 180_000);
});
