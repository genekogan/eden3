import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { loadRootEnv, pg } from '@eden3/db';
import { CronSync, OpenClawCli, withOpenClawConfigLock } from '@eden3/gateway';
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
 * verifies workspace render + routability; PATCH hot-re-renders SOUL.md.
 *
 * Tasks: scheduled firing is EDEN3-SIDE now (services/task-scheduler.ts), so
 * the gateway must hold NO `eden3:<id>` cron job at any point — create only
 * ensures removal of stale jobs, and pause/resume/delete keep the gateway
 * clean. These assertions verify the retirement against the real gateway.
 * Everything created is torn down in afterAll (agent registration,
 * workspace, db rows).
 *
 * Cron ops (list/rm) need the container CLI device to hold the
 * `operator.admin` scope; when the gateway reports a pending scope upgrade,
 * cron-dependent assertions SKIP with the unblock command (same policy as
 * the gateway package's provisioner.itest.ts).
 */

const BASE_URL = (process.env.OPENCLAW_BASE_URL ?? 'http://127.0.0.1:18789').replace(/\/+$/, '');
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
const DATA_DIR = defaultOpenclawDataDir();

const marker = makeMarker('apigw');
const agentUsername = `apitest-${randomUUID().slice(0, 6)}`;
const importedAgentUsername = `apiimport-${randomUUID().slice(0, 6)}`;
const SCOPE_BLOCK_RE = /scope upgrade|pairing required|operator\.admin/i;

let app: FastifyInstance;
let userId = '';
let taskId = '';
let legacyTriggerId = '';

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
  if (legacyTriggerId !== '') {
    await cronSync.removeTrigger(legacyTriggerId).catch(() => {});
  }
  await withOpenClawConfigLock(DATA_DIR, async () => {
    await cli.execJson(['agents', 'delete', agentUsername, '--force']).catch(() => {});
    await cli.execJson(['agents', 'delete', importedAgentUsername, '--force']).catch(() => {});
  }).catch(() => {});
  await fs
    .rm(path.join(DATA_DIR, `workspace-${agentUsername}`), { recursive: true, force: true })
    .catch(() => {});
  await fs
    .rm(path.join(DATA_DIR, `workspace-${importedAgentUsername}`), { recursive: true, force: true })
    .catch(() => {});
  await pg`delete from triggers where user_id = ${userId}`.catch(() => {});
  await app?.close();
  // The itest agent references the marker user via owner_id — remove it first.
  await pg`
    delete from agents where account_id in (select id from accounts where username = ${agentUsername})
  `;
  await pg`delete from accounts where username = ${agentUsername}`;
  await pg`
    delete from agents where account_id in (select id from accounts where username = ${importedAgentUsername})
  `;
  await pg`delete from accounts where username = ${importedAgentUsername}`;
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

  it('exports and imports a real provisioned agent bundle', async () => {
    const exported = await app.inject({
      method: 'GET',
      url: `/agents/${agentUsername}/export`,
      headers: { cookie: devCookie(userId) },
    });
    expect(exported.statusCode).toBe(200);
    const bundle = (
      exported.json() as {
        bundle: {
          kind: 'eden3.agent.bundle';
          version: 1;
          agent: { persona: string; name: string; username: string };
        };
      }
    ).bundle;
    expect(bundle.kind).toBe('eden3.agent.bundle');
    expect(bundle.agent.persona).toContain('REVISED EDITION');

    const imported = await app.inject({
      method: 'POST',
      url: '/agents/import',
      headers: { cookie: devCookie(userId) },
      payload: { username: importedAgentUsername, bundle },
    });
    expect(imported.statusCode).toBe(201);
    const { agent } = imported.json() as { agent: AgentDto };
    expect(agent.username).toBe(importedAgentUsername);
    expect(agent.provisionStatus).toBe('ready');
    expect(agent.persona).toContain('REVISED EDITION');

    const soul = await fs.readFile(
      path.join(DATA_DIR, `workspace-${importedAgentUsername}`, 'SOUL.md'),
      'utf8',
    );
    expect(soul).toContain('Api Itest Agent');
    expect(soul).toContain('REVISED EDITION');

    const models = await fetch(`${BASE_URL}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(models.status).toBe(200);
    const body = (await models.json()) as { data: { id: string }[] };
    expect(body.data.map((m) => m.id)).toContain(`openclaw/${importedAgentUsername}`);
  }, 120_000);
});

describe('POST/PATCH /tasks (gateway cron retired — must stay clean)', () => {
  it('creates a trigger with NO gateway cron job; pause/resume/delete keep it absent', async (ctx) => {
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
    // Eden3-side scheduling is stamped regardless of gateway health.
    expect(task.nextScheduledRun).not.toBeNull();
    expect(Date.parse(task.nextScheduledRun!)).toBeGreaterThan(Date.now());

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
    expect(row!.openclaw_job_id).toBeNull();

    // The gateway holds NO job for this trigger — firing is eden3-side, and
    // a gateway job would double-fire (unmetered).
    const names = (await cronSync.listEdenJobs()).map((j) => j.name);
    expect(names).not.toContain(`eden3:${task.id}`);

    // Pause -> still absent.
    const paused = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { status: 'paused' },
    });
    expect(paused.statusCode).toBe(200);
    const pausedTask = (paused.json() as { task: TriggerDto }).task;
    expect(pausedTask.status).toBe('paused');
    expect(pausedTask.nextScheduledRun).toBeNull();
    const afterPause = (await cronSync.listEdenJobs()).map((j) => j.name);
    expect(afterPause).not.toContain(`eden3:${task.id}`);

    // Resume -> next run recomputed eden3-side, gateway still clean.
    const resumed = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { status: 'active' },
    });
    expect(resumed.statusCode).toBe(200);
    const resumedTask = (resumed.json() as { task: TriggerDto }).task;
    expect(resumedTask.nextScheduledRun).not.toBeNull();
    const afterResume = (await cronSync.listEdenJobs()).map((j) => j.name);
    expect(afterResume).not.toContain(`eden3:${task.id}`);

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

  it('removeAllEden3Jobs sweeps a manually planted legacy job (boot cleanup path)', async (ctx) => {
    // Plant a legacy-style job the way the retired sync used to, then prove
    // the scheduler's boot sweep removes it.
    legacyTriggerId = `legacy-${randomUUID().slice(0, 8)}`;
    try {
      await cronSync.syncTrigger({
        triggerId: legacyTriggerId,
        openclawAgentId: agentUsername,
        cronExpr: '0 5 * * *',
        tz: 'UTC',
        prompt: 'legacy planted job (safe to delete)',
        enabled: true,
      });
    } catch (err) {
      if (SCOPE_BLOCK_RE.test(err instanceof Error ? err.message : String(err))) {
        console.warn('[agents-tasks.itest] SKIPPED legacy-sweep assertions: scope upgrade pending');
        ctx.skip();
        return;
      }
      throw err;
    }
    const planted = (await cronSync.listEdenJobs()).map((j) => j.name);
    expect(planted).toContain(`eden3:${legacyTriggerId}`);

    await cronSync.removeAllEden3Jobs();
    const swept = (await cronSync.listEdenJobs()).map((j) => j.name);
    expect(swept).not.toContain(`eden3:${legacyTriggerId}`);
  }, 120_000);
});
