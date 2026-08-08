import type { DbHandle } from '@eden3/core';
import { numericToNumber, reverseReservation, settleReservation } from '@eden3/core';
import {
  db,
  mannaTransactions,
  turnAuthorizations,
  turnProviderRuns,
  usageEvents,
  type TurnAuthorization,
} from '@eden3/db';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Durable per-turn economic-authorization state machine (MVP gap 42,
 * T08-U02). The row is money truth:
 *
 *   reserved -> worst-case reservation committed; provider may run
 *   settled  -> actual (≤ authorized max) charged, unused refunded, assistant
 *               + usage persisted — all one transaction
 *   reversed -> turn failed; reservation fully reversed
 *   reaped   -> orphaned reservation reversed by the compensation reaper
 *
 * Every transition happens in the same transaction as its ledger operation,
 * guarded by `state='reserved'` so no interleaving (live turn vs reaper vs
 * scheduler recovery) can double-move money.
 */

export interface ReserveAuthorizationRow {
  turnId: string;
  accountId: string;
  agentAccountId: string | null;
  sessionId: string | null;
  provider: string;
  model: string;
  pricingBasis: string;
  ceilingTableVersion: string;
  authorizedMaxManna: number;
  reservedSubscriptionManna: number;
  reservationTxId: string;
}

export const PARTIAL_OUTPUT_SETTLEMENT_RULE = 'full-reserve-v1' as const;

/**
 * Atomically consume the authorization's one provider-start ticket. The
 * insertion is durable and cross-process exclusive; false means another
 * claimant already consumed it or the parent authorization is no longer
 * reserved. Callers losing this race must not reverse the winner's money.
 */
export async function claimTurnProviderStart(
  turnId: string,
  options: { db?: DbHandle; fence?: (tx: DbHandle) => Promise<void> } = {},
): Promise<boolean> {
  const dbc = options.db ?? db;
  return await dbc.transaction(async (tx) => {
    await options.fence?.(tx);
    // Lock the parent first so a terminal transition racing this claim yields
    // a clean false, not a trigger error after a stale state read.
    const parent = (await tx.execute(sql`
      select state from turn_authorizations where turn_id = ${turnId} for update
    `)) as unknown as { state: string }[];
    if (parent[0]?.state !== 'reserved') return false;
    const inserted = (await tx.execute(sql`
      insert into turn_provider_runs (turn_id)
      values (${turnId})
      on conflict (turn_id) do nothing
      returning turn_id
    `)) as unknown as { turn_id: string }[];
    return inserted.length === 1;
  });
}

/**
 * Persist the first non-whitespace output checkpoint before emitting that
 * output. The DB guard permits only NULL -> one timestamp while the parent is
 * reserved. This is intentionally a one-time first-token roundtrip.
 */
export async function markTurnUsableOutput(
  turnId: string,
  options: { db?: DbHandle; fence?: (tx: DbHandle) => Promise<void> } = {},
): Promise<boolean> {
  const dbc = options.db ?? db;
  return await dbc.transaction(async (tx) => {
    await options.fence?.(tx);
    // Preserve the global auth-row -> dependent-row lock order used by every
    // settle/reverse path; the DB trigger rechecks the same parent invariant.
    await tx.execute(sql`
      select turn_id from turn_authorizations where turn_id = ${turnId} for update
    `);
    const [updated] = await tx
      .update(turnProviderRuns)
      .set({ usableOutputAt: new Date() })
      .where(
        and(
          eq(turnProviderRuns.turnId, turnId),
          sql`${turnProviderRuns.usableOutputAt} is null`,
        ),
      )
      .returning({ turnId: turnProviderRuns.turnId });
    if (updated) return true;
    const [existing] = await tx
      .select({ usableOutputAt: turnProviderRuns.usableOutputAt })
      .from(turnProviderRuns)
      .where(eq(turnProviderRuns.turnId, turnId))
      .limit(1);
    if (!existing?.usableOutputAt) {
      throw new Error(`turn-authorization: turn ${turnId} has no provider-start lease`);
    }
    return false;
  });
}

