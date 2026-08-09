import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { credit, getBalance, getEnv, type DbHandle } from '@eden3/core';
import {
  accounts,
  billingSubscriptions,
  db,
  mannaAccounts,
  mannaTransactions,
  mannaVouchers,
  pg,
  stripeCheckoutIntents,
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

interface StripeCheckoutLineItem {
  priceId: string;
  quantity: number;
}

export interface StripeCheckoutClient {
  createCheckoutSession(
    params: URLSearchParams,
    secretKey: string,
    idempotencyKey?: string,
  ): Promise<StripeCheckoutSession>;
  retrieveCheckoutSessionLineItems(
    sessionId: string,
    secretKey: string,
  ): Promise<StripeCheckoutLineItem[]>;
}

export interface BillingRoutesOptions {
  stripeClient?: StripeCheckoutClient;
}

const defaultStripeClient: StripeCheckoutClient = {
  async createCheckoutSession(params, secretKey, idempotencyKey) {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: params,
    });
    const body = (await res.json().catch(() => ({}))) as Partial<StripeCheckoutSession> & {
      error?: { message?: string };
    };
    if (!res.ok) throw new ApiError(502, 'stripe_checkout_failed', 'Stripe Checkout is unavailable');
    if (!body.id) throw new ApiError(502, 'stripe_checkout_failed', 'Stripe response missing session id');
    return { id: body.id, url: body.url ?? null };
  },
  async retrieveCheckoutSessionLineItems(sessionId, secretKey) {
    let res: Response;
    try {
      res = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=10`,
        {
          headers: { authorization: `Bearer ${secretKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new ApiError(502, 'stripe_checkout_failed', 'Stripe Checkout is unavailable');
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw new ApiError(502, 'stripe_checkout_failed', 'Stripe Checkout is unavailable');
    const record = asRecord(body);
    const data = Array.isArray(record?.data) ? record.data : null;
    if (!data || data.length > 10) {
      throw new ApiError(502, 'stripe_checkout_failed', 'Stripe Checkout line items are invalid');
    }
    return data.map((value) => {
      const line = asRecord(value);
      const priceId = asString(asRecord(line?.price)?.id);
      const quantity = asNumber(line?.quantity);
      if (!priceId || !quantity || !Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new ApiError(502, 'stripe_checkout_failed', 'Stripe Checkout line items are invalid');
      }
      return { priceId, quantity };
    });
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
  livemode: false;
  created: number;
  data: { object: Record<string, unknown> };
};

type SubscriptionTier = 'basic' | 'pro' | 'believer';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Source voucher id carried by ETL-imported inventory rows. */
export function legacyVoucherExternalId(metadata: unknown): string | null {
  const value = asRecord(metadata)?.['legacyExternalId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** ETL marker for a present legacy expiry that could not be parsed safely. */
export function legacyVoucherHasMalformedExpiration(metadata: unknown): boolean {
  return asRecord(metadata)?.['legacyMalformedExpiresAt'] === true;
}

/** ETL marker for malformed present authorization/capacity fields. */
export function legacyVoucherHasMalformedCriticalFields(metadata: unknown): boolean {
  const value = asRecord(metadata)?.['legacyMalformedCriticalFields'];
  return value === true || (Array.isArray(value) && value.length > 0);
}

/** Legacy Clerk/user ids allowed to redeem an imported voucher. */
export function legacyVoucherAllowedUserIds(metadata: unknown): string[] {
  const value = asRecord(metadata)?.['allowedUserIds'];
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((item): item is string => typeof item === 'string' && item.length > 0),
    ),
  ];
}

/** Empty allowlists are public; otherwise one preserved legacy identity must match. */
export function legacyVoucherAllowsAccount(
  metadata: unknown,
  accountIdentifiers: readonly (string | null | undefined)[],
): boolean {
  const allowed = legacyVoucherAllowedUserIds(metadata);
  if (allowed.length === 0) return true;
  const identities = new Set(
    accountIdentifiers.filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  return allowed.some((value) => identities.has(value));
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
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

function consistentStripeValue(label: string, values: readonly (string | null)[]): string | null {
  const unique = [...new Set(values.filter((value): value is string => value !== null))];
  if (unique.length > 1) {
    throw new ApiError(409, 'stripe_binding_mismatch', `Stripe ${label} binding is inconsistent`);
  }
  return unique[0] ?? null;
}

function accountIdFromStripeObject(object: Record<string, unknown>): string | null {
  return consistentStripeValue('account', [
    ...metadataCandidates(object).map((metadata) => asString(metadata.accountId)),
    asString(object.client_reference_id),
  ]);
}

function metadataTier(object: Record<string, unknown>): SubscriptionTier | null {
  const value = consistentStripeValue(
    'tier',
    metadataCandidates(object).map((metadata) => asString(metadata.tier)),
  );
  return value === 'basic' || value === 'pro' || value === 'believer' ? value : null;
}

function tierAmount(tier: SubscriptionTier | null): number | null {
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

function subscriptionPrice(tier: SubscriptionTier): { priceId: string | undefined; manna: number } {
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

function configuredTierForPrice(priceId: string): SubscriptionTier | null {
  const env = getEnv();
  if (priceId === env.STRIPE_SUBSCRIPTION_BASIC_PRICE_ID) return 'basic';
  if (priceId === env.STRIPE_SUBSCRIPTION_PRO_PRICE_ID) return 'pro';
  if (priceId === env.STRIPE_SUBSCRIPTION_BELIEVER_PRICE_ID) return 'believer';
  return null;
}

interface StripeSubscriptionLineEvidence {
  priceId: string;
  quantity: number;
  periodEnd: Date | null;
}

function stripeSubscriptionLines(object: Record<string, unknown>): StripeSubscriptionLineEvidence[] {
  const lines = asRecord(object.lines) ?? asRecord(object.items);
  const data = Array.isArray(lines?.data) ? lines.data : [];
  return data.map((item) => {
    const line = asRecord(item);
    const priceId = consistentStripeValue('price', [
      asString(asRecord(line?.price)?.id),
      asString(asRecord(asRecord(line?.pricing)?.price_details)?.price),
    ]);
    const quantity = asNumber(line?.quantity);
    if (!priceId || quantity !== 1 || !Number.isSafeInteger(quantity)) {
      throw new ApiError(400, 'bad_event', 'Stripe event must contain one configured price at quantity one');
    }
    return {
      priceId,
      quantity,
      periodEnd: currentPeriodEndFrom(asRecord(line?.period)?.end),
    };
  });
}

function configuredSubscriptionFromStripeObject(
  object: Record<string, unknown>,
): StripeSubscriptionLineEvidence & { tier: SubscriptionTier } {
  const lines = stripeSubscriptionLines(object);
  if (lines.length !== 1) {
    throw new ApiError(400, 'bad_event', 'Stripe event does not identify one configured tier');
  }
  const line = lines[0]!;
  const tier = configuredTierForPrice(line.priceId);
  if (!tier) throw new ApiError(400, 'bad_event', 'Stripe event does not identify one configured tier');
  const claimed = metadataTier(object);
  if (claimed !== null && claimed !== tier) {
    throw new ApiError(409, 'stripe_binding_mismatch', 'Stripe tier does not match its configured price');
  }
  return { ...line, tier };
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
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
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
  let timestampValue: string | null = null;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const [key, ...rest] = part.split('=');
    const value = rest.join('=');
    if (key === 't') timestampValue = value;
    if (key === 'v1') signatures.push(value);
  }
  const timestamp = Number(timestampValue);
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
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
  if (!signatures.some((signature) => compareHex(expected, signature))) {
    throw new ApiError(400, 'bad_signature', 'Stripe webhook signature verification failed');
  }
}

async function assertAccountExists(accountId: string, dbc: DbHandle = db): Promise<void> {
  const [row] = await dbc.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!row) throw new ApiError(400, 'unknown_account', 'Stripe event does not map to an Eden3 account');
}

async function lockStripeScopes(dbc: DbHandle, scopes: readonly string[]): Promise<void> {
  for (const scope of [...new Set(scopes)].sort()) {
    await dbc.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope}, 29))`);
  }
}

async function assertStripeBindings(
  dbc: DbHandle,
  params: { accountId: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null },
): Promise<void> {
  await assertAccountExists(params.accountId, dbc);
  const conditions = [
    params.stripeSubscriptionId
      ? eq(billingSubscriptions.stripeSubscriptionId, params.stripeSubscriptionId)
      : undefined,
    params.stripeCustomerId
      ? eq(billingSubscriptions.stripeCustomerId, params.stripeCustomerId)
      : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);
  if (conditions.length === 0) return;
  const rows = await dbc
    .select({
      accountId: billingSubscriptions.accountId,
      stripeCustomerId: billingSubscriptions.stripeCustomerId,
      stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
    })
    .from(billingSubscriptions)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions));
  for (const row of rows) {
    if (row.accountId !== params.accountId) {
      throw new ApiError(409, 'stripe_binding_mismatch', 'Stripe billing identity belongs to another account');
    }
    if (
      params.stripeSubscriptionId === row.stripeSubscriptionId &&
      params.stripeCustomerId !== null &&
      row.stripeCustomerId !== null &&
      row.stripeCustomerId !== params.stripeCustomerId
    ) {
      throw new ApiError(409, 'stripe_binding_mismatch', 'Stripe customer binding cannot change');
    }
  }
  if (params.stripeCustomerId) {
    const paymentOwners = await dbc
      .select({ accountId: mannaAccounts.accountId })
      .from(mannaTransactions)
      .innerJoin(mannaAccounts, eq(mannaAccounts.id, mannaTransactions.mannaAccountId))
      .where(sql`${mannaTransactions.stripeEventData}->>'customerId' = ${params.stripeCustomerId}`);
    if (paymentOwners.some((row) => row.accountId !== params.accountId)) {
      throw new ApiError(409, 'stripe_binding_mismatch', 'Stripe billing identity belongs to another account');
    }
  }
}

async function assertCreditBinding(
  dbc: DbHandle,
  idempotencyKey: string,
  accountId: string,
  evidence: Record<string, unknown>,
): Promise<boolean> {
  const [existing] = await dbc
    .select({
      accountId: mannaAccounts.accountId,
      stripeEventData: mannaTransactions.stripeEventData,
    })
    .from(mannaTransactions)
    .innerJoin(mannaAccounts, eq(mannaAccounts.id, mannaTransactions.mannaAccountId))
    .where(eq(mannaTransactions.idempotencyKey, idempotencyKey))
    .limit(1);
  if (
    existing &&
    (existing.accountId !== accountId || stableJson(existing.stripeEventData) !== stableJson(evidence))
  ) {
    throw new ApiError(409, 'stripe_binding_mismatch', 'Stripe credit object binding cannot change');
  }
  return existing !== undefined;
}

function subscriptionCapabilityRank(
  status: string,
  tier: string | null,
  monthlyManna: number,
): number {
  const entitlementClass =
    status === 'canceled' || status === 'incomplete_expired'
      ? 0
      : status === 'unpaid' || status === 'incomplete' || status === 'unknown' || status === 'past_due' || status === 'paused'
        ? 1
        : status === 'trialing' || status === 'active' || status === 'checkout_completed'
          ? 2
          : 1;
  const tierRank = tier === 'believer' ? 3 : tier === 'pro' ? 2 : tier === 'basic' ? 1 : 0;
  const statusTieRank =
    status === 'canceled' || status === 'unpaid' || status === 'trialing'
      ? 0
      : status === 'incomplete_expired' || status === 'incomplete' || status === 'checkout_completed'
        ? 1
        : status === 'unknown' || status === 'active'
          ? 2
          : status === 'past_due'
            ? 3
            : status === 'paused'
              ? 4
              : 5;
  return entitlementClass * 1_000_000_000 + monthlyManna * 100 + tierRank * 10 + statusTieRank;
}

const storedSubscriptionCapabilityRank = sql<number>`(
  case ${billingSubscriptions.status}
    when 'canceled' then 0
    when 'incomplete_expired' then 0
    when 'unpaid' then 1
    when 'incomplete' then 1
    when 'unknown' then 1
    when 'past_due' then 1
    when 'paused' then 1
    when 'trialing' then 2
    when 'active' then 2
    when 'checkout_completed' then 2
    else 1
  end * 1000000000
  + ${billingSubscriptions.monthlyManna} * 100
  + case ${billingSubscriptions.tier}
      when 'believer' then 30
      when 'pro' then 20
      when 'basic' then 10
      else 0
    end
  + case ${billingSubscriptions.status}
      when 'canceled' then 0
      when 'unpaid' then 0
      when 'trialing' then 0
      when 'incomplete_expired' then 1
      when 'incomplete' then 1
      when 'checkout_completed' then 1
      when 'unknown' then 2
      when 'active' then 2
      when 'past_due' then 3
      when 'paused' then 4
      else 5
    end
)`;

async function upsertSubscription(params: {
  db: DbHandle;
  accountId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string;
  status: string;
  tier: string | null;
  monthlyManna: number;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Stripe `event.created` — guards against out-of-order webhook delivery. */
  eventCreatedAt: Date | null;
}): Promise<void> {
  const eventAt = params.eventCreatedAt;
  await params.db
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
      lastStripeEventAt: eventAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: billingSubscriptions.stripeSubscriptionId,
      set: {
        stripeCustomerId: sql`coalesce(${billingSubscriptions.stripeCustomerId}, excluded.stripe_customer_id)`,
        status: params.status,
        tier: params.tier,
        monthlyManna: params.monthlyManna,
        currentPeriodEnd: params.currentPeriodEnd,
        cancelAtPeriodEnd: params.cancelAtPeriodEnd,
        lastStripeEventAt: eventAt,
        updatedAt: new Date(),
      },
      // Last-writer-wins was wrong for webhooks: Stripe delivers out of
      // order, so a stale `customer.subscription.updated` could resurrect a
      // canceled row. Apply only when this event is not older than the last
      // one recorded (rows/events without timestamps keep old behavior).
      setWhere:
        and(
          eq(billingSubscriptions.accountId, params.accountId),
          params.stripeCustomerId === null
            ? undefined
            : or(
                isNull(billingSubscriptions.stripeCustomerId),
                eq(billingSubscriptions.stripeCustomerId, params.stripeCustomerId),
              ),
          eventAt === null
            ? undefined
            : sql`${billingSubscriptions.lastStripeEventAt} is null
              or ${billingSubscriptions.lastStripeEventAt} < ${eventAt.toISOString()}::timestamptz
              or (
                ${billingSubscriptions.lastStripeEventAt} = ${eventAt.toISOString()}::timestamptz
                and ${subscriptionCapabilityRank(params.status, params.tier, params.monthlyManna)} <= ${storedSubscriptionCapabilityRank}
              )`,
        ),
    });
}

/** Stripe `event.created` (unix seconds) as a Date, when present. */
function eventCreatedAtOf(event: StripeEvent): Date | null {
  return new Date(event.created * 1000);
}

async function handleCheckoutCompleted(
  event: StripeEvent,
  stripeClient: StripeCheckoutClient,
): Promise<{ action: string; alreadyApplied?: boolean }> {
  const session = event.data.object;
  const accountId = accountIdFromStripeObject(session);
  if (!accountId) throw new ApiError(400, 'missing_account', 'Checkout session missing account metadata');
  const sessionId = asString(session.id);
  if (!sessionId) throw new ApiError(400, 'bad_event', 'Checkout session is missing its id');
  const checkoutIntentId = metadataValue(session, 'checkoutIntentId');
  if (!checkoutIntentId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(checkoutIntentId)) {
    throw new ApiError(409, 'stripe_binding_mismatch', 'Stripe Checkout intent binding is invalid');
  }
  const mode = asString(session.mode);
  if (mode === 'subscription') {
    // Checkout completion metadata is user-writable and cannot establish an
    // entitlement. Authoritative subscription/invoice webhooks own state.
    const [intent] = await db
      .select({ id: stripeCheckoutIntents.id })
      .from(stripeCheckoutIntents)
      .where(and(
        eq(stripeCheckoutIntents.id, checkoutIntentId),
        eq(stripeCheckoutIntents.accountId, accountId),
        eq(stripeCheckoutIntents.kind, 'subscription'),
        eq(stripeCheckoutIntents.state, 'created'),
        eq(stripeCheckoutIntents.stripeSessionId, sessionId),
      ))
      .limit(1);
    if (!intent) throw new ApiError(409, 'stripe_binding_mismatch', 'Stripe Checkout intent binding is invalid');
    return { action: 'subscription_checkout_awaiting_provider' };
  }

  if (mode !== 'payment' || metadataValue(session, 'kind') !== 'manna_topup') {
    throw new ApiError(400, 'bad_event', 'Checkout session is not an Eden manna purchase');
  }
  if (asString(session.payment_status) !== 'paid') return { action: 'payment_not_paid' };
  const env = getEnv();
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_MANNA_TOPUP_PRICE_ID) {
    throw new ApiError(503, 'stripe_not_configured', 'Stripe top-up verification is not configured');
  }
  const lineItems = await stripeClient.retrieveCheckoutSessionLineItems(sessionId, env.STRIPE_SECRET_KEY);
  if (
    lineItems.length !== 1 ||
    lineItems[0]?.priceId !== env.STRIPE_MANNA_TOPUP_PRICE_ID ||
    lineItems[0]?.quantity !== 1
  ) {
    throw new ApiError(409, 'stripe_binding_mismatch', 'Stripe top-up does not match the configured price');
  }
  const customerId = asString(session.customer);
  const idempotencyKey = `stripe:checkout:${sessionId}`;
  const evidence = {
    kind: 'manna_topup',
    objectId: sessionId,
    accountId,
    customerId,
    priceId: env.STRIPE_MANNA_TOPUP_PRICE_ID,
    quantity: 1,
    amount: env.STRIPE_MANNA_TOPUP_AMOUNT,
    livemode: false,
  };
  return await db.transaction(async (tx) => {
    await lockStripeScopes(tx, [
      `stripe-credit:${idempotencyKey}`,
      ...(customerId ? [`stripe-customer:${customerId}`] : []),
    ]);
    await assertStripeBindings(tx, {
      accountId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: null,
    });
    const [intent] = await tx
      .select({ id: stripeCheckoutIntents.id })
      .from(stripeCheckoutIntents)
      .where(and(
        eq(stripeCheckoutIntents.id, checkoutIntentId),
        eq(stripeCheckoutIntents.accountId, accountId),
        eq(stripeCheckoutIntents.kind, 'manna_topup'),
        eq(stripeCheckoutIntents.state, 'created'),
        eq(stripeCheckoutIntents.stripeSessionId, sessionId),
      ))
      .limit(1);
    if (!intent) throw new ApiError(409, 'stripe_binding_mismatch', 'Stripe Checkout intent binding is invalid');
    if (await assertCreditBinding(tx, idempotencyKey, accountId, evidence)) {
      return { action: 'manna_credited', alreadyApplied: true };
    }
    const result = await credit({
      accountId,
      amount: env.STRIPE_MANNA_TOPUP_AMOUNT,
      type: 'credit:stripe',
      idempotencyKey,
      stripeEventId: event.id,
      stripeEventType: event.type,
      stripeEventData: evidence,
      db: tx,
    });
    return { action: 'manna_credited', alreadyApplied: result.alreadyApplied };
  });
}

async function handleInvoicePaymentSucceeded(event: StripeEvent): Promise<{ action: string; alreadyApplied?: boolean }> {
  const invoice = event.data.object;
  const invoiceId = asString(invoice.id);
  if (!invoiceId) throw new ApiError(400, 'bad_event', 'Invoice is missing its id');
  const billingReason = asString(invoice.billing_reason);
  if (billingReason === 'subscription_update') return { action: 'subscription_proration_ignored' };
  if (billingReason !== 'subscription_create' && billingReason !== 'subscription_cycle') {
    return { action: 'subscription_invoice_ignored' };
  }
  const accountId = accountIdFromStripeObject(invoice);
  if (!accountId) throw new ApiError(400, 'missing_account', 'Invoice missing account metadata');
  const configured = configuredSubscriptionFromStripeObject(invoice);
  const tier = configured.tier;
  const monthlyManna = tierAmount(tier);
  if (!monthlyManna || monthlyManna <= 0) return { action: 'no_subscription_manna' };
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  const customerId = asString(invoice.customer);
  if (!subscriptionId || !customerId) {
    throw new ApiError(400, 'bad_event', 'Invoice is missing subscription billing identity');
  }
  const idempotencyKey = `stripe:invoice:${invoiceId}`;
  const evidence = {
    kind: 'subscription_invoice',
    objectId: invoiceId,
    accountId,
    customerId,
    subscriptionId,
    priceId: configured.priceId,
    quantity: configured.quantity,
    tier,
    amount: monthlyManna,
    billingReason,
    periodEnd: configured.periodEnd?.toISOString() ?? null,
    livemode: false,
  };
  return await db.transaction(async (tx) => {
    await lockStripeScopes(tx, [
      `stripe-credit:${idempotencyKey}`,
      `stripe-customer:${customerId}`,
      `stripe-subscription:${subscriptionId}`,
    ]);
    await assertStripeBindings(tx, {
      accountId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
    });
    if (await assertCreditBinding(tx, idempotencyKey, accountId, evidence)) {
      return { action: 'subscription_manna_credited', alreadyApplied: true };
    }
    await upsertSubscription({
      db: tx,
      accountId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      status: 'active',
      tier,
      monthlyManna,
      currentPeriodEnd: configured.periodEnd,
      cancelAtPeriodEnd: false,
      eventCreatedAt: eventCreatedAtOf(event),
    });
    const result = await credit({
      accountId,
      amount: monthlyManna,
      type: 'credit:subscription',
      idempotencyKey,
      stripeEventId: event.id,
      stripeEventType: event.type,
      stripeEventData: evidence,
      toSubscriptionBalance: true,
      db: tx,
    });
    return { action: 'subscription_manna_credited', alreadyApplied: result.alreadyApplied };
  });
}

async function handleSubscriptionChanged(event: StripeEvent): Promise<{ action: string }> {
  const subscription = event.data.object;
  const accountId = accountIdFromStripeObject(subscription);
  const subscriptionId = asString(subscription.id);
  const customerId = asString(subscription.customer);
  if (!accountId || !subscriptionId || !customerId) return { action: 'subscription_ignored' };
  const tier = configuredSubscriptionFromStripeObject(subscription).tier;
  await db.transaction(async (tx) => {
    await lockStripeScopes(tx, [
      `stripe-customer:${customerId}`,
      `stripe-subscription:${subscriptionId}`,
    ]);
    await assertStripeBindings(tx, {
      accountId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
    });
    await upsertSubscription({
      db: tx,
      accountId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      status: event.type === 'customer.subscription.deleted' ? 'canceled' : (asString(subscription.status) ?? 'unknown'),
      tier,
      monthlyManna: tierAmount(tier) ?? 0,
      currentPeriodEnd: currentPeriodEndFrom(subscription.current_period_end),
      cancelAtPeriodEnd: asBoolean(subscription.cancel_at_period_end),
      eventCreatedAt: eventCreatedAtOf(event),
    });
  });
  return { action: 'subscription_updated' };
}

async function handleStripeEvent(
  event: StripeEvent,
  stripeClient: StripeCheckoutClient,
): Promise<{ action: string; alreadyApplied?: boolean }> {
  switch (event.type) {
    case 'checkout.session.completed':
      return await handleCheckoutCompleted(event, stripeClient);
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
    const checkoutIntentId = randomUUID();
    const checkoutRequestKey = `eden3-checkout-${checkoutIntentId}`;
    const params = new URLSearchParams();
    params.set('success_url', env.BILLING_SUCCESS_URL ?? `http://localhost:${env.WEB_PORT}/manna?checkout=success`);
    params.set('cancel_url', env.BILLING_CANCEL_URL ?? `http://localhost:${env.WEB_PORT}/manna?checkout=cancel`);
    params.set('client_reference_id', account.accountId);
    params.set('line_items[0][quantity]', '1');
    params.set('metadata[accountId]', account.accountId);
    params.set('metadata[username]', account.username);
    params.set('metadata[checkoutIntentId]', checkoutIntentId);

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

    const admitted = await pg.begin(async (tx) => {
      const owners = await tx`select id from accounts where id=${account.accountId}
        and deleted=false for update`;
      if (owners.length !== 1) return false;
      const active = await tx`select 1 from account_erasure_jobs
        where account_id=${account.accountId} and state<>'succeeded' limit 1`;
      if (active.length > 0) return false;
      await tx`insert into stripe_checkout_intents(
        id,account_id,kind,request_key_sha256
      ) values (
        ${checkoutIntentId},${account.accountId},${body.kind},
        ${createHash('sha256').update(checkoutRequestKey,'utf8').digest('hex')}
      )`;
      return true;
    });
    if (!admitted) throw new ApiError(409, 'account_erasure_active', 'Account deletion is in progress');

    const outcome = await pg.begin(async (tx) => {
      const owners = await tx`select id from accounts where id=${account.accountId}
        and deleted=false for key share`;
      if (owners.length !== 1) return { kind: 'fenced' as const };
      const active = await tx`select 1 from account_erasure_jobs
        where account_id=${account.accountId} and state<>'succeeded' limit 1`;
      if (active.length > 0) return { kind: 'fenced' as const };
      const [started] = await tx<{ id: string }[]>`
        update stripe_checkout_intents set state='provider_started',updated_at=statement_timestamp()
        where id=${checkoutIntentId} and account_id=${account.accountId} and state='preparing'
        returning id`;
      if (!started) return { kind: 'fenced' as const };
      try {
        const session = await stripeClient.createCheckoutSession(
          params,
          env.STRIPE_SECRET_KEY!,
          checkoutRequestKey,
        );
        await tx`update stripe_checkout_intents set state='created',stripe_session_id=${session.id},
          updated_at=statement_timestamp() where id=${checkoutIntentId} and state='provider_started'`;
        return { kind: 'created' as const, session };
      } catch {
        // The provider call may have committed remotely before the transport
        // failed. Keep the durable intent in-flight so erasure cannot seal or
        // discard the idempotency identity without operator/provider proof.
        return { kind: 'failed' as const };
      }
    });
    if (outcome.kind === 'fenced') {
      throw new ApiError(409, 'account_erasure_active', 'Account deletion is in progress');
    }
    if (outcome.kind === 'failed') {
      throw new ApiError(502, 'stripe_checkout_failed', 'Stripe Checkout is unavailable');
    }
    return { session: outcome.session };
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
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new ApiError(400, 'bad_event', 'Stripe webhook payload is invalid');
      }
      const record = asRecord(decoded);
      if (record?.livemode !== false) {
        throw new ApiError(400, 'stripe_mode_mismatch', 'Stripe webhook is not a test-mode event');
      }
      const data = asRecord(record.data);
      const object = asRecord(data?.object);
      if (
        !asString(record.id) ||
        !asString(record.type) ||
        typeof record.created !== 'number' ||
        !Number.isFinite(record.created) ||
        record.created < 0 ||
        !object
      ) {
        throw new ApiError(400, 'bad_event', 'Stripe webhook payload is not a supported event object');
      }
      const event = {
        id: record.id,
        type: record.type,
        livemode: false,
        created: record.created,
        data: { object },
      } as StripeEvent;
      const result = await handleStripeEvent(event, stripeClient);
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
      // Defense in depth for inventory imported before/while a reconciliation
      // replay updates `disabled`: durable ETL markers keep malformed expiry,
      // authorization, and capacity fields from becoming permissive defaults.
      if (
        legacyVoucherHasMalformedExpiration(voucher.metadata) ||
        legacyVoucherHasMalformedCriticalFields(voucher.metadata)
      ) {
        throw new ApiError(400, 'voucher_disabled', 'Voucher is disabled');
      }

      const idempotencyKey = `voucher:${voucher.id}:${account.accountId}`;
      // Serialize same-user redeems of the same voucher: without this, two
      // concurrent requests both pass the pre-check and both increment
      // redeemed_count while only one credit lands (a burned slot). The lock
      // holds to commit, so the loser's pre-check below sees the winner.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 7))`);
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

      // Imported MannaVoucherRedemption docs are ledger history with no new
      // Eden3 idempotency key. For migrated inventory only, recognize that
      // same-account legacy fact by source voucher id or its code before
      // consuming capacity/crediting again. This is deliberately scoped by
      // metadata so native Eden3 vouchers retain the ordinary path above.
      const legacyExternalId = legacyVoucherExternalId(voucher.metadata);
      if (legacyExternalId) {
        const [legacyRedemption] = await tx
          .select({ id: mannaTransactions.id })
          .from(mannaTransactions)
          .innerJoin(mannaAccounts, eq(mannaAccounts.id, mannaTransactions.mannaAccountId))
          .where(
            and(
              eq(mannaAccounts.accountId, account.accountId),
              or(
                eq(mannaTransactions.type, 'credit:voucher'),
                eq(mannaTransactions.type, 'credit_voucher'),
              ),
              or(
                eq(mannaTransactions.voucherExternalId, legacyExternalId),
                sql`lower(${mannaTransactions.code}) = lower(${voucher.code})`,
              ),
            ),
          )
          .limit(1);
        if (legacyRedemption) {
          return {
            alreadyApplied: true,
            amount: voucher.amount,
            balance: await getBalance(account.accountId, { db: tx }),
          };
        }
      }

      // Eden1 compared allowedUserIds with User.userId (the inherited Clerk
      // identity), while a few manually-issued vouchers used the Mongo user
      // id. Preserve both identity forms without exposing either in the API.
      if (legacyVoucherAllowedUserIds(voucher.metadata).length > 0) {
        const [legacyAccount] = await tx
          .select({ externalId: accounts.externalId, clerkUserId: accounts.clerkUserId })
          .from(accounts)
          .where(eq(accounts.id, account.accountId))
          .limit(1);
        if (
          !legacyVoucherAllowsAccount(voucher.metadata, [
            legacyAccount?.externalId,
            legacyAccount?.clerkUserId,
          ])
        ) {
          throw new ApiError(403, 'voucher_not_allowed', 'This voucher is not available to this account');
        }
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
        voucherExternalId: legacyExternalId ?? voucher.id,
        code: voucher.code,
        db: tx,
      });
      return { alreadyApplied: credited.alreadyApplied, amount: voucher.amount, balance: credited.balance };
    });

    return result;
  });
};
