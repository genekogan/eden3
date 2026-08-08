import { turnAuthorizations } from '@eden3/db';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '@eden3/db';

import { reverseTurnAuthorization } from './turn-authorization';

/**
 * Compensation reaper for orphaned turn reservations (T08-U02, FG-ECON):
 * a process that dies between the worst-case reservation and terminal
 * persistence leaves an authorization row in `reserved`. Terminal success is
 * one transaction, so an aged `reserved` row is PROOF the turn never
 * completed — the predeclared rule (MVP-ACCEPTANCE §1.5): an unpersisted turn
 * is a failed turn and refunds in full.
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
}

export interface ReapOutcome {
  scanned: number;
  reaped: number;
}

export class TurnReservationReaper {
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private readonly onError: (err: unknown, context: string) => void;
  private readonly refundType: string;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: TurnReservationReaperOptions = {}) {
    this.ttlMs = options.ttlMs ?? TURN_RESERVATION_TTL_MS;
    this.intervalMs = options.intervalMs ?? TURN_RESERVATION_REAPER_INTERVAL_MS;
    this.onError = options.onError ?? (() => {});
    this.refundType = options.refundType ?? 'refund:turn-reservation-reaped';
    this.now = options.now ?? (() => new Date());
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
    if (this.running) return { scanned: 0, reaped: 0 };
    this.running = true;
    try {
      const cutoff = new Date(this.now().getTime() - this.ttlMs);
      const stale = await db
        .select({ turnId: turnAuthorizations.turnId })
        .from(turnAuthorizations)
        .where(
          and(eq(turnAuthorizations.state, 'reserved'), lt(turnAuthorizations.createdAt, cutoff)),
        )
        .limit(200);

      let reaped = 0;
      for (const row of stale) {
        try {
          const result = await reverseTurnAuthorization({
            turnId: row.turnId,
            refundType: this.refundType,
            terminalState: 'reaped',
          });
          if (result.reversed) reaped += 1;
        } catch (err) {
          this.onError(err, `turn-reservation reap ${row.turnId}`);
        }
      }
      return { scanned: stale.length, reaped };
    } finally {
      this.running = false;
    }
  }
}
