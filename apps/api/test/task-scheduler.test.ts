import { loadRootEnv, pg } from '@eden3/db';
import type { Trigger } from '@eden3/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiError } from '../src/errors';
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
    Array<Omit<TriggerRow, 'next_scheduled_run'> & { next_scheduled_run: string | Date | null }>
  >`
    select status, next_scheduled_run, last_error, error_count
    from triggers where id = ${id}
  `;
  return {
    ...row!,
    // Normalize timestamptz to ISO regardless of the driver's parser.
    next_scheduled_run:
      row!.next_scheduled_run === null ? null : new Date(row!.next_scheduled_run).toISOString(),
  };
}

function makeScheduler(opts: {
  runTask?: (trigger: Trigger) => Promise<unknown>;
  now?: () => Date;
  cleanupGatewayJobs?: () => Promise<{ removed: number }>;
  intervalMs?: number;
  reapStaleRunningMs?: number;
  maxConsecutiveFailures?: number;
}): TaskScheduler {
  return new TaskScheduler({
    runTask: opts.runTask ?? (async () => {}),
    intervalMs: opts.intervalMs ?? 0,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.cleanupGatewayJobs ? { cleanupGatewayJobs: opts.cleanupGatewayJobs } : {}),
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

  it('reaps a task stranded in running (api crash mid-run) and re-fires it', async () => {
    // Simulate the strand: status='running', updated_at old, next_scheduled_run
    // still the pre-fire (past) value — exactly what a crash between the
    // active→running claim and the next-run stamp leaves behind.
    const id = await insertTrigger({
      schedule: { hour: 9, minute: 30, timezone: 'UTC' },
      nextScheduledRun: new Date(Date.now() - 60_000),
      status: 'running',
    });
    await pg`update triggers set updated_at = now() - interval '30 minutes' where id = ${id}`;

    const fired: string[] = [];
    const scheduler = makeScheduler({
      runTask: async (trigger) => {
        fired.push(trigger.id);
      },
      reapStaleRunningMs: 15 * 60 * 1000,
    });

    const { outcomes } = await scheduler.tick();
    // Reaped to active, then fired in the same tick.
    expect(fired).toContain(id);
    expect(outcomes.find((o) => o.triggerId === id)?.outcome).toBe('fired');
    const row = await readTrigger(id);
    expect(row.status).toBe('active');
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
  it('does not start when the interval is 0 (disabled)', () => {
    const scheduler = makeScheduler({ intervalMs: 0 });
    scheduler.start();
    expect(scheduler.running).toBe(false);
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