export interface PartialOutputSettlementResult {
  /** True only for the transaction that performed the terminal settlement. */
  settled: boolean;
  /** True when the row was eligible for full-reserve-v1, including a replay. */
  eligible: boolean;
  balanceTotal?: number;
  chargedManna?: number;
}

/**
 * Terminalize a durably marked streamed-prefix failure under the predeclared
 * full-reserve-v1 rule. With no trustworthy terminal usage receipt, the full
 * preauthorized maximum remains charged. Authorization, zero-refund settle,
 * and loud error usage truth commit together; no assistant row is fabricated.
 */
export async function settlePartialOutputAuthorization(options: {
  turnId: string;
  errorCode: string;
  errorMessage: string;
  db?: DbHandle;
  /** Caller-owned generation fence, checked in the settlement transaction. */
  fence?: (tx: DbHandle) => Promise<void>;
}): Promise<PartialOutputSettlementResult> {
  const dbc = options.db ?? db;
  return await dbc.transaction(async (tx) => {
    await options.fence?.(tx);
    await tx.execute(sql`
      select turn_id from turn_authorizations where turn_id = ${options.turnId} for update
    `);
    const rows = (await tx.execute(sql`
      select a.turn_id, a.state, a.account_id, a.agent_account_id, a.session_id,
             a.provider, a.model, a.pricing_basis, a.ceiling_table_version,
             a.authorized_max_manna, a.reserved_subscription_manna,
             p.provider_started_at, p.usable_output_at,
             mt.idempotency_key as reservation_key, mt.type as reservation_type
      from turn_authorizations a
      join turn_provider_runs p on p.turn_id = a.turn_id
      join manna_transactions mt on mt.id = a.reservation_tx_id
      where a.turn_id = ${options.turnId}
      for update of p
    `)) as unknown as {
      turn_id: string;
      state: string;
      account_id: string;
      agent_account_id: string | null;
      session_id: string | null;
      provider: string;
      model: string;
      pricing_basis: string;
      ceiling_table_version: string;
      authorized_max_manna: string;
      reserved_subscription_manna: string;
      provider_started_at: Date;
      usable_output_at: Date | null;
      reservation_key: string | null;
      reservation_type: string | null;
    }[];
    const row = rows[0];
    if (!row || row.usable_output_at === null) return { settled: false, eligible: false };
    if (row.state !== 'reserved') {
      return { settled: false, eligible: row.state === 'settled' };
    }
    if (!row.reservation_key) {
      throw new Error(`turn-authorization: turn ${options.turnId} reservation has no idempotency key`);
    }
    if (
      row.reservation_type !== 'spend:chat' &&
      row.reservation_type !== 'spend:memory-dream'
    ) {
      throw new Error(
        `turn-authorization: turn ${options.turnId} has invalid reservation type ${String(row.reservation_type)}`,
      );
    }
    if (
      row.pricing_basis !== 'provider-api' &&
      row.pricing_basis !== 'notional-subscription'
    ) {
      throw new Error(
        `turn-authorization: turn ${options.turnId} has invalid pricing basis ${row.pricing_basis}`,
      );
    }

    const chargedManna = numericToNumber(row.authorized_max_manna);
    if (!Number.isSafeInteger(chargedManna) || chargedManna <= 0) {
      throw new Error(
        `turn-authorization: turn ${options.turnId} full-reserve charge is not a positive integer`,
      );
    }
    await markTurnSettled(tx, options.turnId, { chargedManna, overrun: false });
    const leg = await settleReservation({
      reservationKey: row.reservation_key,
      chargeManna: chargedManna,
      reservedSubscriptionManna: numericToNumber(row.reserved_subscription_manna),
      type:
        row.reservation_type === 'spend:memory-dream'
          ? 'refund:memory-dream:partial-output-settle'
          : 'refund:chat:partial-output-settle',
      db: tx,
    });
    const eventType =
      row.reservation_type === 'spend:memory-dream' ? 'memory_dream' : 'chat_turn';
    const [usage] = await tx
      .insert(usageEvents)
      .values({
        eventType,
        status: 'error',
        userId: row.account_id,
        agentId: row.agent_account_id,
        sessionId: row.session_id,
        messageId: null,
        turnId: row.turn_id,
        provider: row.provider,
        model: row.model,
        pricingBasis: row.pricing_basis,
        tableVersion: null,
        manna: chargedManna,
        errorCode: options.errorCode,
        errorMessage: options.errorMessage,
        metadata: {
          partialOutputSettlement: {
            rule: PARTIAL_OUTPUT_SETTLEMENT_RULE,
            chargedManna,
            ceilingTableVersion: row.ceiling_table_version,
            providerStartedAt: row.provider_started_at,
            usableOutputAt: row.usable_output_at,
          },
        },
      })
      .onConflictDoNothing()
      .returning({ id: usageEvents.id });
    if (!usage) {
      const survivor = (await tx.execute(sql`
        select status, manna from usage_events
        where event_type = ${eventType} and turn_id = ${row.turn_id}
      `)) as unknown as { status: string; manna: number | null }[];
      if (
        survivor.length !== 1 ||
        survivor[0]!.status !== 'error' ||
        Number(survivor[0]!.manna) !== chargedManna
      ) {
        throw new Error(
          `turn-authorization: turn ${options.turnId} has conflicting partial-output usage truth`,
        );
      }
    }

    return {
      settled: true,
      eligible: true,
      balanceTotal: leg.balance.total,
      chargedManna,
    };
  });
}

