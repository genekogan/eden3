import { createHmac } from 'node:crypto';

import { getBalance, resetEnvCache } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import type { StripeCheckoutClient } from '../src/routes/billing';
import {
  deleteFixturesByMarker,
  devCookie,
  insertUserAccount,
  makeMarker,
} from './fixtures';

loadRootEnv();

const marker = makeMarker('billingapi');
const webhookSecret = 'whsec_test_secret';

let userId = '';
let otherUserId = '';
let app: FastifyInstance;
const checkoutCalls: Array<{ params: URLSearchParams; secretKey: string }> = [];

const fakeStripeClient: StripeCheckoutClient = {
  async createCheckoutSession(params, secretKey) {
    checkoutCalls.push({ params: new URLSearchParams(params), secretKey });
    return { id: `cs_test_${checkoutCalls.length}`, url: `https://checkout.stripe.test/${checkoutCalls.length}` };
  },
};

const envKeys = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_MANNA_TOPUP_PRICE_ID',
  'STRIPE_MANNA_TOPUP_AMOUNT',
  'STRIPE_SUBSCRIPTION_BASIC_PRICE_ID',
  'STRIPE_SUBSCRIPTION_BASIC_MONTHLY_MANNA',
  'BILLING_SUCCESS_URL',
  'BILLING_CANCEL_URL',
] as const;
const originalEnv = new Map<string, string | undefined>();

function signPayload(payload: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function postWebhook(event: unknown) {
  const payload = JSON.stringify(event);
  return await app.inject({
    method: 'POST',
    url: '/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signPayload(payload),
    },
    payload,
  });
}

async function ledgerRows(accountId: string) {
  return await pg<Array<{ type: string | null; amount: string; stripe_event_id: string | null; code: string | null }>>`
    select mt.type, mt.amount, mt.stripe_event_id, mt.code
    from manna_transactions mt
    join manna_accounts ma on ma.id = mt.manna_account_id
    where ma.account_id = ${accountId}
    order by mt.created_at asc
  `;
}

beforeAll(async () => {
  for (const key of envKeys) originalEnv.set(key, process.env[key]);
  process.env.STRIPE_SECRET_KEY = 'sk_test_billing';
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  process.env.STRIPE_MANNA_TOPUP_PRICE_ID = 'price_topup';
  process.env.STRIPE_MANNA_TOPUP_AMOUNT = '1234';
  process.env.STRIPE_SUBSCRIPTION_BASIC_PRICE_ID = 'price_basic';
  process.env.STRIPE_SUBSCRIPTION_BASIC_MONTHLY_MANNA = '4321';
  process.env.BILLING_SUCCESS_URL = 'http://localhost:4300/manna?checkout=success';
  process.env.BILLING_CANCEL_URL = 'http://localhost:4300/manna?checkout=cancel';
  resetEnvCache();

  userId = await insertUserAccount(`${marker}_user`);
  otherUserId = await insertUserAccount(`${marker}_other`);
  app = await buildServer({ billing: { stripeClient: fakeStripeClient } });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
  for (const [key, value] of originalEnv.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
});

describe('POST /billing/checkout', () => {
  it('creates a Stripe Checkout session for a manna top-up with account metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: { cookie: devCookie(userId) },
      payload: { kind: 'manna_topup' },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { session: { id: string; url: string } }).session).toMatchObject({
      id: 'cs_test_1',
      url: 'https://checkout.stripe.test/1',
    });
    const call = checkoutCalls.at(-1)!;
    expect(call.secretKey).toBe('sk_test_billing');
    expect(call.params.get('mode')).toBe('payment');
    expect(call.params.get('line_items[0][price]')).toBe('price_topup');
    expect(call.params.get('metadata[accountId]')).toBe(userId);
    expect(call.params.get('metadata[kind]')).toBe('manna_topup');
    expect(call.params.get('metadata[mannaAmount]')).toBe('1234');
  });

  it('creates a Stripe Checkout session for a subscription tier', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: { cookie: devCookie(userId) },
      payload: { kind: 'subscription', tier: 'basic' },
    });

    expect(res.statusCode).toBe(200);
    const call = checkoutCalls.at(-1)!;
    expect(call.params.get('mode')).toBe('subscription');
    expect(call.params.get('line_items[0][price]')).toBe('price_basic');
    expect(call.params.get('subscription_data[metadata][accountId]')).toBe(userId);
    expect(call.params.get('subscription_data[metadata][tier]')).toBe('basic');
    expect(call.params.get('subscription_data[metadata][monthlyManna]')).toBe('4321');
  });
});

