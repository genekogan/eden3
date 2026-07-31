import { DailyCapExceededError } from '@eden3/core';
import { db, triggers, type Trigger } from '@eden3/db';
import { and, asc, eq, inArray, isNotNull, isNull, like, lte, or, sql } from 'drizzle-orm';

import { ApiError } from '../errors';
import type { EventsBus } from '../events-bus';
import { AUTOMATION_HOURLY_BUDGET_ERROR } from './automation-budget';
import { concurrentTurnLimit, type TurnConcurrencyLimiter } from './chat-limits';
import type { HistorySync } from './history-sync';
import {
  RecordedScheduledTaskError,
  SCHEDULED_TASK_REFUND_PENDING,
  SCHEDULED_TASK_REFUND_PENDING_PREFIX,
  SCHEDULED_TASK_STALE_RECOVERY_PREFIX,
  isScheduledTaskRecoveryPending,
  runScheduledTask,
  scheduledTaskOccurrence,
  type ScheduledRefund,
  type ScheduledRunResult,
  type ScheduledTaskOccurrence,
} from './scheduled-tasks';
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
  SCHEDULED_TASK_REFUND_PENDING, // ledger outage — occurrence remains due
]);

/** Budget refusals are terminal until an owner intervenes or resumes later. */
function immediateAutoPauseReason(err: unknown): string | null {
  if (err instanceof DailyCapExceededError) return err.message;
  if (
    err instanceof ApiError &&
    (err.code === AUTOMATION_HOURLY_BUDGET_ERROR || err.code === 'daily_manna_cap_exceeded')
  ) {
    return err.message;
  }
  return null;
}

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
  runTask: (trigger: Trigger, occurrence: ScheduledTaskOccurrence) => Promise<unknown>;
  /**
   * Provider-free compensation runner. When supplied, its independent loop
   * remains active even when normal task firing is disabled or the gateway is
   * unavailable.
   */
  recoverTask?: (trigger: Trigger, occurrence: ScheduledTaskOccurrence) => Promise<unknown>;
  /** Independent compensation/reaper cadence (default 30s). */
  recoveryIntervalMs?: number;
  /** Normal provider-firing interval; <= 0 disables only that loop. */
  intervalMs: number;
  /** Missed-fire grace window (default 6h). */
  graceMs?: number;
  /**
   * Reap tasks stuck in `running` longer than this (default 45m — beyond the
   * 30m agent-turn timeout) into a durable paused quarantine. Age cannot prove
   * whether a provider side effect landed, so the occurrence is preserved for
   * inspection and is never automatically replayed.
   */
  reapStaleRunningMs?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
  /**
   * One-time boot cleanup — removes legacy `eden3:*` gateway cron jobs so
   * they stop double-firing (gateway-side scheduled firing is retired).
   * Failures are logged and retried without taking down the API; Eden-side
   * firing remains fenced until one successful sweep proves no legacy job can
   * double-execute the same trigger.
   */
  cleanupGatewayJobs?: (() => Promise<{ removed: number }>) | null;
  /**
   * Retry cadence for the native-cron cleanup loop. This loop is independent
   * of scheduled firing so cleanup still runs when intervalMs disables task
   * execution. Defaults to 30 seconds; tests may shorten it.
   */
  cleanupGatewayJobsRetryMs?: number;
  logger?: SchedulerLogger | null;
  /** Max due rows per tick. */
  batchLimit?: number;
  /**
   * Auto-pause a recurring task after this many CONSECUTIVE scheduler-run
   * failures (default 20). A success resets the streak (runScheduledTask
   * zeroes error_count). Guards against zombie tasks — e.g. a migrated
   * trigger whose owner has 0 manna failing every fire, forever. Manual
   * "run now" failures never auto-pause. <= 0 disables.
   */
  maxConsecutiveFailures?: number;
  /**
   * TEST SEAM: when set, ticks only consider these trigger ids — suites run
   * full ticks against the shared dev database without touching real rows.
   * Production never sets this.
   */
  restrictToTriggerIds?: string[];
}

