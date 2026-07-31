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

      return { transaction: ledger, balance: balanceFromRow(updated), alreadyApplied: false };
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

export interface RefundParams {
  /** Idempotency key of the debit to reverse. */
  originalIdempotencyKey: string;
  /** Ledger label (default `'refund'`). */
  type?: string;
  db?: DbHandle;
}

/**
 * Reverse a debit identified by its idempotency key. Returns `null` when no
 * such debit exists (nothing to refund — e.g. the debit itself never landed).
 * Idempotent: the refund's own key is `refund:<original>`, so calling twice
 * credits once. Throws when the original transaction is not a debit.
 */
export async function refund(params: RefundParams): Promise<LedgerResult | null> {
  const dbc = params.db ?? db;
  const refundKey = refundIdempotencyKey(params.originalIdempotencyKey);
  try {
    return await inTransaction(dbc, async (tx) => {
      const existing = await findTransactionByKey(tx, refundKey);
      if (existing) {
        return {
          transaction: existing,
          balance: await balanceOfMannaAccount(tx, existing.mannaAccountId),
          alreadyApplied: true,
        };
      }

      const original = await findTransactionByKey(tx, params.originalIdempotencyKey);
      if (!original) return null;
      const amount = -numericToNumber(original.amount);
      if (!(amount > 0)) {
        throw new Error(
          `manna: transaction ${original.id} (key ${params.originalIdempotencyKey}) is not a debit; refusing to refund`,
        );
      }

      const numericAmount = numberToNumeric(amount);
      const [updated] = await tx
        .update(mannaAccounts)
        .set({
          balance: sql`${mannaAccounts.balance} + ${numericAmount}::numeric`,
          updatedAt: new Date(),
        })
        .where(eq(mannaAccounts.id, original.mannaAccountId))
        .returning();
      if (!updated) throw new Error(`manna: refund lost manna account ${original.mannaAccountId}`);

      const [ledger] = await tx
        .insert(mannaTransactions)
        .values({
          mannaAccountId: original.mannaAccountId,
          amount: numericAmount,
          type: params.type ?? 'refund',
          idempotencyKey: refundKey,
          refundsTransactionId: original.id,
          taskExternalId: original.taskExternalId,
        })
        .returning();
      if (!ledger) throw new Error('manna: ledger insert returned no row');

      return { transaction: ledger, balance: balanceFromRow(updated), alreadyApplied: false };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findTransactionByKey(dbc, refundKey);
      if (existing) {
        return {
          transaction: existing,
          balance: await balanceOfMannaAccount(dbc, existing.mannaAccountId),
          alreadyApplied: true,
        };
      }
    }
    throw err;
  }
}
