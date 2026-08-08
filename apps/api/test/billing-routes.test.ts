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
let testStripeCreated = 10_000;
const checkoutCalls: Array<{ params: URLSearchParams; secretKey: string }> = [];
const checkoutLineItems = new Map<string, Array<{ priceId: string; quantity: number }>>();

const fakeStripeClient: StripeCheckoutClient = {
  async createCheckoutSession(params, secretKey) {
    checkoutCalls.push({ params: new URLSearchParams(params), secretKey });
    return { id: `cs_test_${checkoutCalls.length}`, url: `https://checkout.stripe.test/${checkoutCalls.length}` };
  },
  async retrieveCheckoutSessionLineItems(sessionId) {
    return checkoutLineItems.get(sessionId) ?? [];
  },
};

const envKeys = [
  'STRIPE_MODE',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_MANNA_TOPUP_PRICE_ID',
  'STRIPE_MANNA_TOPUP_AMOUNT',
  'STRIPE_SUBSCRIPTION_BASIC_PRICE_ID',
  'STRIPE_SUBSCRIPTION_BASIC_MONTHLY_MANNA',
  'STRIPE_SUBSCRIPTION_PRO_PRICE_ID',
  'STRIPE_SUBSCRIPTION_PRO_MONTHLY_MANNA',
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

async function postWebhookTo(target: FastifyInstance, event: unknown) {
  const payload = JSON.stringify(
    event !== null && typeof event === 'object' && !Array.isArray(event)
      ? { livemode: false, created: testStripeCreated++, ...event }
      : event,
  );
  return await target.inject({
    method: 'POST',
    url: '/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signPayload(payload),
    },
    payload,
  });
}

