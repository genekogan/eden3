import path from 'node:path';

import { z } from 'zod';

import { databaseNameFromUrl } from './database-url';

/**
 * Typed environment loader for eden3.
 *
 * This module reads `process.env` only — it never loads `.env` files itself.
 * Entrypoints are responsible for populating the environment first (e.g. via
 * `loadRootEnv()` from `@eden3/db`, `node --env-file`, or dotenv).
 */

const portSchema = z.coerce.number().int().min(1).max(65535);
const positiveIntSchema = z.coerce.number().int().min(1);
const nonnegativeIntSchema = z.coerce.number().int().min(0);
const utcHourSchema = z.coerce.number().int().min(0).max(23);
const csvSchema = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : value,
  z.array(z.string().min(1)).default([]),
);
const authProviderSchema = z
  .enum(['dev', 'clerk', 'hybrid'])
  .default('dev');

/** Active closed-cohort signup grant from MVP.md (1,000 manna = $1 peg). */
export const DEFAULT_CLERK_NEW_USER_SEED_MANNA = 100;

export const envSchema = z.object({
  /** Postgres (docker, localhost:5433). */
  DATABASE_URL: z.string().min(1).default('postgres://eden3:eden3@localhost:5433/eden3'),
  /**
   * Logical Postgres database selected for the API and both trusted Compose
   * sidecars. When omitted it is derived from DATABASE_URL; when supplied it
   * must match, so staging cannot silently split API and sidecar state.
   */
  EDEN3_DATABASE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  /** Local fork of prod Mongo (docker, localhost:27018). */
  MONGO_URL: z.string().min(1).default('mongodb://127.0.0.1:27018/eden-prod'),
  /** OpenClaw gateway (single-tenant trusted backend). */
  OPENCLAW_BASE_URL: z.string().min(1).default('http://127.0.0.1:18789'),
  /** Gateway bearer token — no sane default; undefined until configured. */
  OPENCLAW_GATEWAY_TOKEN: z.string().min(1).optional(),
  /** Directory new media files are written into (content-addressed). */
  MEDIA_DIR: z
    .string()
    .min(1)
    .default(() => path.resolve('var', 'media')),
  /**
   * Base URL locally-generated media is served from, stored verbatim on each
   * creation/attachment. Defaults to the SAME-ORIGIN relative `/media` so the
   * browser fetches it against the page origin and the web layer proxies it
   * (next.config rewrites `/media/*` → the API, or a CDN in prod). An absolute
   * API-origin URL here bakes a cross-origin link into every row that only
   * works when the API port is directly browser-reachable — which it is not in
   * production. Set this to the CDN origin when serving media off a CDN.
   */
  MEDIA_BASE_URL: z.string().min(1).default('/media'),
  API_PORT: portSchema.default(4301),
  WEB_PORT: portSchema.default(4300),
  /** Comma-separated dev/operator admin usernames. */
  ADMIN_USERNAMES: csvSchema,
  /**
   * Closed-alpha access gate: comma-separated usernames allowed to use the
   * deployment. Empty (the default) disables the gate entirely — every
   * signed-in account passes. When set, ALL routes 403 with code
   * `access_gated` for anonymous or non-listed accounts, except the paths a
   * gated visitor needs to identify themselves (/health, /auth/*) and
   * signature-authenticated service calls (/billing/webhook). Matching is
   * case-insensitive; admins get no implicit bypass — list them explicitly.
   */
  ACCESS_ALLOWLIST: csvSchema,
  /** Auth mode: dev impersonation, Clerk, or Clerk with dev fallback for localhost. */
  AUTH_PROVIDER: authProviderSchema,
  /**
   * Opt-in gate for the API's /dev routes (account search + impersonation
   * cookie). They mount when AUTH_PROVIDER=dev or this is `1`/`true` — hybrid
   * local stacks need the flag for the dev-cookie flow. Never set it in a
   * real deployment.
   */
  EDEN3_DEV_ROUTES: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  /** Clerk token verification and local auth continuity. */
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_JWT_KEY: z.string().min(1).optional(),
  CLERK_AUTHORIZED_PARTIES: csvSchema,
  /** Seed manna credited once when a brand-new Clerk subject first signs in. */
  CLERK_NEW_USER_SEED_MANNA: nonnegativeIntSchema.default(
    DEFAULT_CLERK_NEW_USER_SEED_MANNA,
  ),
  /** Base64/hex 32-byte AES-GCM key for user channel token custody. */
  CHANNEL_TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  /** Eden3-native agents a non-admin user may create; migrated agents are grandfathered. */
  MAX_NATIVE_AGENTS_PER_USER: nonnegativeIntSchema.default(25),
  /** Scheduled tasks a non-admin user may keep active/non-deleted. */
  MAX_SCHEDULED_TASKS_PER_USER: nonnegativeIntSchema.default(100),
  /** External channel connections a non-admin user may keep connected. */
  MAX_CHANNEL_CONNECTIONS_PER_USER: nonnegativeIntSchema.default(20),
  /** Chat turns a user may have in flight at once for the current local tier. */
  MAX_CONCURRENT_TURNS_PER_USER: nonnegativeIntSchema.default(2),
  /** Tier-specific chat turn concurrency ceilings. Fall back to the local default when unset. */
  MAX_CONCURRENT_TURNS_BASIC: nonnegativeIntSchema.optional(),
  MAX_CONCURRENT_TURNS_PRO: nonnegativeIntSchema.optional(),
  MAX_CONCURRENT_TURNS_BELIEVER: nonnegativeIntSchema.optional(),
  /** Maximum net manna a user may spend on chat turns per UTC day. */
  DAILY_MANNA_SPEND_CAP_PER_USER: nonnegativeIntSchema.default(10_000),
  /**
   * Eden3-side scheduled-task scheduler tick interval. 0 disables the
   * scheduler entirely (it is also disabled when the gateway token is not
   * configured — scheduled runs execute real agent turns).
   */
  TASK_SCHEDULER_INTERVAL_MS: nonnegativeIntSchema.default(30_000),
  /** Eden-managed active-agent memory sweep polling; 0 disables it. */
  MEMORY_DREAM_SCHEDULER_INTERVAL_MS: nonnegativeIntSchema.default(60_000),
  /** First UTC hour in which the once-daily idempotent memory sweep may claim. */
  MEMORY_DREAM_HOUR_UTC: utcHourSchema.default(7),
  /** Fastify JSON/body parser ceiling. */
  API_BODY_LIMIT_BYTES: positiveIntSchema.default(1_000_000),
  /** Fixed-window per-client API rate-limit interval. */
  API_RATE_LIMIT_WINDOW_MS: positiveIntSchema.default(60_000),
  /** Requests per client per fixed window. */
  API_RATE_LIMIT_MAX: nonnegativeIntSchema.default(600),
  /** Fixed-window interval for authenticated per-account request admission. */
  API_ACCOUNT_RATE_LIMIT_WINDOW_MS: positiveIntSchema.default(60_000),
  /** Requests per authenticated account per fixed window. */
  API_ACCOUNT_RATE_LIMIT_MAX: nonnegativeIntSchema.default(600),
  /** Process-local burst window for genuinely new Clerk subjects from one client IP. */
  CLERK_SIGNUP_RATE_LIMIT_WINDOW_MS: positiveIntSchema.default(60 * 60 * 1_000),
  /** New Clerk accounts admitted from one client IP per process-local burst window. */
  CLERK_SIGNUP_RATE_LIMIT_MAX: nonnegativeIntSchema.default(3),
  /** Stripe secret key; optional until billing routes are exercised. */
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  /** Closed-door billing mode. Live mode is introduced only by the later switch ceremony. */
  STRIPE_MODE: z.literal('test').default('test'),
  /** Stripe webhook signing secret for /billing/webhook. */
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Stripe Checkout Price id for one-time manna top-ups. */
  STRIPE_MANNA_TOPUP_PRICE_ID: z.string().min(1).optional(),
  /** Manna credited by the configured one-time top-up price. */
  STRIPE_MANNA_TOPUP_AMOUNT: positiveIntSchema.default(10_000),
  /** Stripe Checkout subscription Price ids for Eden tiers. */
  STRIPE_SUBSCRIPTION_BASIC_PRICE_ID: z.string().min(1).optional(),
  STRIPE_SUBSCRIPTION_PRO_PRICE_ID: z.string().min(1).optional(),
  STRIPE_SUBSCRIPTION_BELIEVER_PRICE_ID: z.string().min(1).optional(),
  /** Monthly subscription manna grants by Eden tier. */
  STRIPE_SUBSCRIPTION_BASIC_MONTHLY_MANNA: nonnegativeIntSchema.default(10_000),
  STRIPE_SUBSCRIPTION_PRO_MONTHLY_MANNA: nonnegativeIntSchema.default(35_000),
  STRIPE_SUBSCRIPTION_BELIEVER_MONTHLY_MANNA: nonnegativeIntSchema.default(100_000),
  /** Checkout redirects. Defaults are local web pages that can be implemented later. */
  BILLING_SUCCESS_URL: z.string().min(1).optional(),
  BILLING_CANCEL_URL: z.string().min(1).optional(),
}).transform((env, ctx) => {
  const fromUrl = databaseNameFromUrl(env.DATABASE_URL);
  if (fromUrl === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message: 'must be a postgres URL with one valid logical database name',
    });
  }
  if (env.EDEN3_DATABASE_NAME !== undefined && fromUrl !== null && env.EDEN3_DATABASE_NAME !== fromUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EDEN3_DATABASE_NAME'],
      message: `must match DATABASE_URL database "${fromUrl}"`,
    });
  }
  if (env.STRIPE_SECRET_KEY !== undefined && !env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STRIPE_SECRET_KEY'],
      message: 'must be an sk_test_ test-mode secret while Eden3 doors are closed',
    });
  }
  const stripePrices = [
    env.STRIPE_MANNA_TOPUP_PRICE_ID,
    env.STRIPE_SUBSCRIPTION_BASIC_PRICE_ID,
    env.STRIPE_SUBSCRIPTION_PRO_PRICE_ID,
    env.STRIPE_SUBSCRIPTION_BELIEVER_PRICE_ID,
  ].filter((value): value is string => value !== undefined);
  if (new Set(stripePrices).size !== stripePrices.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STRIPE_MANNA_TOPUP_PRICE_ID'],
      message: 'Stripe *_PRICE_ID values must be unique',
    });
  }
  return {
    ...env,
    EDEN3_DATABASE_NAME: env.EDEN3_DATABASE_NAME ?? fromUrl ?? '',
  };
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    const detail = issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    super(`Invalid environment: ${detail}`);
    this.name = 'EnvError';
  }
}

/**
 * Parse an environment object (defaults to `process.env`) into a typed `Env`.
 * Empty-string values are treated as unset so `FOO=` in a shell or .env file
 * falls back to the default. Throws {@link EnvError} on invalid values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) throw new EnvError(parsed.error.issues);
  return parsed.data;
}

let cached: Env | null = null;

/** Lazily-parsed, cached view of `process.env`. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Drop the {@link getEnv} cache (tests, or after mutating `process.env`). */
export function resetEnvCache(): void {
  cached = null;
}
