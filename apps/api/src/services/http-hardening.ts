import type { FastifyInstance, FastifyRequest } from 'fastify';

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

  constructor(private readonly options: FixedWindowRateLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  hit(key: string): RateLimitResult {
    const now = this.now();
    const current = this.buckets.get(key);
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

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function clientKey(req: FastifyRequest): string {
  const forwardedFor = headerValue(req.headers['x-forwarded-for']);
  const forwardedClient = forwardedFor?.split(',')[0]?.trim();
  return forwardedClient || req.ip || 'unknown';
}

export function registerHttpHardening(
  app: FastifyInstance,
  opts: { rateLimit: { windowMs: number; max: number } },
): void {
  const limiter = new FixedWindowRateLimiter(opts.rateLimit);
  app.addHook('onRequest', async (req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (req.method === 'OPTIONS') return;

    const result = limiter.hit(clientKey(req));
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
  });
}