describe('GET /billing/subscription', () => {
  it('returns the current subscription summary without Stripe identifiers', async () => {
    await pg`
      insert into billing_subscriptions (
        account_id,
        stripe_customer_id,
        stripe_subscription_id,
        status,
        tier,
        monthly_manna,
        current_period_end,
        cancel_at_period_end
      )
      values (
        ${userId},
        ${`${marker}_customer_hidden`},
        ${`${marker}_subscription_hidden`},
        'active',
        'pro',
        9000,
        ${'2026-08-01T00:00:00.000Z'}::timestamptz,
        true
      )
      on conflict (stripe_subscription_id) do update set updated_at = now()
    `;

    const res = await app.inject({
      method: 'GET',
      url: '/billing/subscription',
      headers: { cookie: devCookie(userId) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      subscription: {
        status: string;
        tier: string;
        monthlyManna: number;
        currentPeriodEnd: string;
        cancelAtPeriodEnd: boolean;
        updatedAt: string;
        stripeSubscriptionId?: string;
        stripeCustomerId?: string;
      };
    };
    expect(body.subscription).toMatchObject({
      status: 'active',
      tier: 'pro',
      monthlyManna: 9000,
      cancelAtPeriodEnd: true,
    });
    expect(new Date(body.subscription.currentPeriodEnd).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(body.subscription.updatedAt).toEqual(expect.any(String));
    expect(body.subscription.stripeSubscriptionId).toBeUndefined();
    expect(body.subscription.stripeCustomerId).toBeUndefined();
  });

  it('returns null when no subscription exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/billing/subscription',
      headers: { cookie: devCookie(otherUserId) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subscription: null });
  });
});

describe('POST /billing/webhook', () => {
  it('credits checkout manna exactly once on signed checkout.session.completed replay', async () => {
    const event = {
      id: `${marker}_evt_checkout`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `${marker}_cs`,
          mode: 'payment',
          payment_status: 'paid',
          client_reference_id: userId,
          metadata: { accountId: userId, mannaAmount: '1234' },
        },
      },
    };

    const first = await postWebhook(event);
    const second = await postWebhook(event);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ received: true, action: 'manna_credited', alreadyApplied: false });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ received: true, action: 'manna_credited', alreadyApplied: true });
    expect(await getBalance(userId)).toMatchObject({ balance: 1234 });
    const stripeRows = (await ledgerRows(userId)).filter((row) => row.stripe_event_id === event.id);
    expect(stripeRows).toHaveLength(1);
    expect(stripeRows[0]).toMatchObject({ type: 'credit:stripe', amount: '1234.0000' });
  });

  it('grants subscription manna to the subscription pot and records subscription state', async () => {
    const event = {
      id: `${marker}_evt_invoice`,
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: `${marker}_in`,
          customer: `${marker}_cus`,
          subscription: `${marker}_sub`,
          metadata: { accountId: userId, tier: 'basic', monthlyManna: '4321' },
        },
      },
    };

    const first = await postWebhook(event);
    const replay = await postWebhook(event);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      received: true,
      action: 'subscription_manna_credited',
      alreadyApplied: false,
    });
    expect(replay.json()).toMatchObject({ alreadyApplied: true });
    expect(await getBalance(userId)).toMatchObject({ subscriptionBalance: 4321 });
    const [sub] = await pg<Array<{ status: string; tier: string; monthly_manna: number }>>`
      select status, tier, monthly_manna
      from billing_subscriptions
      where stripe_subscription_id = ${`${marker}_sub`}
    `;
    expect(sub).toMatchObject({ status: 'active', tier: 'basic', monthly_manna: 4321 });
  });

  it('credits subscription upgrade proration from invoice metadata', async () => {
    const event = {
      id: `${marker}_evt_proration`,
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: `${marker}_in_proration`,
          customer: `${marker}_cus`,
          subscription: `${marker}_sub_proration`,
          metadata: { accountId: userId, tier: 'pro', prorationManna: '321' },
        },
      },
    };

    const before = await getBalance(userId);
    const res = await postWebhook(event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      received: true,
      action: 'subscription_manna_credited',
      alreadyApplied: false,
    });
    expect(await getBalance(userId)).toMatchObject({
      subscriptionBalance: before.subscriptionBalance + 321,
    });
    const stripeRows = (await ledgerRows(userId)).filter((row) => row.stripe_event_id === event.id);
    expect(stripeRows).toHaveLength(1);
    expect(stripeRows[0]).toMatchObject({ type: 'credit:subscription', amount: '321.0000' });
  });

  it('updates subscription tier/monthly manna on downgrade without crediting manna', async () => {
    const event = {
      id: `${marker}_evt_downgrade`,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: `${marker}_sub_proration`,
          customer: `${marker}_cus`,
          status: 'active',
          cancel_at_period_end: true,
          current_period_end: 1_800_000_000,
          metadata: { accountId: userId, tier: 'basic', monthlyManna: '4321' },
        },
      },
    };

    const before = await ledgerRows(userId);
    const res = await postWebhook(event);
    const after = await ledgerRows(userId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: 'subscription_updated' });
    expect(after).toHaveLength(before.length);
    const [sub] = await pg<
      Array<{ status: string; tier: string; monthly_manna: number; cancel_at_period_end: boolean }>
    >`
      select status, tier, monthly_manna, cancel_at_period_end
      from billing_subscriptions
      where stripe_subscription_id = ${`${marker}_sub_proration`}
    `;
    expect(sub).toMatchObject({
      status: 'active',
      tier: 'basic',
      monthly_manna: 4321,
      cancel_at_period_end: true,
    });
  });

  it('updates subscription status on cancel without crediting manna', async () => {
    const event = {
      id: `${marker}_evt_cancel`,
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: `${marker}_sub`,
          customer: `${marker}_cus`,
          status: 'canceled',
          metadata: { accountId: userId, tier: 'basic', monthlyManna: '4321' },
        },
      },
    };

    const before = await ledgerRows(userId);
    const res = await postWebhook(event);
    const after = await ledgerRows(userId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: 'subscription_updated' });
    expect(after).toHaveLength(before.length);
    const [sub] = await pg<Array<{ status: string }>>`
      select status from billing_subscriptions where stripe_subscription_id = ${`${marker}_sub`}
    `;
    expect(sub?.status).toBe('canceled');
  });

  it('ignores an out-of-order older subscription event (no resurrection after cancel)', async () => {
    const subId = `${marker}_sub_order`;
    const base = {
      customer: `${marker}_cus`,
      metadata: { accountId: userId, tier: 'basic', monthlyManna: '4321' },
    };

    // Newest state first: canceled at t=2000.
    const cancel = await postWebhook({
      id: `${marker}_evt_order_cancel`,
      type: 'customer.subscription.deleted',
      created: 2000,
      data: { object: { ...base, id: subId, status: 'canceled' } },
    });
    expect(cancel.statusCode).toBe(200);

    // A stale `updated` from t=1000 arrives late — it must NOT win.
    const stale = await postWebhook({
      id: `${marker}_evt_order_stale`,
      type: 'customer.subscription.updated',
      created: 1000,
      data: { object: { ...base, id: subId, status: 'active' } },
    });
    expect(stale.statusCode).toBe(200);

    const [afterStale] = await pg<Array<{ status: string }>>`
      select status from billing_subscriptions where stripe_subscription_id = ${subId}
    `;
    expect(afterStale?.status).toBe('canceled');

    // A genuinely newer event still applies.
    const newer = await postWebhook({
      id: `${marker}_evt_order_newer`,
      type: 'customer.subscription.updated',
      created: 3000,
      data: { object: { ...base, id: subId, status: 'active' } },
    });
    expect(newer.statusCode).toBe(200);
    const [afterNewer] = await pg<Array<{ status: string }>>`
      select status from billing_subscriptions where stripe_subscription_id = ${subId}
    `;
    expect(afterNewer?.status).toBe('active');
  });

  it('rejects bad signatures before handling the event', async () => {
    const payload = JSON.stringify({ id: `${marker}_bad`, type: 'checkout.session.completed', data: { object: {} } });
    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('bad_signature');
  });
});

