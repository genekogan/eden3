import { describe, expect, it, vi } from 'vitest';

import { ChatMediaCompletionReconciler } from '../src/services/chat-media-reconciler';
import type { SyncTarget } from '../src/services/history-sync';

const target = (id: string): SyncTarget => ({
  session: { id, gatewaySessionKey: `eden3:s:${id}` },
});

describe('ChatMediaCompletionReconciler', () => {
  it('reconciles every durable pending session and isolates one session failure', async () => {
    const targets = [target('session-a'), target('session-b'), target('session-c')];
    const syncSession = vi.fn(async (item: SyncTarget) => {
      if (item.session.id === 'session-b') throw new Error('gateway unavailable');
      return { inserted: 0, backfilled: 0, attachments: 0, historyCount: 0 };
    });
    const errors: string[] = [];
    const reconciler = new ChatMediaCompletionReconciler(
      { syncSession } as never,
      {
        loadTargets: async () => targets,
        onError: (_error, context) => errors.push(context),
      },
    );

    await expect(reconciler.runOnce()).resolves.toEqual({ scanned: 3, synced: 2, failed: 1 });
    expect(syncSession.mock.calls.map(([item]) => item.session.id)).toEqual([
      'session-a',
      'session-b',
      'session-c',
    ]);
    expect(errors).toEqual(['session session-b']);
  });

  it('is single-flight and starts an immediate restart-recovery scan', async () => {
    vi.useFakeTimers();
    try {
      let release!: (targets: SyncTarget[]) => void;
      const firstLoad = new Promise<SyncTarget[]>((resolve) => {
        release = resolve;
      });
      const loadTargets = vi.fn().mockReturnValueOnce(firstLoad).mockResolvedValue([]);
      const syncSession = vi.fn();
      const reconciler = new ChatMediaCompletionReconciler(
        { syncSession } as never,
        { loadTargets, intervalMs: 15_000 },
      );

      reconciler.start();
      await Promise.resolve();
      expect(loadTargets).toHaveBeenCalledTimes(1);
      await expect(reconciler.runOnce()).resolves.toEqual({ scanned: 0, synced: 0, failed: 0 });
      release([]);
      await Promise.resolve();
      reconciler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a stuck gateway history read so later sessions still reconcile', async () => {
    vi.useFakeTimers();
    try {
      const syncSession = vi.fn(
        async (item: SyncTarget, signal?: AbortSignal) =>
          new Promise((resolve, reject) => {
            if (item.session.id !== 'stuck') {
              resolve({ inserted: 0, backfilled: 0, attachments: 0, historyCount: 0 });
              return;
            }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );
      const errors: string[] = [];
      const reconciler = new ChatMediaCompletionReconciler(
        { syncSession } as never,
        {
          loadTargets: async () => [target('stuck'), target('healthy')],
          timeoutMs: 10_000,
          onError: (_error, context) => errors.push(context),
        },
      );

      const run = reconciler.runOnce();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(run).resolves.toEqual({ scanned: 2, synced: 1, failed: 1 });
      expect(syncSession.mock.calls.map(([item]) => item.session.id)).toEqual([
        'stuck',
        'healthy',
      ]);
      expect(errors).toEqual(['session stuck']);
    } finally {
      vi.useRealTimers();
    }
  });
});
