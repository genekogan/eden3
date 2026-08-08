import { db, turnAuthorizations } from '@eden3/db';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';

import {
  reverseTurnAuthorization,
  settlePartialOutputAuthorization,
} from './turn-authorization';

/**
 * Compensation reaper for orphaned turn reservations (T08-U02, FG-ECON):
 * a process that dies between the worst-case reservation and terminal
 * persistence leaves an authorization row in `reserved`. With no durable
 * usable-output checkpoint it refunds in full. Once a non-whitespace prefix
 * was durably marked before emission, full-reserve-v1 retains the authorized
 * max and writes loud error usage truth instead of serving a free prefix.
 *
 * The reaper acts only on `state='reserved'` + age. It never inspects
 * usage-event rows (telemetry must not carry money truth), needs no
 * process-local live-turn set (the TTL exceeds any legitimate turn wall,
 * including the 10-minute sandbox tool timeout), and composes idempotently
 * with scheduler/memory recovery (both sides are remainder-aware and
 * state-guarded).
 *
 * Deliberately constants + constructor options, not env vars (the env schema
 * is outside this unit's footprint).
 */
export const TURN_RESERVATION_TTL_MS = 60 * 60 * 1000;
export const TURN_RESERVATION_REAPER_INTERVAL_MS = 5 * 60 * 1000;

export interface TurnReservationReaperOptions {
  ttlMs?: number;
  intervalMs?: number;
  onError?: (err: unknown, context: string) => void;
  /** Ledger label for reaped reversals. */
  refundType?: string;
  now?: () => Date;
  /**
   * Restrict the sweep to these payer accounts. TEST ISOLATION ONLY — suites
   * running against a shared database must never reap rows they did not seed.
   * Production always runs unscoped.
   */
  accountScope?: string[];
}

export interface ReapOutcome {
  scanned: number;
  reaped: number;
  partialSettled: number;
}

export class TurnReservationReaper {
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private readonly onError: (err: unknown, context: string) => void;
  private readonly refundType: string;
  private readonly now: () => Date;
  private readonly accountScope: string[] | null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: TurnReservationReaperOptions = {}) {
    this.ttlMs = options.ttlMs ?? TURN_RESERVATION_TTL_MS;
    this.intervalMs = options.intervalMs ?? TURN_RESERVATION_REAPER_INTERVAL_MS;
    this.onError = options.onError ?? (() => {});
    this.refundType = options.refundType ?? 'refund:turn-reservation-reaped';
    this.now = options.now ?? (() => new Date());
    this.accountScope = options.accountScope ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => this.onError(err, 'turn-reservation reaper tick'));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sweep. Safe to call concurrently (state guards); serialized locally. */
  async runOnce(): Promise<ReapOutcome> {
    if (this.running) return { scanned: 0, reaped: 0, partialSettled: 0 };
    this.running = true;
    try {
      const cutoff = new Date(this.now().getTime() - this.ttlMs);
      // Oldest first: a page of transiently-failing rows must not starve
      // still-older orphans behind an unordered LIMIT.
      const stale = await db
        .select({ turnId: turnAuthorizations.turnId })
        .from(turnAuthorizations)
        .where(
          and(
            eq(turnAuthorizations.state, 'reserved'),
            lt(turnAuthorizations.createdAt, cutoff),
            ...(this.accountScope ? [inArray(turnAuthorizations.accountId, this.accountScope)] : []),
          ),
        )
        .orderBy(asc(turnAuthorizations.createdAt))
        .limit(200);

      let reaped = 0;
      let partialSettled = 0;
      for (const row of stale) {
        try {
          const partial = await settlePartialOutputAuthorization({
            turnId: row.turnId,
            errorCode: 'provider_process_lost_after_output',
            errorMessage:
              'Provider process ended after emitting usable output; full authorized reserve retained',
          });
          if (partial.eligible) {
            if (partial.settled) partialSettled += 1;
            continue;
          }
          const result = await reverseTurnAuthorization({
            turnId: row.turnId,
            refundType: this.refundType,
            terminalState: 'reaped',
          });
          if (result.reversed) reaped += 1;
          if (result.partialOutputRequired) {
            // A first-output promotion raced the initial eligibility check.
            // Re-enter the row-locked partial settlement; never refund value.
            const raced = await settlePartialOutputAuthorization({
              turnId: row.turnId,
              errorCode: 'provider_process_lost_after_output',
              errorMessage:
                'Provider process ended after emitting usable output; full authorized reserve retained',
            });
            if (raced.settled) partialSettled += 1;
          }
        } catch (err) {
          this.onError(err, `turn-reservation reap ${row.turnId}`);
        }
      }
      return { scanned: stale.length, reaped, partialSettled };
    } finally {
      this.running = false;
    }
  }
}
