import { DailyCapExceededError } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { Trigger } from '@eden3/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiError } from '../src/errors';
import { SCHEDULED_TASK_REFUND_PENDING_PREFIX } from '../src/services/scheduled-tasks';
import { TaskScheduler } from '../src/services/task-scheduler';
import { deleteFixturesByMarker, insertAgentAccount, insertUserAccount, makeMarker } from './fixtures';

loadRootEnv();

/**
 * TaskScheduler against live Postgres with an injected fake runTask and
 * clock. Every scheduler is scoped to this suite's fixture rows via the
 * restrictToTriggerIds test seam (the shared dev DB holds real migrated
 * triggers a full-table tick would otherwise stamp).
 */

const marker = makeMarker('tasksched');
let userId = '';
let agentId = '';
const fixtureTriggerIds: string[] = [];

const HOUR_MS = 60 * 60 * 1000;

interface TriggerRow {
  status: string | null;
  next_scheduled_run: string | null;
  last_error: string | null;
  error_count: number | null;
  pending_occurrence_id: string | null;
  pending_occurrence_kind: string | null;
  pending_occurrence_at: string | null;
  pending_occurrence_claim_id: string | null;
}

async function insertTrigger(opts: {
  schedule: unknown;
  nextScheduledRun: Date | null;
  status?: string;
  deleted?: boolean;
  errorCount?: number;
}): Promise<string> {
  const rows = await pg<{ id: string }[]>`
    insert into triggers (user_id, agent_id, name, prompt, schedule, status,
                          session_target, next_scheduled_run, deleted, error_count)
    values (${userId}, ${agentId}, ${`${marker} task`}, 'scheduled prompt',
            ${JSON.stringify(opts.schedule)}::jsonb, ${opts.status ?? 'active'},
            'new', ${opts.nextScheduledRun?.toISOString() ?? null},
            ${opts.deleted ?? false}, ${opts.errorCount ?? 0})
    returning id
  `;
  const id = rows[0]!.id;
  fixtureTriggerIds.push(id);
  return id;
}

async function readTrigger(id: string): Promise<TriggerRow> {
  const [row] = await pg<
    Array<
      Omit<TriggerRow, 'next_scheduled_run' | 'pending_occurrence_at'> & {
        next_scheduled_run: string | Date | null;
        pending_occurrence_at: string | Date | null;
      }
    >
  >`
    select status, next_scheduled_run, last_error, error_count,
           pending_occurrence_id, pending_occurrence_kind, pending_occurrence_at,
           pending_occurrence_claim_id
    from triggers where id = ${id}
  `;
  return {
    ...row!,
    // Normalize timestamptz to ISO regardless of the driver's parser.
    next_scheduled_run:
      row!.next_scheduled_run === null ? null : new Date(row!.next_scheduled_run).toISOString(),
    pending_occurrence_at:
      row!.pending_occurrence_at === null
        ? null
        : new Date(row!.pending_occurrence_at).toISOString(),
  };
}

function makeScheduler(opts: {
  runTask?: (trigger: Trigger) => Promise<unknown>;
  recoverTask?: (trigger: Trigger) => Promise<unknown>;
  recoveryIntervalMs?: number;
  now?: () => Date;
  cleanupGatewayJobs?: () => Promise<{ removed: number }>;
  cleanupGatewayJobsRetryMs?: number;
  intervalMs?: number;
  reapStaleRunningMs?: number;
  maxConsecutiveFailures?: number;
}): TaskScheduler {
  return new TaskScheduler({
    runTask: opts.runTask ?? (async () => {}),
    ...(opts.recoverTask ? { recoverTask: opts.recoverTask } : {}),
    ...(opts.recoveryIntervalMs !== undefined
      ? { recoveryIntervalMs: opts.recoveryIntervalMs }
      : {}),
    intervalMs: opts.intervalMs ?? 0,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.cleanupGatewayJobs ? { cleanupGatewayJobs: opts.cleanupGatewayJobs } : {}),
    ...(opts.cleanupGatewayJobsRetryMs !== undefined
      ? { cleanupGatewayJobsRetryMs: opts.cleanupGatewayJobsRetryMs }
      : {}),
    ...(opts.reapStaleRunningMs !== undefined
      ? { reapStaleRunningMs: opts.reapStaleRunningMs }
      : {}),
    ...(opts.maxConsecutiveFailures !== undefined
      ? { maxConsecutiveFailures: opts.maxConsecutiveFailures }
      : {}),
    restrictToTriggerIds: fixtureTriggerIds,
  });
}

