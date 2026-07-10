import { createHmac, timingSafeEqual } from 'node:crypto';

import { credit, getBalance, getEnv } from '@eden3/core';
import {
  accounts,
  billingSubscriptions,
  db,
  mannaTransactions,
  mannaVouchers,
  pg,
} from '@eden3/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors';
import { pgToIso } from '../route-helpers';

interface StripeCheckoutSession {
  id: string;
  url: string | null;
}

export interface StripeCheckoutClient {
  createCheckoutSession(params: URLSearchParams, secretKey: string): Promise<StripeCheckoutSession>;
}

export interface BillingRoutesOptions {
  stripeClient?: StripeCheckoutClient;
}

const defaultStripeClient: StripeCheckoutClient = {
  async createCheckoutSession(params, secretKey) {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const body = (await res.json().catch(() => ({}))) as Partial<StripeCheckoutSession> & {
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new ApiError(
        502,
        'stripe_checkout_failed',
        body.error?.message ?? `Stripe checkout failed with HTTP ${res.status}`,
      );
    }
    if (!body.id) throw new ApiError(502, 'stripe_checkout_failed', 'Stripe response missing session id');
    return { id: body.id, url: body.url ?? null };
  },
};

const checkoutBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manna_topup') }),
  z.object({ kind: z.literal('subscription'), tier: z.enum(['basic', 'pro', 'believer']) }),
]);

const redeemVoucherBodySchema = z.object({
  code: z.string().trim().min(1).max(128),
});

type StripeEvent = {
  id: string;
  type: string;
  livemode?: boolean;
  created?: number;
  data: { object: Record<string, unknown> };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function metadataFrom(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter(([, item]) => typeof item === 'string'),
  ) as Record<string, string>;
}

function metadataCandidates(object: Record<string, unknown>): Array<Record<string, string>> {
  const subscriptionDetails = asRecord(object.subscription_details);
  const parent = asRecord(object.parent);
  const parentSubscriptionDetails = asRecord(parent?.subscription_details);
  const lines = asRecord(object.lines);
  const lineData = Array.isArray(lines?.data) ? lines.data : [];
  const firstLine = asRecord(lineData[0]);
  return [
    metadataFrom(object.metadata),
    metadataFrom(subscriptionDetails?.metadata),
    metadataFrom(parentSubscriptionDetails?.metadata),
    metadataFrom(firstLine?.metadata),
  ];
}

function metadataValue(object: Record<string, unknown>, key: string): string | null {
  for (const metadata of metadataCandidates(object)) {
    const value = metadata[key];
    if (value) return value;
  }
  return null;
}

function accountIdFromStripeObject(object: Record<string, unknown>): string | null {
  return metadataValue(object, 'accountId') ?? asString(object.client_reference_id);
}

function tierAmount(tier: string | null): number | null {
  const env = getEnv();
  switch (tier) {
    case 'basic':
      return env.STRIPE_SUBSCRIPTION_BASIC_MONTHLY_MANNA;
    case 'pro':
      return env.STRIPE_SUBSCRIPTION_PRO_MONTHLY_MANNA;
    case 'believer':
      return env.STRIPE_SUBSCRIPTION_BELIEVER_MONTHLY_MANNA;
    default:
      return null;
  }
}

function subscriptionPrice(tier: 'basic' | 'pro' | 'believer'): { priceId: string | undefined; manna: number } {
  const env = getEnv();
  switch (tier) {
    case 'basic':
      return { priceId: env.STRIPE_SUBSCRIPTION_BASIC_PRICE_ID, manna: env.STRIPE_SUBSCRIPTION_BASIC_MONTHLY_MANNA };
    case 'pro':
      return { priceId: env.STRIPE_SUBSCRIPTION_PRO_PRICE_ID, manna: env.STRIPE_SUBSCRIPTION_PRO_MONTHLY_MANNA };
    case 'believer':
      return {
        priceId: env.STRIPE_SUBSCRIPTION_BELIEVER_PRICE_ID,
        manna: env.STRIPE_SUBSCRIPTION_BELIEVER_MONTHLY_MANNA,
      };
  }
}

function subscriptionIdFromInvoice(object: Record<string, unknown>): string | null {
  return (
    asString(object.subscription) ??
    asString(asRecord(object.subscription_details)?.subscription) ??
    asString(asRecord(asRecord(object.parent)?.subscription_details)?.subscription)
  );
}

