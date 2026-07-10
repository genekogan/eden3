import { credit, resetEnvCache } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { GatewayTurnEvent } from '@eden3/gateway';
import type { TriggerDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import type { ToolsClientLike } from '../src/services/history-sync';
import type { CompatClientLike } from '../src/services/turns';
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
let compatCalls: Array<{ agentId: string; sessionKey: string; userMessage: string }> = [];

interface TaskBody {
  task: TriggerDto;
}
interface TaskList {
  items: TriggerDto[];
  nextCursor: string | null;
}
interface TaskRunBody {
  run: {
    triggerId: string;
    sessionId: string;
    outcome: { turnId: string; userMessageId: string; assistantMessageId: string | null; errorCode: string | null };
    lastRunTime: string;
  };
}

const schedule = { hour: 9, minute: 30, timezone: 'UTC' };
const emptyTools: ToolsClientLike = {
  sessionsHistory: async () => ({
    sessionKey: '',
    messages: [],
    truncated: false,
    contentTruncated: false,
  }),
};
// When set, chatTurn blocks before completing — lets tests hold a run
// mid-flight to prove concurrency behavior deterministically.
let turnGate: Promise<void> | null = null;

const fakeCompat: CompatClientLike = {
  async *chatTurn(params): AsyncGenerator<GatewayTurnEvent, void, void> {
    compatCalls.push(params);
    yield { type: 'turn.started' };
    yield { type: 'token', delta: 'scheduled ' };
    if (turnGate) await turnGate;
    yield {
      type: 'turn.completed',
      text: 'scheduled done',
      emptyTurn: false,
      finishReason: 'stop',
      usage: {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
      },
    };
  },
};

async function spendCount(accountId: string): Promise<number> {
  const [row] = await pg<{ count: string }[]>`
    select count(*)::text as count
    from manna_transactions mt
    join manna_accounts ma on ma.id = mt.manna_account_id
    where ma.account_id = ${accountId}
      and mt.type like 'spend%'
  `;
  return Number(row?.count ?? 0);
}

function withEnv(name: string, value: string): () => void {
  const original = process.env[name];
  process.env[name] = value;
  resetEnvCache();
  return () => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
    resetEnvCache();
  };
}

