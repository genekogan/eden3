import { getEnv, netSpendSince } from '@eden3/core';
import { pg } from '@eden3/db';

export class TurnConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  activeCount(accountId: string): number {
    return this.active.get(accountId) ?? 0;
  }

  acquire(accountId: string, limit: number): (() => void) | null {
    if (limit <= 0) return null;
    const current = this.activeCount(accountId);
    if (current >= limit) return null;

    this.active.set(accountId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.activeCount(accountId) - 1;
      if (next > 0) this.active.set(accountId, next);
      else this.active.delete(accountId);
    };
  }
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Fast-path read of today's net spend for friendly pre-checks. The
 * authoritative, race-free enforcement is `debit({dailyCap})` in @eden3/core.
 */
export async function dailyMannaSpend(
  accountId: string,
  opts: { now?: Date } = {},
): Promise<number> {
  return netSpendSince(accountId, startOfUtcDay(opts.now ?? new Date()));
}

export type SubscriptionTier = 'basic' | 'pro' | 'believer';

const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'checkout_completed'];

function tierRank(tier: string | null): number {
  switch (tier) {
    case 'believer':
      return 3;
    case 'pro':
      return 2;
    case 'basic':
      return 1;
    default:
      return 0;
  }
}

function tierLimit(tier: SubscriptionTier | null): number {
  const env = getEnv();
  switch (tier) {
    case 'basic':
      return env.MAX_CONCURRENT_TURNS_BASIC ?? env.MAX_CONCURRENT_TURNS_PER_USER;
    case 'pro':
      return env.MAX_CONCURRENT_TURNS_PRO ?? env.MAX_CONCURRENT_TURNS_PER_USER;
    case 'believer':
      return env.MAX_CONCURRENT_TURNS_BELIEVER ?? env.MAX_CONCURRENT_TURNS_PER_USER;
    default:
      return env.MAX_CONCURRENT_TURNS_PER_USER;
  }
}

export async function activeSubscriptionTier(accountId: string): Promise<SubscriptionTier | null> {
  const rows = await pg<{ tier: string | null }[]>`
    select tier
    from billing_subscriptions
    where account_id = ${accountId}
      and status = any(${ACTIVE_SUBSCRIPTION_STATUSES}::text[])
    order by updated_at desc, created_at desc
    limit 20
  `;
  let best: SubscriptionTier | null = null;
  for (const row of rows) {
    if (row.tier === 'basic' || row.tier === 'pro' || row.tier === 'believer') {
      if (tierRank(row.tier) > tierRank(best)) best = row.tier;
    }
  }
  return best;
}

export async function concurrentTurnLimit(accountId: string): Promise<{
  limit: number;
  tier: SubscriptionTier | null;
}> {
  const tier = await activeSubscriptionTier(accountId);
  return { limit: tierLimit(tier), tier };
}
