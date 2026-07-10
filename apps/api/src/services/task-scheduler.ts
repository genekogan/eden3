import { db, triggers, type Trigger } from '@eden3/db';
import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import { ApiError } from '../errors';
import type { EventsBus } from '../events-bus';
import { concurrentTurnLimit, type TurnConcurrencyLimiter } from './chat-limits';
import type { HistorySync } from './history-sync';
import { runScheduledTask, type ScheduledRunResult } from './scheduled-tasks';
import { isOneTimeSchedule, nextOccurrence, TaskScheduleError } from './task-schedule';
import type { TurnRegistry } from './turn-registry';
import type { CompatClientLike } from './turns';

/**
 * Eden3-side scheduler for scheduled tasks (triggers).
 *
 * An interval loop (default 30s, `TASK_SCHEDULER_INTERVAL_MS`) selects due
 * triggers — status='active', not deleted, next_scheduled_run <= now — and
 * fires each through {@link runScheduledTask}, the SAME metered pipeline
 * run-now uses (atomic active→running claim, manna debit with the daily cap,
 * usage_events, lastRunTime/lastError stamps). This replaces the old
 * OpenClaw-gateway cron path, whose fires bypassed metering entirely.
 *
 * After each attempt (success or failure) the tick stamps the NEXT
 * next_scheduled_run; one-time `{at}` tasks become status='finished' with a
 * null next run instead.
 *
 * Missed-fire grace: a due time older than `graceMs` (default 6h — e.g. the
 * API was down over the window) is NOT fired late; the task skips forward to
 * its next future occurrence and records an advisory
 * `missed fire at <ts> (api was down)` in last_error WITHOUT incrementing
 * error_count. Within the grace window it fires late.
 *
 * Double-fire safety: the atomic active→running claim in runScheduledTask is
 * the authoritative guard (multi-process safe); the in-process `inFlight` set
 * additionally keeps overlapping ticks in this process from even attempting a
 * duplicate.
 */

/** Failure codes that mean "someone else has it / retry next tick" — no stamps. */
const RETRY_NEXT_TICK_CODES = new Set([
  'task_not_active', // lost the atomic claim, or paused/finished mid-tick
  'task_not_found', // deleted mid-tick
  'turn_concurrency_exceeded', // owner's turn slots full — retry within grace
]);

export type ProcessOutcome =
  | 'fired'
  | 'failed'
  | 'missed'
  | 'retry'
  | 'in_flight';

export interface TickResult {
  /** Trigger ids by outcome. */
  outcomes: Array<{ triggerId: string; outcome: ProcessOutcome }>;
}

interface SchedulerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface TaskSchedulerOptions {
  /** Fire one due trigger (injectable; see {@link makeScheduledTaskRunner}). */
  runTask: (trigger: Trigger) => Promise<unknown>;
  /** Tick interval; <= 0 disables start() entirely. */
  intervalMs: number;
  /** Missed-fire grace window (default 6h). */
  graceMs?: number;
  /**
   * Reap tasks stuck in `running` longer than this (default 15m — longer than
   * any turn timeout) back to `active`, so a task stranded by an api
   * crash/kill between the claim and the next-run stamp fires again instead
   * of being lost forever.
   */
  reapStaleRunningMs?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
  /**
   * One-time boot cleanup — removes legacy `eden3:*` gateway cron jobs so
   * they stop double-firing (gateway-side scheduled firing is retired).
   * Best-effort: failures are logged, never fatal.
   */
  cleanupGatewayJobs?: (() => Promise<{ removed: number }>) | null;
  logger?: SchedulerLogger | null;
  /** Max due rows per tick. */
  batchLimit?: number;
  /**
   * TEST SEAM: when set, ticks only consider these trigger ids — suites run
   * full ticks against the shared dev database without touching real rows.
   * Production never sets this.
   */
  restrictToTriggerIds?: string[];
}

