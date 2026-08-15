import { describe, expect, it, vi } from 'vitest';

import {
  reconcileDirectVoiceAndPublish,
  startVoiceReconciliation,
  stopVoiceReconciliation,
  voiceReconcilerFlight,
} from '../src/server';

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe('voice reconciler liveness', () => {
  it('publishes one refresh only for each atomically recovered direct attachment', async () => {
    const publish = vi.fn();
    const reconcileDirectVoiceJobs = vi.fn(async () => ({
      processed: 3,
      settled: [{ sessionId: '22222222-2222-4222-8222-222222222222', messageId: '33333333-3333-4333-8333-333333333333' }],
    }));
    await expect(reconcileDirectVoiceAndPublish(
      { reconcileDirectVoiceJobs } as never,
      { publish },
    )).resolves.toBe(3);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', {
      type: 'session.messages.changed',
      sessionId: '22222222-2222-4222-8222-222222222222',
      messageId: '33333333-3333-4333-8333-333333333333',
    });

    publish.mockClear();
    await reconcileDirectVoiceAndPublish({
      reconcileDirectVoiceJobs: vi.fn(async () => ({ processed: 2, settled: [] })),
    } as never, { publish });
    expect(publish).not.toHaveBeenCalled();
    await expect(reconcileDirectVoiceAndPublish({
      reconcileDirectVoiceJobs: vi.fn(async () => { throw new Error('failed'); }),
    } as never, { publish })).rejects.toThrow('failed');
    expect(publish).not.toHaveBeenCalled();
  });

  it('starts without awaiting provider work and suppresses overlapping ticks', async () => {
    let release!: () => void;
    const neverUntilReleased = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(async (_signal: AbortSignal) => await neverUntilReleased);
    const onError = vi.fn();
    const flight = voiceReconcilerFlight();

    expect(startVoiceReconciliation(flight, task, onError)).toBe(true);
    await flushMicrotasks();
    expect(flight.running).toBe(true);
    expect(startVoiceReconciliation(flight, task, onError)).toBe(false);
    expect(task).toHaveBeenCalledTimes(1);

    release();
    await neverUntilReleased;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flight.running).toBe(false);
    expect(startVoiceReconciliation(flight, async () => undefined, onError)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('logs a rejected flight and releases the single-flight gate', async () => {
    const failure = new Error('provider offline');
    const onError = vi.fn();
    const flight = voiceReconcilerFlight();
    expect(startVoiceReconciliation(flight, async () => { throw failure; }, onError)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith(failure);
    expect(flight.running).toBe(false);
  });

  it('times out one provider family without starving an independent family', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const clones = voiceReconcilerFlight();
    const direct = voiceReconcilerFlight();
    const never = new Promise<void>(() => undefined);
    const directWork = vi.fn(async () => undefined);
    try {
      expect(startVoiceReconciliation(clones, async () => await never, onError, 50)).toBe(true);
      expect(startVoiceReconciliation(direct, directWork, onError, 50)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(directWork).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(50);
      expect(clones.running).toBe(false);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(startVoiceReconciliation(direct, directWork, onError, 50)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(directWork).toHaveBeenCalledTimes(2);
    } finally {
      stopVoiceReconciliation(clones);
      stopVoiceReconciliation(direct);
      vi.useRealTimers();
    }
  });

  it('fences a timed-out generation so its late settlement cannot mutate or clear the next run', async () => {
    vi.useFakeTimers();
    let releaseOld!: () => void;
    const oldWait = new Promise<void>((resolve) => { releaseOld = resolve; });
    const mutations: string[] = [];
    const onError = vi.fn();
    const flight = voiceReconcilerFlight();
    try {
      startVoiceReconciliation(flight, async (signal) => {
        await oldWait;
        signal.throwIfAborted();
        mutations.push('old');
      }, onError, 50);
      await vi.advanceTimersByTimeAsync(50);
      expect(flight.running).toBe(false);
      startVoiceReconciliation(flight, async (signal) => {
        signal.throwIfAborted();
        mutations.push('new');
      }, onError, 50);
      await flushMicrotasks();
      expect(mutations).toEqual(['new']);
      expect(flight.running).toBe(false);
      releaseOld();
      await Promise.resolve();
      await Promise.resolve();
      expect(mutations).toEqual(['new']);
      expect(flight.running).toBe(false);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      stopVoiceReconciliation(flight);
      vi.useRealTimers();
    }
  });
});
