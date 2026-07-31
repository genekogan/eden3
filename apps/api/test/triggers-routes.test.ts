import { credit, debit, refund, refundIdempotencyKey, resetEnvCache } from '@eden3/core';
import { db, loadRootEnv, pg, triggers } from '@eden3/db';
import type { GatewayTurnEvent, GatewayUsage } from '@eden3/gateway';
import type { TriggerDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  automationLedgerKey,
  automationMannaSpendLastHour,
  automationRollingCap,
} from '../src/services/automation-budget';
import type { ToolsClientLike } from '../src/services/history-sync';
import {
  TaskScheduler,
  makeScheduledTaskRecoveryRunner,
  makeScheduledTaskRunner,
} from '../src/services/task-scheduler';
import {
  SCHEDULED_TASK_EMPTY_RESPONSE,
  SCHEDULED_TASK_INDETERMINATE,
  SCHEDULED_TASK_REFUND_PENDING,
  SCHEDULED_TASK_REFUND_PENDING_PREFIX,
  SCHEDULED_TASK_STALE_RECOVERY_PREFIX,
  runScheduledTask,
  scheduledTaskOccurrence,
} from '../src/services/scheduled-tasks';
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
 *
 * Scheduled firing is eden3-side now (services/task-scheduler.ts): creates
 * and edits stamp next_scheduled_run and only ever REMOVE gateway cron jobs
 * (a legacy `eden3:<id>` job would double-fire the task).
 */

/** Assert an ISO instant renders as the given wall-clock parts in a tz. */
function expectLocalParts(
  isoInstant: string,
  timezone: string,
  expected: { weekday?: string; hour: number; minute: number },
): void {
  const parts: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });
  for (const part of formatter.formatToParts(new Date(isoInstant))) {
    parts[part.type] = part.value;
  }
  if (expected.weekday !== undefined) expect(parts.weekday).toBe(expected.weekday);
  expect(Number(parts.hour)).toBe(expected.hour);
  expect(Number(parts.minute)).toBe(expected.minute);
}

const marker = makeMarker('taskapi');
const agentUsername = `${marker}_bot`;
let userId = '';
let otherUserId = '';
let agentId = '';

let app: FastifyInstance;
let fakeCron: FakeCronSync;
let compatCalls: Array<{ agentId: string; sessionKey: string; userMessage: string }> = [];
const automationSeedKeys: string[] = [];

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
const normalTurnUsage: GatewayUsage = {
  promptTokens: 10,
  completionTokens: 2,
  totalTokens: 12,
};
let turnUsage: GatewayUsage = normalTurnUsage;
let turnMode: 'normal' | 'provider_auth_error' | 'empty' = 'normal';

