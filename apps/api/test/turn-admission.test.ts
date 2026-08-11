import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TurnConcurrencyLimiter,
  type TurnAdmissionResult,
} from '../src/services/chat-limits';

function admitted(result: TurnAdmissionResult) {
  if (!result.admitted) throw new Error(`expected admission, received ${result.reason}`);
  return result;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('process-wide turn admission', () => {
  it('holds the global active ceiling and releases one bounded waiter', async () => {
    const limiter = new TurnConcurrencyLimiter({
      globalLimit: 1,
      queueLimit: 2,
      queueTimeoutMs: 30_000,
    });
    const first = admitted(await limiter.admit('account-a', 2));
    let secondSettled = false;
    const secondPromise = limiter.admit('account-b', 2).then((result) => {
      secondSettled = true;
      return result;
    });

    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(limiter.snapshot()).toMatchObject({ active: 1, queued: 1 });

    first.release();
    const second = admitted(await secondPromise);
    expect(second.queued).toBe(true);
    expect(limiter.snapshot()).toMatchObject({ active: 1, queued: 0, queuedGranted: 1 });
    second.release();
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('round-robins account queues so one account cannot monopolize release order', async () => {
    const limiter = new TurnConcurrencyLimiter({
      globalLimit: 1,
      queueLimit: 4,
      queueTimeoutMs: 30_000,
    });
    const active = admitted(await limiter.admit('active', 1));
    const b1Promise = limiter.admit('b', 2);
    const b2Promise = limiter.admit('b', 2);
    const cPromise = limiter.admit('c', 1);

    active.release();
    const b1 = admitted(await b1Promise);
    let b2Settled = false;
    void b2Promise.then(() => { b2Settled = true; });
    let cSettled = false;
    void cPromise.then(() => { cSettled = true; });
    await Promise.resolve();
    expect(b2Settled).toBe(false);
    expect(cSettled).toBe(false);

    b1.release();
    const c = admitted(await cPromise);
    await Promise.resolve();
    expect(b2Settled).toBe(false);

    c.release();
    const b2 = admitted(await b2Promise);
    b2.release();
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0, queuedGranted: 3 });
  });

  it('fails closed when the account demand or global queue bound is exhausted', async () => {
    const limiter = new TurnConcurrencyLimiter({
      globalLimit: 1,
      queueLimit: 1,
      queueTimeoutMs: 30_000,
    });
    const first = admitted(await limiter.admit('account-a', 1));
    await expect(limiter.admit('account-a', 1)).resolves.toEqual({
      admitted: false,
      reason: 'per_account_limit',
    });
    const queued = limiter.admit('account-b', 1);
    await expect(limiter.admit('account-c', 1)).resolves.toEqual({
      admitted: false,
      reason: 'queue_full',
    });

    first.release();
    admitted(await queued).release();
    expect(limiter.snapshot()).toMatchObject({
      rejectedPerAccount: 1,
      rejectedQueueFull: 1,
    });
  });

  it('times out without provider admission and ignores later releases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T20:00:00Z'));
    const limiter = new TurnConcurrencyLimiter({
      globalLimit: 1,
      queueLimit: 1,
      queueTimeoutMs: 5_000,
    });
    const first = admitted(await limiter.admit('account-a', 1));
    const queued = limiter.admit('account-b', 1);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(queued).resolves.toEqual({ admitted: false, reason: 'queue_timeout' });
    expect(limiter.snapshot()).toMatchObject({ active: 1, queued: 0, timedOut: 1 });

    first.release();
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0, granted: 1 });
  });

  it('closes queued work exactly once while allowing active releases to settle', async () => {
    const limiter = new TurnConcurrencyLimiter({
      globalLimit: 1,
      queueLimit: 2,
      queueTimeoutMs: 30_000,
    });
    const first = admitted(await limiter.admit('account-a', 1));
    const queued = limiter.admit('account-b', 1);
    limiter.close();
    limiter.close();

    await expect(queued).resolves.toEqual({ admitted: false, reason: 'closed' });
    await expect(limiter.admit('account-c', 1)).resolves.toEqual({
      admitted: false,
      reason: 'closed',
    });
    first.release();
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('removes a disconnected queued request without consuming a later slot', async () => {
    const limiter = new TurnConcurrencyLimiter({
      globalLimit: 1,
      queueLimit: 2,
      queueTimeoutMs: 30_000,
    });
    const first = admitted(await limiter.admit('account-a', 1));
    const controller = new AbortController();
    const abandoned = limiter.admit('account-b', 1, { signal: controller.signal });
    controller.abort();

    await expect(abandoned).resolves.toEqual({ admitted: false, reason: 'request_aborted' });
    expect(limiter.snapshot()).toMatchObject({ active: 1, queued: 0 });
    first.release();
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0, granted: 1 });
  });
});
