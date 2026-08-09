import { randomUUID } from 'node:crypto';

import { credit, debit, DevAuthProvider, getBalance, refund, refundIdempotencyKey, resetEnvCache, settleReservationIdempotencyKey } from '@eden3/core';
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
  manualTaskOccurrence,
  runScheduledTask,
  scheduledTaskOccurrence,
} from '../src/services/scheduled-tasks';
import type { CompatClientLike } from '../src/services/turns';
import { TurnReservationReaper } from '../src/services/turn-reservation-reaper';
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
let adminId = '';
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

it('scopes caller run-now idempotency keys to the exact task', () => {
  const requestId = randomUUID();
  const firstTask = randomUUID();
  const secondTask = randomUUID();
  expect(manualTaskOccurrence(firstTask, requestId)).toEqual(
    manualTaskOccurrence(firstTask, requestId),
  );
  expect(manualTaskOccurrence(firstTask, requestId).id).not.toBe(
    manualTaskOccurrence(secondTask, requestId).id,
  );
  expect(manualTaskOccurrence(firstTask, requestId).id).not.toBe(requestId);
});

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

async function seedCanonicalRecoveryOccurrence(options: {
  taskId: string;
  dueAt: Date;
  usableOutput: boolean;
}): Promise<{
  occurrenceId: string;
  reservationKey: string;
  durableBefore: number;
}> {
  const occurrence = scheduledTaskOccurrence(options.taskId, options.dueAt);
  const balanceBefore = await getBalance(userId);
  await credit({
    accountId: userId,
    amount: 40,
    type: 'credit:subscription',
    toSubscriptionBalance: true,
    idempotencyKey: `${marker}:subscription:${occurrence.id}`,
  });
  const reservationKey = automationLedgerKey(agentId, occurrence.id);
  const debited = await debit({
    accountId: userId,
    amount: 61,
    type: 'spend:chat',
    idempotencyKey: reservationKey,
  });
  expect(debited.subscriptionDrawn).toBe(40);
  const sessionId = randomUUID();
  await pg`
    insert into sessions (
      id, owner_id, title, session_type, gateway_session_key
    ) values (
      ${sessionId}, ${userId}, ${`${marker} recovery ${occurrence.id}`},
      'scheduled_task', ${`agent:main:eden3:session:${sessionId}`}
    )
  `;
  await pg`
    insert into session_agents (session_id, agent_account_id)
    values (${sessionId}, ${agentId})
  `;
  await pg`
    insert into session_users (session_id, user_account_id)
    values (${sessionId}, ${userId})
  `;
  const old = new Date(Date.now() - 90 * 60_000);
  await pg`
    insert into turn_authorizations (
      turn_id, account_id, agent_account_id, session_id,
      provider, model, pricing_basis, ceiling_table_version,
      authorized_max_manna, reserved_subscription_manna,
      reservation_tx_id, state, created_at, updated_at
    ) values (
      ${occurrence.id}, ${userId}, ${agentId}, ${sessionId},
      'anthropic', 'claude-haiku-4-5', 'provider-api', 'scheduler-test-v1',
      61, ${debited.subscriptionDrawn ?? 0}, ${debited.transaction.id},
      'reserved', ${old.toISOString()}, ${old.toISOString()}
    )
  `;
  await pg`
    insert into turn_provider_runs (turn_id, provider_started_at, usable_output_at)
    values (
      ${occurrence.id}, ${old.toISOString()},
      ${options.usableOutput ? new Date(old.getTime() + 1000).toISOString() : null}
    )
  `;
  await pg`
    update triggers
    set status = 'running',
        next_scheduled_run = ${options.dueAt.toISOString()},
        pending_occurrence_id = ${occurrence.id},
        pending_occurrence_kind = 'scheduled',
        pending_occurrence_at = ${options.dueAt.toISOString()},
        pending_occurrence_claim_id = ${randomUUID()},
        updated_at = ${old.toISOString()}
    where id = ${options.taskId}
  `;
  return {
    occurrenceId: occurrence.id,
    reservationKey,
    durableBefore: balanceBefore.balance,
  };
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
  adminId = await insertUserAccount(`${marker}_admin`);
  agentId = await insertAgentAccount(agentUsername, {
    ownerId: userId,
    name: 'Task Bot',
    public: true,
    openclawId: `${marker}bot`.replace(/_/g, '-'),
    provisionStatus: 'ready',
  });
  await credit({
    accountId: userId,
    // Every scheduled turn now fronts the worst-case reservation (haiku
    // authorized-max 61, T08-U02); these tests exercise scheduling semantics,
    // not balance — fund far above it.
    amount: 5000,
    type: 'credit:test',
    idempotencyKey: `${marker}:credit`,
  });

  fakeCron = makeFakeCronSync();
  app = await buildServer({
    auth: { provider: new DevAuthProvider({ adminUsernames: [`${marker}_admin`] }) },
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
  // Each test owns a fresh 80-manna rolling automation window: settled turns
  // now charge their worst-case-authorized actuals against it (T08-U02), so
  // residue from one test would starve the next test's 61-manna reservation.
  // Marker-scoped hygiene, not a semantics change — every test still runs its
  // own reservations against the real cap.
  await pg`
    update manna_transactions
    set created_at = created_at - interval '2 hours'
    where idempotency_key like ${'budget:automation:' + agentId + ':%'}
  `;
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

  it('admits exactly one concurrent create at the shared owner quota boundary', async () => {
    const [before] = await pg<{ count: number }[]>`
      select count(*)::int as count
      from triggers
      where user_id = ${userId}
        and deleted = false
    `;
    const limit = (before?.count ?? 0) + 1;
    const restore = withEnv('MAX_SCHEDULED_TASKS_PER_USER', String(limit));
    const ownerLockKey = `task-owner:${userId}`;
    const lock = await pg.reserve();
    await lock`select pg_advisory_lock(hashtextextended(${ownerLockKey}::text, 84))`;
    const beforeCalls = fakeCron.removals.length;
    let settled = 0;
    try {
      const attempts = ['first', 'second'].map((suffix) =>
        app
          .inject({
            method: 'POST',
            url: '/tasks',
            headers: { cookie: devCookie(userId) },
            payload: {
              agentUsername,
              name: `${marker} owner quota ${suffix}`,
              prompt: 'exactly one request may insert',
              schedule,
            },
          })
          .finally(() => {
            settled += 1;
          }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(0);
      await lock`select pg_advisory_unlock(hashtextextended(${ownerLockKey}::text, 84))`;

      const responses = await Promise.all(attempts);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 429]);
      const rejected = responses.find((response) => response.statusCode === 429)!;
      expect((rejected.json() as { error: { code: string } }).error.code).toBe(
        'task_quota_exceeded',
      );
      const [after] = await pg<{ count: number }[]>`
        select count(*)::int as count
        from triggers
        where user_id = ${userId}
          and deleted = false
      `;
      expect(after?.count).toBe(limit);
      expect(fakeCron.removals).toHaveLength(beforeCalls + 1);
    } finally {
      await lock`select pg_advisory_unlock(hashtextextended(${ownerLockKey}::text, 84))`;
      lock.release();
      restore();
    }
  });

  it('serializes API and agent-bridge creates under the same owner lock coordinates', async () => {
    const { createPostgresTaskStore } = (await import(
      new URL('../../../infra/agent-cron-bridge/server.mjs', import.meta.url).href
    )) as {
      createPostgresTaskStore: (
        sql: typeof pg,
        options: { maxScheduledTasksPerUser: number },
      ) => {
        create(
          identity: { ownerId: string; agentAccountId: string },
          input: {
            name: string;
            prompt: string;
            schedule: unknown;
            nextScheduledRun: Date;
          },
        ): Promise<unknown>;
      };
    };
    const [before] = await pg<{ count: number }[]>`
      select count(*)::int as count
      from triggers
      where user_id = ${userId}
        and deleted = false
    `;
    const limit = (before?.count ?? 0) + 1;
    const restore = withEnv('MAX_SCHEDULED_TASKS_PER_USER', String(limit));
    const agentLock = await pg.reserve();
    await agentLock`select pg_advisory_lock(hashtextextended(${agentId}::text, 84))`;
    const beforeCalls = fakeCron.removals.length;
    let settled = 0;
    try {
      const store = createPostgresTaskStore(pg, { maxScheduledTasksPerUser: limit });
      const apiAttempt = app
        .inject({
          method: 'POST',
          url: '/tasks',
          headers: { cookie: devCookie(userId) },
          payload: {
            agentUsername,
            name: `${marker} API bridge quota race`,
            prompt: 'API contender',
            schedule,
          },
        })
        .finally(() => {
          settled += 1;
        });
      const bridgeAttempt = store
        .create(
          { ownerId: userId, agentAccountId: agentId },
          {
            name: `${marker} bridge quota race`,
            prompt: 'bridge contender',
            schedule,
            nextScheduledRun: new Date(Date.now() + 60_000),
          },
        )
        .then(
          () => ({ ok: true as const, code: null }),
          (error: unknown) => ({
            ok: false as const,
            code:
              typeof error === 'object' && error !== null && 'code' in error
                ? String(error.code)
                : null,
          }),
        )
        .finally(() => {
          settled += 1;
        });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(0);
      await agentLock`select pg_advisory_unlock(hashtextextended(${agentId}::text, 84))`;

      const [apiResponse, bridgeResult] = await Promise.all([apiAttempt, bridgeAttempt]);
      expect(Number(apiResponse.statusCode === 201) + Number(bridgeResult.ok)).toBe(1);
      if (apiResponse.statusCode !== 201) {
        expect(apiResponse.statusCode).toBe(429);
        expect((apiResponse.json() as { error: { code: string } }).error.code).toBe(
          'task_quota_exceeded',
        );
      }
      if (!bridgeResult.ok) expect(bridgeResult.code).toBe('task_quota_exceeded');

      const [after] = await pg<{ count: number }[]>`
        select count(*)::int as count
        from triggers
        where user_id = ${userId}
          and deleted = false
      `;
      expect(after?.count).toBe(limit);
      expect(fakeCron.removals).toHaveLength(
        beforeCalls + Number(apiResponse.statusCode === 201),
      );
    } finally {
      await agentLock`select pg_advisory_unlock(hashtextextended(${agentId}::text, 84))`;
      agentLock.release();
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

  it('does not let a stranger or platform admin create a task for another owner\'s agent', async () => {
    const before = await pg<{ count: number }[]>`
      select count(*)::int as count from triggers where agent_id = ${agentId}
    `;
    for (const caller of [otherUserId, adminId]) {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: { cookie: devCookie(caller) },
        payload: { agentUsername, name: 'foreign task', prompt: 'must not run', schedule },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe('agent_not_found');
    }
    const after = await pg<{ count: number }[]>`
      select count(*)::int as count from triggers where agent_id = ${agentId}
    `;
    expect(after[0]?.count).toBe(before[0]?.count);
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
      payload: { requestId: randomUUID() },
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

  it('replays one task-scoped run-now request without another provider, charge, output, or notification', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Idempotent run now',
        prompt: 'Run this exact request once.',
        schedule,
      },
    });
    const task = (created.json() as TaskBody).task;
    const requestId = randomUUID();
    const callsBefore = compatCalls.length;
    const first = await app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/runs`,
      headers: { cookie: devCookie(userId) },
      payload: { requestId },
    });
    expect(first.statusCode).toBe(201);
    const firstRun = (first.json() as TaskRunBody).run;
    const second = await app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/runs`,
      headers: { cookie: devCookie(userId) },
      payload: { requestId },
    });
    expect(second.statusCode).toBe(201);
    expect((second.json() as TaskRunBody).run).toEqual(firstRun);
    expect(compatCalls).toHaveLength(callsBefore + 1);

    const [counts] = await pg<{
      usage: number;
      assistant: number;
      notification: number;
      reservation: number;
    }[]>`
      select
        (select count(*)::int from usage_events where turn_id = ${firstRun.outcome.turnId}) as usage,
        (select count(*)::int from messages
          where session_id = ${firstRun.sessionId} and role = 'assistant') as assistant,
        (select count(*)::int from app_notifications where id = ${firstRun.outcome.turnId}) as notification,
        (select count(*)::int from manna_transactions
          where idempotency_key = ${automationLedgerKey(agentId, firstRun.outcome.turnId)}) as reservation
    `;
    expect(counts).toEqual({ usage: 1, assistant: 1, notification: 1, reservation: 1 });
  });

  it('uses an explicitly selected existing session and rejects a foreign tenant session', async () => {
    const ownSessionId = randomUUID();
    const foreignSessionId = randomUUID();
    await pg`
      insert into sessions (id, owner_id, title, session_type, gateway_session_key)
      values
        (${ownSessionId}, ${userId}, ${`${marker} own output`}, 'chat', ${`agent:test:eden3:session:${ownSessionId}`}),
        (${foreignSessionId}, ${otherUserId}, ${`${marker} foreign output`}, 'chat', ${`agent:test:eden3:session:${foreignSessionId}`})
    `;
    await pg`
      insert into session_agents (session_id, agent_account_id)
      values (${ownSessionId}, ${agentId}), (${foreignSessionId}, ${agentId})
    `;
    await pg`
      insert into session_users (session_id, user_account_id)
      values (${ownSessionId}, ${userId}), (${foreignSessionId}, ${otherUserId})
    `;

    const foreign = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Foreign destination',
        prompt: 'must not persist',
        schedule,
        sessionTarget: { kind: 'existing', sessionId: foreignSessionId },
      },
    });
    expect(foreign.statusCode).toBe(409);
    expect((foreign.json() as { error: { code: string } }).error.code).toBe(
      'task_session_unavailable',
    );

    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Existing destination',
        prompt: 'append here',
        schedule,
        sessionTarget: { kind: 'existing', sessionId: ownSessionId },
      },
    });
    expect(created.statusCode).toBe(201);
    const task = (created.json() as TaskBody).task;
    expect(task).toMatchObject({ sessionTarget: 'existing', sessionExternalId: ownSessionId });
    const beforeCalls = compatCalls.length;
    const run = await app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/runs`,
      headers: { cookie: devCookie(userId) },
      payload: { requestId: randomUUID() },
    });
    expect(run.statusCode).toBe(201);
    expect((run.json() as TaskRunBody).run.sessionId).toBe(ownSessionId);
    expect(compatCalls).toHaveLength(beforeCalls + 1);
    expect(compatCalls.at(-1)?.sessionKey).toBe(`agent:test:eden3:session:${ownSessionId}`);
  });

  it('requires a valid run-now request id and never lets a stranger or admin execute it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: { agentUsername, name: 'Owner only run', prompt: 'do not cross tenants', schedule },
    });
    const task = (created.json() as TaskBody).task;
    const beforeCalls = compatCalls.length;
    for (const caller of [otherUserId, adminId]) {
      const denied = await app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/runs`,
        headers: { cookie: devCookie(caller) },
        payload: { requestId: randomUUID() },
      });
      expect(denied.statusCode).toBe(403);
    }
    for (const payload of [undefined, {}, { requestId: 'not-a-uuid' }]) {
      const invalid = await app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/runs`,
        headers: { cookie: devCookie(userId) },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(invalid.statusCode).toBe(400);
    }
    expect(compatCalls).toHaveLength(beforeCalls);
  });

  it('fails closed before provider execution when the task agent was deleted', async () => {
    const deletedAgentId = await insertAgentAccount(`${marker}_deleted_agent`, {
      ownerId: userId,
      openclawId: `${marker}-deleted-agent`,
      provisionStatus: 'ready',
    });
    const [task] = await pg<{ id: string }[]>`
      insert into triggers (
        user_id, agent_id, name, prompt, schedule, status,
        session_target, next_scheduled_run
      ) values (
        ${userId}, ${deletedAgentId}, 'Deleted principal', 'must not run',
        ${JSON.stringify(schedule)}::jsonb, 'active', 'new', now() + interval '1 day'
      ) returning id
    `;
    await pg`update accounts set deleted = true where id = ${deletedAgentId}`;
    const beforeCalls = compatCalls.length;
    const denied = await app.inject({
      method: 'POST',
      url: `/tasks/${task!.id}/runs`,
      headers: { cookie: devCookie(userId) },
      payload: { requestId: randomUUID() },
    });
    expect(denied.statusCode).toBe(409);
    expect((denied.json() as { error: { code: string } }).error.code).toBe(
      'task_agent_unavailable',
    );
    expect(compatCalls).toHaveLength(beforeCalls);
  });

  it('auto-pauses when the worst-case reservation no longer fits the automation budget (rejected pre-provider)', async () => {
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

    // Leave exactly one manna of rolling-hour headroom. The worst-case
    // reservation (haiku authorized-max 61, T08-U02) is refused at
    // reservation time — before any provider call — and the task pauses with
    // the budget error.
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

    const compatCallsBeforeReject = compatCalls.length;
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
    // THE kernel property: the provider was never called and no reservation
    // ledger row / authorization row landed for the rejected occurrence — the
    // old pipeline would have streamed first and only failed at settlement.
    expect(compatCalls).toHaveLength(compatCallsBeforeReject);

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

  it('does not advance a live or recovered provider failure until canonical reversal completes', async () => {
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
    let reversalAttempts = 0;
    turnMode = 'provider_auth_error';
    const callsBefore = compatCalls.length;
    const pendingScheduler = new TaskScheduler({
      runTask: makeScheduledTaskRunner({
        compat: fakeCompat,
        bus: app.eventsBus,
        registry: app.turnRegistry,
        historySync: app.historySync!,
        turnLimiter: app.turnLimiter,
        reverseAuthorization: async () => {
          reversalAttempts += 1;
          throw new Error('simulated authorization reversal outage');
        },
      }),
      intervalMs: 0,
      restrictToTriggerIds: [task.id],
    });

    expect((await pendingScheduler.tick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'retry',
    });
    expect(reversalAttempts).toBe(1);
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
    // completes the exact authorization reversal and records the failure
    // without replaying the provider.
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
          reverseAuthorization: async () => {
            throw new Error('manual authorization reversal unavailable');
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

    // A retry proposes a fresh task-scoped run-now UUID internally, but the
    // atomic claim must recover the persisted UUID and never call the provider twice.
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
    const [usage] = await pg<{
      error_code: string | null;
      manna: number | null;
      metadata: { emptyTurn?: boolean } | null;
    }[]>`
      select error_code, manna, metadata from usage_events
      where metadata->'source'->>'triggerId' = ${task.id}
      order by created_at desc limit 1
    `;
    // T08-U02: an empty scheduled completion is now failed INSIDE the
    // authorization state machine (reserved → reversed, charge 0) instead of
    // being settled and refunded out-of-band by the scheduler — the usage row
    // is a zero-manna error carrying the empty-response code, and the durable
    // emptyTurn marker still drives the circuit breaker.
    expect(usage!.metadata?.emptyTurn).toBe(true);
    expect(usage!.error_code).toBe(SCHEDULED_TASK_EMPTY_RESPONSE);
    expect(usage!.manna).toBe(0);
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
    const [usage] = await pg<{ status: string; manna: number; error_code: string }[]>`
      select status, manna, error_code from usage_events where turn_id = ${occurrence.id}
    `;
    expect(usage).toMatchObject({
      status: 'error',
      manna: 61,
      error_code: SCHEDULED_TASK_INDETERMINATE,
    });
    const [assistant] = await pg<{ count: number }[]>`
      select count(*)::int as count from messages
      where session_id = ${occurrence.id} and role = 'assistant'
    `;
    expect(assistant!.count).toBe(0);
    const refunds = await pg<{ idempotency_key: string }[]>`
      select idempotency_key from manna_transactions
      where idempotency_key = ${refundIdempotencyKey(reservationKey)}
    `;
    expect(refunds).toHaveLength(0);
    const [authorization] = await pg<{ state: string }[]>`
      select state from turn_authorizations where turn_id = ${occurrence.id}
    `;
    expect(authorization?.state).toBe('settled');
  });

  it('atomically fences terminal settlement, assistant, and usage writes', async () => {
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
      // The worst-case reservation is durable; settlement is PART of the
      // atomic terminal write the zombie is paused in front of (T08-U02) —
      // nothing of it may have landed yet.
      const [landed] = await pg<{ reservation: number; settlement: number }[]>`
        select
          count(*) filter (where idempotency_key = ${reservationKey})::int as reservation,
          count(*) filter (where idempotency_key = ${settleReservationIdempotencyKey(reservationKey)})::int as settlement
        from manna_transactions
      `;
      expect(landed).toEqual({ reservation: 1, settlement: 0 });

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
    expect(terminal).toEqual({ usage: 1, assistant: 0 });
    // The nonblank token was durably checkpointed before the terminal write
    // gate. Recovery therefore retains the full reserve and writes one loud
    // error usage row under full-reserve-v1; it never fabricates an assistant.
    const refunds = await pg<{ idempotency_key: string; amount: string }[]>`
      select idempotency_key, amount from manna_transactions
      where idempotency_key in (
        ${refundIdempotencyKey(settlementKey)},
        ${refundIdempotencyKey(reservationKey)},
        ${settleReservationIdempotencyKey(reservationKey)}
      )
    `;
    expect(refunds).toEqual([]);
    const [authorization] = await pg<{ state: string }[]>`
      select state from turn_authorizations where turn_id = ${occurrence.id}
    `;
    expect(authorization?.state).toBe('settled');
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

  it('loses the due-generation claim when an owner edit moves the selected occurrence', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Generation fenced edit',
        prompt: 'old prompt must never execute',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const dueAt = new Date(Date.now() - 30_000);
    await pg`update triggers set next_scheduled_run = ${dueAt.toISOString()} where id = ${task.id}`;
    let releaseSelected!: () => void;
    let markSelected!: () => void;
    const selectedGate = new Promise<void>((resolve) => {
      releaseSelected = resolve;
    });
    const selected = new Promise<void>((resolve) => {
      markSelected = resolve;
    });
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
      beforeProcessDue: async (selectedTrigger) => {
        if (selectedTrigger.id !== task.id) return;
        markSelected();
        await selectedGate;
      },
    });

    const ticking = scheduler.tick();
    try {
      await selected;
      const edited = await app.inject({
        method: 'PATCH',
        url: `/tasks/${task.id}`,
        headers: { cookie: devCookie(userId) },
        payload: {
          prompt: 'new owner prompt',
          schedule: { hour: 17, minute: 5, timezone: 'UTC' },
        },
      });
      expect(edited.statusCode).toBe(200);
      releaseSelected();
      expect((await ticking).outcomes).toContainEqual({
        triggerId: task.id,
        outcome: 'retry',
      });
    } finally {
      releaseSelected();
      await ticking.catch(() => {});
    }

    expect(compatCalls).toHaveLength(callsBefore);
    const [final] = await pg<{
      prompt: string;
      schedule: unknown;
      next_scheduled_run: string | Date;
      pending_occurrence_id: string | null;
    }[]>`
      select prompt, schedule, next_scheduled_run, pending_occurrence_id
      from triggers where id = ${task.id}
    `;
    expect(final!.prompt).toBe('new owner prompt');
    expect(final!.schedule).toEqual({ hour: 17, minute: 5, timezone: 'UTC' });
    expect(new Date(final!.next_scheduled_run).getTime()).toBeGreaterThan(Date.now());
    expect(final!.pending_occurrence_id).toBeNull();
  });

  it('lets two independent workers produce exactly one provider execution and terminal result', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name: 'Two-worker occurrence',
        prompt: 'Execute once across workers.',
        schedule,
      },
    });
    const { task } = created.json() as TaskBody;
    const dueAt = new Date(Date.now() - 30_000);
    const occurrence = scheduledTaskOccurrence(task.id, dueAt);
    await pg`update triggers set next_scheduled_run = ${dueAt.toISOString()} where id = ${task.id}`;
    let releaseProvider!: () => void;
    turnGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let releaseSelections!: () => void;
    let markBothSelected!: () => void;
    let selectedCount = 0;
    const selectionGate = new Promise<void>((resolve) => {
      releaseSelections = resolve;
    });
    const bothSelected = new Promise<void>((resolve) => {
      markBothSelected = resolve;
    });
    const callsBefore = compatCalls.length;
    const notificationFrames: string[] = [];
    const unsubscribeNotifications = app.eventsBus.subscribe(`account:${userId}`, {
      write: (frame: string) => notificationFrames.push(frame),
    });
    const makeWorker = () =>
      new TaskScheduler({
        runTask: makeScheduledTaskRunner({
          compat: fakeCompat,
          bus: app.eventsBus,
          registry: app.turnRegistry,
          historySync: app.historySync!,
          turnLimiter: app.turnLimiter,
        }),
        intervalMs: 0,
        restrictToTriggerIds: [task.id],
        beforeProcessDue: async (selectedTrigger) => {
          if (selectedTrigger.id !== task.id) return;
          selectedCount += 1;
          if (selectedCount === 2) markBothSelected();
          await selectionGate;
        },
      });
    const workerA = makeWorker();
    const workerB = makeWorker();
    const raced = Promise.all([workerA.tick(), workerB.tick()]);
    try {
      await bothSelected;
      releaseSelections();
      await expect.poll(() => compatCalls.length, { timeout: 5000 }).toBe(callsBefore + 1);
      releaseProvider();
      const results = await raced;
      expect(results.flatMap((result) => result.outcomes)).toEqual(
        expect.arrayContaining([
          { triggerId: task.id, outcome: 'fired' },
          { triggerId: task.id, outcome: 'retry' },
        ]),
      );
    } finally {
      releaseSelections();
      releaseProvider();
      turnGate = null;
      unsubscribeNotifications();
      await raced.catch(() => {});
    }
    expect(compatCalls).toHaveLength(callsBefore + 1);

    const [terminal] = await pg<{
      authorizations: number;
      provider_starts: number;
      usage: number;
      user_messages: number;
      assistant_messages: number;
      notifications: number;
    }[]>`
      select
        (select count(*)::int from turn_authorizations where turn_id = ${occurrence.id}) as authorizations,
        (select count(*)::int from turn_provider_runs where turn_id = ${occurrence.id}) as provider_starts,
        (select count(*)::int from usage_events where event_type = 'chat_turn' and turn_id = ${occurrence.id}) as usage,
        (select count(*)::int from messages where session_id = ${occurrence.id} and role = 'user') as user_messages,
        (select count(*)::int from messages where session_id = ${occurrence.id} and role = 'assistant') as assistant_messages,
        (select count(*)::int from app_notifications where id = ${occurrence.id}) as notifications
    `;
    expect(terminal).toEqual({
      authorizations: 1,
      provider_starts: 1,
      usage: 1,
      user_messages: 1,
      assistant_messages: 1,
      notifications: 1,
    });
    const [authorization] = await pg<{ state: string }[]>`
      select state from turn_authorizations where turn_id = ${occurrence.id}
    `;
    expect(authorization!.state).toBe('settled');
    expect(notificationFrames.filter((frame) => frame.includes('notification.created'))).toHaveLength(1);
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
        payload: { requestId: randomUUID() },
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
        payload: { requestId: randomUUID() },
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
        payload: { requestId: randomUUID() },
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

  it('403s non-owners including admins and 404s unknown ids; 400s empty patches', async () => {
    const task = await createTask();
    for (const caller of [otherUserId, adminId]) {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/tasks/${task.id}`,
            headers: { cookie: devCookie(caller) },
            payload: { status: 'paused' },
          })
        ).statusCode,
      ).toBe(403);
    }
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

