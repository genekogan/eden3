import { randomUUID } from 'node:crypto';

import { accounts, db, mannaAccounts, mannaTransactions, pg } from '@eden3/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  InsufficientMannaError,
  PRICING,
  credit,
  debit,
  getBalance,
  getOrCreateMannaAccount,
  numberToNumeric,
  numericToNumber,
  refund,
  refundIdempotencyKey,
} from './manna';

/**
 * These tests hit the live local postgres (localhost:5433, db eden3). Every
 * row they create is a throwaway account made here and deleted in afterAll.
 */

const createdAccountIds: string[] = [];

async function makeAccount(): Promise<string> {
  const username = `core-manna-test-${randomUUID()}`;
  const [row] = await db.insert(accounts).values({ type: 'user', username }).returning();
  if (!row) throw new Error('failed to create test account');
  createdAccountIds.push(row.id);
  return row.id;
}

async function ledgerRowsFor(accountId: string) {
  const [manna] = await db
    .select()
    .from(mannaAccounts)
    .where(eq(mannaAccounts.accountId, accountId))
    .limit(1);
  if (!manna) return [];
  return db.select().from(mannaTransactions).where(eq(mannaTransactions.mannaAccountId, manna.id));
}

afterAll(async () => {
  try {
    if (createdAccountIds.length > 0) {
      const mannaRows = await db
        .select()
        .from(mannaAccounts)
        .where(inArray(mannaAccounts.accountId, createdAccountIds));
      const mannaIds = mannaRows.map((r) => r.id);
      if (mannaIds.length > 0) {
        await db.delete(mannaTransactions).where(inArray(mannaTransactions.mannaAccountId, mannaIds));
        await db.delete(mannaAccounts).where(inArray(mannaAccounts.accountId, createdAccountIds));
      }
      await db.delete(accounts).where(inArray(accounts.id, createdAccountIds));
    }
  } finally {
    await pg.end();
  }
});

describe('PRICING', () => {
  it('matches the approved price sheet', () => {
    expect(PRICING).toEqual({ chatTurn: 1, image: 5, video: 25, music: 10, tts: 2 });
  });
});