describe('POST /billing/vouchers/redeem', () => {
  it('redeems a voucher once per user without double-crediting replay', async () => {
    const code = `${marker}_voucher`;
    await pg`
      insert into manna_vouchers (code, amount, max_redemptions)
      values (${code}, 777, 1)
    `;

    const first = await app.inject({
      method: 'POST',
      url: '/billing/vouchers/redeem',
      headers: { cookie: devCookie(userId) },
      payload: { code },
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/billing/vouchers/redeem',
      headers: { cookie: devCookie(userId) },
      payload: { code },
    });
    const exhausted = await app.inject({
      method: 'POST',
      url: '/billing/vouchers/redeem',
      headers: { cookie: devCookie(otherUserId) },
      payload: { code },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ amount: 777, alreadyApplied: false });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ amount: 777, alreadyApplied: true });
    expect(exhausted.statusCode).toBe(400);
    expect((exhausted.json() as { error: { code: string } }).error.code).toBe('voucher_exhausted');
    const voucherRows = (await ledgerRows(userId)).filter((row) => row.code === code);
    expect(voucherRows).toHaveLength(1);
    expect(voucherRows[0]).toMatchObject({ type: 'credit:voucher', amount: '777.0000' });
  });

  it('handles a concurrent same-user redeem burst: one credit, one counted redemption', async () => {
    const code = `${marker}_voucher_race`;
    await pg`
      insert into manna_vouchers (code, amount, max_redemptions)
      values (${code}, 555, 5)
    `;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: 'POST',
          url: '/billing/vouchers/redeem',
          headers: { cookie: devCookie(userId) },
          payload: { code },
        }),
      ),
    );

    for (const res of responses) expect(res.statusCode).toBe(200);
    const applied = responses.filter(
      (res) => (res.json() as { alreadyApplied: boolean }).alreadyApplied === false,
    );
    expect(applied).toHaveLength(1);

    // Exactly one ledger credit AND exactly one redemption slot consumed —
    // the pre-fix behavior burned a slot per racing request.
    const voucherRows = (await ledgerRows(userId)).filter((row) => row.code === code);
    expect(voucherRows).toHaveLength(1);
    const [voucher] = await pg<{ redeemed_count: number }[]>`
      select redeemed_count from manna_vouchers where code = ${code}
    `;
    expect(voucher?.redeemed_count).toBe(1);
  });

  it('rejects expired vouchers', async () => {
    const code = `${marker}_expired`;
    await pg`
      insert into manna_vouchers (code, amount, expires_at)
      values (${code}, 100, now() - interval '1 day')
    `;

    const res = await app.inject({
      method: 'POST',
      url: '/billing/vouchers/redeem',
      headers: { cookie: devCookie(userId) },
      payload: { code },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('voucher_expired');
  });

  it('rejects unknown voucher codes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/billing/vouchers/redeem',
      headers: { cookie: devCookie(userId) },
      payload: { code: `${marker}_missing` },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('voucher_not_found');
  });
});
