import { credit, debit } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { MannaTransactionDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  deleteFixturesByMarker,
  devCookie,
  insertUserAccount,
  makeMarker,
} from './fixtures';

loadRootEnv();

/** Manna balance + ledger endpoints against live Postgres (@eden3/core ledger). */

const marker = makeMarker('manapi');
let richId = '';
let brokeId = '';

let app: FastifyInstance;

interface BalanceBody {
  accountId: string;
  balance: number;
  subscriptionBalance: number;
  updatedAt: string;
}
interface LedgerBody {
  items: MannaTransactionDto[];
  nextCursor: string | null;
}

beforeAll(async () => {
  richId = await insertUserAccount(`${marker}_rich`);
  brokeId = await insertUserAccount(`${marker}_broke`);
  await credit({
    accountId: richId,
    amount: 100,
    type: 'credit_test',
    idempotencyKey: `${marker}:credit`,
  });
  await credit({
    accountId: richId,
    amount: 40,
    type: 'credit_subscription_test',
    idempotencyKey: `${marker}:sub`,
    toSubscriptionBalance: true,
  });
  await debit({
    accountId: richId,
    amount: 15,
    type: 'spend_test',
    idempotencyKey: `${marker}:debit`,
  });

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('GET /manna', () => {
  it('401s anonymous requests', async () => {
    expect((await app.inject({ method: 'GET', url: '/manna' })).statusCode).toBe(401);
  });

  it('reports both pots for the signed-in account', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/manna',
      headers: { cookie: devCookie(richId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BalanceBody;
    expect(body.accountId).toBe(richId);
    // 100 durable + 40 subscription - 15 spend (subscription pot drains first)
    expect(body.subscriptionBalance).toBe(25);
    expect(body.balance).toBe(100);
    expect(new Date(body.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('reports zeros for accounts without a manna row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/manna',
      headers: { cookie: devCookie(brokeId) },
    });
    const body = res.json() as BalanceBody;
    expect(body.balance).toBe(0);
    expect(body.subscriptionBalance).toBe(0);
  });
});

describe('GET /manna/transactions', () => {
  it('401s anonymous requests', async () => {
    expect((await app.inject({ method: 'GET', url: '/manna/transactions' })).statusCode).toBe(401);
  });

  it('lists the ledger newest-first with signed amounts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/manna/transactions',
      headers: { cookie: devCookie(richId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LedgerBody;
    expect(body.items).toHaveLength(3);
    expect(body.items.map((t) => t.type)).toEqual([
      'spend_test',
      'credit_subscription_test',
      'credit_test',
    ]);
    expect(body.items.map((t) => t.amount)).toEqual([-15, 40, 100]);
    expect(body.nextCursor).toBeNull();
  });

  it('paginates with the keyset cursor', async () => {
    const page1 = (
      await app.inject({
        method: 'GET',
        url: '/manna/transactions?limit=2',
        headers: { cookie: devCookie(richId) },
      })
    ).json() as LedgerBody;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (
      await app.inject({
        method: 'GET',
        url: `/manna/transactions?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        headers: { cookie: devCookie(richId) },
      })
    ).json() as LedgerBody;
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.items, ...page2.items].map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('is empty for accounts with no ledger', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/manna/transactions',
      headers: { cookie: devCookie(brokeId) },
    });
    expect((res.json() as LedgerBody).items).toEqual([]);
  });
});