export class TaskScheduler {
  private readonly runTask: (
    trigger: Trigger,
    occurrence: ScheduledTaskOccurrence,
  ) => Promise<unknown>;
  private readonly recoverTask: ((
    trigger: Trigger,
    occurrence: ScheduledTaskOccurrence,
  ) => Promise<unknown>) | null;
  private readonly intervalMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly graceMs: number;
  private readonly reapStaleRunningMs: number;
  private readonly now: () => Date;
  private readonly cleanupGatewayJobs: (() => Promise<{ removed: number }>) | null;
  private readonly cleanupGatewayJobsRetryMs: number;
  private readonly log: SchedulerLogger | null;
  private readonly batchLimit: number;
  private readonly maxConsecutiveFailures: number;
  private readonly restrictToTriggerIds: string[] | null;
  private readonly inFlight = new Set<string>();
  private cleanupGatewayJobsDone = false;
  private cleanupGatewayJobsInFlight: Promise<void> | null = null;
  private cleanupGatewayJobsTimer: NodeJS.Timeout | null = null;
  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(options: TaskSchedulerOptions) {
    this.runTask = options.runTask;
    this.recoverTask = options.recoverTask ?? null;
    this.intervalMs = options.intervalMs;
    this.recoveryIntervalMs = Math.max(1, options.recoveryIntervalMs ?? 30_000);
    this.graceMs = options.graceMs ?? 6 * 60 * 60 * 1000;
    this.reapStaleRunningMs = options.reapStaleRunningMs ?? 45 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.cleanupGatewayJobs = options.cleanupGatewayJobs ?? null;
    this.cleanupGatewayJobsRetryMs = Math.max(
      1,
      options.cleanupGatewayJobsRetryMs ?? 30_000,
    );
    this.log = options.logger ?? null;
    this.batchLimit = options.batchLimit ?? 50;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 20;
    this.restrictToTriggerIds = options.restrictToTriggerIds ?? null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Begin cleanup and, when enabled, scheduled-task ticking. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Legacy gateway cron jobs would double-fire against this scheduler —
    // start an independent retry loop (a down gateway must not block boot).
    // It deliberately remains active when intervalMs=0: disabling Eden task
    // firing must never leave legacy native jobs running unmetered.
    this.scheduleGatewayJobsCleanup();
    // Billing compensation is independent of provider availability and of the
    // operator's normal-firing toggle. Only an explicitly supplied recovery
    // runner enables this loop; ordinary unit schedulers remain timer-free.
    if (this.recoverTask !== null) {
      this.recoveryTimer = setInterval(() => {
        void this.recoveryTick().catch((err) => {
          this.log?.error({ err }, 'task-scheduler: recovery tick failed');
        });
      }, this.recoveryIntervalMs);
      this.recoveryTimer.unref?.();
    }
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.log?.error({ err }, 'task-scheduler: tick failed');
      });
    }, this.intervalMs);
    this.timer.unref?.();
    this.log?.info({ intervalMs: this.intervalMs }, 'task-scheduler: started');
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.cleanupGatewayJobsTimer !== null) {
      clearTimeout(this.cleanupGatewayJobsTimer);
      this.cleanupGatewayJobsTimer = null;
    }
    if (this.recoveryTimer !== null) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private scheduleGatewayJobsCleanup(): void {
    if (
      !this.started ||
      this.cleanupGatewayJobs === null ||
      this.cleanupGatewayJobsDone ||
      this.cleanupGatewayJobsTimer !== null
    ) {
      return;
    }
    void this.ensureGatewayJobsCleaned().finally(() => {
      if (!this.started || this.cleanupGatewayJobsDone || this.cleanupGatewayJobs === null) {
        return;
      }
      this.cleanupGatewayJobsTimer = setTimeout(() => {
        this.cleanupGatewayJobsTimer = null;
        this.scheduleGatewayJobsCleanup();
      }, this.cleanupGatewayJobsRetryMs);
      this.cleanupGatewayJobsTimer.unref?.();
    });
  }

  /**
   * One scheduler pass: select due triggers and process them concurrently.
   * Safe to call directly (tests) or while another tick is still running —
   * `inFlight` + the DB claim make duplicate fires impossible.
   */
  async tick(): Promise<TickResult> {
    // Compensation is billing safety, not provider firing. It runs before the
    // native-cron cleanup attempt/fence so even a hung or down gateway cannot
    // strand ledger debits.
    const recovery = await this.recoveryTick();
    await this.ensureGatewayJobsCleaned();
    if (this.cleanupGatewayJobs !== null && !this.cleanupGatewayJobsDone) {
      this.log?.warn(
        {},
        'task-scheduler: firing fenced until legacy gateway cron cleanup succeeds',
      );
      return recovery;
    }
    const now = this.now();
    const due = await db
      .select()
      .from(triggers)
      .where(
        and(
          eq(triggers.status, 'active'),
          eq(triggers.deleted, false),
          isNull(triggers.pendingOccurrenceId),
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
    return { outcomes: [...recovery.outcomes, ...outcomes] };
  }

  /**
   * Provider-free stale/refund compensation pass. This method deliberately
   * does not consult native-cron cleanup state or the normal firing interval.
   */
  async recoveryTick(): Promise<TickResult> {
    const now = this.now();
    await this.reapStaleRunning(now);
    const due = await db
      .select()
      .from(triggers)
      .where(
        and(
          inArray(triggers.status, ['active', 'paused']),
          eq(triggers.deleted, false),
          isNotNull(triggers.pendingOccurrenceId),
          or(
            like(triggers.lastError, `${SCHEDULED_TASK_REFUND_PENDING_PREFIX}%`),
            like(triggers.lastError, `${SCHEDULED_TASK_STALE_RECOVERY_PREFIX}%`),
          ),
          ...(this.restrictToTriggerIds !== null
            ? [inArray(triggers.id, this.restrictToTriggerIds)]
            : []),
        ),
      )
      .orderBy(asc(triggers.updatedAt))
      .limit(this.batchLimit);
    const outcomes = await Promise.all(
      due.map(async (row) => ({ triggerId: row.id, outcome: await this.processDue(row) })),
    );
    return { outcomes };
  }

  /** Retry legacy native-cron cleanup until one successful sweep, then latch. */
  private async ensureGatewayJobsCleaned(): Promise<void> {
    if (
      this.cleanupGatewayJobs === null ||
      this.cleanupGatewayJobsDone ||
      this.cleanupGatewayJobsInFlight !== null
    ) {
      if (this.cleanupGatewayJobsInFlight !== null) {
        await this.cleanupGatewayJobsInFlight;
      }
      return;
    }

    const attempt = this.cleanupGatewayJobs()
      .then(({ removed }) => {
        this.cleanupGatewayJobsDone = true;
        this.log?.info({ removed }, 'task-scheduler: removed legacy eden3 gateway cron jobs');
      })
      .catch((err) => {
        this.log?.warn({ err }, 'task-scheduler: legacy gateway cron cleanup failed');
      });
    this.cleanupGatewayJobsInFlight = attempt;
    try {
      await attempt;
    } finally {
      this.cleanupGatewayJobsInFlight = null;
    }
  }

  /**
   * Quarantine tasks stranded in `running`, plus owner-paused rows that still
   * carry an in-flight claim generation. An expired process lease cannot
   * prove whether its provider call landed, so replaying the same occurrence
   * could duplicate an external side effect. Stale rows are therefore
   * auto-paused with their durable occurrence identity intact, the old claim
   * generation is invalidated, and only compensation/checkpoint recovery may
   * reclaim it. Pure paused rows have no claim id and are never selected by
   * age. Not deleted/finished rows. Excluded from `restrictToTriggerIds` test
   * scoping.
   */
  private async reapStaleRunning(now: Date): Promise<void> {
    if (this.restrictToTriggerIds !== null && this.restrictToTriggerIds.length === 0) return;
    const cutoff = new Date(now.getTime() - this.reapStaleRunningMs);
    const reaped = await db
      .update(triggers)
      .set({
        status: 'paused',
        nextScheduledRun: null,
        lastError: sql`case
          when ${triggers.pendingOccurrenceId} is not null
            then ${`${SCHEDULED_TASK_STALE_RECOVERY_PREFIX} stale running lease was quarantined; compensation-only recovery required`}
          else 'Scheduled occurrence indeterminate after stale running lease; auto-paused without replay'
        end`,
        // Invalidate the old process generation atomically with quarantine.
        // A recovery claim will receive a fresh UUID for the same occurrence.
        pendingOccurrenceClaimId: null,
        updatedAt: now,
      })
      .where(
        and(
          or(
            eq(triggers.status, 'running'),
            and(
              eq(triggers.status, 'paused'),
              isNotNull(triggers.pendingOccurrenceClaimId),
            ),
          ),
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
        'task-scheduler: quarantined stale task claims for compensation-only recovery',
      );
    }
  }

  private async processDue(row: Trigger): Promise<ProcessOutcome> {
    if (this.inFlight.has(row.id)) return 'in_flight';
    this.inFlight.add(row.id);
    try {
      const pendingKind = row.pendingOccurrenceKind;
      const pendingOccurrence = row.pendingOccurrenceId
        ? pendingKind === 'manual'
          ? { id: row.pendingOccurrenceId, kind: 'manual' as const, dueAt: null }
          : pendingKind === 'scheduled' && row.pendingOccurrenceAt
            ? {
                id: row.pendingOccurrenceId,
                kind: 'scheduled' as const,
                dueAt: row.pendingOccurrenceAt,
              }
            : null
        : null;
      if (row.pendingOccurrenceId && !pendingOccurrence) {
        this.log?.error(
          { triggerId: row.id },
          'task-scheduler: invalid durable occurrence state',
        );
        return 'retry';
      }
      const dueAt = pendingOccurrence?.dueAt ?? row.nextScheduledRun;
      if (!dueAt && !pendingOccurrence) return 'retry';
      const occurrence =
        pendingOccurrence ?? scheduledTaskOccurrence(row.id, dueAt!);
      const now = this.now();
      if (
        !pendingOccurrence &&
        dueAt &&
        now.getTime() - dueAt.getTime() > this.graceMs
      ) {
        await this.skipMissedFire(row, dueAt);
        return 'missed';
      }

      let failed = false;
      let capPauseReason: string | null = null;
      try {
        const runner =
          isScheduledTaskRecoveryPending(row) && this.recoverTask !== null
            ? this.recoverTask
            : this.runTask;
        await runner(row, occurrence);
      } catch (err) {
        if (err instanceof ApiError && RETRY_NEXT_TICK_CODES.has(err.code)) {
          return 'retry';
        }
        failed = true;
        capPauseReason = immediateAutoPauseReason(err);
        if (err instanceof ApiError && !(err instanceof RecordedScheduledTaskError)) {
          // Pre-claim config failures (owner/agent unavailable, missing
          // prompt) never reach runScheduledTask's own error stamps — record
          // here so the task row surfaces the reason.
          await this.recordError(row, occurrence, err.message);
        }
        // Non-ApiError failures (turn errors, manna) were already recorded by
        // runScheduledTask.markTaskError — only the next-run stamp remains.
        this.log?.error({ err, triggerId: row.id }, 'task-scheduler: scheduled run failed');
      }
      // A pending manual run is recovery of an owner-requested occurrence,
      // not a scheduled fire. It must not move the task's normal cadence or
      // participate in the scheduler's auto-pause streak.
      if (pendingOccurrence?.kind === 'manual') return failed ? 'failed' : 'fired';

      // A cap refusal pauses even a one-time job. Stamping first would mark a
      // one-time row `finished`, making the conditional pause silently miss.
      if (capPauseReason !== null) await this.autoPauseForCap(row, capPauseReason);
      else {
        await this.stampNextRun(row);
        if (failed) await this.maybeAutoPause(row);
      }
      return failed ? 'failed' : 'fired';
    } finally {
      this.inFlight.delete(row.id);
    }
  }

  /**
   * Daily and rolling-hour budget refusals pause immediately instead of
   * retrying every cadence until the generic 20-failure circuit breaker.
   * Clearing next_scheduled_run gives `/tasks` the same durable pause shape
   * as an owner-requested pause.
   */
  private async autoPauseForCap(row: Trigger, reason: string): Promise<void> {
    const message = `auto-paused after automation budget refusal: ${reason}`.slice(0, 2000);
    const paused = await db
      .update(triggers)
      .set({
        status: 'paused',
        nextScheduledRun: null,
        lastError: message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(triggers.id, row.id),
          eq(triggers.status, 'active'),
          eq(triggers.deleted, false),
        ),
      )
      .returning({ id: triggers.id });
    if (paused.length > 0) {
      this.log?.warn(
        { triggerId: row.id, reason },
        'task-scheduler: auto-paused task after automation budget refusal',
      );
    }
  }

  /**
   * Pause a recurring task whose consecutive scheduler-failure streak has hit
   * the threshold, so a permanently-broken task (owner out of manna, agent
   * gone) stops burning a failed attempt every fire, forever. error_count IS
   * the streak: every failure path increments it and a successful run resets
   * it to 0. Only status='active' rows are touched (one-time tasks are
   * already 'finished' by stampNextRun; paused/deleted stay as they are).
   */
  private async maybeAutoPause(row: Trigger): Promise<void> {
    if (this.maxConsecutiveFailures <= 0) return;
    const paused = await db
      .update(triggers)
      .set({
        status: 'paused',
        lastError: sql`left('auto-paused after ' || coalesce(${triggers.errorCount}, 0) || ' consecutive failures; last: ' || coalesce(${triggers.lastError}, 'unknown error'), 2000)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(triggers.id, row.id),
          eq(triggers.status, 'active'),
          eq(triggers.deleted, false),
          sql`coalesce(${triggers.errorCount}, 0) >= ${this.maxConsecutiveFailures}`,
        ),
      )
      .returning({ id: triggers.id, errorCount: triggers.errorCount });
    if (paused.length > 0) {
      this.log?.warn(
        { triggerId: row.id, consecutiveFailures: paused[0]?.errorCount },
        'task-scheduler: auto-paused task after repeated consecutive failures',
      );
    }
  }

  /** Compute the follow-up next_scheduled_run after a fire attempt. */
  private async stampNextRun(row: Trigger): Promise<void> {
    // A running task may be edited through `/tasks` while its turn is in
    // flight. Re-read the schedule after the turn so the old due-row snapshot
    // cannot overwrite the owner's newly selected cadence.
    const [fresh] = await db
      .select()
      .from(triggers)
      .where(
        and(
          eq(triggers.id, row.id),
          eq(triggers.status, 'active'),
          eq(triggers.deleted, false),
        ),
      )
      .limit(1);
    if (!fresh) return;
    if (isOneTimeSchedule(fresh.schedule)) {
      // One shot spent (fired or failed): finish the task.
      await db
        .update(triggers)
        .set({ status: 'finished', nextScheduledRun: null, updatedAt: new Date() })
        .where(
          and(
            eq(triggers.id, row.id),
            eq(triggers.status, 'active'),
            eq(triggers.deleted, false),
          ),
        );
      return;
    }
    const next = this.safeNext(fresh);
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
      .where(
        and(
          eq(triggers.id, row.id),
          eq(triggers.status, 'active'),
          eq(triggers.deleted, false),
        ),
      );
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

  private async recordError(
    row: Trigger,
    occurrence: ScheduledTaskOccurrence,
    message: string,
  ): Promise<void> {
    const checkpoint = occurrence.dueAt ?? this.now();
    await db
      .update(triggers)
      .set({
        lastRunTime: checkpoint,
        lastError: message.slice(0, 2000),
        errorCount: sql`case when ${triggers.lastRunTime} is distinct from ${checkpoint.toISOString()}::timestamptz
          then coalesce(${triggers.errorCount}, 0) + 1
          else coalesce(${triggers.errorCount}, 0) end`,
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
  refundLedger?: ScheduledRefund;
  onError?: (err: unknown, context: string) => void;
  /** TEST SEAM: pause immediately before the durable debit-lease renewal. */
  beforeLeaseRenewal?: (claim: {
    triggerId: string;
    occurrenceId: string;
    claimId: string;
  }) => Promise<void>;
  /** TEST SEAM: pause after terminal preflight but before atomic persistence. */
  beforeTerminalPersistence?: () => Promise<void>;
}

export interface ScheduledTaskRecoveryRunnerDeps {
  refundLedger?: ScheduledRefund;
  onError?: (err: unknown, context: string) => void;
}

/**
 * Build a DB/ledger-only runner for the independent compensation loop. It has
 * no compat, history, or provider dependency and refuses non-recovery rows.
 */
export function makeScheduledTaskRecoveryRunner(
  deps: ScheduledTaskRecoveryRunnerDeps = {},
): (trigger: Trigger, occurrence: ScheduledTaskOccurrence) => Promise<ScheduledRunResult> {
  return async (trigger, occurrence) => {
    if (!isScheduledTaskRecoveryPending(trigger)) {
      throw new ApiError(
        409,
        'task_not_active',
        `Task ${trigger.id} is not pending compensation recovery`,
      );
    }
    return await runScheduledTask(
      {
        ...(deps.refundLedger ? { refundLedger: deps.refundLedger } : {}),
        ...(deps.onError ? { onError: deps.onError } : {}),
      },
      trigger,
      occurrence,
    );
  };
}

/**
 * Build the production `runTask` for {@link TaskScheduler}: acquire a slot in
 * the owner's turn-concurrency limiter, then run the metered pipeline. The
 * daily manna cap needs no pre-check here — `debit({dailyCap})` inside
 * runTurn enforces it race-free and the failure is recorded on the task row.
 */
export function makeScheduledTaskRunner(
  deps: ScheduledTaskRunnerDeps,
): (trigger: Trigger, occurrence: ScheduledTaskOccurrence) => Promise<ScheduledRunResult> {
  return async (trigger, occurrence) => {
    const run = () =>
      runScheduledTask(
        {
          compat: deps.compat,
          bus: deps.bus,
          registry: deps.registry,
          historySync: deps.historySync,
          ...(deps.refundLedger ? { refundLedger: deps.refundLedger } : {}),
          ...(deps.onError ? { onError: deps.onError } : {}),
          ...(deps.beforeLeaseRenewal
            ? { beforeLeaseRenewal: deps.beforeLeaseRenewal }
            : {}),
          ...(deps.beforeTerminalPersistence
            ? { beforeTerminalPersistence: deps.beforeTerminalPersistence }
            : {}),
        },
        trigger,
        occurrence,
      );
    // Compensation/checkpoint recovery performs no provider work and must not
    // depend on a still-existing owner or an available interactive turn slot.
    // Otherwise account deletion or a busy owner could strand landed debits.
    if (isScheduledTaskRecoveryPending(trigger)) return await run();
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
      return await run();
    } finally {
      releaseTurn();
    }
  };
}