function currentPeriodEndFrom(value: unknown): Date | null {
  const seconds = asNumber(value);
  return seconds && seconds > 0 ? new Date(seconds * 1000) : null;
}

function compareHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyStripeWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  opts: { nowMs?: number; toleranceSeconds?: number } = {},
): void {
  if (!signatureHeader) throw new ApiError(400, 'bad_signature', 'Missing Stripe-Signature header');
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => {
      const [key, ...rest] = part.split('=');
      return [key, rest.join('=')];
    }),
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) {
    throw new ApiError(400, 'bad_signature', 'Malformed Stripe-Signature header');
  }
  const nowMs = opts.nowMs ?? Date.now();
  const toleranceSeconds = opts.toleranceSeconds ?? 300;
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) {
    throw new ApiError(400, 'bad_signature', 'Stripe webhook timestamp outside tolerance');
  }
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  if (!compareHex(expected, signature)) {
    throw new ApiError(400, 'bad_signature', 'Stripe webhook signature verification failed');
  }
}

async function assertAccountExists(accountId: string): Promise<void> {
  const [row] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!row) throw new ApiError(400, 'unknown_account', 'Stripe event does not map to an Eden3 account');
}

async function upsertSubscription(params: {
  accountId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string;
  status: string;
  tier: string | null;
  monthlyManna: number;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}): Promise<void> {
  await db
    .insert(billingSubscriptions)
    .values({
      accountId: params.accountId,
      stripeCustomerId: params.stripeCustomerId,
      stripeSubscriptionId: params.stripeSubscriptionId,
      status: params.status,
      tier: params.tier,
      monthlyManna: params.monthlyManna,
      currentPeriodEnd: params.currentPeriodEnd,
      cancelAtPeriodEnd: params.cancelAtPeriodEnd,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: billingSubscriptions.stripeSubscriptionId,
      set: {
        accountId: params.accountId,
        stripeCustomerId: params.stripeCustomerId,
        status: params.status,
        tier: params.tier,
        monthlyManna: params.monthlyManna,
        currentPeriodEnd: params.currentPeriodEnd,
        cancelAtPeriodEnd: params.cancelAtPeriodEnd,
        updatedAt: new Date(),
      },
    });
}

async function handleCheckoutCompleted(event: StripeEvent): Promise<{ action: string; alreadyApplied?: boolean }> {
  const session = event.data.object;
  const accountId = accountIdFromStripeObject(session);
  if (!accountId) throw new ApiError(400, 'missing_account', 'Checkout session missing account metadata');
  await assertAccountExists(accountId);

  const mode = asString(session.mode);
  if (mode === 'subscription') {
    const subscriptionId = asString(session.subscription);
    if (subscriptionId) {
      const tier = metadataValue(session, 'tier');
      await upsertSubscription({
        accountId,
        stripeCustomerId: asString(session.customer),
        stripeSubscriptionId: subscriptionId,
        status: 'checkout_completed',
        tier,
        monthlyManna: asNumber(metadataValue(session, 'monthlyManna')) ?? tierAmount(tier) ?? 0,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      });
    }
    return { action: 'subscription_recorded' };
  }

  if (asString(session.payment_status) !== 'paid') return { action: 'payment_not_paid' };
  const amount = asNumber(metadataValue(session, 'mannaAmount')) ?? getEnv().STRIPE_MANNA_TOPUP_AMOUNT;
  const result = await credit({
    accountId,
    amount,
    type: 'credit:stripe',
    idempotencyKey: `stripe:${event.id}`,
    stripeEventId: event.id,
    stripeEventType: event.type,
    stripeEventData: session,
  });
  return { action: 'manna_credited', alreadyApplied: result.alreadyApplied };
}

async function handleInvoicePaymentSucceeded(event: StripeEvent): Promise<{ action: string; alreadyApplied?: boolean }> {
  const invoice = event.data.object;
  const accountId = accountIdFromStripeObject(invoice);
  if (!accountId) throw new ApiError(400, 'missing_account', 'Invoice missing account metadata');
  await assertAccountExists(accountId);

  const tier = metadataValue(invoice, 'tier');
  const monthlyManna =
    asNumber(metadataValue(invoice, 'monthlyManna')) ??
    asNumber(metadataValue(invoice, 'prorationManna')) ??
    tierAmount(tier) ??
    0;
  if (monthlyManna <= 0) return { action: 'no_subscription_manna' };

  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (subscriptionId) {
    await upsertSubscription({
      accountId,
      stripeCustomerId: asString(invoice.customer),
      stripeSubscriptionId: subscriptionId,
      status: 'active',
      tier,
      monthlyManna,
      currentPeriodEnd: currentPeriodEndFrom(metadataValue(invoice, 'currentPeriodEnd')),
      cancelAtPeriodEnd: false,
    });
  }

  const result = await credit({
    accountId,
    amount: monthlyManna,
    type: 'credit:subscription',
    idempotencyKey: `stripe:${event.id}`,
    stripeEventId: event.id,
    stripeEventType: event.type,
    stripeEventData: invoice,
    toSubscriptionBalance: true,
  });
  return { action: 'subscription_manna_credited', alreadyApplied: result.alreadyApplied };
}