describe('scheduled occurrence canonical authorization recovery', () => {
  async function createRecoveryTask(name: string): Promise<TriggerDto> {
    const response = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
      payload: {
        agentUsername,
        name,
        prompt: 'Recovery must never execute this prompt twice.',
        schedule,
      },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as TaskBody).task;
  }

  it('reverses a no-output crash split-exactly under a three-way recovery race', async () => {
    const task = await createRecoveryTask('Canonical split recovery race');
    const dueAt = new Date(Date.now() - 90 * 60_000);
    const seeded = await seedCanonicalRecoveryOccurrence({
      taskId: task.id,
      dueAt,
      usableOutput: false,
    });
    const callsBefore = compatCalls.length;
    const makeRecoveryWorker = () =>
      new TaskScheduler({
        runTask: async () => {
          throw new Error('provider runner must not execute canonical recovery');
        },
        recoverTask: makeScheduledTaskRecoveryRunner(),
        intervalMs: 0,
        reapStaleRunningMs: 15 * 60_000,
        restrictToTriggerIds: [task.id],
      });
    const reaper = new TurnReservationReaper({ accountScope: [userId] });

    await Promise.all([
      makeRecoveryWorker().recoveryTick(),
      makeRecoveryWorker().recoveryTick(),
      reaper.runOnce(),
    ]);

    expect(compatCalls).toHaveLength(callsBefore);
    const balance = await getBalance(userId);
    expect(balance.balance).toBe(seeded.durableBefore);
    expect(balance.subscriptionBalance).toBe(40);
    const [truth] = await pg<{
      state: string;
      refunds: number;
      usage: number;
      pending_occurrence_id: string | null;
      pending_occurrence_claim_id: string | null;
    }[]>`
      select
        a.state,
        (select count(*)::int
           from manna_transactions r
          where r.refunds_transaction_id = a.reservation_tx_id
            and r.amount > 0) as refunds,
        (select count(*)::int from usage_events u
          where u.event_type = 'chat_turn' and u.turn_id = a.turn_id) as usage,
        t.pending_occurrence_id,
        t.pending_occurrence_claim_id
      from turn_authorizations a
      join triggers t on t.id = ${task.id}
      where a.turn_id = ${seeded.occurrenceId}
    `;
    expect(['reversed', 'reaped']).toContain(truth!.state);
    expect(truth!.refunds).toBe(1);
    expect(truth!.usage).toBe(0);
    expect(truth!.pending_occurrence_id).toBeNull();
    expect(truth!.pending_occurrence_claim_id).toBeNull();

    // Leave the shared fixture account with an empty subscription pot so the
    // following split-exact case independently proves a 40 subscription / 21
    // durable reservation instead of inheriting this restored credit.
    await debit({
      accountId: userId,
      amount: 40,
      type: 'spend:test_cleanup',
      idempotencyKey: `${marker}:consume-restored-subscription:${seeded.occurrenceId}`,
    });
  });

  it('retains the full reserve after a durably checkpointed usable prefix', async () => {
    const task = await createRecoveryTask('Canonical partial-output recovery');
    const dueAt = new Date(Date.now() - 90 * 60_000);
    const seeded = await seedCanonicalRecoveryOccurrence({
      taskId: task.id,
      dueAt,
      usableOutput: true,
    });
    const callsBefore = compatCalls.length;
    const scheduler = new TaskScheduler({
      runTask: async () => {
        throw new Error('provider runner must not replay usable output');
      },
      recoverTask: makeScheduledTaskRecoveryRunner(),
      intervalMs: 0,
      reapStaleRunningMs: 15 * 60_000,
      restrictToTriggerIds: [task.id],
    });

    expect((await scheduler.recoveryTick()).outcomes).toContainEqual({
      triggerId: task.id,
      outcome: 'failed',
    });
    expect(compatCalls).toHaveLength(callsBefore);
    const balance = await getBalance(userId);
    expect(balance.balance).toBe(seeded.durableBefore - 21);
    expect(balance.subscriptionBalance).toBe(0);
    const [truth] = await pg<{
      state: string;
      charged_manna: string;
      refunds: number;
      usage: number;
      usage_manna: string;
      error_code: string;
      assistants: number;
      pending_occurrence_id: string | null;
    }[]>`
      select
        a.state,
        a.charged_manna,
        (select count(*)::int
           from manna_transactions r
          where r.refunds_transaction_id = a.reservation_tx_id
            and r.amount > 0) as refunds,
        (select count(*)::int from usage_events u
          where u.event_type = 'chat_turn' and u.turn_id = a.turn_id) as usage,
        (select u.manna::text from usage_events u
          where u.event_type = 'chat_turn' and u.turn_id = a.turn_id) as usage_manna,
        (select u.error_code from usage_events u
          where u.event_type = 'chat_turn' and u.turn_id = a.turn_id) as error_code,
        (select count(*)::int from messages m
          where m.session_id = a.session_id and m.role = 'assistant') as assistants,
        t.pending_occurrence_id
      from turn_authorizations a
      join triggers t on t.id = ${task.id}
      where a.turn_id = ${seeded.occurrenceId}
    `;
    expect(truth).toMatchObject({
      state: 'settled',
      charged_manna: '61.0000',
      refunds: 0,
      usage: 1,
      usage_manna: '61',
      error_code: SCHEDULED_TASK_INDETERMINATE,
      assistants: 0,
      pending_occurrence_id: null,
    });
  });
});
