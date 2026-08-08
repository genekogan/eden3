import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ApiError } from '../errors';

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'cross-origin-resource-policy': 'same-site',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

interface RateLimitBucket {
  windowStartedAt: number;
  count: number;
}

export interface FixedWindowRateLimiterOptions {
  windowMs: number;
  max: number;
  now?: () => number;
  /** Bound attacker-controlled cardinality; new keys fail closed at capacity. */
  maxBuckets?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly now: () => number;
  private readonly maxBuckets: number;

  constructor(private readonly options: FixedWindowRateLimiterOptions) {
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError('rate-limit windowMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(options.max) || options.max < 0) {
      throw new RangeError('rate-limit max must be a nonnegative safe integer');
    }
    if (
      options.maxBuckets !== undefined &&
      (!Number.isSafeInteger(options.maxBuckets) || options.maxBuckets <= 0)
    ) {
      throw new RangeError('rate-limit maxBuckets must be a positive safe integer');
    }
    this.now = options.now ?? Date.now;
    this.maxBuckets = options.maxBuckets ?? 10_000;
  }

  hit(key: string): RateLimitResult {
    const now = this.now();
    const current = this.buckets.get(key);
    if (current && now - current.windowStartedAt >= this.options.windowMs) {
      this.buckets.delete(key);
    }
    if (!this.buckets.has(key) && this.buckets.size >= this.maxBuckets) {
      // Capacity is attacker-influenced, but expiry is time-based. Reclaim in
      // one bounded pass before denying a genuinely new client forever.
      for (const [bucketKey, bucket] of this.buckets) {
        if (now - bucket.windowStartedAt >= this.options.windowMs) {
          this.buckets.delete(bucketKey);
        }
      }
    }
    if (!this.buckets.has(key) && this.buckets.size >= this.maxBuckets) {
      return {
        allowed: false,
        limit: this.options.max,
        remaining: 0,
        retryAfterMs: this.options.windowMs,
        resetAt: now + this.options.windowMs,
      };
    }
    const bucket =
      current && now - current.windowStartedAt < this.options.windowMs
        ? current
        : { windowStartedAt: now, count: 0 };
    bucket.count += 1;
    this.buckets.set(key, bucket);

    const resetAt = bucket.windowStartedAt + this.options.windowMs;
    const remaining = Math.max(0, this.options.max - bucket.count);
    return {
      allowed: bucket.count <= this.options.max,
      limit: this.options.max,
      remaining,
      retryAfterMs: Math.max(0, resetAt - now),
      resetAt,
    };
  }
}

export function proxySafeClientKey(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

type RateLimitBypass = (req: FastifyRequest) => boolean;
type ServiceCallbackAdmission = (
  req: FastifyRequest,
  reply: FastifyReply,
) => boolean | Promise<boolean>;

function enforceRateLimit(
  limiter: FixedWindowRateLimiter,
  key: string,
  reply: FastifyReply,
): void {
  const result = limiter.hit(key);
  reply.header('x-ratelimit-limit', String(result.limit));
  reply.header('x-ratelimit-remaining', String(result.remaining));
  reply.header('x-ratelimit-reset', String(Math.ceil(result.resetAt / 1000)));
  if (!result.allowed) {
    reply.header('retry-after', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    throw new ApiError(
      429,
      'rate_limited',
      `Too many requests; retry after ${Math.max(1, Math.ceil(result.retryAfterMs / 1000))}s`,
    );
  }
}

export function registerHttpHardening(
  app: FastifyInstance,
  opts: {
    rateLimit: { windowMs: number; max: number; maxBuckets?: number };
    /** Run the exact root-bound callback guard before granting its bypass. */
    serviceCallbackAdmission?: ServiceCallbackAdmission;
  },
): void {
  const limiter = new FixedWindowRateLimiter(opts.rateLimit);
  app.addHook('onRequest', async (req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (req.method === 'OPTIONS') return;
    if (opts.serviceCallbackAdmission && await opts.serviceCallbackAdmission(req, reply)) return;
    if (reply.sent) return;
    enforceRateLimit(limiter, `ip:${proxySafeClientKey(req)}`, reply);
  });
}

/**
 * Authenticated tenant admission. Register after registerAuth so request.account
 * is resolved, but before resource routes so a rejected request cannot debit or
 * reach a provider. Service callbacks remain owned by their root-bound guard.
 */
export function registerAccountRateLimiting(
  app: FastifyInstance,
  opts: {
    rateLimit: { windowMs: number; max: number; maxBuckets?: number };
    bypass?: RateLimitBypass;
  },
): void {
  const limiter = new FixedWindowRateLimiter(opts.rateLimit);
  app.addHook('onRequest', async (req, reply) => {
    if (reply.sent || req.method === 'OPTIONS' || opts.bypass?.(req) === true) return;
    const accountId = req.account?.accountId;
    if (!accountId) return;
    enforceRateLimit(limiter, `account:${accountId}`, reply);
  });
}