async function handleSubscriptionChanged(event: StripeEvent): Promise<{ action: string }> {
  const subscription = event.data.object;
  const accountId = accountIdFromStripeObject(subscription);
  const subscriptionId = asString(subscription.id);
  if (!accountId || !subscriptionId) return { action: 'subscription_ignored' };
  await assertAccountExists(accountId);
  const tier = metadataValue(subscription, 'tier');
  await upsertSubscription({
    accountId,
    stripeCustomerId: asString(subscription.customer),
    stripeSubscriptionId: subscriptionId,
    status: event.type === 'customer.subscription.deleted' ? 'canceled' : (asString(subscription.status) ?? 'unknown'),
    tier,
    monthlyManna: asNumber(metadataValue(subscription, 'monthlyManna')) ?? tierAmount(tier) ?? 0,
    currentPeriodEnd: currentPeriodEndFrom(subscription.current_period_end),
    cancelAtPeriodEnd: asBoolean(subscription.cancel_at_period_end),
  });
  return { action: 'subscription_updated' };
}

async function handleStripeEvent(event: StripeEvent): Promise<{ action: string; alreadyApplied?: boolean }> {
  switch (event.type) {
    case 'checkout.session.completed':
      return await handleCheckoutCompleted(event);
    case 'invoice.payment_succeeded':
      return await handleInvoicePaymentSucceeded(event);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return await handleSubscriptionChanged(event);
    default:
      return { action: 'ignored' };
  }
}

