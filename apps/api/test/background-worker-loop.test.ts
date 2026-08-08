import { describe, expect, it, vi } from 'vitest';

import { startBackgroundWorkerLoop } from '../src/services/background-worker-loop';

describe('background worker loop', () => {
  it('awaits the first tick, coalesces overlap, unrefs, and stops cleanly', async () => {
    let scheduled: () => void = () => {
      throw new Error('worker interval was not scheduled');
    };
    let resolveBlocked: () => void = () => {
      throw new Error('blocking tick was not started');
    };
    let calls = 0;
    const unref = vi.fn();
    const cancel = vi.fn();
    const results: number[] = [];

    const loop = await startBackgroundWorkerLoop({
      intervalMs: 60_000,
      tick: async () => {
        calls += 1;
        if (calls === 2) {
          await new Promise<void>((resolve) => {
            resolveBlocked = resolve;
          });
        }
        return calls;
      },
      onResult: (result) => results.push(result),
      onError: () => undefined,
      schedule: (callback) => {
        scheduled = callback;
        return { unref } as unknown as ReturnType<typeof setInterval>;
      },
      cancel,
    });

    expect(calls).toBe(1);
    expect(results).toEqual([1]);
    expect(unref).toHaveBeenCalledOnce();

    scheduled();
    scheduled();
    await vi.waitFor(() => expect(calls).toBe(2));
    resolveBlocked();
    await vi.waitFor(() => expect(results).toEqual([1, 2]));

    scheduled();
    await vi.waitFor(() => expect(calls).toBe(3));
    await loop.stop();
    expect(cancel).toHaveBeenCalledOnce();
    scheduled();
    await Promise.resolve();
    expect(calls).toBe(3);
  });

  it('reports a rejected immediate tick and still schedules later work', async () => {
    const error = new Error('synthetic failure');
    const onError = vi.fn();
    const unref = vi.fn();
    let scheduled = false;
    const loop = await startBackgroundWorkerLoop({
      intervalMs: 1,
      tick: async () => {
        throw error;
      },
      onResult: () => undefined,
      onError,
      schedule: () => {
        scheduled = true;
        return { unref } as unknown as ReturnType<typeof setInterval>;
      },
      cancel: () => undefined,
    });

    expect(onError).toHaveBeenCalledWith(error);
    expect(scheduled).toBe(true);
    await loop.stop();
  });
});