beforeAll(async () => {
  userId = await insertUserAccount(`${marker}_user`);
  otherUserId = await insertUserAccount(`${marker}_other`);
  await insertAgentAccount(agentUsername, {
    ownerId: userId,
    name: 'Task Bot',
    public: true,
    openclawId: `${marker}bot`.replace(/_/g, '-'),
    provisionStatus: 'ready',
  });
  await credit({
    accountId: userId,
    amount: 100,
    type: 'credit:test',
    idempotencyKey: `${marker}:credit`,
  });

  fakeCron = makeFakeCronSync();
  app = await buildServer({
    gateway: { compat: fakeCompat, tools: emptyTools },
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

  it('429s before insert/cron-sync when the scheduled-task quota is exhausted', async () => {
    const restore = withEnv('MAX_SCHEDULED_TASKS_PER_USER', '0');
    const beforeCalls = fakeCron.calls.length;
    const [beforeRows] = await pg<{ count: string }[]>`
      select count(*)::text as count from triggers where name = ${`${marker} quota blocked`}
    `;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: { cookie: devCookie(userId) },
        payload: {
          agentUsername,
          name: `${marker} quota blocked`,
          prompt: 'should not insert',
          schedule,
        },
      });
      expect(res.statusCode).toBe(429);
      expect((res.json() as { error: { code: string } }).error.code).toBe('task_quota_exceeded');
      expect(fakeCron.calls).toHaveLength(beforeCalls);
      const [afterRows] = await pg<{ count: string }[]>`
        select count(*)::text as count from triggers where name = ${`${marker} quota blocked`}
      `;
      expect(Number(afterRows!.count)).toBe(Number(beforeRows!.count));
    } finally {
      restore();
    }
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

  it('does not spend while idle; firing a task records a session output and metered spend', async () => {
    const beforeCreateSpend = await spendCount(userId);
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Fire me',
        prompt: 'Run the scheduled practice.',
        schedule,
      },
    });
    expect(created.statusCode).toBe(201);
    const { task } = created.json() as TaskBody;
    expect(await spendCount(userId)).toBe(beforeCreateSpend);

    const beforeRunCalls = compatCalls.length;
    const fired = await app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/runs`,
      headers: { cookie: devCookie(userId) },
    });
    expect(fired.statusCode).toBe(201);
    const { run } = fired.json() as TaskRunBody;
    expect(run.triggerId).toBe(task.id);
    expect(run.outcome.errorCode).toBeNull();
    expect(run.outcome.assistantMessageId).toEqual(expect.any(String));
    expect(Date.parse(run.lastRunTime)).not.toBeNaN();

    const call = compatCalls.at(-1)!;
    expect(compatCalls).toHaveLength(beforeRunCalls + 1);
    expect(call).toMatchObject({
      agentId: `${marker}bot`.replace(/_/g, '-'),
      userMessage: 'Run the scheduled practice.',
    });
    expect(call.sessionKey).toContain(run.sessionId);

    const transcript = await pg<{ role: string; content: string | null; name: string | null }[]>`
      select role, content, name
      from messages
      where session_id = ${run.sessionId}
      order by created_at asc
    `;
    expect(transcript.map((row) => [row.role, row.content])).toEqual([
      ['user', 'Run the scheduled practice.'],
      ['assistant', 'scheduled done'],
    ]);

    const [triggerRow] = await pg<
      { last_run_time: string | null; last_error: string | null; status: string | null }[]
    >`
      select last_run_time, last_error, status from triggers where id = ${task.id}
    `;
    expect(triggerRow).toMatchObject({
      last_error: null,
      status: 'active',
    });
    expect(triggerRow!.last_run_time).not.toBeNull();

    const [usage] = await pg<{ status: string; metadata: { source?: { triggerId?: string } } | null }[]>`
      select status, metadata
      from usage_events
      where turn_id = ${run.outcome.turnId}
    `;
    expect(usage).toMatchObject({ status: 'completed' });
    expect(usage!.metadata?.source).toMatchObject({
      kind: 'scheduled_task',
      triggerId: task.id,
    });
    expect(await spendCount(userId)).toBeGreaterThan(beforeCreateSpend);

    const listed = (
      await app.inject({ method: 'GET', url: '/tasks', headers: { cookie: devCookie(userId) } })
    ).json() as TaskList;
    const listedTask = listed.items.find((item) => item.id === task.id);
    expect(typeof listedTask?.lastRunTime).toBe('string');
    expect(Date.parse(listedTask!.lastRunTime!)).not.toBeNaN();
    expect(listedTask?.lastError).toBeNull();
  });

  it('rejects a concurrent second fire of the same task (atomic running claim)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'No double fire',
        prompt: 'Run once at a time.',
        schedule,
      },
    });
    expect(created.statusCode).toBe(201);
    const { task } = created.json() as TaskBody;

    // Hold the first run mid-turn, then fire again while it's running.
    let releaseGate!: () => void;
    turnGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    try {
      const first = app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/runs`,
        headers: { cookie: devCookie(userId) },
      });
      // Wait until the first run has actually claimed the task.
      await expect
        .poll(
          async () => {
            const [row] = await pg<{ status: string }[]>`
              select status from triggers where id = ${task.id}`;
            return row?.status;
          },
          { timeout: 5000 },
        )
        .toBe('running');

      const second = await app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/runs`,
        headers: { cookie: devCookie(userId) },
      });
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: { code: string } }).error.code).toBe('task_not_active');

      releaseGate();
      const firstRes = await first;
      expect(firstRes.statusCode).toBe(201);
    } finally {
      turnGate = null;
    }

    const [row] = await pg<{ status: string }[]>`
      select status from triggers where id = ${task.id}`;
    expect(row?.status).toBe('active');
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

  it('edits name, prompt, and schedule, then resyncs the active cron job', async () => {
    const task = await createTask();
    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: {
        name: 'Edited task',
        prompt: 'edited prompt',
        schedule: { hour: 14, minute: 5, day_of_week: 'fri', timezone: 'America/New_York' },
      },
    });
    expect(res.statusCode).toBe(200);
    const edited = (res.json() as TaskBody).task;
    expect(edited).toMatchObject({
      id: task.id,
      name: 'Edited task',
      prompt: 'edited prompt',
      status: 'active',
    });
    expect(edited.schedule).toMatchObject({
      hour: 14,
      minute: 5,
      day_of_week: 'fri',
      timezone: 'America/New_York',
    });
    const editCall = fakeCron.calls.filter((c) => c.triggerId === task.id).at(-1)!;
    expect(editCall).toMatchObject({
      enabled: true,
      cronExpr: '5 14 * * fri',
      tz: 'America/New_York',
      prompt: 'edited prompt',
    });
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