describe('numeric helpers', () => {
  it('round-trip at ledger scale', () => {
    expect(numberToNumeric(25)).toBe('25.0000');
    expect(numberToNumeric(-1.5)).toBe('-1.5000');
    expect(numericToNumber('25.0000')).toBe(25);
    expect(numericToNumber('-0.5000')).toBe(-0.5);
  });

  it('rejects non-finite input', () => {
    expect(() => numberToNumeric(Number.NaN)).toThrow(RangeError);
    expect(() => numberToNumeric(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('getBalance / getOrCreateMannaAccount', () => {
  it('reports zeros for an account with no manna row', async () => {
    const accountId = await makeAccount();
    expect(await getBalance(accountId)).toEqual({ balance: 0, subscriptionBalance: 0, total: 0 });
  });

  it('creates the manna row once and reuses it', async () => {
    const accountId = await makeAccount();
    const first = await getOrCreateMannaAccount(accountId);
    const second = await getOrCreateMannaAccount(accountId);
    expect(second.id).toBe(first.id);
    expect(numericToNumber(first.balance)).toBe(0);
  });
});

describe('credit', () => {
  it('creates the account row and increases the durable balance', async () => {
    const accountId = await makeAccount();
    const result = await credit({ accountId, amount: 100, type: 'credit:test' });
    expect(result.alreadyApplied).toBe(false);
    expect(result.balance).toEqual({ balance: 100, subscriptionBalance: 0, total: 100 });
    expect(numericToNumber(result.transaction.amount)).toBe(100);
    expect(result.transaction.type).toBe('credit:test');
    expect(await getBalance(accountId)).toEqual(result.balance);
  });

  it('targets the subscription pot when asked', async () => {
    const accountId = await makeAccount();
    const result = await credit({
      accountId,
      amount: 10,
      type: 'credit:subscription',
      toSubscriptionBalance: true,
    });
    expect(result.balance).toEqual({ balance: 0, subscriptionBalance: 10, total: 10 });
  });

  it('is idempotent when a key is provided', async () => {
    const accountId = await makeAccount();
    const key = `credit-${randomUUID()}`;
    const first = await credit({ accountId, amount: 5, type: 'credit:test', idempotencyKey: key });
    const second = await credit({ accountId, amount: 5, type: 'credit:test', idempotencyKey: key });
    expect(second.alreadyApplied).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(await getBalance(accountId)).toEqual({ balance: 5, subscriptionBalance: 0, total: 5 });
  });
});

describe('debit', () => {
  it('spends subscription balance first, then the durable balance', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 100, type: 'credit:test' });
    await credit({ accountId, amount: 10, type: 'credit:sub', toSubscriptionBalance: true });

    const result = await debit({
      accountId,
      amount: PRICING.video,
      type: 'spend:video',
      idempotencyKey: `debit-${randomUUID()}`,
      taskExternalId: '665f0a1b2c3d4e5f60718293',
    });

    // 25 debited: 10 from subscription, 15 from balance.
    expect(result.balance).toEqual({ balance: 85, subscriptionBalance: 0, total: 85 });
    expect(numericToNumber(result.transaction.amount)).toBe(-25);
    expect(result.transaction.taskExternalId).toBe('665f0a1b2c3d4e5f60718293');
    expect(await getBalance(accountId)).toEqual(result.balance);
  });

  it('leaves the durable balance untouched when subscription covers it', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 50, type: 'credit:test' });
    await credit({ accountId, amount: 10, type: 'credit:sub', toSubscriptionBalance: true });

    const result = await debit({
      accountId,
      amount: PRICING.chatTurn,
      type: 'spend:chat',
      idempotencyKey: `debit-${randomUUID()}`,
    });
    expect(result.balance).toEqual({ balance: 50, subscriptionBalance: 9, total: 59 });
  });

  it('throws InsufficientMannaError and writes nothing when overdrawn', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 3, type: 'credit:test' });

    await expect(
      debit({ accountId, amount: 5, type: 'spend:image', idempotencyKey: `debit-${randomUUID()}` }),
    ).rejects.toThrow(InsufficientMannaError);
    await expect(
      debit({ accountId, amount: 5, type: 'spend:image', idempotencyKey: `debit-${randomUUID()}` }),
    ).rejects.toMatchObject({ name: 'InsufficientMannaError', required: 5, available: 3 });

    expect(await getBalance(accountId)).toEqual({ balance: 3, subscriptionBalance: 0, total: 3 });
    expect(await ledgerRowsFor(accountId)).toHaveLength(1); // just the credit
  });

  it('debits a brand-new account only up to zero (no implicit grant)', async () => {
    const accountId = await makeAccount();
    await expect(
      debit({ accountId, amount: 1, type: 'spend:chat', idempotencyKey: `debit-${randomUUID()}` }),
    ).rejects.toThrow(InsufficientMannaError);
  });

  it('rejects non-positive and non-finite amounts before touching the db', async () => {
    const accountId = randomUUID(); // never created — validation fires first
    for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.00001]) {
      await expect(
        debit({ accountId, amount, type: 'spend:test', idempotencyKey: `debit-${randomUUID()}` }),
      ).rejects.toThrow(RangeError);
    }
  });

  it('is idempotent per key (sequential replay)', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 50, type: 'credit:test' });
    const key = `debit-${randomUUID()}`;

    const first = await debit({ accountId, amount: 5, type: 'spend:image', idempotencyKey: key });
    const second = await debit({ accountId, amount: 5, type: 'spend:image', idempotencyKey: key });

    expect(first.alreadyApplied).toBe(false);
    expect(second.alreadyApplied).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(await getBalance(accountId)).toEqual({ balance: 45, subscriptionBalance: 0, total: 45 });
    const rows = await ledgerRowsFor(accountId);
    expect(rows.filter((r) => r.idempotencyKey === key)).toHaveLength(1);
  });

  it('debits exactly once under a concurrent same-key race', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 50, type: 'credit:test' });
    const key = `debit-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        debit({ accountId, amount: 10, type: 'spend:music', idempotencyKey: key }),
      ),
    );

    const applied = results.filter((r) => !r.alreadyApplied);
    expect(applied).toHaveLength(1);
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(await getBalance(accountId)).toEqual({ balance: 40, subscriptionBalance: 0, total: 40 });
  });

  it('never overdraws under concurrent distinct-key debits', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 55, type: 'credit:test' });

    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        debit({ accountId, amount: 10, type: 'spend:music', idempotencyKey: `debit-${randomUUID()}` }),
      ),
    );

    const ok = settled.filter((s) => s.status === 'fulfilled');
    const failed = settled.filter((s) => s.status === 'rejected');
    expect(ok).toHaveLength(5); // 55 covers exactly five 10-manna debits
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientMannaError);
    }
    expect(await getBalance(accountId)).toEqual({ balance: 5, subscriptionBalance: 0, total: 5 });
  });
});

describe('refund', () => {
  it('restores the debited amount and links the original transaction', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 50, type: 'credit:test' });
    const key = `debit-${randomUUID()}`;
    const debited = await debit({ accountId, amount: 20, type: 'spend:video', idempotencyKey: key });

    const refunded = await refund({ originalIdempotencyKey: key });
    expect(refunded).not.toBeNull();
    expect(refunded!.alreadyApplied).toBe(false);
    expect(numericToNumber(refunded!.transaction.amount)).toBe(20);
    expect(refunded!.transaction.type).toBe('refund');
    expect(refunded!.transaction.idempotencyKey).toBe(refundIdempotencyKey(key));
    expect(refunded!.transaction.refundsTransactionId).toBe(debited.transaction.id);
    expect(await getBalance(accountId)).toEqual({ balance: 50, subscriptionBalance: 0, total: 50 });
  });

  it('is idempotent — refunding twice credits once', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 10, type: 'credit:test' });
    const key = `debit-${randomUUID()}`;
    await debit({ accountId, amount: 2, type: 'spend:tts', idempotencyKey: key });

    const first = await refund({ originalIdempotencyKey: key });
    const second = await refund({ originalIdempotencyKey: key });
    expect(first!.alreadyApplied).toBe(false);
    expect(second!.alreadyApplied).toBe(true);
    expect(second!.transaction.id).toBe(first!.transaction.id);
    expect(await getBalance(accountId)).toEqual({ balance: 10, subscriptionBalance: 0, total: 10 });
  });

  it('refunds exactly once under a concurrent race', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 30, type: 'credit:test' });
    const key = `debit-${randomUUID()}`;
    await debit({ accountId, amount: 25, type: 'spend:video', idempotencyKey: key });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => refund({ originalIdempotencyKey: key })),
    );
    expect(results.filter((r) => r && !r.alreadyApplied)).toHaveLength(1);
    expect(await getBalance(accountId)).toEqual({ balance: 30, subscriptionBalance: 0, total: 30 });
  });

  it('returns null when the original debit never happened', async () => {
    expect(await refund({ originalIdempotencyKey: `missing-${randomUUID()}` })).toBeNull();
  });

  it('refuses to refund a credit', async () => {
    const accountId = await makeAccount();
    const key = `credit-${randomUUID()}`;
    await credit({ accountId, amount: 5, type: 'credit:test', idempotencyKey: key });
    await expect(refund({ originalIdempotencyKey: key })).rejects.toThrow(/not a debit/);
  });
});
