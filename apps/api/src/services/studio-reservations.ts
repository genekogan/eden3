import {
  debit,
  numericToNumber,
  reverseReservation,
  type DbHandle,
  type ReverseReservationParams,
} from '@eden3/core';
import { db, mannaAccounts, mannaTransactions, usageEvents } from '@eden3/db';
import { and, asc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';

export const STUDIO_RESERVATION_EVENT_TYPE = 'studio_generation';
export const STUDIO_RESERVATION_TTL_MS = 60 * 60 * 1000;
export const STUDIO_RESERVATION_REAPER_INTERVAL_MS = 5 * 60 * 1000;

export class StudioGenerationBusyError extends Error {
  readonly code = 'studio_generation_busy';

  constructor(readonly outputKind: 'image' | 'video' | 'audio') {
    super(`studio-reservation: another ${outputKind} generation is already active`);
    this.name = 'StudioGenerationBusyError';
  }
}

export interface StudioAuthorizationQuote {
  action: string;
  provider: string;
  model: string;
  tableVersion: string;
  costUsd: number;
  manna: number;
}

export interface StudioReservationMetadata {
  version: 1;
  tool: string;
  /** Pricing facts only. Generation prompt/text is deliberately excluded. */
  quote: StudioAuthorizationQuote;
  reservation: {
    idempotencyKey: string;
    transactionId: string;
    reservedManna: number;
    subscriptionManna: number;
    durableManna: number;
  };
  creationId?: string;
  refundAttemptedAt?: string;
  failureCode?: string;
  failureLatencyMs?: number;
}

export interface StudioReservation {
  turnId: string;
  metadata: StudioReservationMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function outputKindForStudioTool(tool: string): 'image' | 'video' | 'audio' {
  if (tool === 'image_generate') return 'image';
  if (tool === 'video_generate') return 'video';
  if (tool === 'music_generate' || tool === 'tts') return 'audio';
  throw new Error(`studio-reservation: unsupported tool ${tool}`);
}

function readReservationMetadata(value: unknown): StudioReservationMetadata {
  if (!isRecord(value) || value.version !== 1 || typeof value.tool !== 'string') {
    throw new Error('studio-reservation: invalid authorization metadata');
  }
  const quote = value.quote;
  const reservation = value.reservation;
  if (
    !isRecord(quote) ||
    typeof quote.action !== 'string' ||
    typeof quote.provider !== 'string' ||
    typeof quote.model !== 'string' ||
    typeof quote.tableVersion !== 'string' ||
    typeof quote.costUsd !== 'number' ||
    typeof quote.manna !== 'number' ||
    !isRecord(reservation) ||
    typeof reservation.idempotencyKey !== 'string' ||
    typeof reservation.transactionId !== 'string' ||
    typeof reservation.reservedManna !== 'number' ||
    typeof reservation.subscriptionManna !== 'number' ||
    typeof reservation.durableManna !== 'number'
  ) {
    throw new Error('studio-reservation: incomplete authorization metadata');
  }
  if (
    !Number.isFinite(quote.costUsd) ||
    quote.costUsd < 0 ||
    !Number.isFinite(quote.manna) ||
    quote.manna < 0 ||
    !Number.isFinite(reservation.reservedManna) ||
    !Number.isFinite(reservation.subscriptionManna) ||
    !Number.isFinite(reservation.durableManna) ||
    reservation.reservedManna < 0 ||
    reservation.subscriptionManna < 0 ||
    reservation.durableManna < 0 ||
    Number((reservation.subscriptionManna + reservation.durableManna).toFixed(4)) !==
      reservation.reservedManna ||
    quote.manna !== reservation.reservedManna
  ) {
    throw new Error('studio-reservation: invalid reservation split');
  }
  return value as unknown as StudioReservationMetadata;
}

/** Commit the debit and its durable authorization row as one unit. */
export async function reserveStudioGeneration(options: {
  turnId: string;
  accountId: string;
  tool: string;
  quote: StudioAuthorizationQuote;
  reservationKey: string;
  dailyCap: number;
  db?: DbHandle;
}): Promise<StudioReservation> {
  const dbc = options.db ?? db;
  return await dbc.transaction(async (tx) => {
    const outputKind = outputKindForStudioTool(options.tool);
    // OpenClaw 2026.7.1 exposes no durable task→file identity. Keep exactly
    // one provider-visible Studio claim per output kind across every API
    // process, so a later completion can never be FIFO-attributed to another
    // tenant. The lock is taken before both debit and provider admission.
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${'studio-media-output:' + outputKind}, 0))
    `);
    const active = (await tx.execute(sql`
      select turn_id
      from usage_events
      where event_type = ${STUDIO_RESERVATION_EVENT_TYPE}
        and status in ('pending', 'provider_admitted', 'refund_pending')
        and case ${outputKind}
          when 'image' then metadata->>'tool' = 'image_generate'
          when 'video' then metadata->>'tool' = 'video_generate'
          when 'audio' then metadata->>'tool' in ('music_generate', 'tts')
          else false
        end
      limit 1
    `)) as unknown as Array<{ turn_id: string | null }>;
    if (active[0]) throw new StudioGenerationBusyError(outputKind);

    const debited = await debit({
      accountId: options.accountId,
      amount: options.quote.manna,
      type: `spend:${options.quote.action}`,
      idempotencyKey: options.reservationKey,
      dailyCap: { limit: options.dailyCap },
      db: tx,
    });
    if (debited.alreadyApplied) {
      throw new Error(`studio-reservation: fresh request ${options.turnId} replayed a debit`);
    }

    const subscriptionManna = debited.subscriptionDrawn ?? 0;
    const metadata: StudioReservationMetadata = {
      version: 1,
      tool: options.tool,
      quote: options.quote,
      reservation: {
        idempotencyKey: options.reservationKey,
        transactionId: debited.transaction.id,
        reservedManna: options.quote.manna,
        subscriptionManna,
        durableManna: Number((options.quote.manna - subscriptionManna).toFixed(4)),
      },
    };
    const [inserted] = await tx
      .insert(usageEvents)
      .values({
        eventType: STUDIO_RESERVATION_EVENT_TYPE,
        status: 'pending',
        userId: options.accountId,
        turnId: options.turnId,
        provider: options.quote.provider,
        model: options.quote.model,
        tableVersion: options.quote.tableVersion,
        // Authorization truth, not yet a provider-cost event. The quote lives
        // in metadata; terminal completion materializes cost_usd.
        costUsd: null,
        manna: options.quote.manna,
        metadata,
      })
      .onConflictDoNothing()
      .returning({ id: usageEvents.id });
    if (!inserted) {
      throw new Error(`studio-reservation: durable authorization refused for ${options.turnId}`);
    }
    return { turnId: options.turnId, metadata };
  });
}

/** Must run in the same transaction that creates the Studio artifact. */
export async function completeStudioGeneration(
  tx: DbHandle,
  options: {
    reservation: StudioReservation;
    creationId: string;
    latencyMs: number;
  },
): Promise<void> {
  const [updated] = await tx
    .update(usageEvents)
    .set({
      status: 'completed',
      manna: options.reservation.metadata.quote.manna,
      costUsd: options.reservation.metadata.quote.costUsd.toFixed(8),
      latencyMs: options.latencyMs,
      errorCode: null,
      errorMessage: null,
      metadata: { ...options.reservation.metadata, creationId: options.creationId },
    })
    .where(
      and(
        eq(usageEvents.eventType, STUDIO_RESERVATION_EVENT_TYPE),
        eq(usageEvents.turnId, options.reservation.turnId),
        inArray(usageEvents.status, ['pending', 'provider_admitted']),
      ),
    )
    .returning({ id: usageEvents.id });
  if (!updated) {
    throw new Error(
      `studio-reservation: ${options.reservation.turnId} is no longer pending; artifact commit refused`,
    );
  }
}

export type StudioCompensationOutcome = 'refunded' | 'refund_pending' | 'terminal';

/**
 * Mark compensation intent durably, then reverse + terminalize atomically.
 * A reversal outage leaves a truthful `refund_pending` row for the reaper.
 */
export async function compensateStudioGeneration(options: {
  turnId: string;
  errorCode: string;
  errorMessage: string;
  latencyMs?: number;
  refundType?: string;
  db?: DbHandle;
  reverse?: (params: ReverseReservationParams) => ReturnType<typeof reverseReservation>;
}): Promise<StudioCompensationOutcome> {
  const dbc = options.db ?? db;
  const reverse = options.reverse ?? reverseReservation;

  const marked = await dbc.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      select status, error_message, metadata from usage_events
      where event_type = ${STUDIO_RESERVATION_EVENT_TYPE}
        and turn_id = ${options.turnId}
      for update
    `)) as unknown as Array<{ status: string; error_message: string | null; metadata: unknown }>;
    const row = rows[0];
    if (!row || row.status === 'completed' || row.status === 'error') return null;
    if (
      row.status !== 'pending' &&
      row.status !== 'provider_admitted' &&
      row.status !== 'refund_pending'
    ) {
      throw new Error(`studio-reservation: unexpected status ${row.status}`);
    }
    const existingMetadata = isRecord(row.metadata) ? row.metadata : {};
    const effective = {
      errorCode:
        row.status === 'refund_pending' && typeof existingMetadata.failureCode === 'string'
          ? existingMetadata.failureCode
          : options.errorCode,
      errorMessage:
        row.status === 'refund_pending' && row.error_message
          ? row.error_message
          : options.errorMessage,
      latencyMs:
        row.status === 'refund_pending' && typeof existingMetadata.failureLatencyMs === 'number'
          ? existingMetadata.failureLatencyMs
          : options.latencyMs,
    };
    await tx
      .update(usageEvents)
      .set({
        status: 'refund_pending',
        errorCode: 'refund_pending',
        errorMessage: effective.errorMessage,
        metadata: sql`coalesce(${usageEvents.metadata}, '{}'::jsonb) || ${JSON.stringify({
          refundAttemptedAt: new Date().toISOString(),
          failureCode: effective.errorCode,
          ...(effective.latencyMs !== undefined ? { failureLatencyMs: effective.latencyMs } : {}),
        })}::jsonb`,
      })
      .where(
        and(
          eq(usageEvents.eventType, STUDIO_RESERVATION_EVENT_TYPE),
          eq(usageEvents.turnId, options.turnId),
        ),
      );
    return effective;
  });
  if (!marked) return 'terminal';

  try {
    return await dbc.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        select status, user_id, metadata from usage_events
        where event_type = ${STUDIO_RESERVATION_EVENT_TYPE}
          and turn_id = ${options.turnId}
        for update
      `)) as unknown as Array<{ status: string; user_id: string | null; metadata: unknown }>;
      const row = rows[0];
      if (!row || row.status === 'completed' || row.status === 'error') return 'terminal';
      if (row.status !== 'refund_pending') {
        throw new Error(`studio-reservation: compensation lost refund_pending state`);
      }
      const metadata = readReservationMetadata(row.metadata);
      if (!row.user_id) throw new Error('studio-reservation: authorization has no payer');
      const [reservationTx] = await tx
        .select({
          id: mannaTransactions.id,
          amount: mannaTransactions.amount,
          type: mannaTransactions.type,
        })
        .from(mannaTransactions)
        .innerJoin(mannaAccounts, eq(mannaAccounts.id, mannaTransactions.mannaAccountId))
        .where(
          and(
            eq(mannaTransactions.id, metadata.reservation.transactionId),
            eq(mannaTransactions.idempotencyKey, metadata.reservation.idempotencyKey),
            eq(mannaAccounts.accountId, row.user_id),
          ),
        )
        .limit(1);
      if (!reservationTx) {
        throw new Error('studio-reservation: reservation transaction identity mismatch');
      }
      if (
        numericToNumber(reservationTx.amount) !== -metadata.reservation.reservedManna ||
        reservationTx.type !== `spend:${metadata.quote.action}`
      ) {
        throw new Error('studio-reservation: reservation transaction amount/type mismatch');
      }
      await reverse({
        reservationKey: metadata.reservation.idempotencyKey,
        reservedSubscriptionManna: metadata.reservation.subscriptionManna,
        type: options.refundType ?? `refund:${metadata.quote.action}`,
        db: tx,
      });
      const [updated] = await tx
        .update(usageEvents)
        .set({
          status: 'error',
          manna: 0,
          costUsd: '0',
          errorCode: marked.errorCode,
          errorMessage: marked.errorMessage,
          latencyMs: marked.latencyMs ?? null,
        })
        .where(
          and(
            eq(usageEvents.eventType, STUDIO_RESERVATION_EVENT_TYPE),
            eq(usageEvents.turnId, options.turnId),
            eq(usageEvents.status, 'refund_pending'),
          ),
        )
        .returning({ id: usageEvents.id });
      if (!updated) throw new Error('studio-reservation: terminal compensation update lost race');
      return 'refunded';
    });
  } catch {
    return 'refund_pending';
  }
}

export interface StudioReservationReaperOptions {
  ttlMs?: number;
  intervalMs?: number;
  onError?: (err: unknown, context: string) => void;
  now?: () => Date;
  db?: DbHandle;
  accountScope?: string[];
}

export class StudioReservationReaper {
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private readonly onError: (err: unknown, context: string) => void;
  private readonly now: () => Date;
  private readonly db: DbHandle;
  private readonly accountScope: string[] | null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: StudioReservationReaperOptions = {}) {
    this.ttlMs = options.ttlMs ?? STUDIO_RESERVATION_TTL_MS;
    this.intervalMs = options.intervalMs ?? STUDIO_RESERVATION_REAPER_INTERVAL_MS;
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.db = options.db ?? db;
    this.accountScope = options.accountScope ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => this.onError(err, 'studio-reservation reaper tick'));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<{ scanned: number; reaped: number; pending: number }> {
    if (this.running) return { scanned: 0, reaped: 0, pending: 0 };
    this.running = true;
    try {
      const cutoff = new Date(this.now().getTime() - this.ttlMs);
      const rows = await this.db
        .select({ turnId: usageEvents.turnId })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.eventType, STUDIO_RESERVATION_EVENT_TYPE),
            // Makes the existing partial (event_type, turn_id) index eligible.
            isNotNull(usageEvents.turnId),
            or(
              eq(usageEvents.status, 'refund_pending'),
              and(
                inArray(usageEvents.status, ['pending', 'provider_admitted']),
                lt(usageEvents.createdAt, cutoff),
              ),
            ),
            ...(this.accountScope ? [inArray(usageEvents.userId, this.accountScope)] : []),
          ),
        )
        .orderBy(asc(usageEvents.createdAt))
        .limit(200);

      let reaped = 0;
      let pending = 0;
      for (const row of rows) {
        if (!row.turnId) continue;
        try {
          const outcome = await compensateStudioGeneration({
            turnId: row.turnId,
            errorCode: 'studio_reservation_reaped',
            errorMessage: 'Studio generation did not commit an artifact before its reservation expired',
            refundType: 'refund:studio-reservation-reaped',
            db: this.db,
          });
          if (outcome === 'refunded') reaped += 1;
          if (outcome === 'refund_pending') pending += 1;
        } catch (err) {
          pending += 1;
          this.onError(err, `studio-reservation reap ${row.turnId}`);
        }
      }
      return { scanned: rows.length, reaped, pending };
    } finally {
      this.running = false;
    }
  }
}