const fakeCompat: CompatClientLike = {
  async *chatTurn(params): AsyncGenerator<GatewayTurnEvent, void, void> {
    compatCalls.push(params);
    yield { type: 'turn.started' };
    if (turnMode === 'provider_auth_error') {
      yield {
        type: 'error',
        code: 'gateway_http_error',
        message: 'gateway responded 401 Unauthorized',
        status: 401,
      };
      return;
    }
    if (turnMode === 'empty') {
      yield {
        type: 'turn.completed',
        text: '',
        emptyTurn: true,
        finishReason: 'stop',
        usage: turnUsage,
      };
      return;
    }
    yield { type: 'token', delta: 'scheduled ' };
    if (turnGate) await turnGate;
    yield {
      type: 'turn.completed',
      text: 'scheduled done',
      emptyTurn: false,
      finishReason: 'stop',
      usage: turnUsage,
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
  agentId = await insertAgentAccount(agentUsername, {
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

// The production cap is per enabled task, not lifetime rows. Keep tests
// independent while retaining paused rows for GET/listing coverage.
afterEach(async () => {
  turnUsage = normalTurnUsage;
  turnMode = 'normal';
  for (const key of automationSeedKeys.splice(0)) {
    await refund({ originalIdempotencyKey: key, type: 'refund:test' });
  }
  await pg`
    update triggers
    set status = 'paused', next_scheduled_run = null
    where agent_id = ${agentId}
      and deleted = false
      and status in ('active', 'running')
  `;
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
    const beforeCalls = fakeCron.removals.length;
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
      expect(fakeCron.removals).toHaveLength(beforeCalls);
      const [afterRows] = await pg<{ count: string }[]>`
        select count(*)::text as count from triggers where name = ${`${marker} quota blocked`}
      `;
      expect(Number(afterRows!.count)).toBe(Number(beforeRows!.count));
    } finally {
      restore();
    }
  });

  it('enforces the hard ten-enabled-task limit per agent', async () => {
    for (let index = 0; index < 10; index += 1) {
      await pg`
        insert into triggers (
          user_id, agent_id, name, prompt, schedule, status,
          session_target, next_scheduled_run
        ) values (
          ${userId}, ${agentId}, ${`${marker} limit ${index}`}, 'limit fixture',
          ${JSON.stringify(schedule)}::jsonb, 'active', 'new', now() + interval '1 day'
        )
      `;
    }
    const beforeCalls = fakeCron.removals.length;
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: `${marker} eleventh`,
        prompt: 'must not be created',
        schedule,
      },
    });
    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'agent_task_limit_exceeded',
    );
    expect(fakeCron.removals).toHaveLength(beforeCalls);
  });

  it('creates the trigger row, stamps nextScheduledRun, and never adds a gateway job', async () => {
    const before = Date.now();
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
    expect(task.lastRunSessionId).toBeNull();

    // next_scheduled_run is real: the upcoming 09:30 UTC, in the future.
    expect(task.nextScheduledRun).not.toBeNull();
    const next = Date.parse(task.nextScheduledRun!);
    expect(next).toBeGreaterThan(before);
    expect(next).toBeLessThanOrEqual(before + 25 * 60 * 60 * 1000);
    expectLocalParts(task.nextScheduledRun!, 'UTC', { hour: 9, minute: 30 });

    // Gateway side: removal-only (a legacy eden3:<id> job would double-fire).
    expect(fakeCron.removals).toContain(task.id);
    const [row] = await pg<{ openclaw_job_id: string | null; last_synced_at: string | null }[]>`
      select openclaw_job_id, last_synced_at from triggers where id = ${task.id}
    `;
    expect(row!.openclaw_job_id).toBeNull();
    expect(row!.last_synced_at).not.toBeNull();
  });

  it('supports weekly day names and apscheduler day numbers with timezones', async () => {
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
    expect(task.nextScheduledRun).not.toBeNull();
    expectLocalParts(task.nextScheduledRun!, 'America/New_York', {
      weekday: 'Mon',
      hour: 8,
      minute: 0,
    });

    // APScheduler numbering: 4 = Friday.
    const numeric = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Weekly numeric',
        prompt: 'weekly check',
        schedule: { hour: 8, minute: 0, day_of_week: 4, timezone: 'UTC' },
      },
    });
    expect(numeric.statusCode).toBe(201);
    const numericTask = (numeric.json() as TaskBody).task;
    expectLocalParts(numericTask.nextScheduledRun!, 'UTC', {
      weekday: 'Fri',
      hour: 8,
      minute: 0,
    });
  });

  it('supports hourly schedules (hour "*")', async () => {
    const before = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Hourly',
        prompt: 'hourly check',
        schedule: { hour: '*', minute: 45, timezone: 'UTC' },
      },
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json() as TaskBody;
    const next = Date.parse(task.nextScheduledRun!);
    expect(next).toBeGreaterThan(before);
    expect(next).toBeLessThanOrEqual(before + 61 * 60 * 1000); // within the hour
    expect(new Date(next).getUTCMinutes()).toBe(45);
  });

  it('creates one-time {at} tasks with nextScheduledRun = that instant', async () => {
    const at = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'One shot',
        prompt: 'run once',
        schedule: { at },
      },
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json() as TaskBody;
    expect(task.status).toBe('active');
    expect(task.schedule).toEqual({ at });
    expect(task.nextScheduledRun).toBe(at);
  });

  it('400s invalid schedules (recurring fields, at shapes, past one-times)', async () => {
    for (const bad of [
      { hour: 99, minute: 0 },
      { hour: 9 }, // minute required
      { hour: 9, minute: 'sixty' },
      { at: 'not-a-timestamp' },
      { at: new Date(Date.now() - 60_000).toISOString() }, // already passed
      { at: new Date(Date.now() + 60_000).toISOString(), hour: 9, minute: 0 }, // ambiguous
      {},
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
    // The run's output session is linked on the task row (resolved from the
    // run's usage event).
    expect(listedTask?.lastRunSessionId).toBe(run.sessionId);
  });

  it('auto-pauses when actual metering no longer fits after the one-manna reservation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Settlement cap edge',
        prompt: 'Use enough context to cross the remaining automation budget.',
        schedule,
      },
    });
    expect(created.statusCode).toBe(201);
    const { task } = created.json() as TaskBody;

    // Leave exactly one manna of rolling-hour headroom. The initial reserve
    // succeeds; the 54-manna actual charge must then fail at settlement.
    await credit({
      accountId: userId,
      amount: 500,
      type: 'credit:test',
      idempotencyKey: `${marker}:settlement-cap-credit`,
    });
    const spent = await automationMannaSpendLastHour(agentId);
    expect(spent).toBeLessThan(79);
    const seedKey = automationLedgerKey(agentId, `test-seed-${task.id}`);
    await debit({
      accountId: userId,
      amount: 79 - spent,
      type: 'spend:chat',
      idempotencyKey: seedKey,
      rollingCap: automationRollingCap(agentId),
    });
    automationSeedKeys.push(seedKey);
    turnUsage = {
      promptTokens: 40_000,
      completionTokens: 0,
      totalTokens: 40_000,
    };
    await pg`
      update triggers
      set next_scheduled_run = ${new Date(Date.now() - 60_000).toISOString()}
      where id = ${task.id}
    `;

    const scheduler = new TaskScheduler({
      runTask: makeScheduledTaskRunner({
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        turnLimiter: app.turnLimiter,
      }),
      intervalMs: 0,
      restrictToTriggerIds: [task.id],
    });
    const tick = await scheduler.tick();
    expect(tick.outcomes).toContainEqual({ triggerId: task.id, outcome: 'failed' });

    const [row] = await pg<{
      status: string;
      next_scheduled_run: string | null;
      last_run_time: string | null;
      last_error: string | null;
      error_count: number;
    }[]>`
      select status, next_scheduled_run, last_run_time, last_error, error_count
      from triggers where id = ${task.id}
    `;
    expect(row).toMatchObject({
      status: 'paused',
      next_scheduled_run: null,
      error_count: 1,
    });
    expect(row!.last_run_time).not.toBeNull();
    expect(row!.last_error).toContain('automation rolling manna cap exceeded');

    const [usage] = await pg<{
      status: string;
      manna: number | null;
      session_id: string;
      error_code: string | null;
    }[]>`
      select status, manna, session_id, error_code
      from usage_events
      where metadata->'source'->>'triggerId' = ${task.id}
      order by created_at desc
      limit 1
    `;
    expect(usage).toMatchObject({
      status: 'error',
      manna: 0,
      error_code: 'automation_hourly_budget_exceeded',
    });
    const [assistantCount] = await pg<{ count: number }[]>`
      select count(*)::int as count from messages
      where session_id = ${usage!.session_id} and role = 'assistant'
    `;
    expect(assistantCount!.count).toBe(0);
    expect(await automationMannaSpendLastHour(agentId)).toBe(79);
  });

  it('counts a real provider/auth failure and auto-pauses at 20 consecutive occurrences', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Provider auth circuit breaker',
        prompt: 'This call will receive a provider auth error.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    await pg`
      update triggers
      set error_count = 19, next_scheduled_run = ${new Date(Date.now() - 30_000).toISOString()}
      where id = ${task.id}
    `;
    turnMode = 'provider_auth_error';
    const scheduler = new TaskScheduler({
      runTask: makeScheduledTaskRunner({
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        turnLimiter: app.turnLimiter,
      }),
      intervalMs: 0,
      restrictToTriggerIds: [task.id],
    });

    expect((await scheduler.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'failed',
    });
    const [row] = await pg<{ status: string; error_count: number; last_error: string }[]>`
      select status, error_count, last_error from triggers where id = ${task.id}
    `;
    expect(row).toMatchObject({ status: 'paused', error_count: 20 });
    expect(row!.last_error).toContain('gateway responded 401 Unauthorized');
  });

  it('does not advance a live or recovered provider failure until both refunds complete', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Provider failure refund retry',
        prompt: 'This call will receive a provider auth error.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const dueAt = new Date(Date.now() - 30_000);
    await pg`update triggers set next_scheduled_run = ${dueAt.toISOString()} where id = ${task.id}`;
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    const settlementKey = automationLedgerKey(agentId, occurrence.id, 'settle');
    const reservationKey = automationLedgerKey(agentId, occurrence.id);
    const attempts: string[] = [];
    turnMode = 'provider_auth_error';
    const callsBefore = compatCalls.length;
    const pendingScheduler = new TaskScheduler({
      runTask: makeScheduledTaskRunner({
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        turnLimiter: app.turnLimiter,
        refundLedger: async (params) => {
          attempts.push(params.originalIdempotencyKey);
          if (params.originalIdempotencyKey === settlementKey) {
            throw new Error('simulated refund verification outage');
          }
          return await refund(params);
        },
      }),
      intervalMs: 0,
      restrictToTriggerIds: [task.id],
    });

    expect((await pendingScheduler.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'retry',
    });
    expect(attempts).toEqual([settlementKey, reservationKey]);
    expect(compatCalls).toHaveLength(callsBefore + 1);
    const [pending] = await pg<{
      status: string;
      next_scheduled_run: string;
      last_run_time: string | null;
      last_error: string;
      error_count: number | null;
    }[]>`
      select status, next_scheduled_run, last_run_time, last_error, error_count
      from triggers where id = ${task.id}
    `;
    expect(pending!.status).toBe('active');
    expect(new Date(pending!.next_scheduled_run).getTime()).toBe(dueAt.getTime());
    expect(pending!.last_run_time).toBeNull();
    expect(pending!.error_count ?? 0).toBe(0);
    expect(pending!.last_error).toContain('refund pending');

    // The error usage row is now the recovery checkpoint. A healthy retry
    // refunds both keys idempotently and records the failure without replaying
    // the provider.
    const healthyScheduler = new TaskScheduler({
      runTask: makeScheduledTaskRunner({
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        turnLimiter: app.turnLimiter,
      }),
      intervalMs: 0,
      restrictToTriggerIds: [task.id],
    });
    expect((await healthyScheduler.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'failed',
    });
    expect(compatCalls).toHaveLength(callsBefore + 1);
    const [recovered] = await pg<{ last_run_time: string | null; error_count: number }[]>`
      select last_run_time, error_count from triggers where id = ${task.id}
    `;
    expect(recovered!.last_run_time).not.toBeNull();
    expect(recovered!.error_count).toBe(1);
  });

  it('persists and reuses the exact manual run identity until refunds finish', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Manual durable refund identity',
        prompt: 'This manual run will fail at the provider.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const [initial] = await db.select().from(triggers).where(eq(triggers.id, task.id)).limit(1);
    expect(initial).toBeDefined();
    turnMode = 'provider_auth_error';
    const callsBefore = compatCalls.length;

    await expect(
      runScheduledTask(
        {
          compat: fakeCompat,
          bus: app.eventsBus,
          registry: app.turnRegistry,
          historySync: app.historySync!,
          refundLedger: async (params) => {
            if (params.type === 'refund:chat:settle') {
              throw new Error('manual refund path unavailable');
            }
            return await refund(params);
          },
        },
        initial!,
      ),
    ).rejects.toMatchObject({ code: SCHEDULED_TASK_REFUND_PENDING });
    expect(compatCalls).toHaveLength(callsBefore + 1);

    const [pending] = await db.select().from(triggers).where(eq(triggers.id, task.id)).limit(1);
    expect(pending!.pendingOccurrenceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(pending!.pendingOccurrenceKind).toBe('manual');
    expect(pending!.pendingOccurrenceAt).toBeNull();

    // A retry proposes a fresh random run-now UUID internally, but the atomic
    // claim must recover the persisted UUID and never call the provider twice.
    await expect(
      runScheduledTask(
        {
          compat: fakeCompat,
          bus: app.eventsBus,
          registry: app.turnRegistry,
          historySync: app.historySync!,
        },
        pending!,
      ),
    ).rejects.toMatchObject({ code: 'gateway_http_error' });
    expect(compatCalls).toHaveLength(callsBefore + 1);
    const [recovered] = await db.select().from(triggers).where(eq(triggers.id, task.id)).limit(1);
    expect(recovered!.pendingOccurrenceId).toBeNull();
    expect(recovered!.pendingOccurrenceKind).toBeNull();
  });

  it('keeps a thrown scheduled failure due while refund verification is unavailable', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Thrown failure refund retry',
        prompt: 'Do not checkpoint before refund verification.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const dueAt = new Date(Date.now() - 30_000);
    await pg`update triggers set next_scheduled_run = ${dueAt.toISOString()} where id = ${task.id}`;
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    const settlementKey = automationLedgerKey(agentId, occurrence.id, 'settle');
    const reservationKey = automationLedgerKey(agentId, occurrence.id);
    const attempts: string[] = [];
    const callsBefore = compatCalls.length;
    await pg`update agents set provision_status = 'failed' where account_id = ${agentId}`;
    try {
      const scheduler = new TaskScheduler({
        runTask: makeScheduledTaskRunner({
          compat: fakeCompat,
          bus: app.eventsBus,
          registry: app.turnRegistry,
          historySync: app.historySync!,
          turnLimiter: app.turnLimiter,
          refundLedger: async (params) => {
            attempts.push(params.originalIdempotencyKey);
            if (params.originalIdempotencyKey === settlementKey) {
              throw new Error('simulated refund verification outage');
            }
            return await refund(params);
          },
        }),
        intervalMs: 0,
        restrictToTriggerIds: [task.id],
      });
      expect((await scheduler.tick()).outcomes).toContainEqual({
        triggerId: task.id,
        outcome: 'retry',
      });
    } finally {
      await pg`update agents set provision_status = 'ready' where account_id = ${agentId}`;
    }
    expect(attempts).toEqual([settlementKey, reservationKey]);
    expect(compatCalls).toHaveLength(callsBefore);
    const [pending] = await pg<{
      status: string;
      next_scheduled_run: string;
      last_run_time: string | null;
      last_error: string;
      error_count: number | null;
    }[]>`
      select status, next_scheduled_run, last_run_time, last_error, error_count
      from triggers where id = ${task.id}
    `;
    expect(pending!.status).toBe('active');
    expect(new Date(pending!.next_scheduled_run).getTime()).toBe(dueAt.getTime());
    expect(pending!.last_run_time).toBeNull();
    expect(pending!.error_count ?? 0).toBe(0);
    expect(pending!.last_error).toContain('refund pending');
  });

  it('counts a provider-completed empty turn and auto-pauses at 20', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Empty response circuit breaker',
        prompt: 'This call will complete without assistant output.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    await pg`
      update triggers
      set error_count = 19, next_scheduled_run = ${new Date(Date.now() - 30_000).toISOString()}
      where id = ${task.id}
    `;
    turnMode = 'empty';
    const scheduler = new TaskScheduler({
      runTask: makeScheduledTaskRunner({
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        turnLimiter: app.turnLimiter,
      }),
      intervalMs: 0,
      restrictToTriggerIds: [task.id],
    });

    expect((await scheduler.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'failed',
    });
    const [row] = await pg<{ status: string; error_count: number; last_error: string }[]>`
      select status, error_count, last_error from triggers where id = ${task.id}
    `;
    expect(row).toMatchObject({ status: 'paused', error_count: 20 });
    expect(row!.last_error).toContain('without an assistant response');
    const [usage] = await pg<{ error_code: string | null; metadata: { emptyTurn?: boolean } }[]>`
      select error_code, metadata from usage_events
      where metadata->'source'->>'triggerId' = ${task.id}
      order by created_at desc limit 1
    `;
    // Usage truthfully remains a provider completion; the scheduled-task
    // circuit breaker derives its failure from the durable emptyTurn marker.
    expect(usage!.metadata.emptyTurn).toBe(true);
    expect(usage!.error_code).toBeNull();
    expect(SCHEDULED_TASK_EMPTY_RESPONSE).toBe('scheduled_task_empty_response');
  });

  it('reaps a stale funded occurrence through refund-only recovery with zero provider calls', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Stale funded recovery',
        prompt: 'This prompt must never be replayed.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const now = new Date();
    const dueAt = new Date(now.getTime() - 60_000);
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    const reservationKey = automationLedgerKey(agentId, occurrence.id);
    const settlementKey = automationLedgerKey(agentId, occurrence.id, 'settle');
    await debit({
      accountId: userId,
      amount: 1,
      type: 'spend:chat',
      idempotencyKey: reservationKey,
    });
    await debit({
      accountId: userId,
      amount: 2,
      type: 'spend:chat:settle',
      idempotencyKey: settlementKey,
    });
    automationSeedKeys.push(reservationKey, settlementKey);
    await pg`
      update triggers
      set status = 'running',
          next_scheduled_run = ${dueAt.toISOString()},
          pending_occurrence_id = ${occurrence.id},
          pending_occurrence_kind = 'scheduled',
          pending_occurrence_at = ${dueAt.toISOString()},
          pending_occurrence_claim_id = ${crypto.randomUUID()},
          updated_at = ${new Date(now.getTime() - 30 * 60_000).toISOString()}
      where id = ${task.id}
    `;
    const callsBefore = compatCalls.length;
    const scheduler = new TaskScheduler({
      runTask: async () => {
        throw new Error('provider runner must not execute recovery');
      },
      recoverTask: makeScheduledTaskRecoveryRunner(),
      intervalMs: 0,
      now: () => now,
      reapStaleRunningMs: 15 * 60_000,
      restrictToTriggerIds: [task.id],
    });

    expect((await scheduler.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'failed',
    });
    expect(compatCalls).toHaveLength(callsBefore);
    const [closed] = await pg<{
      status: string;
      next_scheduled_run: string | null;
      pending_occurrence_id: string | null;
      pending_occurrence_claim_id: string | null;
      last_error: string;
    }[]>`
      select status, next_scheduled_run, pending_occurrence_id,
             pending_occurrence_claim_id, last_error
      from triggers where id = ${task.id}
    `;
    expect(closed).toMatchObject({
      status: 'paused',
      next_scheduled_run: null,
      pending_occurrence_id: null,
      pending_occurrence_claim_id: null,
    });
    expect(closed!.last_error).toContain('was not re-executed');
    const refunds = await pg<{ idempotency_key: string }[]>`
      select idempotency_key from manna_transactions
      where idempotency_key in (
        ${refundIdempotencyKey(settlementKey)},
        ${refundIdempotencyKey(reservationKey)}
      )
    `;
    expect(new Set(refunds.map((row) => row.idempotency_key))).toEqual(
      new Set([refundIdempotencyKey(settlementKey), refundIdempotencyKey(reservationKey)]),
    );
  });

  it('keeps stale compensation retryable when one reversal fails, then closes without provider', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Stale reversal retry',
        prompt: 'Never replay this stale action.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const now = new Date();
    const dueAt = new Date(now.getTime() - 60_000);
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    const reservationKey = automationLedgerKey(agentId, occurrence.id);
    const settlementKey = automationLedgerKey(agentId, occurrence.id, 'settle');
    await debit({
      accountId: userId,
      amount: 1,
      type: 'spend:chat',
      idempotencyKey: reservationKey,
    });
    await debit({
      accountId: userId,
      amount: 2,
      type: 'spend:chat:settle',
      idempotencyKey: settlementKey,
    });
    automationSeedKeys.push(reservationKey, settlementKey);
    await pg`
      update triggers
      set status = 'running',
          next_scheduled_run = ${dueAt.toISOString()},
          pending_occurrence_id = ${occurrence.id},
          pending_occurrence_kind = 'scheduled',
          pending_occurrence_at = ${dueAt.toISOString()},
          pending_occurrence_claim_id = ${crypto.randomUUID()},
          updated_at = ${new Date(now.getTime() - 30 * 60_000).toISOString()}
      where id = ${task.id}
    `;
    const callsBefore = compatCalls.length;
    const attempts: string[] = [];
    const failing = new TaskScheduler({
      runTask: async () => {
        throw new Error('provider runner must not execute recovery');
      },
      recoverTask: makeScheduledTaskRecoveryRunner({
        refundLedger: async (params) => {
          attempts.push(params.originalIdempotencyKey);
          if (params.originalIdempotencyKey === settlementKey) {
            throw new Error('settlement reversal temporarily unavailable');
          }
          return await refund(params);
        },
      }),
      intervalMs: 0,
      now: () => now,
      reapStaleRunningMs: 15 * 60_000,
      restrictToTriggerIds: [task.id],
    });

    expect((await failing.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'retry',
    });
    expect(attempts).toEqual([settlementKey, reservationKey]);
    expect(compatCalls).toHaveLength(callsBefore);
    const [pending] = await pg<{
      status: string;
      pending_occurrence_id: string | null;
      pending_occurrence_claim_id: string | null;
      last_error: string;
    }[]>`
      select status, pending_occurrence_id, pending_occurrence_claim_id, last_error
      from triggers where id = ${task.id}
    `;
    expect(pending).toMatchObject({
      status: 'paused',
      pending_occurrence_id: occurrence.id,
      pending_occurrence_claim_id: null,
    });
    expect(pending!.last_error).toContain(SCHEDULED_TASK_REFUND_PENDING_PREFIX);

    const healthy = new TaskScheduler({
      runTask: async () => {
        throw new Error('provider runner must not execute recovery');
      },
      recoverTask: makeScheduledTaskRecoveryRunner(),
      intervalMs: 0,
      now: () => new Date(now.getTime() + 60_000),
      reapStaleRunningMs: 15 * 60_000,
      restrictToTriggerIds: [task.id],
    });
    expect((await healthy.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'failed',
    });
    expect(compatCalls).toHaveLength(callsBefore);
    const [closed] = await pg<{
      status: string;
      pending_occurrence_id: string | null;
      pending_occurrence_claim_id: string | null;
    }[]>`
      select status, pending_occurrence_id, pending_occurrence_claim_id
      from triggers where id = ${task.id}
    `;
    expect(closed).toEqual({
      status: 'paused',
      pending_occurrence_id: null,
      pending_occurrence_claim_id: null,
    });
  });

  it('fences an old runner before debit when the stale reaper wins first', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Reaper wins debit fence',
        prompt: 'Never reach the provider after stale quarantine.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const dueAt = new Date(Date.now() - 30_000);
    await pg`update triggers set next_scheduled_run = ${dueAt.toISOString()} where id = ${task.id}`;
    const [initial] = await db.select().from(triggers).where(eq(triggers.id, task.id)).limit(1);
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    let releaseFence!: () => void;
    let markFenceEntered!: () => void;
    const fenceGate = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const fenceEntered = new Promise<void>((resolve) => {
      markFenceEntered = resolve;
    });
    const callsBefore = compatCalls.length;
    const oldRunner = runScheduledTask(
      {
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        beforeLeaseRenewal: async () => {
          markFenceEntered();
          await fenceGate;
        },
      },
      initial!,
      occurrence,
    );
    await fenceEntered;

    const reaperNow = new Date();
    await pg`
      update triggers
      set updated_at = ${new Date(reaperNow.getTime() - 30 * 60_000).toISOString()}
      where id = ${task.id}
    `;
    const reaper = new TaskScheduler({
      runTask: async () => {
        throw new Error('provider runner must not execute recovery');
      },
      recoverTask: makeScheduledTaskRecoveryRunner(),
      intervalMs: 0,
      now: () => reaperNow,
      reapStaleRunningMs: 15 * 60_000,
      restrictToTriggerIds: [task.id],
    });
    expect((await reaper.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'failed',
    });
    releaseFence();
    await expect(oldRunner).rejects.toMatchObject({ code: 'task_not_active' });
    expect(compatCalls).toHaveLength(callsBefore);
    const [spends] = await pg<{ count: number }[]>`
      select count(*)::int as count from manna_transactions
      where idempotency_key = ${automationLedgerKey(agentId, occurrence.id)}
    `;
    expect(spends!.count).toBe(0);
    const [closed] = await pg<{
      status: string;
      pending_occurrence_id: string | null;
      pending_occurrence_claim_id: string | null;
    }[]>`
      select status, pending_occurrence_id, pending_occurrence_claim_id
      from triggers where id = ${task.id}
    `;
    expect(closed).toEqual({
      status: 'paused',
      pending_occurrence_id: null,
      pending_occurrence_claim_id: null,
    });
    expect(SCHEDULED_TASK_STALE_RECOVERY_PREFIX).toContain('stale recovery pending');
  });

  it('keeps a runner live when debit-lease renewal wins before the reaper', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Renewal wins debit fence',
        prompt: 'Execute once after renewing the lease.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const dueAt = new Date(Date.now() - 30_000);
    await pg`update triggers set next_scheduled_run = ${dueAt.toISOString()} where id = ${task.id}`;
    const [initial] = await db.select().from(triggers).where(eq(triggers.id, task.id)).limit(1);
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    let releaseFence!: () => void;
    let markFenceEntered!: () => void;
    let releaseProvider!: () => void;
    const fenceGate = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const fenceEntered = new Promise<void>((resolve) => {
      markFenceEntered = resolve;
    });
    turnGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const callsBefore = compatCalls.length;
    const runner = runScheduledTask(
      {
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        beforeLeaseRenewal: async () => {
          markFenceEntered();
          await fenceGate;
        },
      },
      initial!,
      occurrence,
    );
    try {
      await fenceEntered;
      const reaperNow = new Date();
      await pg`
        update triggers
        set updated_at = ${new Date(reaperNow.getTime() - 30 * 60_000).toISOString()}
        where id = ${task.id}
      `;
      releaseFence();
      await expect
        .poll(() => compatCalls.length, { timeout: 5000 })
        .toBe(callsBefore + 1);

      const reaper = new TaskScheduler({
        runTask: makeScheduledTaskRunner({
          compat: fakeCompat,
          bus: app.eventsBus,
          registry: app.turnRegistry,
          historySync: app.historySync!,
          turnLimiter: app.turnLimiter,
        }),
        intervalMs: 0,
        now: () => new Date(),
        reapStaleRunningMs: 15 * 60_000,
        restrictToTriggerIds: [task.id],
      });
      expect((await reaper.tick()).outcomes).toEqual([]);
      expect(compatCalls).toHaveLength(callsBefore + 1);

      releaseProvider();
      const result = await runner;
      expect(result.outcome.errorCode).toBeNull();
    } finally {
      releaseFence();
      releaseProvider();
      turnGate = null;
      await runner.catch(() => {});
    }
    const [closed] = await pg<{
      status: string;
      pending_occurrence_id: string | null;
      pending_occurrence_claim_id: string | null;
    }[]>`
      select status, pending_occurrence_id, pending_occurrence_claim_id
      from triggers where id = ${task.id}
    `;
    expect(closed).toEqual({
      status: 'active',
      pending_occurrence_id: null,
      pending_occurrence_claim_id: null,
    });
  });

  it('fences a reaped provider zombie again before late settlement and usage finalization', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Terminal settlement fence',
        prompt: 'A suspended provider completion must not settle after recovery.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const dueAt = new Date(Date.now() - 30_000);
    await pg`update triggers set next_scheduled_run = ${dueAt.toISOString()} where id = ${task.id}`;
    const [initial] = await db.select().from(triggers).where(eq(triggers.id, task.id)).limit(1);
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    const reservationKey = automationLedgerKey(agentId, occurrence.id);
    const settlementKey = automationLedgerKey(agentId, occurrence.id, 'settle');
    // This would require a positive settlement adjustment if the stale
    // provider completion were allowed to proceed.
    turnUsage = { promptTokens: 40_000, completionTokens: 0, totalTokens: 40_000 };
    let releaseProvider!: () => void;
    turnGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const callsBefore = compatCalls.length;
    const zombie = runScheduledTask(
      {
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
      },
      initial!,
      occurrence,
    );
    try {
      await expect
        .poll(async () => {
          const [reservation] = await pg<{ count: number }[]>`
            select count(*)::int as count from manna_transactions
            where idempotency_key = ${reservationKey}
          `;
          return {
            providerCalls: compatCalls.length - callsBefore,
            reservation: reservation?.count ?? 0,
          };
        }, { timeout: 5000 })
        .toEqual({ providerCalls: 1, reservation: 1 });

      const reaperNow = new Date();
      await pg`
        update triggers
        set updated_at = ${new Date(reaperNow.getTime() - 30 * 60_000).toISOString()}
        where id = ${task.id}
      `;
      const reaper = new TaskScheduler({
        runTask: async () => {
          throw new Error('provider runner must not execute recovery');
        },
        recoverTask: makeScheduledTaskRecoveryRunner(),
        intervalMs: 0,
        now: () => reaperNow,
        reapStaleRunningMs: 15 * 60_000,
        restrictToTriggerIds: [task.id],
      });
      expect((await reaper.tick()).outcomes).toContainEqual({
        triggerId: task.id,
        outcome: 'failed',
      });

      releaseProvider();
      await expect(zombie).rejects.toMatchObject({ code: 'task_not_active' });
    } finally {
      releaseProvider();
      turnGate = null;
      await zombie.catch(() => {});
    }
    expect(compatCalls).toHaveLength(callsBefore + 1);
    const [settlement] = await pg<{ count: number }[]>`
      select count(*)::int as count from manna_transactions
      where idempotency_key = ${settlementKey}
    `;
    expect(settlement!.count).toBe(0);
    const [usage] = await pg<{ count: number }[]>`
      select count(*)::int as count from usage_events where turn_id = ${occurrence.id}
    `;
    expect(usage!.count).toBe(0);
    const [assistant] = await pg<{ count: number }[]>`
      select count(*)::int as count from messages
      where session_id = ${occurrence.id} and role = 'assistant'
    `;
    expect(assistant!.count).toBe(0);
    const refunds = await pg<{ idempotency_key: string }[]>`
      select idempotency_key from manna_transactions
      where idempotency_key = ${refundIdempotencyKey(reservationKey)}
    `;
    expect(refunds).toHaveLength(1);
  });

  it('atomically fences terminal assistant and usage writes after settlement', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Atomic terminal write fence',
        prompt: 'Do not persist this completion after stale recovery.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const dueAt = new Date(Date.now() - 30_000);
    await pg`update triggers set next_scheduled_run = ${dueAt.toISOString()} where id = ${task.id}`;
    const [initial] = await db.select().from(triggers).where(eq(triggers.id, task.id)).limit(1);
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    const reservationKey = automationLedgerKey(agentId, occurrence.id);
    const settlementKey = automationLedgerKey(agentId, occurrence.id, 'settle');
    turnUsage = { promptTokens: 40_000, completionTokens: 0, totalTokens: 40_000 };
    let enterTerminal!: () => void;
    let releaseTerminal!: () => void;
    const terminalEntered = new Promise<void>((resolve) => {
      enterTerminal = resolve;
    });
    const terminalGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const callsBefore = compatCalls.length;
    const zombie = runScheduledTask(
      {
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        beforeTerminalPersistence: async () => {
          enterTerminal();
          await terminalGate;
        },
      },
      initial!,
      occurrence,
    );
    try {
      await terminalEntered;
      const [landed] = await pg<{ reservation: number; settlement: number }[]>`
        select
          count(*) filter (where idempotency_key = ${reservationKey})::int as reservation,
          count(*) filter (where idempotency_key = ${settlementKey})::int as settlement
        from manna_transactions
      `;
      expect(landed).toEqual({ reservation: 1, settlement: 1 });

      // Model a process suspended beyond the lease after its terminal
      // preflight but immediately before the atomic assistant/usage write.
      const reaperNow = new Date();
      await pg`
        update triggers
        set updated_at = ${new Date(reaperNow.getTime() - 30 * 60_000).toISOString()}
        where id = ${task.id}
      `;
      const reaper = new TaskScheduler({
        runTask: async () => {
          throw new Error('provider runner must not execute recovery');
        },
        recoverTask: makeScheduledTaskRecoveryRunner(),
        intervalMs: 0,
        now: () => reaperNow,
        reapStaleRunningMs: 15 * 60_000,
        restrictToTriggerIds: [task.id],
      });
      expect((await reaper.tick()).outcomes).toContainEqual({
        triggerId: task.id,
        outcome: 'failed',
      });

      releaseTerminal();
      await expect(zombie).rejects.toMatchObject({ code: 'task_not_active' });
    } finally {
      releaseTerminal();
      await zombie.catch(() => {});
    }
    expect(compatCalls).toHaveLength(callsBefore + 1);
    const [terminal] = await pg<{ usage: number; assistant: number }[]>`
      select
        (select count(*)::int from usage_events where turn_id = ${occurrence.id}) as usage,
        (select count(*)::int from messages
          where session_id = ${occurrence.id} and role = 'assistant') as assistant
    `;
    expect(terminal).toEqual({ usage: 0, assistant: 0 });
    const refunds = await pg<{ idempotency_key: string }[]>`
      select idempotency_key from manna_transactions
      where idempotency_key in (
        ${refundIdempotencyKey(settlementKey)},
        ${refundIdempotencyKey(reservationKey)}
      )
    `;
    expect(new Set(refunds.map((row) => row.idempotency_key))).toEqual(
      new Set([refundIdempotencyKey(settlementKey), refundIdempotencyKey(reservationKey)]),
    );
  });

  it('does not re-call the provider after a crash in the started-before-usage window', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Indeterminate occurrence',
        prompt: 'Must never be sent twice.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const dueAt = new Date(Date.now() - 30_000);
    await pg`update triggers set next_scheduled_run = ${dueAt.toISOString()} where id = ${task.id}`;
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    const ledgerKey = automationLedgerKey(agentId, occurrence.id);
    const settlementKey = automationLedgerKey(agentId, occurrence.id, 'settle');
    // The reservation is the durable "provider may have started" marker: debit
    // always precedes the compat call. A positive exact-cost adjustment can
    // land under the settlement key before usage does, so simulate both legs.
    await debit({
      accountId: userId,
      amount: 1,
      type: 'spend:chat',
      idempotencyKey: ledgerKey,
    });
    await debit({
      accountId: userId,
      amount: 2,
      type: 'spend:chat:settle',
      idempotencyKey: settlementKey,
    });
    automationSeedKeys.push(ledgerKey, settlementKey);
    const callsBefore = compatCalls.length;
    const scheduler = new TaskScheduler({
      runTask: makeScheduledTaskRunner({
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        turnLimiter: app.turnLimiter,
      }),
      intervalMs: 0,
      restrictToTriggerIds: [task.id],
    });

    expect((await scheduler.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'failed',
    });
    expect(compatCalls).toHaveLength(callsBefore);
    const [row] = await pg<{ last_error: string; error_count: number }[]>`
      select last_error, error_count from triggers where id = ${task.id}
    `;
    expect(row!.last_error).toContain('was not re-executed');
    expect(row!.error_count).toBe(1);
    const refundRows = await pg<{ idempotency_key: string }[]>`
      select idempotency_key from manna_transactions
      where idempotency_key in (
        ${refundIdempotencyKey(settlementKey)},
        ${refundIdempotencyKey(ledgerKey)}
      )
    `;
    expect(new Set(refundRows.map((ledger) => ledger.idempotency_key))).toEqual(
      new Set([
        refundIdempotencyKey(settlementKey),
        refundIdempotencyKey(ledgerKey),
      ]),
    );
    expect(SCHEDULED_TASK_INDETERMINATE).toBe('scheduled_task_occurrence_indeterminate');
  });

  it('keeps an indeterminate occurrence due when either ledger reversal fails', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Refund retry occurrence',
        prompt: 'Must wait for complete ledger recovery.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const dueAt = new Date(Date.now() - 30_000);
    await pg`update triggers set next_scheduled_run = ${dueAt.toISOString()} where id = ${task.id}`;
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    const reservationKey = automationLedgerKey(agentId, occurrence.id);
    const settlementKey = automationLedgerKey(agentId, occurrence.id, 'settle');
    await debit({
      accountId: userId,
      amount: 1,
      type: 'spend:chat',
      idempotencyKey: reservationKey,
    });
    await debit({
      accountId: userId,
      amount: 2,
      type: 'spend:chat:settle',
      idempotencyKey: settlementKey,
    });
    automationSeedKeys.push(reservationKey, settlementKey);

    const refundAttempts: string[] = [];
    const refundErrors: string[] = [];
    const callsBefore = compatCalls.length;
    const scheduler = new TaskScheduler({
      runTask: makeScheduledTaskRunner({
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        turnLimiter: app.turnLimiter,
        refundLedger: async (params) => {
          refundAttempts.push(params.originalIdempotencyKey);
          if (params.originalIdempotencyKey === settlementKey) {
            throw new Error('simulated settlement reversal outage');
          }
          return await refund(params);
        },
        onError: (_err, context) => refundErrors.push(context),
      }),
      intervalMs: 0,
      restrictToTriggerIds: [task.id],
    });

    expect((await scheduler.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'retry',
    });
    expect(compatCalls).toHaveLength(callsBefore);
    expect(refundAttempts).toEqual([settlementKey, reservationKey]);
    expect(refundErrors).toContain('scheduled occurrence settlement recovery refund');
    const [pending] = await pg<{
      status: string;
      next_scheduled_run: string | null;
      last_run_time: string | null;
      last_error: string;
      error_count: number | null;
    }[]>`
      select status, next_scheduled_run, last_run_time, last_error, error_count
      from triggers where id = ${task.id}
    `;
    expect(pending!.status).toBe('active');
    expect(new Date(pending!.next_scheduled_run!).getTime()).toBe(dueAt.getTime());
    expect(pending!.last_run_time).toBeNull();
    expect(pending!.error_count ?? 0).toBe(0);
    expect(pending!.last_error).toContain('refund pending: settlement reversal failed');
    expect(SCHEDULED_TASK_REFUND_PENDING).toBe('scheduled_task_occurrence_refund_pending');
    const [durablePending] = await pg<{
      pending_occurrence_id: string;
      pending_occurrence_kind: string;
      pending_occurrence_at: string;
    }[]>`
      select pending_occurrence_id, pending_occurrence_kind, pending_occurrence_at
      from triggers where id = ${task.id}
    `;
    expect(durablePending!.pending_occurrence_id).toBe(occurrence.id);
    expect(durablePending!.pending_occurrence_kind).toBe('scheduled');
    expect(new Date(durablePending!.pending_occurrence_at).getTime()).toBe(dueAt.getTime());

    const blockedEdit = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { name: 'must wait for refund recovery' },
    });
    expect(blockedEdit.statusCode).toBe(409);
    expect((blockedEdit.json() as { error: { code: string } }).error.code).toBe(
      'task_refund_pending',
    );

    const reservationRefundKey = refundIdempotencyKey(reservationKey);
    const settlementRefundKey = refundIdempotencyKey(settlementKey);
    const partialRefunds = await pg<{ idempotency_key: string }[]>`
      select idempotency_key from manna_transactions
      where idempotency_key in (${settlementRefundKey}, ${reservationRefundKey})
    `;
    expect(partialRefunds.map((ledger) => ledger.idempotency_key)).toEqual([
      reservationRefundKey,
    ]);

    // Even a corrupted/moved normal cadence and a clock beyond the six-hour
    // grace cannot strand the durable occurrence. Pending recovery is selected
    // independently, bypasses missed-fire skipping, and never hits provider.
    const recoveryNow = new Date(dueAt.getTime() + 8 * 60 * 60 * 1000);
    await pg`
      update triggers
      set next_scheduled_run = ${new Date(recoveryNow.getTime() + 24 * 60 * 60 * 1000).toISOString()}
      where id = ${task.id}
    `;
    const healthyScheduler = new TaskScheduler({
      runTask: makeScheduledTaskRunner({
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        turnLimiter: app.turnLimiter,
      }),
      intervalMs: 0,
      now: () => recoveryNow,
      restrictToTriggerIds: [task.id],
    });
    expect((await healthyScheduler.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'failed',
    });
    expect(compatCalls).toHaveLength(callsBefore);
    const finalRefunds = await pg<{ idempotency_key: string }[]>`
      select idempotency_key from manna_transactions
      where idempotency_key in (${settlementRefundKey}, ${reservationRefundKey})
    `;
    expect(new Set(finalRefunds.map((ledger) => ledger.idempotency_key))).toEqual(
      new Set([settlementRefundKey, reservationRefundKey]),
    );
    const [recovered] = await pg<{ last_error: string; error_count: number }[]>`
      select last_error, error_count from triggers where id = ${task.id}
    `;
    expect(recovered!.last_error).toContain('was not re-executed');
    expect(recovered!.error_count).toBe(1);
    const [cleared] = await pg<{ pending_occurrence_id: string | null }[]>`
      select pending_occurrence_id from triggers where id = ${task.id}
    `;
    expect(cleared!.pending_occurrence_id).toBeNull();
  });

  it('recovers settled usage after a crash before next-run stamping without a second provider call', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Settled occurrence recovery',
        prompt: 'Execute exactly once.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const dueAt = new Date(Date.now() - 30_000);
    await pg`update triggers set next_scheduled_run = ${dueAt.toISOString()} where id = ${task.id}`;
    const [trigger] = await db.select().from(triggers).where(eq(triggers.id, task.id)).limit(1);
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    const callsBefore = compatCalls.length;
    const first = await runScheduledTask(
      {
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
      },
      trigger!,
      occurrence,
    );
    expect(compatCalls).toHaveLength(callsBefore + 1);
    expect(first.outcome.turnId).toBe(occurrence.id);

    // Simulated crash: runScheduledTask settled and checkpointed, but the
    // scheduler never advanced next_scheduled_run. A fresh scheduler sees the
    // same due row and must recover, not execute.
    const scheduler = new TaskScheduler({
      runTask: makeScheduledTaskRunner({
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        turnLimiter: app.turnLimiter,
      }),
      intervalMs: 0,
      restrictToTriggerIds: [task.id],
    });
    expect((await scheduler.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'fired',
    });
    expect(compatCalls).toHaveLength(callsBefore + 1);
    const [usageCount] = await pg<{ count: number }[]>`
      select count(*)::int as count from usage_events where turn_id = ${occurrence.id}
    `;
    expect(usageCount!.count).toBe(1);
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
      const compatCallsBefore = compatCalls.length;
      const [sessionsBefore] = await pg<{ count: number }[]>`
        select count(*)::int as count
        from sessions
        where owner_id = ${userId} and title = '[Task] No double fire'
      `;
      const first = app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/runs`,
        headers: { cookie: devCookie(userId) },
      });
      // Wait until the first run has both claimed the task and reached the
      // held provider turn. Observing only status='running' is too early: the
      // atomic claim deliberately precedes owner/agent validation and session
      // creation, so that state alone cannot prove the first session exists.
      await expect
        .poll(
          async () => {
            const [row] = await pg<{ status: string }[]>`
              select status from triggers where id = ${task.id}`;
            return {
              status: row?.status,
              providerCalls: compatCalls.length - compatCallsBefore,
            };
          },
          { timeout: 5000 },
        )
        .toEqual({ status: 'running', providerCalls: 1 });

      const second = await app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/runs`,
        headers: { cookie: devCookie(userId) },
      });
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: { code: string } }).error.code).toBe('task_not_active');
      const [sessionsAfterSecond] = await pg<{ count: number }[]>`
        select count(*)::int as count
        from sessions
        where owner_id = ${userId} and title = '[Task] No double fire'
      `;
      expect(sessionsAfterSecond!.count - sessionsBefore!.count).toBe(1);

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

  it('does not resurrect a task paused while its run is in flight', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Pause in flight',
        prompt: 'Run once at a time.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    let releaseGate!: () => void;
    turnGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    try {
      const callsBefore = compatCalls.length;
      const run = app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/runs`,
        headers: { cookie: devCookie(userId) },
      });
      await expect
        .poll(
          async () => {
            const [row] = await pg<{ status: string }[]>`
              select status from triggers where id = ${task.id}`;
            return {
              status: row?.status,
              providerCalls: compatCalls.length - callsBefore,
            };
          },
          { timeout: 5000 },
        )
        .toEqual({ status: 'running', providerCalls: 1 });

      const pause = await app.inject({
        method: 'PATCH',
        url: `/tasks/${task.id}`,
        headers: { cookie: devCookie(userId) },
        payload: { status: 'paused' },
      });
      expect(pause.statusCode).toBe(200);

      // A scheduler in another API process must not mistake this freshly
      // paused, still-running HTTP turn for abandoned recovery work.
      const providerCallsWhileHeld = compatCalls.length;
      const scheduler = new TaskScheduler({
        runTask: makeScheduledTaskRunner({
          compat: fakeCompat,
          bus: app.eventsBus,
          registry: app.turnRegistry,
          historySync: app.historySync!,
          turnLimiter: app.turnLimiter,
        }),
        intervalMs: 0,
        restrictToTriggerIds: [task.id],
      });
      expect((await scheduler.tick()).outcomes).toEqual([]);
      expect(compatCalls).toHaveLength(providerCallsWhileHeld);

      releaseGate();
      expect((await run).statusCode).toBe(201);
    } finally {
      turnGate = null;
    }
    const [row] = await pg<{ status: string; next_scheduled_run: string | null }[]>`
      select status, next_scheduled_run from triggers where id = ${task.id}`;
    expect(row).toMatchObject({ status: 'paused', next_scheduled_run: null });
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

  it('pauses (next run cleared) and resumes (next run recomputed); gateway stays removal-only', async () => {
    const task = await createTask();
    expect(task.nextScheduledRun).not.toBeNull();

    const beforeRemovals = fakeCron.removals.filter((id) => id === task.id).length;
    const paused = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { status: 'paused' },
    });
    expect(paused.statusCode).toBe(200);
    const pausedTask = (paused.json() as TaskBody).task;
    expect(pausedTask.status).toBe('paused');
    expect(pausedTask.nextScheduledRun).toBeNull();
    expect(fakeCron.removals.filter((id) => id === task.id).length).toBe(beforeRemovals + 1);

    const resumed = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { status: 'active' },
    });
    const resumedTask = (resumed.json() as TaskBody).task;
    expect(resumedTask.status).toBe('active');
    expect(resumedTask.nextScheduledRun).not.toBeNull();
    expect(Date.parse(resumedTask.nextScheduledRun!)).toBeGreaterThan(Date.now());
    expectLocalParts(resumedTask.nextScheduledRun!, 'UTC', { hour: 9, minute: 30 });
    expect(fakeCron.removals.filter((id) => id === task.id).length).toBe(beforeRemovals + 2);
  });

  it('refuses to resume an eleventh enabled task', async () => {
    for (let index = 0; index < 10; index += 1) {
      await pg`
        insert into triggers (
          user_id, agent_id, name, prompt, schedule, status,
          session_target, next_scheduled_run
        ) values (
          ${userId}, ${agentId}, ${`${marker} resume limit ${index}`}, 'limit fixture',
          ${JSON.stringify(schedule)}::jsonb, 'active', 'new', now() + interval '1 day'
        )
      `;
    }
    const [paused] = await pg<{ id: string }[]>`
      insert into triggers (
        user_id, agent_id, name, prompt, schedule, status, session_target
      ) values (
        ${userId}, ${agentId}, ${`${marker} resume blocked`}, 'limit fixture',
        ${JSON.stringify(schedule)}::jsonb, 'paused', 'new'
      )
      returning id
    `;
    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${paused!.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { status: 'active' },
    });
    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'agent_task_limit_exceeded',
    );
  });

  it('edits name, prompt, and schedule, restamping the next run', async () => {
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
    expect(edited.nextScheduledRun).not.toBeNull();
    expectLocalParts(edited.nextScheduledRun!, 'America/New_York', {
      weekday: 'Fri',
      hour: 14,
      minute: 5,
    });
  });

  it('edits a task onto a one-time {at} schedule', async () => {
    const task = await createTask();
    const at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { schedule: { at } },
    });
    expect(res.statusCode).toBe(200);
    const edited = (res.json() as TaskBody).task;
    expect(edited.schedule).toEqual({ at });
    expect(edited.nextScheduledRun).toBe(at);

    // A past one-time schedule cannot be saved on an active task.
    const past = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { schedule: { at: new Date(Date.now() - 60_000).toISOString() } },
    });
    expect(past.statusCode).toBe(400);
    expect((past.json() as { error: { code: string } }).error.code).toBe('invalid_schedule');
  });

  it('soft-deletes (gateway job removed, gone from the list)', async () => {
    const task = await createTask();
    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: { cookie: devCookie(userId) },
      payload: { deleted: true },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeCron.removals).toContain(task.id);
    const [deletedRow] = await pg<{ next_scheduled_run: string | null; status: string }[]>`
      select next_scheduled_run, status from triggers where id = ${task.id}
    `;
    expect(deletedRow!.next_scheduled_run).toBeNull();
    expect(deletedRow!.status).toBe('finished');

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
