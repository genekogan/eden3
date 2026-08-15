import { describe, expect, it, vi } from 'vitest';

import { settleVoiceReconciliationTasks, startVoiceReconciliation } from '../src/server';

describe('voice reconciler liveness', () => {
  it('starts without awaiting provider work and suppresses overlapping ticks', async () => {
    let release!: () => void;
    const neverUntilReleased = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(() => neverUntilReleased);
    const onError = vi.fn();
    const flight = { running: false };

    expect(startVoiceReconciliation(flight, task, onError)).toBe(true);
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
    const flight = { running: false };
    expect(startVoiceReconciliation(flight, async () => { throw failure; }, onError)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith(failure);
    expect(flight.running).toBe(false);
  });

  it('keeps the gate closed until every sibling settles after an early rejection', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const onError = vi.fn();
    const flight = { running: false };
    const task = () => settleVoiceReconciliationTasks([
      async () => { throw new Error('first failed'); },
      async () => await slow,
    ]);
    expect(startVoiceReconciliation(flight, task, onError)).toBe(true);
    await Promise.resolve();
    expect(flight.running).toBe(true);
    expect(startVoiceReconciliation(flight, task, onError)).toBe(false);
    release();
    await slow;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flight.running).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
