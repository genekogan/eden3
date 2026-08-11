import { getEnv, netSpendSince } from '@eden3/core';
import { pg } from '@eden3/db';

export type TurnAdmissionRejection =
  | 'closed'
  | 'per_account_limit'
  | 'request_aborted'
  | 'queue_full'
  | 'queue_timeout';

export type TurnAdmissionResult =
  | {
      admitted: true;
      queued: boolean;
      queueWaitMs: number;
      release: () => void;
    }
  | {
      admitted: false;
      reason: TurnAdmissionRejection;
    };

interface QueuedTurn {
  accountId: string;
  limit: number;
  enqueuedAt: number;
  resolve: (result: TurnAdmissionResult) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface TurnConcurrencySnapshot {
  active: number;
  queued: number;
  activeAccounts: number;
  queuedAccounts: number;
  globalLimit: number;
  queueLimit: number;
  granted: number;
  queuedGranted: number;
  rejectedPerAccount: number;
  rejectedQueueFull: number;
  timedOut: number;
  maxQueueWaitMs: number;
}

export class TurnConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, QueuedTurn[]>();
  private readonly queueOrder: string[] = [];
  private totalActive = 0;
  private totalQueued = 0;
  private closed = false;
  private granted = 0;
  private queuedGranted = 0;
  private rejectedPerAccount = 0;
  private rejectedQueueFull = 0;
  private timedOut = 0;
  private maxQueueWaitMs = 0;

