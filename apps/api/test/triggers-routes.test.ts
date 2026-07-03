import { loadRootEnv, pg } from '@eden3/db';
import type { TriggerDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertUserAccount,
  makeFakeCronSync,
  makeFakeProvisioner,
  makeMarker,
  type FakeCronSync,
} from './fixtures';

loadRootEnv();

/**
 * Tasks (triggers) API against live Postgres with a FAKE cron-sync (the real
 * gateway CLI path is exercised by test/integration/agents-tasks.itest.ts).
 */

const marker = makeMarker('taskapi');
const agentUsername = `${marker}_bot`;
let userId = '';
let otherUserId = '';

let app: FastifyInstance;
let fakeCron: FakeCronSync;

interface TaskBody {
  task: TriggerDto;
}
interface TaskList {
  items: TriggerDto[];
  nextCursor: string | null;
}

const schedule = { hour: 9, minute: 30, timezone: 'UTC' };

beforeAll(async () => {
  userId = await insertUserAccount(`${marker}_user`);
  otherUserId = await insertUserAccount(`${marker}_other`);
  await insertAgentAccount(agentUsername, {
    ownerId: userId,
    name: 'Task Bot',
    public: true,
    openclawId: `${marker}bot`.replace(/_/g, '-'),
  });

  fakeCron = makeFakeCronSync();
  app = await buildServer({
    provisioning: { provisioner: makeFakeProvisioner(), cronSync: fakeCron },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('POST /tasks', () => {
  it('401s anonymous requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { agentUsername, name: 'x', prompt: 'y', schedule },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates the trigger row and syncs a gateway cron job', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Morning digest',
        prompt: 'Summarize the news.',
        schedule,
      },
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json() as TaskBody;
    expect(task.name).toBe('Morning digest');
    expect(task.status).toBe('active');
    expect(task.userId).toBe(userId);
    expect(task.schedule).toMatchObject(schedule);

    const call = fakeCron.calls.find((c) => c.triggerId === task.id);
    expect(call).toBeDefined();
    expect(call).toMatchObject({
      cronExpr: '30 9 * * *',
      tz: 'UTC',
      prompt: 'Summarize the news.',
      enabled: true,
      openclawAgentId: `${marker}bot`.replace(/_/g, '-'),
    });

    const [row] = await pg<{ openclaw_job_id: string | null; last_synced_at: string | null }[]>`
      select openclaw_job_id, last_synced_at from triggers where id = ${task.id}
    `;
    expect(row!.openclaw_job_id).toBe(`fake-job-${task.id.slice(0, 8)}`);
    expect(row!.last_synced_at).not.toBeNull();
  });

  it('supports weekly day names and apscheduler day numbers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Weekly',
        prompt: 'weekly check',
        schedule: { hour: 8, minute: 0, day_of_week: 'mon', timezone: 'America/New_York' },
      },
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json() as TaskBody;
    const call = fakeCron.calls.find((c) => c.triggerId === task.id)!;
    expect(call.cronExpr).toBe('0 8 * * mon');
    expect(call.tz).toBe('America/New_York');
  });

  it('400s invalid schedules via scheduleToCron validation', async () => {
    for (const bad of [
      { hour: 99, minute: 0 },
      { hour: 9 }, // minute required
      { hour: 9, minute: 'sixty' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: { cookie: devCookie(userId) },
        payload: { agentUsername, name: 'bad', prompt: 'bad', schedule: bad },
      });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('404s unknown agents', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: { agentUsername: `${marker}_nobody`, name: 'x', prompt: 'y', schedule },
    });
    expect(res.statusCode).toBe(404);
  });

  it('records the failure (201, last_error) when cron-sync throws', async () => {
    const failingCron = makeFakeCronSync({ fail: true });
    const app2 = await buildServer({
      provisioning: { provisioner: makeFakeProvisioner(), cronSync: failingCron },
    });
    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/tasks',
        headers: { cookie: devCookie(userId) },
        payload: { agentUsername, name: 'Doomed', prompt: 'z', schedule },
      });
      expect(res.statusCode).toBe(201);
      const { task } = res.json() as TaskBody;
      const [row] = await pg<{ last_error: string | null; error_count: number | null }[]>`
        select last_error, error_count from triggers where id = ${task.id}
      `;
      expect(row!.last_error).toContain('fake cron-sync failure');
      expect(row!.error_count).toBe(1);
    } finally {
      await app2.close();
    }
  });
});

describe('GET /tasks', () => {
  it('401s anonymous and lists only the caller\'s triggers', async () => {
    expect((await app.inject({ method: 'GET', url: '/tasks' })).statusCode).toBe(401);

    const mine = (
      await app.inject({ method: 'GET', url: '/tasks', headers: { cookie: devCookie(userId) } })
    ).json() as TaskList;
    expect(mine.items.length).toBeGreaterThanOrEqual(2);
    expect(mine.items.every((t) => t.userId === userId)).toBe(true);

    const theirs = (
      await app.inject({
        method: 'GET',
        url: '/tasks',
        headers: { cookie: devCookie(otherUserId) },
      })
    ).json() as TaskList;
    expect(theirs.items).toEqual([]);
  });
});

describe('PATCH /tasks/:id', () => {
  async function createTask(): Promise<TriggerDto> {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: { agentUsername, name: 'Toggler', prompt: 'toggle me', schedule },
    });
    return (res.json() as TaskBody).task;
  }

  it('pauses (cron removed) and resumes (cron re-added)', async () => {
    const task = await createTask();

    const paused = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { status: 'paused' },
    });
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as TaskBody).task.status).toBe('paused');
    const pauseCall = fakeCron.calls.filter((c) => c.triggerId === task.id).at(-1)!;
    expect(pauseCall.enabled).toBe(false);

    const resumed = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { status: 'active' },
    });
    expect((resumed.json() as TaskBody).task.status).toBe('active');
    const resumeCall = fakeCron.calls.filter((c) => c.triggerId === task.id).at(-1)!;
    expect(resumeCall).toMatchObject({ enabled: true, cronExpr: '30 9 * * *' });
  });

  it('soft-deletes (cron removed, gone from the list)', async () => {
    const task = await createTask();
    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { deleted: true },
    });
    expect(res.statusCode).toBe(200);
    const lastCall = fakeCron.calls.filter((c) => c.triggerId === task.id).at(-1)!;
    expect(lastCall.enabled).toBe(false);

    const mine = (
      await app.inject({ method: 'GET', url: '/tasks', headers: { cookie: devCookie(userId) } })
    ).json() as TaskList;
    expect(mine.items.find((t) => t.id === task.id)).toBeUndefined();

    // A deleted task 404s on further PATCHes.
    const again = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { status: 'active' },
    });
    expect(again.statusCode).toBe(404);
  });

  it('403s non-owners and 404s unknown ids; 400s empty patches', async () => {
    const task = await createTask();
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/tasks/${task.id}`,
          headers: { cookie: devCookie(otherUserId) },
          payload: { status: 'paused' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/tasks/00000000-0000-4000-8000-000000000000`,
          headers: { cookie: devCookie(userId) },
          payload: { status: 'paused' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/tasks/${task.id}`,
          headers: { cookie: devCookie(userId) },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });
});