async function postWebhook(event: unknown) {
  return await postWebhookTo(app, event);
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
  process.env.STRIPE_MODE = 'test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_billing';
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  process.env.STRIPE_MANNA_TOPUP_PRICE_ID = 'price_topup';
  process.env.STRIPE_MANNA_TOPUP_AMOUNT = '1234';
  process.env.STRIPE_SUBSCRIPTION_BASIC_PRICE_ID = 'price_basic';
  process.env.STRIPE_SUBSCRIPTION_BASIC_MONTHLY_MANNA = '4321';
  process.env.STRIPE_SUBSCRIPTION_PRO_PRICE_ID = 'price_pro';
  process.env.STRIPE_SUBSCRIPTION_PRO_MONTHLY_MANNA = '8765';
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
    checkoutLineItems.set(`${marker}_cs`, [{ priceId: 'price_topup', quantity: 1 }]);
    const event = {
      id: `${marker}_evt_checkout`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `${marker}_cs`,
          mode: 'payment',
          payment_status: 'paid',
          client_reference_id: userId,
          metadata: { accountId: userId, kind: 'manna_topup', mannaAmount: '1234' },
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

  it('credits one checkout object once across concurrent distinct event ids and ignores amount metadata', async () => {
    checkoutLineItems.set(`${marker}_cs_semantic`, [{ priceId: 'price_topup', quantity: 1 }]);
    const before = await getBalance(userId);
    const object = {
      id: `${marker}_cs_semantic`,
      mode: 'payment',
      payment_status: 'paid',
      client_reference_id: userId,
      metadata: { accountId: userId, kind: 'manna_topup', mannaAmount: '999999' },
    };
    const responses = await Promise.all([
      postWebhook({ id: `${marker}_evt_semantic_a`, type: 'checkout.session.completed', data: { object } }),
      postWebhook({ id: `${marker}_evt_semantic_b`, type: 'checkout.session.completed', data: { object } }),
    ]);

    for (const response of responses) expect(response.statusCode).toBe(200);
    expect(responses.filter((response) => response.json().alreadyApplied === false)).toHaveLength(1);
    expect((await getBalance(userId)).balance - before.balance).toBe(1234);
    const semanticRows = (await ledgerRows(userId)).filter((row) =>
      [`${marker}_evt_semantic_a`, `${marker}_evt_semantic_b`].includes(row.stripe_event_id ?? ''),
    );
    expect(semanticRows).toHaveLength(1);
    expect(semanticRows[0]?.amount).toBe('1234.0000');
  });

  it('durably binds a payment-only Stripe customer to one account across sessions', async () => {
    const customerId = `${marker}_cus_payment_only`;
    for (const sessionId of [`${marker}_cs_customer_owner`, `${marker}_cs_customer_rebind`]) {
      checkoutLineItems.set(sessionId, [{ priceId: 'price_topup', quantity: 1 }]);
    }
    const first = await postWebhook({
      id: `${marker}_evt_customer_owner`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `${marker}_cs_customer_owner`,
          mode: 'payment',
          payment_status: 'paid',
          customer: customerId,
          client_reference_id: userId,
          metadata: { accountId: userId, kind: 'manna_topup' },
        },
      },
    });
    expect(first.statusCode).toBe(200);
    const beforeOther = await getBalance(otherUserId);
    const conflict = await postWebhook({
      id: `${marker}_evt_customer_rebind`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `${marker}_cs_customer_rebind`,
          mode: 'payment',
          payment_status: 'paid',
          customer: customerId,
          client_reference_id: otherUserId,
          metadata: { accountId: otherUserId, kind: 'manna_topup' },
        },
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe('stripe_binding_mismatch');
    expect(await getBalance(otherUserId)).toEqual(beforeOther);
  });

  it('rejects conflicting checkout account claims before credit', async () => {
    const before = await getBalance(userId);
    const res = await postWebhook({
      id: `${marker}_evt_checkout_conflict`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `${marker}_cs_conflict`,
          mode: 'payment',
          payment_status: 'paid',
          client_reference_id: otherUserId,
          metadata: { accountId: userId, kind: 'manna_topup' },
        },
      },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('stripe_binding_mismatch');
    expect(await getBalance(userId)).toEqual(before);
  });

  it('rejects a paid checkout whose authoritative line item is not the configured top-up price', async () => {
    const sessionId = `${marker}_cs_wrong_price`;
    checkoutLineItems.set(sessionId, [{ priceId: 'price_unrelated', quantity: 1 }]);
    const before = await getBalance(userId);
    const res = await postWebhook({
      id: `${marker}_evt_checkout_wrong_price`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          mode: 'payment',
          payment_status: 'paid',
          client_reference_id: userId,
          metadata: { accountId: userId, kind: 'manna_topup' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('stripe_binding_mismatch');
    expect(await getBalance(userId)).toEqual(before);
  });

  it.each([
    [[{ priceId: 'price_topup', quantity: 2 }], 'wrong quantity'],
    [[
      { priceId: 'price_topup', quantity: 1 },
      { priceId: 'price_unrelated', quantity: 1 },
    ], 'additional line'],
  ] as const)('rejects top-up checkout with %s', async (lineItems, suffix) => {
    const sessionId = `${marker}_cs_${suffix.replaceAll(' ', '_')}`;
    checkoutLineItems.set(sessionId, [...lineItems]);
    const before = await getBalance(userId);
    const res = await postWebhook({
      id: `${marker}_evt_${suffix.replaceAll(' ', '_')}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          mode: 'payment',
          payment_status: 'paid',
          customer: `${marker}_cus_topup_shape`,
          client_reference_id: userId,
          metadata: { accountId: userId, kind: 'manna_topup' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('stripe_binding_mismatch');
    expect(await getBalance(userId)).toEqual(before);
  });

  it('leaves subscription checkout completion side-effect-free until an authoritative webhook arrives', async () => {
    const subscriptionId = `${marker}_sub_checkout_untrusted`;
    const res = await postWebhook({
      id: `${marker}_evt_checkout_subscription`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `${marker}_cs_subscription`,
          mode: 'subscription',
          customer: `${marker}_cus_checkout_untrusted`,
          subscription: subscriptionId,
          client_reference_id: userId,
          metadata: { accountId: userId, kind: 'subscription', tier: 'pro' },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: 'subscription_checkout_awaiting_provider' });
    const [row] = await pg<Array<{ count: number }>>`
      select count(*)::int as count from billing_subscriptions
      where stripe_subscription_id = ${subscriptionId}
    `;
    expect(row?.count).toBe(0);
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
          billing_reason: 'subscription_cycle',
          lines: { data: [{ price: { id: 'price_basic' }, quantity: 1, period: { end: 1_800_000_000 } }] },
          metadata: { accountId: userId, tier: 'basic', monthlyManna: '999999' },
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
    const [sub] = await pg<Array<{ status: string; tier: string; monthly_manna: number; current_period_end: Date }>>`
      select status, tier, monthly_manna, current_period_end
      from billing_subscriptions
      where stripe_subscription_id = ${`${marker}_sub`}
    `;
    expect(sub).toMatchObject({ status: 'active', tier: 'basic', monthly_manna: 4321 });
    expect(new Date(sub!.current_period_end).toISOString()).toBe('2027-01-15T08:00:00.000Z');
  });

  it.each([
    { suffix: 'quantity', data: [{ price: { id: 'price_basic' }, quantity: 2 }] },
    {
      suffix: 'extra',
      data: [
        { price: { id: 'price_basic' }, quantity: 1 },
        { price: { id: 'price_unrelated' }, quantity: 1 },
      ],
    },
  ])('rejects an invoice without exactly one configured price at quantity one: $suffix', async ({ suffix, data }) => {
    const before = await getBalance(userId);
    const res = await postWebhook({
      id: `${marker}_evt_invoice_shape_${suffix}`,
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: `${marker}_in_shape_${suffix}`,
          customer: `${marker}_cus_shape_${suffix}`,
          subscription: `${marker}_sub_shape_${suffix}`,
          billing_reason: 'subscription_cycle',
          lines: { data },
          metadata: { accountId: userId, tier: 'basic' },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('bad_event');
    expect(await getBalance(userId)).toEqual(before);
  });

  it('credits one paid invoice once across concurrent distinct event ids', async () => {
    const before = await getBalance(userId);
    const object = {
      id: `${marker}_in_semantic`,
      customer: `${marker}_cus_semantic`,
      subscription: `${marker}_sub_semantic`,
      billing_reason: 'subscription_cycle',
      lines: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
      metadata: { accountId: userId, tier: 'basic', monthlyManna: '999999' },
    };
    const responses = await Promise.all([
      postWebhook({ id: `${marker}_evt_invoice_semantic_a`, type: 'invoice.payment_succeeded', data: { object } }),
      postWebhook({ id: `${marker}_evt_invoice_semantic_b`, type: 'invoice.payment_succeeded', data: { object } }),
    ]);

    for (const response of responses) expect(response.statusCode).toBe(200);
    expect(responses.filter((response) => response.json().alreadyApplied === false)).toHaveLength(1);
    expect((await getBalance(userId)).subscriptionBalance - before.subscriptionBalance).toBe(4321);

    const restarted = await buildServer({ billing: { stripeClient: fakeStripeClient } });
    await restarted.ready();
    try {
      const replay = await postWebhookTo(restarted, {
        id: `${marker}_evt_invoice_semantic_restart`,
        type: 'invoice.payment_succeeded',
        data: { object },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ alreadyApplied: true });
    } finally {
      await restarted.close();
    }
  });

  it('rejects a conflicting duplicate invoice before mutating subscription state in both arrival orders', async () => {
    const invoiceIdA = `${marker}_in_payload_a`;
    const originalA = {
      id: invoiceIdA,
      customer: `${marker}_cus_payload_a`,
      subscription: `${marker}_sub_payload_a`,
      billing_reason: 'subscription_cycle',
      lines: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
      metadata: { accountId: userId, tier: 'basic' },
    };
    expect((await postWebhook({
      id: `${marker}_evt_payload_a_first`,
      type: 'invoice.payment_succeeded',
      data: { object: originalA },
    })).statusCode).toBe(200);
    const conflictA = await postWebhook({
      id: `${marker}_evt_payload_a_conflict`,
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          ...originalA,
          customer: `${marker}_cus_payload_a_changed`,
          subscription: `${marker}_sub_payload_a_changed`,
        },
      },
    });
    expect(conflictA.statusCode).toBe(409);

    const invoiceIdB = `${marker}_in_payload_b`;
    const firstB = {
      id: invoiceIdB,
      customer: `${marker}_cus_payload_b_changed_first`,
      subscription: `${marker}_sub_payload_b_changed_first`,
      billing_reason: 'subscription_cycle',
      lines: { data: [{ price: { id: 'price_pro' }, quantity: 1 }] },
      metadata: { accountId: userId, tier: 'pro' },
    };
    expect((await postWebhook({
      id: `${marker}_evt_payload_b_first`,
      type: 'invoice.payment_succeeded',
      data: { object: firstB },
    })).statusCode).toBe(200);
    const conflictB = await postWebhook({
      id: `${marker}_evt_payload_b_conflict`,
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          ...firstB,
          customer: `${marker}_cus_payload_b`,
          subscription: `${marker}_sub_payload_b`,
          lines: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
          metadata: { accountId: userId, tier: 'basic' },
        },
      },
    });
    expect(conflictB.statusCode).toBe(409);

    const rows = await pg<Array<{ stripe_subscription_id: string; tier: string; monthly_manna: number }>>`
      select stripe_subscription_id, tier, monthly_manna from billing_subscriptions
      where stripe_subscription_id like ${`${marker}_sub_payload_%`}
      order by stripe_subscription_id
    `;
    expect(rows).toEqual([
      {
        stripe_subscription_id: `${marker}_sub_payload_a`,
        tier: 'basic',
        monthly_manna: 4321,
      },
      {
        stripe_subscription_id: `${marker}_sub_payload_b_changed_first`,
        tier: 'pro',
        monthly_manna: 8765,
      },
    ]);
  });

  it('rejects subscription and customer rebinding across tenants', async () => {
    const baseBalance = await getBalance(otherUserId);
    const sameSubscription = await postWebhook({
      id: `${marker}_evt_rebind_subscription`,
      type: 'customer.subscription.updated',
      created: 4_000,
      data: {
        object: {
          id: `${marker}_sub`,
          customer: `${marker}_cus`,
          status: 'active',
          items: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
          metadata: { accountId: otherUserId, tier: 'basic' },
        },
      },
    });
    expect(sameSubscription.statusCode).toBe(409);
    expect((sameSubscription.json() as { error: { code: string } }).error.code).toBe(
      'stripe_binding_mismatch',
    );

    const sameCustomer = await postWebhook({
      id: `${marker}_evt_rebind_customer`,
      type: 'customer.subscription.created',
      created: 4_001,
      data: {
        object: {
          id: `${marker}_sub_other`,
          customer: `${marker}_cus`,
          status: 'active',
          items: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
          metadata: { accountId: otherUserId, tier: 'basic' },
        },
      },
    });
    expect(sameCustomer.statusCode).toBe(409);
    expect((sameCustomer.json() as { error: { code: string } }).error.code).toBe(
      'stripe_binding_mismatch',
    );
    expect(await getBalance(otherUserId)).toEqual(baseBalance);
    const [bound] = await pg<Array<{ account_id: string; stripe_customer_id: string | null }>>`
      select account_id, stripe_customer_id
      from billing_subscriptions
      where stripe_subscription_id = ${`${marker}_sub`}
    `;
    expect(bound).toMatchObject({ account_id: userId, stripe_customer_id: `${marker}_cus` });
  });

  it('rejects a metadata tier that disagrees with the configured Stripe price', async () => {
    const before = await getBalance(userId);
    const res = await postWebhook({
      id: `${marker}_evt_tier_mismatch`,
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: `${marker}_in_tier_mismatch`,
          customer: `${marker}_cus_tier_mismatch`,
          subscription: `${marker}_sub_tier_mismatch`,
          billing_reason: 'subscription_cycle',
          lines: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
          metadata: { accountId: userId, tier: 'pro' },
        },
      },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('stripe_binding_mismatch');
    expect(await getBalance(userId)).toEqual(before);
  });

  it('does not trust webhook metadata to mint subscription upgrade proration', async () => {
    const event = {
      id: `${marker}_evt_proration`,
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: `${marker}_in_proration`,
          customer: `${marker}_cus`,
          subscription: `${marker}_sub_proration`,
          billing_reason: 'subscription_update',
          lines: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
          metadata: { accountId: userId, tier: 'pro', prorationManna: '321' },
        },
      },
    };

    const before = await getBalance(userId);
    const res = await postWebhook(event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      received: true,
      action: 'subscription_proration_ignored',
    });
    expect(await getBalance(userId)).toEqual(before);
    const stripeRows = (await ledgerRows(userId)).filter((row) => row.stripe_event_id === event.id);
    expect(stripeRows).toHaveLength(0);
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
          items: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
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
          items: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
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
      items: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
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

  it('converges equal-second tier and status ties to the conservative entitlement in both orders', async () => {
    const sameSecond = 9_000;
    for (const order of ['high-first', 'low-first'] as const) {
      const subId = `${marker}_sub_tie_tier_${order}`;
      const customerId = `${marker}_cus_tie_tier_${order}`;
      const pro = {
        id: subId,
        customer: customerId,
        status: 'active',
        items: { data: [{ price: { id: 'price_pro' }, quantity: 1 }] },
        metadata: { accountId: userId, tier: 'pro' },
      };
      const basic = {
        ...pro,
        items: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
        metadata: { accountId: userId, tier: 'basic' },
      };
      const objects = order === 'high-first' ? [pro, basic] : [basic, pro];
      for (const [index, object] of objects.entries()) {
        const response = await postWebhook({
          id: `${marker}_evt_tie_tier_${order}_${index}`,
          type: 'customer.subscription.updated',
          created: sameSecond,
          data: { object },
        });
        expect(response.statusCode).toBe(200);
      }
      const [row] = await pg<Array<{ status: string; tier: string; monthly_manna: number }>>`
        select status, tier, monthly_manna from billing_subscriptions
        where stripe_subscription_id = ${subId}
      `;
      expect(row).toMatchObject({ status: 'active', tier: 'basic', monthly_manna: 4321 });
    }

    for (const order of ['active-first', 'past-due-first'] as const) {
      const subId = `${marker}_sub_tie_status_${order}`;
      const base = {
        id: subId,
        customer: `${marker}_cus_tie_status_${order}`,
        items: { data: [{ price: { id: 'price_basic' }, quantity: 1 }] },
        metadata: { accountId: userId, tier: 'basic' },
      };
      const active = { ...base, status: 'active' };
      const pastDue = { ...base, status: 'past_due' };
      const objects = order === 'active-first' ? [active, pastDue] : [pastDue, active];
      for (const [index, object] of objects.entries()) {
        const response = await postWebhook({
          id: `${marker}_evt_tie_status_${order}_${index}`,
          type: 'customer.subscription.updated',
          created: sameSecond,
          data: { object },
        });
        expect(response.statusCode).toBe(200);
      }
      const [row] = await pg<Array<{ status: string; tier: string }>>`
        select status, tier from billing_subscriptions where stripe_subscription_id = ${subId}
      `;
      expect(row).toMatchObject({ status: 'past_due', tier: 'basic' });
    }
  });

  it('rejects bad signatures before handling the event', async () => {
    const payload = JSON.stringify({ id: `${marker}_bad`, type: 'checkout.session.completed', data: { object: {} } });
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)}` },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('bad_signature');
  });

  it('accepts any valid v1 signature in a secret-rotation header', async () => {
    const payload = JSON.stringify({
      id: `${marker}_rotation`,
      type: 'unhandled.test.event',
      livemode: false,
      created: testStripeCreated++,
      data: { object: {} },
    });
    const validHeader = signPayload(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `${validHeader},v1=${'0'.repeat(64)}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, action: 'ignored' });
  });

  it('rejects an in-window bad MAC before parsing malformed JSON', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)}`,
      },
      payload: '{not-json',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('bad_signature');
  });

  it.each([true, undefined])('rejects a signed non-test-mode event livemode=%s', async (livemode) => {
    const payload = JSON.stringify({
      id: `${marker}_mode_${String(livemode)}`,
      type: 'checkout.session.completed',
      ...(livemode === undefined ? {} : { livemode }),
      data: { object: { id: `${marker}_mode_object` } },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signPayload(payload),
      },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('stripe_mode_mismatch');
  });

  it('returns a safe bad-event response for signed malformed JSON', async () => {
    const payload = '{not-json';
    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signPayload(payload),
      },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'bad_event',
      message: 'Stripe webhook payload is invalid',
    });
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

  it('recognizes an imported per-user redemption without crediting or consuming capacity again', async () => {
    const code = `${marker}_voucher_imported`;
    const legacyVoucherId = `${marker}_legacy_voucher`;
    const before = await getBalance(userId);
    await pg`
      insert into manna_vouchers (
        code, amount, max_redemptions, redeemed_count, metadata
      )
      values (
        ${code}, 888, 3, 1,
        ${JSON.stringify({ legacyExternalId: legacyVoucherId, legacyAction: 'manna' })}::jsonb
      )
    `;
    await pg`
      insert into manna_transactions (
        external_id, manna_account_id, amount, type, voucher_external_id, code
      )
      select
        ${`${marker}_legacy_redemption`}, ma.id, 888, 'credit:voucher',
        ${legacyVoucherId}, ${code}
      from manna_accounts ma
      where ma.account_id = ${userId}
    `;

    const replay = await app.inject({
      method: 'POST',
      url: '/billing/vouchers/redeem',
      headers: { cookie: devCookie(userId) },
      payload: { code },
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ amount: 888, alreadyApplied: true, balance: before });
    expect((await ledgerRows(userId)).filter((row) => row.code === code)).toHaveLength(1);
    const [voucher] = await pg<{ redeemed_count: number }[]>`
      select redeemed_count from manna_vouchers where code = ${code}
    `;
    expect(voucher?.redeemed_count).toBe(1);
  });

  it('preserves and enforces an imported legacy user allowlist', async () => {
    const code = `${marker}_voucher_allowlisted`;
    const legacyClerkId = `${marker}_legacy_clerk_user`;
    await pg`update accounts set clerk_user_id = ${legacyClerkId} where id = ${userId}`;
    await pg`
      insert into manna_vouchers (code, amount, max_redemptions, metadata)
      values (
        ${code}, 222, 1,
        ${JSON.stringify({
          legacyExternalId: `${marker}_legacy_allowlisted_voucher`,
          legacyAction: 'manna',
          allowedUserIds: [legacyClerkId],
        })}::jsonb
      )
    `;

    const denied = await app.inject({
      method: 'POST',
      url: '/billing/vouchers/redeem',
      headers: { cookie: devCookie(otherUserId) },
      payload: { code },
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe(
      'voucher_not_allowed',
    );

    const allowed = await app.inject({
      method: 'POST',
      url: '/billing/vouchers/redeem',
      headers: { cookie: devCookie(userId) },
      payload: { code },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ amount: 222, alreadyApplied: false });
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

  it('refuses a malformed-expiry legacy voucher even before disabled reconciliation lands', async () => {
    const code = `${marker}_malformed_expiry`;
    await pg`
      insert into manna_vouchers (code, amount, disabled, expires_at, metadata)
      values (
        ${code}, 321, false, null,
        ${JSON.stringify({
          legacyExternalId: `${marker}_legacy_malformed_expiry`,
          legacyAction: 'manna',
          legacyMalformedExpiresAt: true,
        })}::jsonb
      )
    `;
    const before = await getBalance(userId);

    const res = await app.inject({
      method: 'POST',
      url: '/billing/vouchers/redeem',
      headers: { cookie: devCookie(userId) },
      payload: { code },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('voucher_disabled');
    expect((await getBalance(userId)).total).toBe(before.total);
    const [voucher] = await pg<{ redeemed_count: number }[]>`
      select redeemed_count from manna_vouchers where code = ${code}
    `;
    expect(voucher?.redeemed_count).toBe(0);
    expect((await ledgerRows(userId)).filter((row) => row.code === code)).toHaveLength(0);
  });

  it('refuses a malformed-critical legacy voucher even before disabled reconciliation lands', async () => {
    const code = `${marker}_malformed_critical`;
    await pg`
      insert into manna_vouchers (code, amount, disabled, metadata)
      values (
        ${code}, 654, false,
        ${JSON.stringify({
          legacyExternalId: `${marker}_legacy_malformed_critical`,
          legacyAction: 'manna',
          legacyMalformedCriticalFields: ['maxUses', 'allowedUserIds'],
        })}::jsonb
      )
    `;
    const before = await getBalance(userId);

    const res = await app.inject({
      method: 'POST',
      url: '/billing/vouchers/redeem',
      headers: { cookie: devCookie(userId) },
      payload: { code },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('voucher_disabled');
    expect((await getBalance(userId)).total).toBe(before.total);
    const [voucher] = await pg<{ redeemed_count: number }[]>`
      select redeemed_count from manna_vouchers where code = ${code}
    `;
    expect(voucher?.redeemed_count).toBe(0);
    expect((await ledgerRows(userId)).filter((row) => row.code === code)).toHaveLength(0);
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
