import { describe, expect, it, vi } from 'vitest';

import type {
  ClaimedPolicyEvent,
  PolicyEventMetrics,
  UploadPolicyEventStore,
} from '../src/services/upload-repository';
import { UploadPolicyEventWorker } from '../src/services/upload-policy-events';

const CLAIM: ClaimedPolicyEvent = {
  id: 'event-1',
  objectId: '00000000-0000-4000-8000-000000000001',
  ownerAccountId: '00000000-0000-4000-8000-000000000002',
  policyCode: 'synthetic_policy_match',
  state: 'delivering',
  attemptCount: 1,
  claimToken: 'claim-1',
};

class MetricTruthStore implements UploadPolicyEventStore {
  claimCalls = 0;
  markDelivered = true;
  retryOutcome: 'pending' | 'failed' | 'stale' = 'pending';
  claims: ClaimedPolicyEvent[] = [CLAIM];
  recovery = { requeued: 0, failed: 0 };
  metrics: PolicyEventMetrics = {
    pending: 0,
    claimed: 0,
    failed: 0,
    oldestPendingAgeMs: 0,
    maxAttemptCount: 1,
  };

  async recoverExpiredPolicyEvents(): Promise<{ requeued: number; failed: number }> {
    return this.recovery;
  }

  async claimDuePolicyEvents(): Promise<ClaimedPolicyEvent[]> {
    this.claimCalls += 1;
    return this.claims.map((claim) => ({ ...claim, claimToken: `claim-${this.claimCalls}` }));
  }

  async markPolicyEventDelivered(): Promise<boolean> {
    return this.markDelivered;
  }

  async retryPolicyEvent(): Promise<'pending' | 'failed' | 'stale'> {
    return this.retryOutcome;
  }

  async policyEventMetrics(): Promise<PolicyEventMetrics> {
    return this.metrics;
  }
}

describe('upload policy outbox operator truth (DEBT-020)', () => {
  it('does not report delivery when the final claim-token CAS loses', async () => {
    const store = new MetricTruthStore();
    store.markDelivered = false;
    const worker = new UploadPolicyEventWorker({
      store,
      sink: { deliver: async () => undefined },
    });

    await expect(worker.tick()).resolves.toMatchObject({
      claimed: 1,
      delivered: 0,
      retried: 0,
      stale: 1,
    });
  });

  it('does not report a retry when the retry CAS loses', async () => {
    const store = new MetricTruthStore();
    store.retryOutcome = 'stale';
    const worker = new UploadPolicyEventWorker({
      store,
      sink: { deliver: async () => { throw new Error('synthetic sink outage'); } },
    });

    await expect(worker.tick()).resolves.toMatchObject({
      claimed: 1,
      delivered: 0,
      retried: 0,
      stale: 1,
    });
  });

  it('reports exhausted delivery attempts as terminal instead of retried', async () => {
    const store = new MetricTruthStore();
    store.retryOutcome = 'failed';
    const worker = new UploadPolicyEventWorker({
      store,
      sink: { deliver: async () => { throw new Error('synthetic terminal outage'); } },
    });

    await expect(worker.tick()).resolves.toMatchObject({
      claimed: 1,
      delivered: 0,
      retried: 0,
      terminalFailed: 1,
      stale: 0,
    });
  });

  it('reports restart recovery and durable backlog metrics without inventing delivery work', async () => {
    const store = new MetricTruthStore();
    store.claims = [];
    store.recovery = { requeued: 2, failed: 1 };
    store.metrics = {
      pending: 2,
      claimed: 0,
      failed: 1,
      oldestPendingAgeMs: 12_345,
      maxAttemptCount: 5,
    };
    const worker = new UploadPolicyEventWorker({
      store,
      sink: { deliver: async () => undefined },
    });

    await expect(worker.tick()).resolves.toEqual({
      recovered: 2,
      recoveryFailed: 1,
      claimed: 0,
      delivered: 0,
      retried: 0,
      terminalFailed: 0,
      stale: 0,
      metrics: store.metrics,
    });
  });

  it('coalesces request-path and background ticks into one bounded claim batch', async () => {
    const store = new MetricTruthStore();
    let release: () => void = () => undefined;
    let deliveries = 0;
    const worker = new UploadPolicyEventWorker({
      store,
      sink: {
        deliver: async () => {
          deliveries += 1;
          await new Promise<void>((resolve) => { release = resolve; });
        },
      },
    });

    const first = worker.tick();
    const overlapping = worker.tick();
    await vi.waitFor(() => expect(deliveries).toBe(1));
    expect(store.claimCalls).toBe(1);
    release();
    await expect(Promise.all([first, overlapping])).resolves.toEqual([
      expect.objectContaining({ claimed: 1, delivered: 1 }),
      expect.objectContaining({ claimed: 1, delivered: 1 }),
    ]);
    expect(store.claimCalls).toBe(1);
  });

  it('bounds a stuck sink, aborts it, durably retries, and permits the next tick', async () => {
    const store = new MetricTruthStore();
    let aborts = 0;
    const worker = new UploadPolicyEventWorker({
      store,
      batchSize: 1,
      leaseMs: 1_000,
      deliveryTimeoutMs: 5,
      sink: {
        deliver: async (_event, signal) => new Promise<void>(() => {
          signal.addEventListener('abort', () => { aborts += 1; }, { once: true });
        }),
      },
    });

    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, retried: 1 });
    expect(aborts).toBe(1);
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, retried: 1 });
    expect(store.claimCalls).toBe(2);
  });

  it('rejects unbounded or invalid worker geometry before any store access', () => {
    const store = new MetricTruthStore();
    const sink = { deliver: async () => undefined };
    expect(() => new UploadPolicyEventWorker({ store, sink, batchSize: 0 })).toThrow(/batchSize/);
    expect(() => new UploadPolicyEventWorker({ store, sink, maxAttempts: 101 })).toThrow(/maxAttempts/);
    expect(() => new UploadPolicyEventWorker({ store, sink, leaseMs: 999 })).toThrow(/leaseMs/);
    expect(() => new UploadPolicyEventWorker({ store, sink, retryBaseMs: Number.NaN })).toThrow(/retryBaseMs/);
    expect(() => new UploadPolicyEventWorker({
      store,
      sink,
      batchSize: 2,
      leaseMs: 1_000,
      deliveryTimeoutMs: 500,
    })).toThrow(/outlive/);
  });
});
