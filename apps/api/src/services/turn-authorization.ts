import type { DbHandle } from '@eden3/core';
import { numericToNumber, reverseReservation } from '@eden3/core';
import { db, mannaTransactions, turnAuthorizations, type TurnAuthorization } from '@eden3/db';
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
      select turn_id, state, reserved_subscription_manna, reservation_tx_id
      from turn_authorizations where turn_id = ${options.turnId} for update
    `)) as unknown as {
      turn_id: string;
      state: string;
      reserved_subscription_manna: string;
      reservation_tx_id: string;
    }[];
    const row = rows[0];
    if (!row || row.state !== 'reserved') return { reversed: false };

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