/**
 * Insert the authorization row for a fresh reservation. MUST run inside the
 * same transaction as the reservation debit. On a restart-safe replay
 * (deterministic scheduled turn ids) the existing row is returned; a replay
 * whose row is already terminal, or whose recorded max differs, returns null
 * — the caller must abort BEFORE any provider call (fail closed).
 */
export async function insertTurnAuthorization(
  tx: DbHandle,
  row: ReserveAuthorizationRow,
): Promise<TurnAuthorization | null> {
  const [inserted] = await tx
    .insert(turnAuthorizations)
    .values({
      turnId: row.turnId,
      accountId: row.accountId,
      agentAccountId: row.agentAccountId,
      sessionId: row.sessionId,
      provider: row.provider,
      model: row.model,
      pricingBasis: row.pricingBasis,
      ceilingTableVersion: row.ceilingTableVersion,
      authorizedMaxManna: row.authorizedMaxManna.toFixed(4),
      reservedSubscriptionManna: row.reservedSubscriptionManna.toFixed(4),
      reservationTxId: row.reservationTxId,
      state: 'reserved',
    })
    .onConflictDoNothing({ target: turnAuthorizations.turnId })
    .returning();
  if (inserted) return inserted;

  const [existing] = await tx
    .select()
    .from(turnAuthorizations)
    .where(eq(turnAuthorizations.turnId, row.turnId))
    .limit(1);
  if (!existing) return null;
  if (existing.state !== 'reserved') return null;
  if (numericToNumber(existing.authorizedMaxManna) !== row.authorizedMaxManna) return null;
  if (existing.reservationTxId !== row.reservationTxId) return null;
  // Full identity tuple: a replayed authorization must belong to the same
  // payer, agent, route, and pricing basis — never a same-sized foreign row
  // (checkpoint-#2).
  if (existing.accountId !== row.accountId) return null;
  if (existing.provider !== row.provider || existing.model !== row.model) return null;
  if (existing.pricingBasis !== row.pricingBasis) return null;
  return existing;
}

