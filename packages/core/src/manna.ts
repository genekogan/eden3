import {
  db,
  mannaAccounts,
  mannaTransactions,
  type MannaAccount,
  type MannaTransaction,
} from '@eden3/db';
import { and, eq, sql } from 'drizzle-orm';

import type { DbHandle, Tx } from './db-handle';

/**
 * Manna ledger — eden3's internal currency.
 *
 * Mirrors eden1's two-pot model (`manna` collection): every account has a
 * durable `balance` plus a monthly `subscription_balance`; spends draw the
 * subscription pot down first, then the durable pot (see eden1
 * `taskController.spendManna`). Unlike eden1, the guard and the two-column
 * split happen in ONE atomic SQL UPDATE, so concurrent spends can never
 * overdraw, and every mutation writes an append-only `manna_transactions`
 * row in the same database transaction (debits negative, credits positive,
 * as in eden1).
 *
 * Idempotency: `manna_transactions.idempotency_key` is unique. Passing a key
 * you have used before returns the original transaction instead of applying
 * a second charge — safe to retry a whole chat-turn pipeline. Refunds derive
 * their key from the original (`refund:<original key>`), so refunding twice
 * is also a no-op. Keys are a global namespace owned by the caller.
 *
 * Simplification (documented on purpose): refunds credit the durable
 * `balance` pot even when the original debit partially drew from
 * `subscription_balance`. The ledger does not record the split, and total
 * spendable manna — the thing the 402 guard checks — is restored exactly.
 */

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** Manna prices per action (PLAN.md: chat 1, image 5, video 25, music 10, tts 2). */
export const PRICING = {
  chatTurn: 1,
  image: 5,
  video: 25,
  music: 10,
  tts: 2,
} as const satisfies Record<string, number>;

export type PricedAction = keyof typeof PRICING;

// ---------------------------------------------------------------------------
// Numeric plumbing — pg numeric(20,4) travels as strings through drizzle.
// ---------------------------------------------------------------------------

/** Convert a JS number to the ledger's numeric(20,4) string form. */
export function numberToNumeric(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`manna amount must be a finite number, got ${String(value)}`);
  }
  return value.toFixed(4);
}

/** Parse a pg numeric string back into a JS number. */
export function numericToNumber(value: string): number {
  return Number(value);
}