beforeAll(async () => {
  userId = await insertUserAccount(`${marker}_user`);
  agentId = await insertAgentAccount(`${marker}_bot`, {
    ownerId: userId,
    openclawId: `${marker}bot`.replace(/_/g, '-'),
    provisionStatus: 'ready',
  });
});

afterAll(async () => {
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('TaskScheduler.tick', () => {
  it('retries native cron cleanup on ticks until one success, then latches', async () => {
    let sweeps = 0;
    const scheduler = makeScheduler({
      cleanupGatewayJobs: async () => {
        sweeps += 1;
        if (sweeps < 3) throw new Error('gateway temporarily unavailable');
        return { removed: 4 };
      },
    });

    await scheduler.tick();
    expect(sweeps).toBe(1);
    await scheduler.tick();
    expect(sweeps).toBe(2);
    await scheduler.tick();
    expect(sweeps).toBe(3);
    await scheduler.tick();
    expect(sweeps).toBe(3);
  });

  it('does not fire due work until the legacy native-cron sweep succeeds', async () => {
    const id = await insertTrigger({
      schedule: { hour: '*', minute: 0, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000),
    });
    let sweeps = 0;
    const fired: string[] = [];
    const scheduler = makeScheduler({
      cleanupGatewayJobs: async () => {
        sweeps += 1;
        if (sweeps < 3) throw new Error('legacy cron state unavailable');
        return { removed: 1 };
      },
      runTask: async (trigger) => {
        fired.push(trigger.id);
      },
    });

    expect((await scheduler.tick()).outcomes).toEqual([]);
    expect((await scheduler.tick()).outcomes).toEqual([]);
    expect(fired).toEqual([]);
    expect((await scheduler.tick()).outcomes).toContainEqual({
      triggerId: id,
      outcome: 'fired',
    });
    expect(fired).toEqual([id]);
  });

  it('runs compensation before the native-cron cleanup fence', async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const id = await insertTrigger({
      schedule: { hour: '*', minute: 0, timezone: 'UTC' },
      nextScheduledRun: null,
      status: 'paused',
    });
    await pg`
      update triggers
      set pending_occurrence_id = ${crypto.randomUUID()},
          pending_occurrence_kind = 'scheduled',
          pending_occurrence_at = ${dueAt.toISOString()},
          last_error = ${`${SCHEDULED_TASK_REFUND_PENDING_PREFIX} retry me`}
      where id = ${id}
    `;
    const recovered: string[] = [];
    let finishCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const scheduler = makeScheduler({
      cleanupGatewayJobs: async () => {
        await cleanupBlocked;
        return { removed: 0 };
      },
      runTask: async () => {
        throw new Error('normal provider runner must stay fenced');
      },
      recoverTask: async (trigger) => {
        recovered.push(trigger.id);
        await pg`
          update triggers
          set pending_occurrence_id = null,
              pending_occurrence_kind = null,
              pending_occurrence_at = null,
              pending_occurrence_claim_id = null
          where id = ${trigger.id}
        `;
      },
    });

    const ticking = scheduler.tick();
    try {
      // A gateway cleanup call that never returns must not hold compensation.
      await expect.poll(() => recovered.includes(id), { timeout: 5000 }).toBe(true);
    } finally {
      finishCleanup();
    }
    expect((await ticking).outcomes).toContainEqual({ triggerId: id, outcome: 'fired' });
  });

  it('fires due recurring tasks via runTask and stamps the next future run', async () => {
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000), // due 1 min ago
    });
    const fired: string[] = [];
    const scheduler = makeScheduler({
      runTask: async (trigger) => {
        fired.push(trigger.id);
      },
    });

    const { outcomes } = await scheduler.tick();
    expect(outcomes.find((o) => o.triggerId === id)?.outcome).toBe('fired');
    expect(fired).toEqual([id]);

    const row = await readTrigger(id);
    expect(row.status).toBe('active');
    expect(row.next_scheduled_run).not.toBeNull();
    const next = new Date(row.next_scheduled_run!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(30);
    expect(row.last_error).toBeNull();
    expect(row.error_count).toBe(0);
  });

  it('finishes one-time tasks after firing (status finished, next null)', async () => {
    const at = new Date(Date.now() - 30_000).toISOString();
    const id = await insertTrigger({
      schedule: { at },
      nextScheduledRun: new Date(at),
    });
    const fired: string[] = [];
    const scheduler = makeScheduler({
      runTask: async (trigger) => {
        fired.push(trigger.id);
      },
    });

    const { outcomes } = await scheduler.tick();
    expect(outcomes.find((o) => o.triggerId === id)?.outcome).toBe('fired');
    expect(fired).toEqual([id]);

    const row = await readTrigger(id);
    expect(row.status).toBe('finished');
    expect(row.next_scheduled_run).toBeNull();
  });

  it('skips fires missed by more than the grace window, stamping forward with an advisory note', async () => {
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 7 * HOUR_MS), // way past 6h grace
      errorCount: 3,
    });
    const fired: string[] = [];
    const scheduler = makeScheduler({
      runTask: async (trigger) => {
        fired.push(trigger.id);
      },
    });

    const { outcomes } = await scheduler.tick();
    expect(outcomes.find((o) => o.triggerId === id)?.outcome).toBe('missed');
    expect(fired).toEqual([]); // NOT fired late

    const row = await readTrigger(id);
    expect(row.status).toBe('active');
    expect(new Date(row.next_scheduled_run!).getTime()).toBeGreaterThan(Date.now());
    expect(row.last_error).toMatch(/^missed fire at .* \(api was down\)$/);
    expect(row.error_count).toBe(3); // advisory only — NOT incremented
  });

  it('fires late when the miss is within the grace window', async () => {
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 2 * HOUR_MS), // stale but < 6h
    });
    const fired: string[] = [];
    const scheduler = makeScheduler({
      runTask: async (trigger) => {
        fired.push(trigger.id);
      },
    });
    await scheduler.tick();
    expect(fired).toEqual([id]);
  });

  it('finishes a one-time task whose instant was missed beyond grace (never fires)', async () => {
    const at = new Date(Date.now() - 8 * HOUR_MS).toISOString();
    const id = await insertTrigger({ schedule: { at }, nextScheduledRun: new Date(at) });
    const fired: string[] = [];
    const scheduler = makeScheduler({
      runTask: async (trigger) => {
        fired.push(trigger.id);
      },
    });
    await scheduler.tick();
    expect(fired).toEqual([]);
    const row = await readTrigger(id);
    expect(row.status).toBe('finished');
    expect(row.next_scheduled_run).toBeNull();
    expect(row.last_error).toContain('missed fire at');
  });

  it('still stamps the next run when the run fails (error recording stays with runScheduledTask)', async () => {
    const id = await insertTrigger({
      schedule: { hour: '*', minute: 0, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000),
    });
    const scheduler = makeScheduler({
      runTask: async () => {
        throw new Error('gateway exploded mid-turn');
      },
    });

    const { outcomes } = await scheduler.tick();
    expect(outcomes.find((o) => o.triggerId === id)?.outcome).toBe('failed');

    const row = await readTrigger(id);
    expect(new Date(row.next_scheduled_run!).getTime()).toBeGreaterThan(Date.now());
    // Non-ApiError failures are recorded by runScheduledTask.markTaskError,
    // which the fake bypassed — the scheduler itself must not double-record.
    expect(row.last_error).toBeNull();
    expect(row.error_count).toBe(0);
  });

  it('records pre-claim ApiError config failures itself, then stamps forward', async () => {
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000),
    });
    const scheduler = makeScheduler({
      runTask: async () => {
        throw new ApiError(409, 'task_agent_not_ready', 'Task agent is not ready');
      },
    });

    await scheduler.tick();
    const row = await readTrigger(id);
    expect(new Date(row.next_scheduled_run!).getTime()).toBeGreaterThan(Date.now());
    expect(row.last_error).toBe('Task agent is not ready');
    expect(row.error_count).toBe(1);
  });

  it('auto-pauses a recurring task once consecutive failures reach the threshold', async () => {
    // 19 prior consecutive failures; this tick's ApiError makes 20 = the default threshold.
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000),
      errorCount: 19,
    });
    const scheduler = makeScheduler({
      runTask: async () => {
        throw new ApiError(402, 'insufficient_manna', 'insufficient manna: account x has 0, needs 1');
      },
    });

    await scheduler.tick();
    const row = await readTrigger(id);
    expect(row.status).toBe('paused');
    expect(row.error_count).toBe(20);
    expect(row.last_error).toMatch(
      /^auto-paused after 20 consecutive failures; last: insufficient manna/,
    );
  });

  it('keeps a failing task active while below the consecutive-failure threshold', async () => {
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000),
      errorCount: 5,
    });
    const scheduler = makeScheduler({
      runTask: async () => {
        throw new ApiError(402, 'insufficient_manna', 'insufficient manna: account x has 0, needs 1');
      },
    });

    await scheduler.tick();
    const row = await readTrigger(id);
    expect(row.status).toBe('active');
    expect(row.error_count).toBe(6);
    expect(new Date(row.next_scheduled_run!).getTime()).toBeGreaterThan(Date.now());
  });

  it('immediately auto-pauses and clears the next run on the rolling hourly cap', async () => {
    const id = await insertTrigger({
      schedule: { hour: '*', minute: 30, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000),
    });
    const scheduler = makeScheduler({
      runTask: async () => {
        throw new ApiError(
          429,
          'automation_hourly_budget_exceeded',
          'Agent automation hourly manna cap reached: 80 spent in the last hour, cap is 80',
        );
      },
    });

    const result = await scheduler.tick();
    expect(result.outcomes.find((row) => row.triggerId === id)?.outcome).toBe('failed');
    const row = await readTrigger(id);
    expect(row.status).toBe('paused');
    expect(row.next_scheduled_run).toBeNull();
    expect(row.error_count).toBe(1);
    expect(row.last_error).toContain('auto-paused after automation budget refusal');
    expect(row.last_error).toContain('cap is 80');
  });

  it('auto-pauses rather than finishes a one-time task refused by a budget cap', async () => {
    const at = new Date(Date.now() - 30_000).toISOString();
    const id = await insertTrigger({ schedule: { at }, nextScheduledRun: new Date(at) });
    const scheduler = makeScheduler({
      runTask: async () => {
        throw new ApiError(
          429,
          'automation_hourly_budget_exceeded',
          'Agent automation hourly manna cap reached: 80 spent in the last hour, cap is 80',
        );
      },
    });

    await scheduler.tick();
    const row = await readTrigger(id);
    expect(row.status).toBe('paused');
    expect(row.next_scheduled_run).toBeNull();
    expect(row.last_error).toContain('auto-paused after automation budget refusal');
  });

  it('immediately auto-pauses after the metering layer refuses the daily cap', async () => {
    const id = await insertTrigger({
      schedule: { hour: '*', minute: 35, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000),
    });
    const scheduler = makeScheduler({
      runTask: async () => {
        // runScheduledTask records this pre-stream debit refusal before
        // rethrowing it; mirror that durable effect in the injected seam.
        await pg`
          update triggers
          set last_error = 'daily cap reached', error_count = 1
          where id = ${id}
        `;
        throw new DailyCapExceededError(userId, 500, 1, 500);
      },
    });

    await scheduler.tick();
    const row = await readTrigger(id);
    expect(row.status).toBe('paused');
    expect(row.next_scheduled_run).toBeNull();
    expect(row.error_count).toBe(1);
    expect(row.last_error).toContain('daily manna cap exceeded');
  });

  it('never auto-pauses when maxConsecutiveFailures is disabled (<= 0)', async () => {
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000),
      errorCount: 500,
    });
    const scheduler = makeScheduler({
      maxConsecutiveFailures: 0,
      runTask: async () => {
        throw new ApiError(402, 'insufficient_manna', 'insufficient manna: account x has 0, needs 1');
      },
    });

    await scheduler.tick();
    const row = await readTrigger(id);
    expect(row.status).toBe('active');
    expect(row.error_count).toBe(501);
  });

  it('leaves the row untouched on lost-claim/concurrency errors (retry next tick)', async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: dueAt,
    });
    for (const code of ['task_not_active', 'turn_concurrency_exceeded']) {
      const scheduler = makeScheduler({
        runTask: async () => {
          throw new ApiError(code === 'task_not_active' ? 409 : 429, code, code);
        },
      });
      const { outcomes } = await scheduler.tick();
      expect(outcomes.find((o) => o.triggerId === id)?.outcome).toBe('retry');
      const row = await readTrigger(id);
      expect(row.next_scheduled_run).toBe(dueAt.toISOString());
      expect(row.last_error).toBeNull();
      expect(row.error_count).toBe(0);
    }
    // Clear the row so later ticks in this suite don't re-see it.
    await pg`update triggers set status = 'paused' where id = ${id}`;
  });

  it('never selects paused, deleted, finished, un-stamped, or future rows', async () => {
    const pausedId = await insertTrigger({
      schedule: { hour: 9, minute: 30 },
      nextScheduledRun: new Date(Date.now() - 60_000),
      status: 'paused',
    });
    const deletedId = await insertTrigger({
      schedule: { hour: 9, minute: 30 },
      nextScheduledRun: new Date(Date.now() - 60_000),
      deleted: true,
    });
    const finishedId = await insertTrigger({
      schedule: { hour: 9, minute: 30 },
      nextScheduledRun: new Date(Date.now() - 60_000),
      status: 'finished',
    });
    const unstampedId = await insertTrigger({
      schedule: { hour: 9, minute: 30 },
      nextScheduledRun: null,
    });
    const futureId = await insertTrigger({
      schedule: { hour: 9, minute: 30 },
      nextScheduledRun: new Date(Date.now() + HOUR_MS),
    });
    const fired: string[] = [];
    const scheduler = makeScheduler({
      runTask: async (trigger) => {
        fired.push(trigger.id);
      },
    });
    await scheduler.tick();
    for (const id of [pausedId, deletedId, finishedId, unstampedId, futureId]) {
      expect(fired).not.toContain(id);
    }
  });

  it('overlapping ticks cannot double-fire a task (in-process guard)', async () => {
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const scheduler = makeScheduler({
      runTask: async () => {
        calls += 1;
        await gate; // hold the run mid-flight
      },
    });

    const first = scheduler.tick();
    // Wait until the first tick has actually claimed the row in-process.
    await expect.poll(() => calls, { timeout: 5000 }).toBe(1);
    const second = await scheduler.tick(); // overlaps while the run hangs
    expect(second.outcomes.find((o) => o.triggerId === id)?.outcome).toBe('in_flight');
    expect(calls).toBe(1);

    release();
    const firstResult = await first;
    expect(firstResult.outcomes.find((o) => o.triggerId === id)?.outcome).toBe('fired');
  });

  it('queues a stale running occurrence exactly once for compensation-only recovery', async () => {
    let schedulerNow = new Date();
    const dueAt = new Date(schedulerNow.getTime() - 60_000);
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: dueAt,
      status: 'running',
    });
    const occurrenceId = crypto.randomUUID();
    const oldClaimId = crypto.randomUUID();
    await pg`
      update triggers
      set pending_occurrence_id = ${occurrenceId},
          pending_occurrence_kind = 'scheduled',
          pending_occurrence_at = ${dueAt.toISOString()},
          pending_occurrence_claim_id = ${oldClaimId},
          updated_at = ${new Date(schedulerNow.getTime() - 30 * 60_000).toISOString()}
      where id = ${id}
    `;

    const recoveries: Array<{ id: string; status: string | null; error: string | null }> = [];
    const scheduler = makeScheduler({
      runTask: async (trigger) => {
        recoveries.push({ id: trigger.id, status: trigger.status, error: trigger.lastError });
        // The injected seam stands in for runScheduledTask's terminal
        // compensation write; clear the occurrence so later ages cannot replay.
        await pg`
          update triggers
          set pending_occurrence_id = null,
              pending_occurrence_kind = null,
              pending_occurrence_at = null,
              pending_occurrence_claim_id = null,
              last_error = 'stale occurrence closed without provider replay'
          where id = ${trigger.id}
        `;
      },
      now: () => schedulerNow,
      reapStaleRunningMs: 15 * 60 * 1000,
    });

    const { outcomes } = await scheduler.tick();
    expect(recoveries).toEqual([
      {
        id,
        status: 'paused',
        error: expect.stringContaining('stale recovery pending'),
      },
    ]);
    expect(outcomes.find((o) => o.triggerId === id)?.outcome).toBe('fired');
    const row = await readTrigger(id);
    expect(row.status).toBe('paused');
    expect(row.next_scheduled_run).toBeNull();
    expect(row.pending_occurrence_id).toBeNull();
    expect(row.pending_occurrence_kind).toBeNull();
    expect(row.pending_occurrence_at).toBeNull();
    expect(row.pending_occurrence_claim_id).toBeNull();
    expect(row.last_error).toContain('without provider replay');

    // Ageing the terminal quarantine by another hour must never make it
    // cadence-replayable.
    schedulerNow = new Date(schedulerNow.getTime() + 60 * 60_000);
    const later = await scheduler.tick();
    expect(recoveries.filter((recovery) => recovery.id === id)).toHaveLength(1);
    expect(later.outcomes.find((outcome) => outcome.triggerId === id)).toBeUndefined();
  });

  it('never replays an old owner-paused pending occurrence based on age alone', async () => {
    const now = new Date();
    const dueAt = new Date(now.getTime() - 60_000);
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: null,
      status: 'paused',
    });
    const occurrenceId = crypto.randomUUID();
    await pg`
      update triggers
      set pending_occurrence_id = ${occurrenceId},
          pending_occurrence_kind = 'scheduled',
          pending_occurrence_at = ${dueAt.toISOString()},
          updated_at = ${new Date(now.getTime() - 3 * 60 * 60_000).toISOString()}
      where id = ${id}
    `;

    let calls = 0;
    const scheduler = makeScheduler({
      runTask: async () => {
        calls += 1;
      },
      now: () => now,
      reapStaleRunningMs: 15 * 60 * 1000,
    });

    const result = await scheduler.tick();
    expect(calls).toBe(0);
    expect(result.outcomes.find((outcome) => outcome.triggerId === id)).toBeUndefined();
    const row = await readTrigger(id);
    expect(row.status).toBe('paused');
    expect(row.pending_occurrence_id).toBe(occurrenceId);
  });

  it('does NOT reap a task that is legitimately mid-run (recently updated)', async () => {
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000),
      status: 'running',
    });
    // updated_at is fresh (just inserted) → within the reap window.
    const fired: string[] = [];
    const scheduler = makeScheduler({
      runTask: async (trigger) => {
        fired.push(trigger.id);
      },
      reapStaleRunningMs: 15 * 60 * 1000,
    });

    await scheduler.tick();
    expect(fired).not.toContain(id);
    const row = await readTrigger(id);
    expect(row.status).toBe('running'); // left alone
    await pg`update triggers set status = 'paused' where id = ${id}`; // clear for later ticks
  });
});