/**
 * Transition `reserved -> settled` recording the actual charge. Must run in
 * the same transaction as the settlement refund + assistant/usage persistence.
 * Throws when the row is not in `reserved` (a reaper/recovery interleaving
 * won) — the caller's transaction rolls back and no money moves twice.
 */
export async function markTurnSettled(
  tx: DbHandle,
  turnId: string,
  outcome: { chargedManna: number; overrun: boolean },
): Promise<void> {
  const [updated] = await tx
    .update(turnAuthorizations)
    .set({
      state: 'settled',
      chargedManna: outcome.chargedManna.toFixed(4),
      overrun: outcome.overrun,
      updatedAt: new Date(),
    })
    .where(and(eq(turnAuthorizations.turnId, turnId), eq(turnAuthorizations.state, 'reserved')))
    .returning({ turnId: turnAuthorizations.turnId });
  if (!updated) {
    throw new Error(
      `turn-authorization: turn ${turnId} is no longer 'reserved' — settlement refused (recovery owns it)`,
    );
  }
}

export interface ReverseTurnAuthorizationResult {
  /** True when this call performed the reversal (row was still `reserved`). */
  reversed: boolean;
  /** Balance after the reversal (only when `reversed`). */
  balanceTotal?: number;
  /** A durable usable prefix must settle under full-reserve-v1, never refund. */
  partialOutputRequired?: boolean;
}

/**
 * Fully reverse a turn's outstanding reservation and mark the row
 * `reversed` (or `reaped`), in one transaction. Idempotent and state-guarded:
 * a row already terminal is left untouched. Split-exact via the recorded
 * reservation split.
 */
export async function reverseTurnAuthorization(options: {
  turnId: string;
  refundType: string;
  terminalState?: 'reversed' | 'reaped';
  db?: DbHandle;
  /** Caller-owned generation fence, checked in the reversal transaction. */
  fence?: (tx: DbHandle) => Promise<void>;
}): Promise<ReverseTurnAuthorizationResult> {
  const dbc = options.db ?? db;
  return await dbc.transaction(async (tx) => {
    await options.fence?.(tx);
    // Lock the authorization row so a racing settle/reverse serializes here.
    const rows = (await tx.execute(sql`
      select a.turn_id, a.state, a.reserved_subscription_manna, a.reservation_tx_id,
             p.usable_output_at
      from turn_authorizations a
      left join turn_provider_runs p on p.turn_id = a.turn_id
      where a.turn_id = ${options.turnId}
      for update of a
    `)) as unknown as {
      turn_id: string;
      state: string;
      reserved_subscription_manna: string;
      reservation_tx_id: string;
      usable_output_at: Date | null;
    }[];
    const row = rows[0];
    if (!row || row.state !== 'reserved') return { reversed: false };
    if (row.usable_output_at !== null) {
      return { reversed: false, partialOutputRequired: true };
    }

    const [reservationTx] = await tx
      .select({ idempotencyKey: mannaTransactions.idempotencyKey })
      .from(mannaTransactions)
      .where(eq(mannaTransactions.id, row.reservation_tx_id))
      .limit(1);
    if (!reservationTx?.idempotencyKey) {
      throw new Error(
        `turn-authorization: reservation tx ${row.reservation_tx_id} for turn ${options.turnId} has no idempotency key`,
      );
    }

    const leg = await reverseReservation({
      reservationKey: reservationTx.idempotencyKey,
      reservedSubscriptionManna: numericToNumber(row.reserved_subscription_manna),
      type: options.refundType,
      db: tx,
    });

    await tx
      .update(turnAuthorizations)
      .set({ state: options.terminalState ?? 'reversed', updatedAt: new Date() })
      .where(
        and(eq(turnAuthorizations.turnId, options.turnId), eq(turnAuthorizations.state, 'reserved')),
      );

    return { reversed: true, balanceTotal: leg.balance.total };
  });
}