function assertValidAmount(amount: number): void {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new RangeError(`manna amount must be a positive finite number, got ${String(amount)}`);
  }
  if (Number(amount.toFixed(4)) <= 0) {
    throw new RangeError(`manna amount ${amount} rounds to zero at ledger scale (4 dp)`);
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a debit would overdraw `subscription_balance + balance`. */
export class InsufficientMannaError extends Error {
  constructor(
    readonly accountId: string,
    readonly required: number,
    readonly available: number,
  ) {
    super(`insufficient manna: account ${accountId} has ${available}, needs ${required}`);
    this.name = 'InsufficientMannaError';
  }
}

/** Thrown by {@link debit} when a `dailyCap` check would be exceeded. */
export class DailyCapExceededError extends Error {
  constructor(
    readonly accountId: string,
    readonly spentToday: number,
    readonly requested: number,
    readonly cap: number,
  ) {
    super(
      `daily manna cap exceeded: account ${accountId} spent ${spentToday} today, ` +
        `requested ${requested} more, cap is ${cap}`,
    );
    this.name = 'DailyCapExceededError';
  }
}

/** Thrown when a debit would exceed a transactionally-enforced rolling scope cap. */
export class RollingSpendCapExceededError extends Error {
  constructor(
    readonly scope: string,
    readonly scopeId: string,
    readonly spent: number,
    readonly requested: number,
    readonly cap: number,
    readonly windowMs: number,
  ) {
    super(
      `${scope} rolling manna cap exceeded: scope ${scopeId} spent ${spent} in the ` +
        `last ${windowMs}ms, requested ${requested} more, cap is ${cap}`,
    );
    this.name = 'RollingSpendCapExceededError';
  }
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface MannaBalance {
  /** Durable pot (purchases, vouchers, refunds). */
  balance: number;
  /** Monthly subscription pot — spent first. */
  subscriptionBalance: number;
  /** Total spendable: `balance + subscriptionBalance`. */
  total: number;
}

function balanceFromRow(row: Pick<MannaAccount, 'balance' | 'subscriptionBalance'> | null): MannaBalance {
  const balance = row ? numericToNumber(row.balance) : 0;
  const subscriptionBalance = row ? numericToNumber(row.subscriptionBalance) : 0;
  return { balance, subscriptionBalance, total: balance + subscriptionBalance };
}

/**
 * Current balance for `accountId` (an `accounts.id` uuid). Accounts without
 * a manna row yet report zeros.
 */
export async function getBalance(accountId: string, opts: { db?: DbHandle } = {}): Promise<MannaBalance> {
  const dbc = opts.db ?? db;
  const [row] = await dbc
    .select()
    .from(mannaAccounts)
    .where(eq(mannaAccounts.accountId, accountId))
    .limit(1);
  return balanceFromRow(row ?? null);
}

async function balanceOfMannaAccount(dbc: DbHandle, mannaAccountId: string): Promise<MannaBalance> {
  const [row] = await dbc
    .select()
    .from(mannaAccounts)
    .where(eq(mannaAccounts.id, mannaAccountId))
    .limit(1);
  return balanceFromRow(row ?? null);
}

/**
 * Fetch the `manna_accounts` row for `accountId`, creating it (zero balances)
 * when missing. Race-safe via `ON CONFLICT DO NOTHING` + re-select.
 */
export async function getOrCreateMannaAccount(
  accountId: string,
  opts: { db?: DbHandle } = {},
): Promise<MannaAccount> {
  const dbc = opts.db ?? db;
  const [existing] = await dbc
    .select()
    .from(mannaAccounts)
    .where(eq(mannaAccounts.accountId, accountId))
    .limit(1);
  if (existing) return existing;
  const [inserted] = await dbc
    .insert(mannaAccounts)
    .values({ accountId })
    .onConflictDoNothing({ target: mannaAccounts.accountId })
    .returning();
  if (inserted) return inserted;
  const [raced] = await dbc
    .select()
    .from(mannaAccounts)
    .where(eq(mannaAccounts.accountId, accountId))
    .limit(1);
  if (!raced) throw new Error(`manna: could not create manna account for ${accountId}`);
  return raced;
}

// ---------------------------------------------------------------------------
// Ledger operations
// ---------------------------------------------------------------------------

export interface LedgerResult {
  /** The `manna_transactions` row this call created (or found, if replayed). */
  transaction: MannaTransaction;
  /** Balance after the operation. */
  balance: MannaBalance;
  /** True when the idempotency key had already been applied — nothing changed. */
  alreadyApplied: boolean;
  /**
   * Debits only: exact manna this debit drew from the subscription pot
   * (subscription-first policy). `undefined` on replays — the split of the
   * original application is not re-derivable from the ledger row (callers
   * that need it durably record it at first application, e.g.
   * `turn_authorizations.reserved_subscription_manna`).
   */
  subscriptionDrawn?: number;
}

export interface DebitParams {
  /** `accounts.id` uuid to charge. */
  accountId: string;
  /** Positive manna amount (max 4 decimal places of precision). */
  amount: number;
  /** Ledger label, e.g. `'spend:chat'`, `'spend:image'`. */
  type: string;
  /** Caller-owned unique key making the debit safe to retry. */
  idempotencyKey: string;
  /** Legacy task hex id, when the spend maps to an eden1-style task. */
  taskExternalId?: string;
  /**
   * Optional per-UTC-day spend ceiling (Q7 runaway protection). When set, the
   * debit takes a per-account advisory lock inside its transaction and
   * re-checks today's net spend (spends minus refunds) plus this debit
   * against the cap, throwing {@link DailyCapExceededError} without writing
   * anything when it would exceed. The lock serializes cap-checked debits for
   * the same account, so concurrent requests cannot all pass a stale check
   * (the classic route-level TOCTOU this replaces).
   */
  dailyCap?: { limit: number; now?: Date };
  /**
   * Optional rolling spend ceiling for a caller-defined scope. Debit keys for
   * the scope must be produced by {@link scopedLedgerIdempotencyKey}; the
   * ledger prefix is the durable attribution used by the cap query. The
   * per-scope advisory lock is held only for this short ledger transaction,
   * never across provider work.
   */
  rollingCap?: {
    scope: string;
    scopeId: string;
    limit: number;
    windowMs: number;
    now?: Date;
  };
  /** Run inside an existing drizzle client/transaction. */
  db?: DbHandle;
}

const LEDGER_SCOPE_PART = /^[a-z][a-z0-9-]{0,31}$/;
const LEDGER_SCOPE_ID = /^[a-zA-Z0-9._-]{1,128}$/;

function scopedLedgerPrefix(scope: string, scopeId: string): string {
  if (!LEDGER_SCOPE_PART.test(scope)) {
    throw new RangeError(`ledger scope must match ${LEDGER_SCOPE_PART}, got ${scope}`);
  }
  if (!LEDGER_SCOPE_ID.test(scopeId)) {
    throw new RangeError(`ledger scope id must match ${LEDGER_SCOPE_ID}, got ${scopeId}`);
  }
  return `budget:${scope}:${scopeId}:`;
}

/** Stable idempotency-key namespace for rolling-cap-attributed debits. */
export function scopedLedgerIdempotencyKey(
  scope: string,
  scopeId: string,
  operationId: string,
): string {
  if (!operationId || operationId.length > 200 || /[\r\n]/.test(operationId)) {
    throw new RangeError('ledger operation id must be 1-200 characters without newlines');
  }
  return `${scopedLedgerPrefix(scope, scopeId)}${operationId}`;
}

/** Start of the UTC day containing `now` — the daily-cap window boundary. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Net metered spend for one account since `since`, grouped by the original
 * debit's timestamp. A linked refund reduces that debit even when written
 * later; a refund of an older debit cannot erase newer-window spend. Exposed
 * for the API's fast-path check; the authoritative, race-free check runs
 * inside {@link debit}.
 */
export async function netSpendSince(
  accountId: string,
  since: Date,
  opts: { db?: DbHandle } = {},
): Promise<number> {
  const dbc = opts.db ?? db;
  const rows = (await dbc.execute(sql`
    select coalesce(sum(greatest(
      -original.amount - coalesce(linked_refunds.amount, 0),
      0
    )), 0)::numeric::text as spend
    from manna_transactions original
    join manna_accounts ma on ma.id = original.manna_account_id
    left join lateral (
      select coalesce(sum(refund_tx.amount), 0) as amount
      from manna_transactions refund_tx
      where refund_tx.refunds_transaction_id = original.id
        and refund_tx.type like 'refund%'
        and refund_tx.amount > 0
    ) linked_refunds on true
    where ma.account_id = ${accountId}
      and original.type like 'spend%'
      and original.amount < 0
      and original.created_at >= ${since.toISOString()}
  `)) as unknown as { spend: string | null }[];
  return Math.max(0, Number(rows[0]?.spend ?? 0));
}

/**
 * Net debit amount for one rolling-cap scope, grouped by the original debit's
 * timestamp. Linked refunds reduce that debit even when the refund itself was
 * written later; this avoids a refund near the window boundary incorrectly
 * offsetting newer work after its original debit ages out.
 */
export async function scopedNetSpendSince(
  scope: string,
  scopeId: string,
  since: Date,
  opts: { db?: DbHandle } = {},
): Promise<number> {
  const dbc = opts.db ?? db;
  const prefix = scopedLedgerPrefix(scope, scopeId);
  const rows = (await dbc.execute(sql`
    select coalesce(sum(greatest(
      -original.amount - coalesce(linked_refunds.amount, 0),
      0
    )), 0)::numeric::text as spend
    from manna_transactions original
    left join lateral (
      select coalesce(sum(refund_tx.amount), 0) as amount
      from manna_transactions refund_tx
      where refund_tx.refunds_transaction_id = original.id
        and refund_tx.amount > 0
    ) linked_refunds on true
    where original.amount < 0
      and original.idempotency_key like ${`${prefix}%`}
      and original.created_at >= ${since.toISOString()}
  `)) as unknown as { spend: string | null }[];
  return Math.max(0, Number(rows[0]?.spend ?? 0));
}

/** `dbc.transaction` for either the root client or a tx (savepoint). */
async function inTransaction<T>(dbc: DbHandle, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return await dbc.transaction(fn);
}

async function findTransactionByKey(dbc: DbHandle, key: string): Promise<MannaTransaction | null> {
  const [row] = await dbc
    .select()
    .from(mannaTransactions)
    .where(eq(mannaTransactions.idempotencyKey, key))
    .limit(1);
  return row ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Atomically debit `amount` manna from an account.
 *
 * One transaction: a guarded UPDATE (`subscription_balance + balance >=
 * amount`, subscription pot drained first — old column values on the right
 * side, so the split is race-free) plus the ledger insert (amount negative).
 * Throws {@link InsufficientMannaError} without writing anything when the
 * account can't cover it. Replaying an `idempotencyKey` — including losing a
 * concurrent race on it — returns the original transaction unchanged.
 */
export async function debit(params: DebitParams): Promise<LedgerResult> {
  assertValidAmount(params.amount);
  const dbc = params.db ?? db;
  try {
    return await inTransaction(dbc, async (tx) => {
      const existing = await findTransactionByKey(tx, params.idempotencyKey);
      if (existing) {
        return {
          transaction: existing,
          balance: await getBalance(params.accountId, { db: tx }),
          alreadyApplied: true,
        };
      }

      const account = await getOrCreateMannaAccount(params.accountId, { db: tx });

      if (params.dailyCap || params.rollingCap) {
        // Lock ordering is global and deliberate: account/day first, then the
        // rolling scope. Every multi-cap debit follows this order, preventing
        // deadlocks while serializing concurrent reservations/settlements.
        if (params.dailyCap) {
          // hash seed 42 is the existing per-account daily budget namespace.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${params.accountId}::text, 42))`,
          );
        }
        if (params.rollingCap) {
          scopedLedgerPrefix(params.rollingCap.scope, params.rollingCap.scopeId);
          if (!Number.isFinite(params.rollingCap.limit) || params.rollingCap.limit < 0) {
            throw new RangeError('rolling cap limit must be finite and nonnegative');
          }
          if (!Number.isFinite(params.rollingCap.windowMs) || params.rollingCap.windowMs <= 0) {
            throw new RangeError('rolling cap windowMs must be finite and positive');
          }
          const expectedPrefix = scopedLedgerPrefix(
            params.rollingCap.scope,
            params.rollingCap.scopeId,
          );
          if (!params.idempotencyKey.startsWith(expectedPrefix)) {
            throw new RangeError(
              `rolling-cap debit key must start with ${expectedPrefix}`,
            );
          }
          // hash seed 43 is disjoint from daily-account and task-limit locks.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`${params.rollingCap.scope}:${params.rollingCap.scopeId}`}::text, 43))`,
          );
        }
        // Re-check idempotency INSIDE the lock: a concurrent replay of the
        // same key that lost the lock race must return the winner's result,
        // not a spurious DailyCapExceededError once the winner's spend is
        // counted below. (Belt-and-suspenders — current callers use fresh
        // keys, but this keeps the debit() contract correct under replay.)
        const applied = await findTransactionByKey(tx, params.idempotencyKey);
        if (applied) {
          return {
            transaction: applied,
            balance: await getBalance(params.accountId, { db: tx }),
            alreadyApplied: true,
          };
        }
        if (params.dailyCap) {
          const spentToday = await netSpendSince(
            params.accountId,
            startOfUtcDay(params.dailyCap.now ?? new Date()),
            { db: tx },
          );
          if (spentToday + params.amount > params.dailyCap.limit) {
            throw new DailyCapExceededError(
              params.accountId,
              spentToday,
              params.amount,
              params.dailyCap.limit,
            );
          }
        }
        if (params.rollingCap) {
          const now = params.rollingCap.now ?? new Date();
          const spent = await scopedNetSpendSince(
            params.rollingCap.scope,
            params.rollingCap.scopeId,
            new Date(now.getTime() - params.rollingCap.windowMs),
            { db: tx },
          );
          if (spent + params.amount > params.rollingCap.limit) {
            throw new RollingSpendCapExceededError(
              params.rollingCap.scope,
              params.rollingCap.scopeId,
              spent,
              params.amount,
              params.rollingCap.limit,
              params.rollingCap.windowMs,
            );
          }
        }
      }

      const amount = numberToNumeric(params.amount);
      // Lock the account row first so the pre-read subscription balance is the
      // exact value the guarded UPDATE below computes from — the reported
      // subscription/durable split is authoritative, not best-effort.
      const [locked] = await tx
        .select()
        .from(mannaAccounts)
        .where(eq(mannaAccounts.id, account.id))
        .for('update');
      if (!locked) throw new Error(`manna: debit lost manna account ${account.id}`);
      const subscriptionBefore = numericToNumber(locked.subscriptionBalance);
      const [updated] = await tx
        .update(mannaAccounts)
        .set({
          subscriptionBalance: sql`greatest(${mannaAccounts.subscriptionBalance} - ${amount}::numeric, 0)`,
          balance: sql`${mannaAccounts.balance} - greatest(${amount}::numeric - ${mannaAccounts.subscriptionBalance}, 0)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mannaAccounts.id, account.id),
            sql`${mannaAccounts.balance} + ${mannaAccounts.subscriptionBalance} >= ${amount}::numeric`,
          ),
        )
        .returning();

      if (!updated) {
        // Re-read inside the tx so the error reports the freshest total.
        const current = await balanceOfMannaAccount(tx, account.id);
        throw new InsufficientMannaError(params.accountId, params.amount, current.total);
      }

      const [ledger] = await tx
        .insert(mannaTransactions)
        .values({
          mannaAccountId: account.id,
          amount: numberToNumeric(-params.amount),
          type: params.type,
          idempotencyKey: params.idempotencyKey,
          taskExternalId: params.taskExternalId ?? null,
        })
        .returning();
      if (!ledger) throw new Error('manna: ledger insert returned no row');

      return {
        transaction: ledger,
        balance: balanceFromRow(updated),
        alreadyApplied: false,
        subscriptionDrawn: Number(Math.min(subscriptionBefore, params.amount).toFixed(4)),
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findTransactionByKey(dbc, params.idempotencyKey);
      if (existing) {
        return {
          transaction: existing,
          balance: await getBalance(params.accountId, { db: dbc }),
          alreadyApplied: true,
        };
      }
    }
    throw err;
  }
}

export interface CreditParams {
  /** `accounts.id` uuid to credit. */
  accountId: string;
  /** Positive manna amount. */
  amount: number;
  /** Ledger label, e.g. `'credit:stripe'`, `'credit:voucher'`. */
  type: string;
  /** Optional idempotency key (recommended for anything webhook-driven). */
  idempotencyKey?: string;
  taskExternalId?: string;
  stripeEventId?: string;
  stripeEventType?: string;
  stripeEventData?: unknown;
  voucherExternalId?: string;
  code?: string;
  /** Credit the monthly subscription pot instead of the durable balance. */
  toSubscriptionBalance?: boolean;
  db?: DbHandle;
}

/**
 * Credit `amount` manna to an account (creating its manna row when missing).
 * Ledger amount is positive. Idempotent when `idempotencyKey` is provided.
 */
export async function credit(params: CreditParams): Promise<LedgerResult> {
  assertValidAmount(params.amount);
  const dbc = params.db ?? db;
  try {
    return await inTransaction(dbc, async (tx) => {
      if (params.idempotencyKey) {
        const existing = await findTransactionByKey(tx, params.idempotencyKey);
        if (existing) {
          return {
            transaction: existing,
            balance: await getBalance(params.accountId, { db: tx }),
            alreadyApplied: true,
          };
        }
      }

      const account = await getOrCreateMannaAccount(params.accountId, { db: tx });
      const amount = numberToNumeric(params.amount);
      const [updated] = await tx
        .update(mannaAccounts)
        .set(
          params.toSubscriptionBalance
            ? {
                subscriptionBalance: sql`${mannaAccounts.subscriptionBalance} + ${amount}::numeric`,
                updatedAt: new Date(),
              }
            : {
                balance: sql`${mannaAccounts.balance} + ${amount}::numeric`,
                updatedAt: new Date(),
              },
        )
        .where(eq(mannaAccounts.id, account.id))
        .returning();
      if (!updated) throw new Error(`manna: credit lost the account row for ${params.accountId}`);

      const [ledger] = await tx
        .insert(mannaTransactions)
        .values({
          mannaAccountId: account.id,
          amount,
          type: params.type,
          idempotencyKey: params.idempotencyKey ?? null,
          taskExternalId: params.taskExternalId ?? null,
          stripeEventId: params.stripeEventId ?? null,
          stripeEventType: params.stripeEventType ?? null,
          stripeEventData: params.stripeEventData ?? null,
          voucherExternalId: params.voucherExternalId ?? null,
          code: params.code ?? null,
        })
        .returning();
      if (!ledger) throw new Error('manna: ledger insert returned no row');

      return { transaction: ledger, balance: balanceFromRow(updated), alreadyApplied: false };
    });
  } catch (err) {
    if (params.idempotencyKey && isUniqueViolation(err)) {
      const existing = await findTransactionByKey(dbc, params.idempotencyKey);
      if (existing) {
        return {
          transaction: existing,
          balance: await getBalance(params.accountId, { db: dbc }),
          alreadyApplied: true,
        };
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/** Idempotency key a refund of `originalKey` uses: `refund:<originalKey>`. */
export function refundIdempotencyKey(originalKey: string): string {
  return `refund:${originalKey}`;
}

/**
 * Idempotency key of the settlement leg that returns a reservation's UNUSED
 * portion (T08-U02). Deliberately in a namespace no legacy derivation can
 * produce: `refundIdempotencyKey('<key>:settle')` (the scheduler/memory
 * recovery reversal of old-style settle DEBITS) yields `refund:<key>:settle`,
 * which must never collide with this leg.
 */
export function settleReservationIdempotencyKey(reservationKey: string): string {
  return `refund:${reservationKey}:authz-settle`;
}

export interface RefundParams {
  /** Idempotency key of the debit to reverse. */
  originalIdempotencyKey: string;
  /** Ledger label (default `'refund'`). */
  type?: string;
  db?: DbHandle;
}

interface RefundLegParams {
  originalIdempotencyKey: string;
  /** Manna to credit back; default = the full remaining refundable amount. */
  amount?: number;
  /** Refund idempotency key; default {@link refundIdempotencyKey}. */
  key?: string;
  type?: string;
  /**
   * Exact share of `amount` to restore to the subscription pot (rest goes to
   * the durable pot). Capped at `amount`. Default 0 — the documented legacy
   * simplification (refunds credit durable) for callers that never recorded
   * the original split.
   */
  toSubscription?: number;
  db?: DbHandle;
}

export interface RefundLegResult {
  /** The refund ledger row this leg created or replayed (null when nothing was refundable and no leg row exists). */
  transaction: MannaTransaction | null;
  balance: MannaBalance;
  alreadyApplied: boolean;
  /** Manna this leg's key credited (the existing row's amount on replay; 0 when nothing was refundable). */
  appliedManna: number;
  /** Refundable manna still outstanding on the original debit AFTER this leg. */
  remainingRefundable: number;
}

/**
 * Sum of refunds already linked to `originalTxId`. Runs inside the caller's
 * transaction, after the original row is locked — serialized per original.
 */
async function alreadyRefundedManna(tx: DbHandle, originalTxId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    select coalesce(sum(amount), 0)::numeric::text as refunded
    from manna_transactions
    where refunds_transaction_id = ${originalTxId}
      and amount > 0
  `)) as unknown as { refunded: string }[];
  return Number(rows[0]?.refunded ?? 0);
}

/**
 * The single remainder-aware refund primitive every reversal path uses.
 * Serialized per original debit (`SELECT … FOR UPDATE` on the original ledger
 * row), idempotent per leg key, and split-capable. Never over-credits: the
 * amount is validated against `-original.amount - sum(linked refunds)` inside
 * the same transaction that inserts the leg.
 */
async function refundLeg(params: RefundLegParams): Promise<RefundLegResult | null> {
  const dbc = params.db ?? db;
  const legKey = params.key ?? refundIdempotencyKey(params.originalIdempotencyKey);
  const run = async (tx: Tx): Promise<RefundLegResult | null> => {
    const original = await findTransactionByKey(tx, params.originalIdempotencyKey);
    if (original) {
      // Serialize refund legs per original debit BEFORE any replay inspection:
      // two concurrent identical legs must resolve as winner-inserts /
      // loser-replays, never as a spurious over-refund error (checkpoint-#2).
      await tx.execute(
        sql`select id from manna_transactions where id = ${original.id} for update`,
      );
    }
    const existing = await findTransactionByKey(tx, legKey);
    if (existing) {
      // Replay validation: the leg row must reverse THIS original, and when
      // the caller names an amount it must be the amount that leg applied.
      if (original && existing.refundsTransactionId !== original.id) {
        throw new Error(
          `manna: refund key ${legKey} already reverses transaction ` +
            `${existing.refundsTransactionId ?? '<none>'}, not ${original.id}; refusing to replay`,
        );
      }
      const appliedManna = numericToNumber(existing.amount);
      if (
        params.amount !== undefined &&
        Math.abs(appliedManna - Number(params.amount.toFixed(4))) > 1e-9
      ) {
        throw new Error(
          `manna: refund key ${legKey} already applied ${appliedManna}, ` +
            `refusing a replay that requests ${params.amount}`,
        );
      }
      const remaining = original
        ? -numericToNumber(original.amount) - (await alreadyRefundedManna(tx, original.id))
        : 0;
      return {
        transaction: existing,
        balance: await balanceOfMannaAccount(tx, existing.mannaAccountId),
        alreadyApplied: true,
        appliedManna,
        remainingRefundable: Number(Math.max(0, remaining).toFixed(4)),
      };
    }

    if (!original) return null;
    const originalAmount = -numericToNumber(original.amount);
    if (!(originalAmount > 0)) {
      throw new Error(
        `manna: transaction ${original.id} (key ${params.originalIdempotencyKey}) is not a debit; refusing to refund`,
      );
    }

    const refunded = await alreadyRefundedManna(tx, original.id);
    const refundable = Number(Math.max(0, originalAmount - refunded).toFixed(4));
    const requested = params.amount ?? refundable;
    if (!Number.isFinite(requested) || requested < 0) {
      throw new RangeError(`manna: refund amount must be finite and nonnegative, got ${String(requested)}`);
    }
    if (requested > refundable + 1e-9) {
      throw new RangeError(
        `manna: refund of ${requested} exceeds the refundable remainder ${refundable} ` +
          `of debit ${params.originalIdempotencyKey}`,
      );
    }
    const amount = Number(requested.toFixed(4));
    if (amount <= 0) {
      return {
        transaction: null,
        balance: await balanceOfMannaAccount(tx, original.mannaAccountId),
        alreadyApplied: false,
        appliedManna: 0,
        remainingRefundable: refundable,
      };
    }

    const toSubscription = Number(
      Math.min(Math.max(params.toSubscription ?? 0, 0), amount).toFixed(4),
    );
    const toDurable = Number((amount - toSubscription).toFixed(4));
    const [updated] = await tx
      .update(mannaAccounts)
      .set({
        balance: sql`${mannaAccounts.balance} + ${numberToNumeric(toDurable)}::numeric`,
        subscriptionBalance: sql`${mannaAccounts.subscriptionBalance} + ${numberToNumeric(toSubscription)}::numeric`,
        updatedAt: new Date(),
      })
      .where(eq(mannaAccounts.id, original.mannaAccountId))
      .returning();
    if (!updated) throw new Error(`manna: refund lost manna account ${original.mannaAccountId}`);

    const [ledger] = await tx
      .insert(mannaTransactions)
      .values({
        mannaAccountId: original.mannaAccountId,
        amount: numberToNumeric(amount),
        type: params.type ?? 'refund',
        idempotencyKey: legKey,
        refundsTransactionId: original.id,
        taskExternalId: original.taskExternalId,
      })
      .returning();
    if (!ledger) throw new Error('manna: ledger insert returned no row');

    return {
      transaction: ledger,
      balance: balanceFromRow(updated),
      alreadyApplied: false,
      appliedManna: amount,
      remainingRefundable: Number((refundable - amount).toFixed(4)),
    };
  };

  try {
    return await inTransaction(dbc, run);
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Validate the surviving leg exactly like an in-transaction replay —
      // the race loser must never bless a leg that reverses a different
      // original or a different amount (checkpoint-#2).
      const existing = await findTransactionByKey(dbc, legKey);
      if (existing) {
        const original = await findTransactionByKey(dbc, params.originalIdempotencyKey);
        if (original && existing.refundsTransactionId !== original.id) {
          throw new Error(
            `manna: refund key ${legKey} already reverses transaction ` +
              `${existing.refundsTransactionId ?? '<none>'}, not ${original.id}; refusing to replay`,
          );
        }
        const appliedManna = numericToNumber(existing.amount);
        if (
          params.amount !== undefined &&
          Math.abs(appliedManna - Number(params.amount.toFixed(4))) > 1e-9
        ) {
          throw new Error(
            `manna: refund key ${legKey} already applied ${appliedManna}, ` +
              `refusing a replay that requests ${params.amount}`,
          );
        }
        const remaining = original
          ? -numericToNumber(original.amount) - (await alreadyRefundedManna(dbc, original.id))
          : 0;
        return {
          transaction: existing,
          balance: await balanceOfMannaAccount(dbc, existing.mannaAccountId),
          alreadyApplied: true,
          appliedManna,
          remainingRefundable: Number(Math.max(0, remaining).toFixed(4)),
        };
      }
    }
    throw err;
  }
}

/**
 * Reverse a debit identified by its idempotency key. Returns `null` when no
 * such debit exists (nothing to refund — e.g. the debit itself never landed).
 * Idempotent: the refund's own key is `refund:<original>`, so calling twice
 * credits once. Throws when the original transaction is not a debit.
 *
 * REMAINDER-AWARE (T08-U02): after a partial settlement leg has returned part
 * of the debit, this credits exactly the outstanding remainder — never the
 * full original amount again. With no partial legs the behavior is identical
 * to the original contract. Credits the durable pot (the documented legacy
 * simplification); split-exact reversal is {@link reverseReservation}.
 */
export async function refund(params: RefundParams): Promise<LedgerResult | null> {
  const leg = await refundLeg({
    originalIdempotencyKey: params.originalIdempotencyKey,
    ...(params.type !== undefined ? { type: params.type } : {}),
    ...(params.db !== undefined ? { db: params.db } : {}),
  });
  if (leg === null) return null;
  if (leg.transaction === null) {
    // Nothing refundable remains and this key never landed: the reservation
    // was already fully returned by other legs. Surface the most recent
    // reversing leg as an idempotent no-op so callers know the money is back.
    const dbc = params.db ?? db;
    const original = await findTransactionByKey(dbc, params.originalIdempotencyKey);
    if (!original) return null;
    const [latestLeg] = await dbc
      .select()
      .from(mannaTransactions)
      .where(eq(mannaTransactions.refundsTransactionId, original.id))
      .orderBy(sql`created_at desc`)
      .limit(1);
    if (!latestLeg) return null;
    return {
      transaction: latestLeg,
      balance: await balanceOfMannaAccount(dbc, latestLeg.mannaAccountId),
      alreadyApplied: true,
    };
  }
  return {
    transaction: leg.transaction,
    balance: leg.balance,
    alreadyApplied: leg.alreadyApplied,
  };
}

export interface SettleReservationParams {
  /** The reservation debit's idempotency key (the turn id). */
  reservationKey: string;
  /** Actual charge to keep — must be ≤ the reservation's refundable amount. */
  chargeManna: number;
  /** The exact subscription share the reservation drew (from the authz row). */
  reservedSubscriptionManna: number;
  /** Ledger label for the unused-reserve leg (default `'refund:settle'`). */
  type?: string;
  db?: DbHandle;
}

/**
 * Settle a worst-case reservation at its actual cost: keep `chargeManna`
 * debited and return the unused remainder in one idempotent leg under
 * {@link settleReservationIdempotencyKey}. Split-exact: the charge draws the
 * reservation's subscription share first, so the unused portion restores
 * `reservedSubscription − min(reservedSubscription, charge)` to the
 * subscription pot and the rest to durable. Throws when `chargeManna` exceeds
 * what the reservation still holds (settle > authorized-max is structurally
 * impossible at the ledger).
 */
export async function settleReservation(
  params: SettleReservationParams,
): Promise<RefundLegResult> {
  if (!Number.isFinite(params.chargeManna) || params.chargeManna < 0) {
    throw new RangeError(`manna: settle charge must be finite and nonnegative, got ${String(params.chargeManna)}`);
  }
  const dbc = params.db ?? db;
  const result = await inTransaction(dbc, async (tx) => {
    const original = await findTransactionByKey(tx, params.reservationKey);
    if (!original) {
      throw new Error(`manna: no reservation debit under key ${params.reservationKey}`);
    }
    const reserved = -numericToNumber(original.amount);
    if (params.chargeManna > reserved + 1e-9) {
      throw new RangeError(
        `manna: settle charge ${params.chargeManna} exceeds reservation ${reserved} (${params.reservationKey})`,
      );
    }
    const chargeSubscription = Math.min(params.reservedSubscriptionManna, params.chargeManna);
    const unusedSubscription = Number(
      Math.max(0, params.reservedSubscriptionManna - chargeSubscription).toFixed(4),
    );
    const unused = Number((reserved - params.chargeManna).toFixed(4));
    const leg = await refundLeg({
      originalIdempotencyKey: params.reservationKey,
      amount: unused,
      key: settleReservationIdempotencyKey(params.reservationKey),
      type: params.type ?? 'refund:settle',
      toSubscription: unusedSubscription,
      db: tx,
    });
    if (leg === null) {
      throw new Error(`manna: reservation ${params.reservationKey} disappeared during settlement`);
    }
    return leg;
  });
  return result;
}

export interface ReverseReservationParams {
  /** The reservation debit's idempotency key (the turn id). */
  reservationKey: string;
  /**
   * The exact subscription share the reservation drew, when known (authz
   * row). The outstanding remainder restores `min(share, remainder)` to the
   * subscription pot. Omitted → durable-only (legacy behavior).
   */
  reservedSubscriptionManna?: number;
  type?: string;
  db?: DbHandle;
}

/**
 * Fully reverse whatever remains of a reservation (failed turn, orphan reap).
 * Remainder-aware and idempotent under `refund:<key>`; split-exact when the
 * reservation's subscription share is provided.
 */
export async function reverseReservation(
  params: ReverseReservationParams,
): Promise<RefundLegResult> {
  const dbc = params.db ?? db;
  return await inTransaction(dbc, async (tx) => {
    const original = await findTransactionByKey(tx, params.reservationKey);
    if (!original) {
      throw new Error(`manna: no reservation debit under key ${params.reservationKey}`);
    }
    await tx.execute(
      sql`select id from manna_transactions where id = ${original.id} for update`,
    );
    const reserved = -numericToNumber(original.amount);
    const refunded = await alreadyRefundedManna(tx, original.id);
    const remainder = Number(Math.max(0, reserved - refunded).toFixed(4));
    // The charge portion of the remainder draws subscription-first, so its
    // subscription share is min(reservedSubscription, remainder).
    const toSubscription = Number(
      Math.min(params.reservedSubscriptionManna ?? 0, remainder).toFixed(4),
    );
    const leg = await refundLeg({
      originalIdempotencyKey: params.reservationKey,
      // When another caller already completed the full reversal, remainder is
      // zero. Omit the amount only in that terminal case so refundLeg can
      // validate and return the matching existing leg as an idempotent replay;
      // passing `0` would incorrectly compare it with the positive applied
      // amount. Positive remainders keep exact amount validation.
      ...(remainder > 0 ? { amount: remainder } : {}),
      type: params.type ?? 'refund',
      toSubscription,
      db: tx,
    });
    if (leg === null) {
      throw new Error(`manna: reservation ${params.reservationKey} disappeared during reversal`);
    }
    return leg;
  });
}