export const billingRoutes: FastifyPluginAsync<BillingRoutesOptions> = async (app, opts) => {
  const stripeClient = opts.stripeClient ?? defaultStripeClient;

  app.get('/subscription', { preHandler: app.requireAuth }, async (req) => {
    const [row] = await pg<
      Array<{
        status: string;
        tier: string | null;
        monthlyManna: number;
        currentPeriodEnd: string | Date | null;
        cancelAtPeriodEnd: boolean;
        updatedAt: string | Date;
      }>
    >`
      select
        status,
        tier,
        monthly_manna as "monthlyManna",
        current_period_end as "currentPeriodEnd",
        cancel_at_period_end as "cancelAtPeriodEnd",
        updated_at as "updatedAt"
      from billing_subscriptions
      where account_id = ${req.account!.accountId}
      order by
        case
          when status in ('active', 'trialing', 'checkout_completed') then 0
          when status in ('past_due', 'unpaid') then 1
          else 2
        end,
        updated_at desc
      limit 1
    `;

    return {
      subscription: row
        ? {
            status: row.status,
            tier: row.tier,
            monthlyManna: Number(row.monthlyManna),
            currentPeriodEnd: row.currentPeriodEnd ? pgToIso(row.currentPeriodEnd) : null,
            cancelAtPeriodEnd: row.cancelAtPeriodEnd,
            updatedAt: pgToIso(row.updatedAt),
          }
        : null,
    };
  });

  app.post('/checkout', { preHandler: app.requireAuth }, async (req) => {
    const env = getEnv();
    if (!env.STRIPE_SECRET_KEY) {
      throw new ApiError(503, 'stripe_not_configured', 'STRIPE_SECRET_KEY is not configured');
    }
    const body = checkoutBodySchema.parse(req.body);
    const account = req.account!;
    const params = new URLSearchParams();
    params.set('success_url', env.BILLING_SUCCESS_URL ?? `http://localhost:${env.WEB_PORT}/manna?checkout=success`);
    params.set('cancel_url', env.BILLING_CANCEL_URL ?? `http://localhost:${env.WEB_PORT}/manna?checkout=cancel`);
    params.set('client_reference_id', account.accountId);
    params.set('line_items[0][quantity]', '1');
    params.set('metadata[accountId]', account.accountId);
    params.set('metadata[username]', account.username);

    if (body.kind === 'manna_topup') {
      if (!env.STRIPE_MANNA_TOPUP_PRICE_ID) {
        throw new ApiError(503, 'stripe_price_not_configured', 'STRIPE_MANNA_TOPUP_PRICE_ID is not configured');
      }
      params.set('mode', 'payment');
      params.set('line_items[0][price]', env.STRIPE_MANNA_TOPUP_PRICE_ID);
      params.set('metadata[kind]', 'manna_topup');
      params.set('metadata[mannaAmount]', String(env.STRIPE_MANNA_TOPUP_AMOUNT));
    } else {
      const plan = subscriptionPrice(body.tier);
      if (!plan.priceId) {
        throw new ApiError(503, 'stripe_price_not_configured', `Stripe price is not configured for ${body.tier}`);
      }
      params.set('mode', 'subscription');
      params.set('line_items[0][price]', plan.priceId);
      params.set('metadata[kind]', 'subscription');
      params.set('metadata[tier]', body.tier);
      params.set('metadata[monthlyManna]', String(plan.manna));
      params.set('subscription_data[metadata][accountId]', account.accountId);
      params.set('subscription_data[metadata][tier]', body.tier);
      params.set('subscription_data[metadata][monthlyManna]', String(plan.manna));
    }

    const session = await stripeClient.createCheckoutSession(params, env.STRIPE_SECRET_KEY);
    return { session };
  });

  await app.register(async (webhook) => {
    webhook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    webhook.post('/webhook', async (req) => {
      const env = getEnv();
      if (!env.STRIPE_WEBHOOK_SECRET) {
        throw new ApiError(503, 'stripe_not_configured', 'STRIPE_WEBHOOK_SECRET is not configured');
      }
      const rawBody =
        Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
      verifyStripeWebhookSignature(
        rawBody,
        typeof req.headers['stripe-signature'] === 'string' ? req.headers['stripe-signature'] : undefined,
        env.STRIPE_WEBHOOK_SECRET,
      );
      const event = JSON.parse(rawBody.toString('utf8')) as StripeEvent;
      if (!event.id || !event.type || !event.data?.object) {
        throw new ApiError(400, 'bad_event', 'Stripe webhook payload is not a supported event object');
      }
      const result = await handleStripeEvent(event);
      return { received: true, ...result };
    });
  });

  app.post('/vouchers/redeem', { preHandler: app.requireAuth }, async (req) => {
    const body = redeemVoucherBodySchema.parse(req.body);
    const account = req.account!;
    const result = await db.transaction(async (tx) => {
      const [voucher] = await tx
        .select()
        .from(mannaVouchers)
        .where(eq(mannaVouchers.code, body.code))
        .limit(1);
      if (!voucher) throw new ApiError(404, 'voucher_not_found', 'Voucher code not found');

      const idempotencyKey = `voucher:${voucher.id}:${account.accountId}`;
      const [existing] = await tx
        .select()
        .from(mannaTransactions)
        .where(eq(mannaTransactions.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existing) {
        return {
          alreadyApplied: true,
          amount: voucher.amount,
          balance: await getBalance(account.accountId, { db: tx }),
        };
      }

      const [updated] = await tx
        .update(mannaVouchers)
        .set({ redeemedCount: sql`${mannaVouchers.redeemedCount} + 1`, updatedAt: new Date() })
        .where(
          and(
            eq(mannaVouchers.id, voucher.id),
            eq(mannaVouchers.disabled, false),
            or(isNull(mannaVouchers.expiresAt), sql`${mannaVouchers.expiresAt} > now()`),
            sql`${mannaVouchers.redeemedCount} < ${mannaVouchers.maxRedemptions}`,
          ),
        )
        .returning();
      if (!updated) {
        if (voucher.disabled) throw new ApiError(400, 'voucher_disabled', 'Voucher is disabled');
        if (voucher.expiresAt && voucher.expiresAt.getTime() <= Date.now()) {
          throw new ApiError(400, 'voucher_expired', 'Voucher has expired');
        }
        throw new ApiError(400, 'voucher_exhausted', 'Voucher has already been redeemed');
      }

      const credited = await credit({
        accountId: account.accountId,
        amount: voucher.amount,
        type: 'credit:voucher',
        idempotencyKey,
        voucherExternalId: voucher.id,
        code: voucher.code,
        db: tx,
      });
      return { alreadyApplied: credited.alreadyApplied, amount: voucher.amount, balance: credited.balance };
    });

    return result;
  });
};