export class TaskScheduler {
  private readonly runTask: (trigger: Trigger) => Promise<unknown>;
  private readonly intervalMs: number;
  private readonly graceMs: number;
  private readonly reapStaleRunningMs: number;
  private readonly now: () => Date;
  private readonly cleanupGatewayJobs: (() => Promise<{ removed: number }>) | null;
  private readonly log: SchedulerLogger | null;
  private readonly batchLimit: number;
  private readonly restrictToTriggerIds: string[] | null;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: TaskSchedulerOptions) {
    this.runTask = options.runTask;
    this.intervalMs = options.intervalMs;
    this.graceMs = options.graceMs ?? 6 * 60 * 60 * 1000;
    this.reapStaleRunningMs = options.reapStaleRunningMs ?? 15 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.cleanupGatewayJobs = options.cleanupGatewayJobs ?? null;
    this.log = options.logger ?? null;
    this.batchLimit = options.batchLimit ?? 50;
    this.restrictToTriggerIds = options.restrictToTriggerIds ?? null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Begin ticking (no-op when already running or intervalMs <= 0). */
  start(): void {
    if (this.timer !== null || this.intervalMs <= 0) return;
    // Legacy gateway cron jobs would double-fire against this scheduler —
    // sweep them once, in the background (a down gateway must not block boot).
    if (this.cleanupGatewayJobs) {
      void this.cleanupGatewayJobs()
        .then(({ removed }) => {
          this.log?.info({ removed }, 'task-scheduler: removed legacy eden3 gateway cron jobs');
        })
        .catch((err) => {
          this.log?.warn({ err }, 'task-scheduler: legacy gateway cron cleanup failed');
        });
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.log?.error({ err }, 'task-scheduler: tick failed');
      });
    }, this.intervalMs);
    this.timer.unref?.();
    this.log?.info({ intervalMs: this.intervalMs }, 'task-scheduler: started');
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One scheduler pass: select due triggers and process them concurrently.
   * Safe to call directly (tests) or while another tick is still running —
   * `inFlight` + the DB claim make duplicate fires impossible.
   */
  async tick(): Promise<TickResult> {
    const now = this.now();
    await this.reapStaleRunning(now);
    const due = await db
      .select()
      .from(triggers)
      .where(
        and(
          eq(triggers.status, 'active'),
          eq(triggers.deleted, false),
          isNotNull(triggers.nextScheduledRun),
          lte(triggers.nextScheduledRun, now),
          ...(this.restrictToTriggerIds !== null
            ? [inArray(triggers.id, this.restrictToTriggerIds)]
            : []),
        ),
      )
      .orderBy(asc(triggers.nextScheduledRun))
      .limit(this.batchLimit);

    const outcomes = await Promise.all(
      due.map(async (row) => ({ triggerId: row.id, outcome: await this.processDue(row) })),
    );
    return { outcomes };
  }

  /**
   * Reclaim tasks stranded in `running` (an api crash/kill between the
   * atomic active→running claim and the next-run stamp). Only rows not
   * touched for `reapStaleRunningMs` — longer than any turn — are reset to
   * `active`; their next_scheduled_run is still the pre-fire (past) value, so
   * the normal tick then re-fires or skip-forwards them. Not deleted/finished
   * rows. Excluded from `restrictToTriggerIds` test scoping.
   */
  private async reapStaleRunning(now: Date): Promise<void> {
    if (this.restrictToTriggerIds !== null && this.restrictToTriggerIds.length === 0) return;
    const cutoff = new Date(now.getTime() - this.reapStaleRunningMs);
    const reaped = await db
      .update(triggers)
      .set({ status: 'active', updatedAt: now })
      .where(
        and(
          eq(triggers.status, 'running'),
          eq(triggers.deleted, false),
          lte(triggers.updatedAt, cutoff),
          ...(this.restrictToTriggerIds !== null
            ? [inArray(triggers.id, this.restrictToTriggerIds)]
            : []),
        ),
      )
      .returning({ id: triggers.id });
    if (reaped.length > 0) {
      this.log?.warn(
        { count: reaped.length, triggerIds: reaped.map((r) => r.id) },
        'task-scheduler: reclaimed stale running tasks (likely an api restart mid-run)',
      );
    }
  }

  private async processDue(row: Trigger): Promise<ProcessOutcome> {
    if (this.inFlight.has(row.id)) return 'in_flight';
    this.inFlight.add(row.id);
    try {
      const dueAt = row.nextScheduledRun;
      if (!dueAt) return 'retry'; // unreachable — the query filters nulls
      const now = this.now();
      if (now.getTime() - dueAt.getTime() > this.graceMs) {
        await this.skipMissedFire(row, dueAt);
        return 'missed';
      }

      let failed = false;
      try {
        await this.runTask(row);
      } catch (err) {
        if (err instanceof ApiError && RETRY_NEXT_TICK_CODES.has(err.code)) {
          return 'retry';
        }
        failed = true;
        if (err instanceof ApiError) {
          // Pre-claim config failures (owner/agent unavailable, missing
          // prompt) never reach runScheduledTask's own error stamps — record
          // here so the task row surfaces the reason.
          await this.recordError(row, err.message);
        }
        // Non-ApiError failures (turn errors, manna) were already recorded by
        // runScheduledTask.markTaskError — only the next-run stamp remains.
        this.log?.error({ err, triggerId: row.id }, 'task-scheduler: scheduled run failed');
      }
      await this.stampNextRun(row);
      return failed ? 'failed' : 'fired';
    } finally {
      this.inFlight.delete(row.id);
    }
  }

  /** Compute the follow-up next_scheduled_run after a fire attempt. */
  private async stampNextRun(row: Trigger): Promise<void> {
    if (isOneTimeSchedule(row.schedule)) {
      // One shot spent (fired or failed): finish the task.
      await db
        .update(triggers)
        .set({ status: 'finished', nextScheduledRun: null, updatedAt: new Date() })
        .where(eq(triggers.id, row.id));
      return;
    }
    const next = this.safeNext(row);
    await db
      .update(triggers)
      .set({
        nextScheduledRun: next.value,
        ...(next.error !== null
          ? {
              lastError: next.error.slice(0, 2000),
              errorCount: sql`coalesce(${triggers.errorCount}, 0) + 1`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(triggers.id, row.id));
  }

  /**
   * Grace exceeded: do NOT fire. Skip forward to the next future occurrence
   * and leave an advisory note in last_error (no error_count increment —
   * the task itself did nothing wrong).
   */
  private async skipMissedFire(row: Trigger, dueAt: Date): Promise<void> {
    const oneTime = isOneTimeSchedule(row.schedule);
    const next = oneTime ? { value: null, error: null } : this.safeNext(row);
    await db
      .update(triggers)
      .set({
        nextScheduledRun: next.value,
        // A one-time task's single occurrence is gone — finish it.
        ...(oneTime ? { status: 'finished' as const } : {}),
        lastError: `missed fire at ${dueAt.toISOString()} (api was down)`,
        updatedAt: new Date(),
      })
      .where(and(eq(triggers.id, row.id), eq(triggers.status, 'active')));
    this.log?.warn(
      { triggerId: row.id, dueAt: dueAt.toISOString() },
      'task-scheduler: skipped missed fire',
    );
  }

  private safeNext(row: Trigger): { value: Date | null; error: string | null } {
    try {
      return { value: nextOccurrence(row.schedule, this.now()), error: null };
    } catch (err) {
      if (err instanceof TaskScheduleError) return { value: null, error: err.message };
      throw err;
    }
  }

  private async recordError(row: Trigger, message: string): Promise<void> {
    await db
      .update(triggers)
      .set({
        lastError: message.slice(0, 2000),
        errorCount: sql`coalesce(${triggers.errorCount}, 0) + 1`,
        updatedAt: new Date(),
      })
      .where(eq(triggers.id, row.id));
  }
}

// ---------------------------------------------------------------------------
// Default runner — the same guard rails as POST /tasks/:id/runs
// ---------------------------------------------------------------------------

export interface ScheduledTaskRunnerDeps {
  compat: CompatClientLike;
  bus: EventsBus;
  registry: TurnRegistry;
  historySync: HistorySync;
  turnLimiter: TurnConcurrencyLimiter;
  onError?: (err: unknown, context: string) => void;
}

/**
 * Build the production `runTask` for {@link TaskScheduler}: acquire a slot in
 * the owner's turn-concurrency limiter, then run the metered pipeline. The
 * daily manna cap needs no pre-check here — `debit({dailyCap})` inside
 * runTurn enforces it race-free and the failure is recorded on the task row.
 */
export function makeScheduledTaskRunner(
  deps: ScheduledTaskRunnerDeps,
): (trigger: Trigger) => Promise<ScheduledRunResult> {
  return async (trigger) => {
    if (!trigger.userId) {
      throw new ApiError(409, 'task_missing_owner', `Task ${trigger.id} has no owner`);
    }
    const turnLimit = await concurrentTurnLimit(trigger.userId);
    const releaseTurn = deps.turnLimiter.acquire(trigger.userId, turnLimit.limit);
    if (!releaseTurn) {
      throw new ApiError(
        429,
        'turn_concurrency_exceeded',
        `Too many active turns for ${trigger.userId}: limit is ${turnLimit.limit}`,
      );
    }
    try {
      return await runScheduledTask(
        {
          compat: deps.compat,
          bus: deps.bus,
          registry: deps.registry,
          historySync: deps.historySync,
          ...(deps.onError ? { onError: deps.onError } : {}),
        },
        trigger,
      );
    } finally {
      releaseTurn();
    }
  };
}
