import { randomUUID } from 'node:crypto';

import { accounts, db, mannaAccounts, mannaTransactions, pg } from '@eden3/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DailyCapExceededError,
  InsufficientMannaError,
  PRICING,
  RollingSpendCapExceededError,
  credit,
  debit,
  getBalance,
  getOrCreateMannaAccount,
  numberToNumeric,
  numericToNumber,
  refund,
  refundIdempotencyKey,
  scopedLedgerIdempotencyKey,
  scopedNetSpendSince,
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

describe('debit dailyCap (Q7 per-day ceiling, race-free)', () => {
  it('allows spends under the cap and rejects the one that would cross it, writing nothing', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 1_000, type: 'credit:test' });

    await debit({
      accountId,
      amount: 200,
      type: 'spend:image',
      idempotencyKey: `cap-${randomUUID()}`,
      dailyCap: { limit: 300 },
    });
    await expect(
      debit({
        accountId,
        amount: 150,
        type: 'spend:image',
        idempotencyKey: `cap-${randomUUID()}`,
        dailyCap: { limit: 300 },
      }),
    ).rejects.toMatchObject({
      name: 'DailyCapExceededError',
      spentToday: 200,
      requested: 150,
      cap: 300,
    });

    // The rejected debit left no ledger row and took no manna.
    expect(await getBalance(accountId)).toEqual({
      balance: 800,
      subscriptionBalance: 0,
      total: 800,
    });
    const rows = await ledgerRowsFor(accountId);
    expect(rows.filter((r) => r.type === 'spend:image')).toHaveLength(1);
  });

  it('counts refunds back into the day’s headroom', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 1_000, type: 'credit:test' });
    const key = `cap-${randomUUID()}`;

    await debit({
      accountId,
      amount: 250,
      type: 'spend:video',
      idempotencyKey: key,
      dailyCap: { limit: 300 },
    });
    await refund({ originalIdempotencyKey: key, type: 'refund:video' });

    // 250 spent then refunded -> net 0 today; a fresh 250 fits again.
    const again = await debit({
      accountId,
      amount: 250,
      type: 'spend:video',
      idempotencyKey: `cap-${randomUUID()}`,
      dailyCap: { limit: 300 },
    });
    expect(again.alreadyApplied).toBe(false);
  });

  it('never lets concurrent debits collectively exceed the cap (advisory-lock serialization)', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 1_000, type: 'credit:test' });

    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        debit({
          accountId,
          amount: 100,
          type: 'spend:image',
          idempotencyKey: `cap-${randomUUID()}`,
          dailyCap: { limit: 300 },
        }),
      ),
    );

    const ok = settled.filter((s) => s.status === 'fulfilled');
    const failed = settled.filter((s) => s.status === 'rejected');
    expect(ok).toHaveLength(3); // 300-cap admits exactly three 100-manna spends
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toMatchObject({
        name: 'DailyCapExceededError',
      });
    }
    expect(await getBalance(accountId)).toEqual({
      balance: 700,
      subscriptionBalance: 0,
      total: 700,
    });
  });

  it('replays an applied key untouched even when the cap is exhausted', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 1_000, type: 'credit:test' });
    const key = `cap-${randomUUID()}`;

    await debit({
      accountId,
      amount: 300,
      type: 'spend:image',
      idempotencyKey: key,
      dailyCap: { limit: 300 },
    });
    // Cap fully consumed — but replaying the SAME key is a read, not a spend.
    const replay = await debit({
      accountId,
      amount: 300,
      type: 'spend:image',
      idempotencyKey: key,
      dailyCap: { limit: 300 },
    });
    expect(replay.alreadyApplied).toBe(true);
  });

  it('CONCURRENT same-key replay at the cap edge returns the tx, never a spurious 429', async () => {
    // The debit amount alone fits the cap, but two concurrent debits with the
    // SAME key must collapse to one applied charge — the loser of the lock
    // race must re-read the key and return alreadyApplied, NOT throw
    // DailyCapExceededError because the winner's spend now fills the cap.
    const accountId = await makeAccount();
    await credit({ accountId, amount: 1_000, type: 'credit:test' });
    const key = `cap-${randomUUID()}`;

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        debit({
          accountId,
          amount: 300,
          type: 'spend:image',
          idempotencyKey: key,
          dailyCap: { limit: 300 },
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(4); // none threw
    const applied = fulfilled.filter(
      (r) => !(r as PromiseFulfilledResult<{ alreadyApplied: boolean }>).value.alreadyApplied,
    );
    expect(applied).toHaveLength(1); // exactly one real charge
    // Exactly one ledger row for the key; only 300 spent.
    const rows = (await ledgerRowsFor(accountId)).filter((r) => r.idempotencyKey === key);
    expect(rows).toHaveLength(1);
    expect((await getBalance(accountId)).total).toBe(700);
  });

  it('does not let a current refund of an older debit erase current-day spend', async () => {
    const accountId = await makeAccount();
    await credit({ accountId, amount: 1_000, type: 'credit:test' });
    const oldKey = `old-cap-${randomUUID()}`;
    const old = await debit({
      accountId,
      amount: 80,
      type: 'spend:chat',
      idempotencyKey: oldKey,
    });
    await db
      .update(mannaTransactions)
      .set({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
      .where(eq(mannaTransactions.id, old.transaction.id));
    await refund({ originalIdempotencyKey: oldKey, type: 'refund:chat' });

    await debit({
      accountId,
      amount: 80,
      type: 'spend:chat',
      idempotencyKey: `today-cap-${randomUUID()}`,
      dailyCap: { limit: 80 },
    });
    await expect(
      debit({
        accountId,
        amount: 1,
        type: 'spend:chat',
        idempotencyKey: `today-over-${randomUUID()}`,
        dailyCap: { limit: 80 },
      }),
    ).rejects.toBeInstanceOf(DailyCapExceededError);
  });
});

describe('debit rollingCap (scoped, race-free)', () => {
  it('never lets adversarial concurrent debits collectively exceed the rolling cap', async () => {
    const accountId = await makeAccount();
    const scopeId = randomUUID();
    await credit({ accountId, amount: 1_000, type: 'credit:test' });
    const rollingCap = {
      scope: 'automation',
      scopeId,
      limit: 80,
      windowMs: 60 * 60 * 1000,
    };

    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        debit({
          accountId,
          amount: 30,
          type: 'spend:chat',
          idempotencyKey: scopedLedgerIdempotencyKey('automation', scopeId, randomUUID()),
          rollingCap,
        }),
      ),
    );

    const ok = settled.filter((result) => result.status === 'fulfilled');
    const failed = settled.filter((result) => result.status === 'rejected');
    expect(ok).toHaveLength(2);
    expect(failed).toHaveLength(8);
    for (const result of failed) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
        RollingSpendCapExceededError,
      );
    }
    expect(
      await scopedNetSpendSince(
        'automation',
        scopeId,
        new Date(Date.now() - 60 * 60 * 1000),
      ),
    ).toBe(60);
    expect((await getBalance(accountId)).total).toBe(940);
  });

  it('uses linked refunds to release headroom without a window-boundary undercount', async () => {
    const accountId = await makeAccount();
    const scopeId = randomUUID();
    const firstKey = scopedLedgerIdempotencyKey('automation', scopeId, randomUUID());
    const rollingCap = {
      scope: 'automation',
      scopeId,
      limit: 80,
      windowMs: 60 * 60 * 1000,
    };
    await credit({ accountId, amount: 1_000, type: 'credit:test' });
    const first = await debit({
      accountId,
      amount: 80,
      type: 'spend:chat',
      idempotencyKey: firstKey,
      rollingCap,
    });
    await refund({ originalIdempotencyKey: firstKey, type: 'refund:chat' });
    // Age only the original out of the rolling window. A naive
    // transaction-created-at sum would still count the newer refund and let
    // it offset unrelated current work.
    await db
      .update(mannaTransactions)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(mannaTransactions.id, first.transaction.id));

    expect(
      await scopedNetSpendSince(
        'automation',
        scopeId,
        new Date(Date.now() - 60 * 60 * 1000),
      ),
    ).toBe(0);
    await expect(
      debit({
        accountId,
        amount: 80,
        type: 'spend:chat',
        idempotencyKey: scopedLedgerIdempotencyKey('automation', scopeId, randomUUID()),
        rollingCap,
      }),
    ).resolves.toMatchObject({ alreadyApplied: false });
    expect(
      await scopedNetSpendSince(
        'automation',
        scopeId,
        new Date(Date.now() - 60 * 60 * 1000),
      ),
    ).toBe(80);
    await expect(
      debit({
        accountId,
        amount: 1,
        type: 'spend:chat',
        idempotencyKey: scopedLedgerIdempotencyKey('automation', scopeId, randomUUID()),
        rollingCap,
      }),
    ).rejects.toBeInstanceOf(RollingSpendCapExceededError);
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