  constructor(private readonly options: {
    globalLimit?: number;
    queueLimit?: number;
    queueTimeoutMs?: number;
  } = {}) {
    const globalLimit = options.globalLimit ?? Number.MAX_SAFE_INTEGER;
    const queueLimit = options.queueLimit ?? 0;
    const queueTimeoutMs = options.queueTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(globalLimit) || globalLimit < 1) {
      throw new Error('global turn concurrency limit must be a positive integer');
    }
    if (!Number.isSafeInteger(queueLimit) || queueLimit < 0) {
      throw new Error('global turn queue limit must be a nonnegative integer');
    }
    if (!Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1) {
      throw new Error('turn queue timeout must be a positive integer');
    }
  }

  private get globalLimit(): number {
    return this.options.globalLimit ?? Number.MAX_SAFE_INTEGER;
  }

  private get queueLimit(): number {
    return this.options.queueLimit ?? 0;
  }

  private get queueTimeoutMs(): number {
    return this.options.queueTimeoutMs ?? 30_000;
  }

  activeCount(accountId: string): number {
    return this.active.get(accountId) ?? 0;
  }

  queuedCount(accountId: string): number {
    return this.queues.get(accountId)?.length ?? 0;
  }

  snapshot(): TurnConcurrencySnapshot {
    return {
      active: this.totalActive,
      queued: this.totalQueued,
      activeAccounts: this.active.size,
      queuedAccounts: this.queues.size,
      globalLimit: this.globalLimit,
      queueLimit: this.queueLimit,
      granted: this.granted,
      queuedGranted: this.queuedGranted,
      rejectedPerAccount: this.rejectedPerAccount,
      rejectedQueueFull: this.rejectedQueueFull,
      timedOut: this.timedOut,
      maxQueueWaitMs: this.maxQueueWaitMs,
    };
  }

  private grant(accountId: string, queued: boolean, enqueuedAt = Date.now()): TurnAdmissionResult {
    this.active.set(accountId, this.activeCount(accountId) + 1);
    this.totalActive += 1;
    this.granted += 1;
    const queueWaitMs = queued ? Math.max(0, Date.now() - enqueuedAt) : 0;
    if (queued) {
      this.queuedGranted += 1;
      this.maxQueueWaitMs = Math.max(this.maxQueueWaitMs, queueWaitMs);
    }
    let released = false;
    return {
      admitted: true,
      queued,
      queueWaitMs,
      release: () => {
        if (released) return;
        released = true;
        const next = this.activeCount(accountId) - 1;
        if (next > 0) this.active.set(accountId, next);
        else this.active.delete(accountId);
        this.totalActive -= 1;
        this.drain();
      },
    };
  }

  acquire(accountId: string, limit: number): (() => void) | null {
    if (this.closed || limit <= 0 || this.totalActive >= this.globalLimit || this.totalQueued > 0) {
      return null;
    }
    const current = this.activeCount(accountId);
    if (current >= limit) return null;
    const admission = this.grant(accountId, false);
    return admission.admitted ? admission.release : null;
  }

  async admit(
    accountId: string,
    limit: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<TurnAdmissionResult> {
    if (this.closed) return { admitted: false, reason: 'closed' };
    if (options.signal?.aborted) return { admitted: false, reason: 'request_aborted' };
    if (limit <= 0 || this.activeCount(accountId) + this.queuedCount(accountId) >= limit) {
      this.rejectedPerAccount += 1;
      return { admitted: false, reason: 'per_account_limit' };
    }
    if (this.totalActive < this.globalLimit && this.totalQueued === 0) {
      return this.grant(accountId, false);
    }
    if (this.queueLimit === 0 || this.totalQueued >= this.queueLimit) {
      this.rejectedQueueFull += 1;
      return { admitted: false, reason: 'queue_full' };
    }

    return await new Promise<TurnAdmissionResult>((resolve) => {
      const queue = this.queues.get(accountId) ?? [];
      const waiter: QueuedTurn = {
        accountId,
        limit,
        enqueuedAt: Date.now(),
        resolve,
        timer: setTimeout(() => this.expire(waiter), this.queueTimeoutMs),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        waiter.onAbort = () => this.abort(waiter);
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      waiter.timer.unref?.();
      if (queue.length === 0) this.queueOrder.push(accountId);
      queue.push(waiter);
      this.queues.set(accountId, queue);
      this.totalQueued += 1;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const queue of this.queues.values()) {
      for (const waiter of queue) {
        clearTimeout(waiter.timer);
        this.removeAbortListener(waiter);
        waiter.resolve({ admitted: false, reason: 'closed' });
      }
    }
    this.queues.clear();
    this.queueOrder.length = 0;
    this.totalQueued = 0;
  }

  private expire(waiter: QueuedTurn): void {
    const queue = this.queues.get(waiter.accountId);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index < 0) return;
    queue.splice(index, 1);
    this.totalQueued -= 1;
    if (queue.length === 0) {
      this.queues.delete(waiter.accountId);
      const orderIndex = this.queueOrder.indexOf(waiter.accountId);
      if (orderIndex >= 0) this.queueOrder.splice(orderIndex, 1);
    }
    this.timedOut += 1;
    this.removeAbortListener(waiter);
    waiter.resolve({ admitted: false, reason: 'queue_timeout' });
  }

  private abort(waiter: QueuedTurn): void {
    const queue = this.queues.get(waiter.accountId);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index < 0) return;
    queue.splice(index, 1);
    this.totalQueued -= 1;
    clearTimeout(waiter.timer);
    this.removeAbortListener(waiter);
    if (queue.length === 0) {
      this.queues.delete(waiter.accountId);
      const orderIndex = this.queueOrder.indexOf(waiter.accountId);
      if (orderIndex >= 0) this.queueOrder.splice(orderIndex, 1);
    }
    waiter.resolve({ admitted: false, reason: 'request_aborted' });
  }

  private removeAbortListener(waiter: QueuedTurn): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      delete waiter.onAbort;
    }
  }

  private drain(): void {
    if (this.closed) return;
    while (this.totalActive < this.globalLimit && this.totalQueued > 0) {
      let grantedOne = false;
      const accountsToTry = this.queueOrder.length;
      for (let index = 0; index < accountsToTry; index += 1) {
        const accountId = this.queueOrder.shift();
        if (!accountId) break;
        const queue = this.queues.get(accountId);
        if (!queue || queue.length === 0) continue;
        const waiter = queue[0]!;
        if (this.activeCount(accountId) >= waiter.limit) {
          this.queueOrder.push(accountId);
          continue;
        }

        queue.shift();
        this.totalQueued -= 1;
        clearTimeout(waiter.timer);
        this.removeAbortListener(waiter);
        if (queue.length > 0) this.queueOrder.push(accountId);
        else this.queues.delete(accountId);
        waiter.resolve(this.grant(accountId, true, waiter.enqueuedAt));
        grantedOne = true;
        break;
      }
      if (!grantedOne) break;
    }
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