describe('TaskScheduler.start', () => {
  it('does not start task firing when the interval is 0 (disabled)', () => {
    const scheduler = makeScheduler({ intervalMs: 0 });
    scheduler.start();
    expect(scheduler.running).toBe(false);
    scheduler.stop();
  });

  it('keeps provider-free compensation running when normal firing is disabled', async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const id = await insertTrigger({
      schedule: { hour: '*', minute: 0, timezone: 'UTC' },
      nextScheduledRun: null,
      status: 'paused',
    });
    await pg`
      update triggers
      set pending_occurrence_id = ${crypto.randomUUID()},
          pending_occurrence_kind = 'scheduled',
          pending_occurrence_at = ${dueAt.toISOString()},
          last_error = ${`${SCHEDULED_TASK_REFUND_PENDING_PREFIX} interval-zero retry`}
      where id = ${id}
    `;
    const recovered: string[] = [];
    const scheduler = makeScheduler({
      intervalMs: 0,
      recoveryIntervalMs: 5,
      runTask: async () => {
        throw new Error('normal provider runner must remain disabled');
      },
      recoverTask: async (trigger) => {
        recovered.push(trigger.id);
        await pg`
          update triggers
          set pending_occurrence_id = null,
              pending_occurrence_kind = null,
              pending_occurrence_at = null,
              pending_occurrence_claim_id = null
          where id = ${trigger.id}
        `;
      },
    });
    try {
      scheduler.start();
      expect(scheduler.running).toBe(false);
      await expect.poll(() => recovered.includes(id), { timeout: 5000 }).toBe(true);
    } finally {
      scheduler.stop();
    }
  });

  it('retries native cron cleanup even when task firing is disabled', async () => {
    let sweeps = 0;
    const scheduler = makeScheduler({
      intervalMs: 0,
      cleanupGatewayJobsRetryMs: 5,
      cleanupGatewayJobs: async () => {
        sweeps += 1;
        if (sweeps === 1) throw new Error('gateway booting');
        return { removed: 3 };
      },
    });
    try {
      scheduler.start();
      scheduler.start();
      expect(scheduler.running).toBe(false);
      await expect.poll(() => sweeps, { timeout: 5000 }).toBe(2);
    } finally {
      scheduler.stop();
    }
  });

  it('runs the legacy gateway-job sweep once on start', async () => {
    let sweeps = 0;
    const scheduler = makeScheduler({
      intervalMs: 60_000,
      cleanupGatewayJobs: async () => {
        sweeps += 1;
        return { removed: 2 };
      },
    });
    try {
      scheduler.start();
      scheduler.start(); // idempotent — no second sweep, no second timer
      expect(scheduler.running).toBe(true);
      await expect.poll(() => sweeps, { timeout: 5000 }).toBe(1);
    } finally {
      scheduler.stop();
    }
    expect(scheduler.running).toBe(false);
  });
});
