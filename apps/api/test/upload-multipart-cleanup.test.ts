import { describe, expect, it } from 'vitest';

import {
  UploadMultipartCleanupWorker,
  type ClaimedMultipartCleanup,
  type MultipartCleanupMetrics,
  type MultipartCleanupStore,
} from '../src/services/upload-multipart-cleanup';

interface Job {
  uploadId: string;
  ownerAccountId: string;
  backingKey: string;
  backendUploadId: string;
  uploadState: 'uploading' | 'aborted' | 'expired';
  expiresAt: Date;
  cleanupState: 'not_required' | 'pending' | 'claimed' | 'succeeded' | 'failed';
  attemptCount: number;
  nextAttemptAt: Date | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  enqueuedAt: Date | null;
}

class MemoryCleanupStore implements MultipartCleanupStore {
  readonly jobs = new Map<string, Job>();
  failNextSuccessWrite = false;
  private claimSequence = 0;
  private currentNow = new Date(0);

  add(job: Partial<Job> & Pick<Job, 'uploadId' | 'ownerAccountId'>): Job {
    const row: Job = {
      backingKey: `objects/${job.ownerAccountId}/${job.uploadId}`,
      backendUploadId: `provider:${job.uploadId}`,
      uploadState: 'aborted',
      expiresAt: new Date('2026-08-08T11:00:00.000Z'),
      cleanupState: 'pending',
      attemptCount: 0,
      nextAttemptAt: new Date('2026-08-08T12:00:00.000Z'),
      claimToken: null,
      claimExpiresAt: null,
      enqueuedAt: new Date('2026-08-08T12:00:00.000Z'),
      ...job,
    };
    this.jobs.set(row.uploadId, row);
    return row;
  }

  async enqueueExpiredUploads(now: Date, limit: number): Promise<number> {
    this.currentNow = now;
    let enqueued = 0;
    for (const row of this.jobs.values()) {
      if (enqueued >= limit) break;
      if (row.uploadState !== 'uploading' || row.expiresAt > now) continue;
      row.uploadState = 'expired';
      row.cleanupState = 'pending';
      row.nextAttemptAt = now;
      row.enqueuedAt = now;
      enqueued += 1;
    }
    return enqueued;
  }

  async recoverExpiredClaims(input: {
    limit: number;
    maxAttempts: number;
  }): Promise<{ requeued: number; failed: number }> {
    let requeued = 0;
    let failed = 0;
    for (const row of this.jobs.values()) {
      if (requeued + failed >= input.limit) break;
      if (
        row.cleanupState !== 'claimed' ||
        !row.claimExpiresAt ||
        row.claimExpiresAt > this.currentNow
      ) continue;
      row.claimToken = null;
      row.claimExpiresAt = null;
      if (row.attemptCount >= input.maxAttempts) {
        row.cleanupState = 'failed';
        failed += 1;
      } else {
        row.cleanupState = 'pending';
        row.nextAttemptAt = this.currentNow;
        requeued += 1;
      }
    }
    return { requeued, failed };
  }

  async claimDueCleanups(input: {
    now: Date;
    limit: number;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ClaimedMultipartCleanup[]> {
    const claims: ClaimedMultipartCleanup[] = [];
    for (const row of this.jobs.values()) {
      if (claims.length >= input.limit) break;
      if (row.cleanupState !== 'pending' || !row.nextAttemptAt || row.nextAttemptAt > input.now || row.attemptCount >= input.maxAttempts) continue;
      row.cleanupState = 'claimed';
      row.attemptCount += 1;
      row.nextAttemptAt = null;
      row.claimToken = `claim-${++this.claimSequence}`;
      row.claimExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      claims.push({
        uploadId: row.uploadId,
        ownerAccountId: row.ownerAccountId,
        backingKey: row.backingKey,
        backendUploadId: row.backendUploadId,
        attemptCount: row.attemptCount,
        claimToken: row.claimToken,
        enqueuedAt: row.enqueuedAt!,
      });
    }
    return claims;
  }

  async markCleanupSucceeded(uploadId: string, claimToken: string): Promise<boolean> {
    if (this.failNextSuccessWrite) {
      this.failNextSuccessWrite = false;
      throw new Error('simulated process death before cleanup success commit');
    }
    const row = this.jobs.get(uploadId);
    if (!row || row.cleanupState !== 'claimed' || row.claimToken !== claimToken) return false;
    row.cleanupState = 'succeeded';
    row.claimToken = null;
    row.claimExpiresAt = null;
    return true;
  }

  async retryCleanup(input: {
    uploadId: string;
    claimToken: string;
    now: Date;
    retryDelayMs: number;
    maxAttempts: number;
    errorCode: string;
  }): Promise<'pending' | 'failed' | 'stale'> {
    const row = this.jobs.get(input.uploadId);
    if (!row || row.cleanupState !== 'claimed' || row.claimToken !== input.claimToken) return 'stale';
    row.claimToken = null;
    row.claimExpiresAt = null;
    if (row.attemptCount >= input.maxAttempts) {
      row.cleanupState = 'failed';
      return 'failed';
    }
    row.cleanupState = 'pending';
    row.nextAttemptAt = new Date(input.now.getTime() + input.retryDelayMs);
    return 'pending';
  }

  async cleanupMetrics(now: Date): Promise<MultipartCleanupMetrics> {
    const pending = [...this.jobs.values()].filter((row) => row.cleanupState === 'pending');
    return {
      pending: pending.length,
      claimed: [...this.jobs.values()].filter((row) => row.cleanupState === 'claimed').length,
      failed: [...this.jobs.values()].filter((row) => row.cleanupState === 'failed').length,
      oldestPendingAgeMs: pending.length === 0
        ? 0
        : Math.max(...pending.map((row) => now.getTime() - row.enqueuedAt!.getTime())),
      maxAttemptCount: Math.max(
        0,
        ...[...this.jobs.values()]
          .filter((row) => ['pending', 'claimed', 'failed'].includes(row.cleanupState))
          .map((row) => row.attemptCount),
      ),
    };
  }
}

const OWNER_A = '00000000-0000-4000-8000-00000000000a';
const OWNER_B = '00000000-0000-4000-8000-00000000000b';

describe('durable multipart abort/expiry cleanup (DEBT-018)', () => {
  it('retries a transient provider failure after restart and records age/attempt metrics', async () => {
    let now = new Date('2026-08-08T12:00:00.000Z');
    const store = new MemoryCleanupStore();
    store.add({ uploadId: 'upload-a', ownerAccountId: OWNER_A });
    let calls = 0;
    const backend = {
      abortMultipart: async () => {
        calls += 1;
        if (calls === 1) throw new Error('synthetic provider outage');
      },
    };
    const errors: Array<{ terminal: boolean; ownerAccountId: string }> = [];
    const makeWorker = () => new UploadMultipartCleanupWorker({
      store,
      backend,
      now: () => now,
      retryBaseMs: 1_000,
      onError: (_error, context) => errors.push(context),
    });

    const first = await makeWorker().tick();
    expect(first).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
    expect(store.jobs.get('upload-a')).toMatchObject({ cleanupState: 'pending', attemptCount: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ terminal: false, ownerAccountId: OWNER_A });

    now = new Date(now.getTime() + 1_000);
    const second = await makeWorker().tick();
    expect(second).toMatchObject({ claimed: 1, succeeded: 1, retried: 0 });
    expect(second.metrics).toMatchObject({ pending: 0, failed: 0, maxAttemptCount: 0 });
    expect(calls).toBe(2);
  });

  it('recovers a crash after provider success and treats the repeated abort as idempotent', async () => {
    let now = new Date('2026-08-08T12:00:00.000Z');
    const store = new MemoryCleanupStore();
    store.add({ uploadId: 'upload-crash', ownerAccountId: OWNER_A });
    store.failNextSuccessWrite = true;
    let providerExists = true;
    let calls = 0;
    const backend = {
      abortMultipart: async () => {
        calls += 1;
        providerExists = false;
        // Missing multipart state is the provider's idempotent success case.
        if (!providerExists) return;
      },
    };
    const first = new UploadMultipartCleanupWorker({
      store,
      backend,
      now: () => now,
      leaseMs: 1_000,
      batchSize: 1,
      abortTimeoutMs: 100,
      onError: () => undefined,
    });
    await expect(first.tick()).rejects.toThrow('simulated process death');
    expect(store.jobs.get('upload-crash')?.cleanupState).toBe('claimed');

    now = new Date(now.getTime() + 1_001);
    const restarted = new UploadMultipartCleanupWorker({
      store,
      backend,
      now: () => now,
      leaseMs: 1_000,
      batchSize: 1,
      abortTimeoutMs: 100,
      onError: () => undefined,
    });
    expect(await restarted.tick()).toMatchObject({ recovered: 1, claimed: 1, succeeded: 1 });
    expect(calls).toBe(2);
    expect(store.jobs.get('upload-crash')?.cleanupState).toBe('succeeded');
  });

  it('expires sessions without tenant input and never crosses immutable owner locators', async () => {
    const now = new Date('2026-08-08T12:00:00.000Z');
    const store = new MemoryCleanupStore();
    store.add({
      uploadId: 'upload-a',
      ownerAccountId: OWNER_A,
      uploadState: 'uploading',
      cleanupState: 'not_required',
      nextAttemptAt: null,
      enqueuedAt: null,
    });
    store.add({ uploadId: 'upload-b', ownerAccountId: OWNER_B });
    const seen: string[] = [];
    const worker = new UploadMultipartCleanupWorker({
      store,
      now: () => now,
      backend: {
        abortMultipart: async (input) => { seen.push(`${input.ownerAccountId}:${input.key}`); },
      },
      onError: () => undefined,
    });
    const result = await worker.tick();
    expect(result).toMatchObject({ expiredEnqueued: 1, claimed: 2, succeeded: 2 });
    expect(seen).toEqual(expect.arrayContaining([
      `${OWNER_A}:objects/${OWNER_A}/upload-a`,
      `${OWNER_B}:objects/${OWNER_B}/upload-b`,
    ]));
  });

  it('terminalizes max-attempt and expired claims loudly instead of stranding pending work', async () => {
    let now = new Date('2026-08-08T12:00:00.000Z');
    const store = new MemoryCleanupStore();
    store.add({ uploadId: 'upload-fail', ownerAccountId: OWNER_A });
    const errors: boolean[] = [];
    const worker = new UploadMultipartCleanupWorker({
      store,
      now: () => now,
      maxAttempts: 2,
      retryBaseMs: 1_000,
      backend: { abortMultipart: async () => { throw new Error('provider unavailable'); } },
      onError: (_error, context) => errors.push(context.terminal),
    });
    await worker.tick();
    now = new Date(now.getTime() + 1_000);
    const terminal = await worker.tick();
    expect(terminal).toMatchObject({ claimed: 1, terminalFailed: 1 });
    expect(store.jobs.get('upload-fail')).toMatchObject({ cleanupState: 'failed', attemptCount: 2 });
    expect(errors).toEqual([false, true]);
    expect((await worker.tick()).claimed).toBe(0);

    const expired = store.add({
      uploadId: 'upload-expired-claim',
      ownerAccountId: OWNER_B,
      cleanupState: 'claimed',
      attemptCount: 2,
      nextAttemptAt: null,
      claimToken: 'dead-worker',
      claimExpiresAt: new Date(now.getTime() - 1),
    });
    const recovered = await worker.tick();
    expect(recovered.recoveryFailed).toBe(1);
    expect(expired.cleanupState).toBe('failed');
  });

  it('bounds a hung provider abort and leaves a durable retry instead of wedging the loop', async () => {
    const store = new MemoryCleanupStore();
    store.add({ uploadId: 'upload-hung', ownerAccountId: OWNER_A });
    const errors: unknown[] = [];
    const worker = new UploadMultipartCleanupWorker({
      store,
      abortTimeoutMs: 5,
      batchSize: 1,
      leaseMs: 1_000,
      retryBaseMs: 100,
      backend: {
        abortMultipart: ({ signal }) => new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      },
      onError: (error) => errors.push(error),
    });
    const result = await worker.tick();
    expect(result).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
    expect(store.jobs.get('upload-hung')).toMatchObject({ cleanupState: 'pending', attemptCount: 1 });
    expect(errors[0]).toMatchObject({ message: 'Multipart provider abort timed out' });
  });

  it('rejects a lease shorter than the worst-case sequential provider batch', () => {
    const store = new MemoryCleanupStore();
    expect(() => new UploadMultipartCleanupWorker({
      store,
      backend: { abortMultipart: async () => undefined },
      batchSize: 2,
      abortTimeoutMs: 1_000,
      leaseMs: 2_000,
      onError: () => undefined,
    })).toThrow(/outlive the worst-case sequential cleanup batch/);
  });

  it('bounds dead-claim recovery work per tick', async () => {
    const now = new Date('2026-08-08T12:00:00.000Z');
    const store = new MemoryCleanupStore();
    for (const suffix of ['a', 'b', 'c']) {
      store.add({
        uploadId: `expired-${suffix}`,
        ownerAccountId: OWNER_A,
        cleanupState: 'claimed',
        attemptCount: 2,
        nextAttemptAt: null,
        claimToken: `dead-${suffix}`,
        claimExpiresAt: new Date(now.getTime() - 1),
      });
    }
    const worker = new UploadMultipartCleanupWorker({
      store,
      now: () => now,
      maxAttempts: 2,
      batchSize: 2,
      backend: { abortMultipart: async () => undefined },
      onError: () => undefined,
    });
    const result = await worker.tick();
    expect(result.recoveryFailed).toBe(2);
    expect([...store.jobs.values()].filter((row) => row.cleanupState === 'claimed')).toHaveLength(1);
  });

  it('counts lost success and retry CAS outcomes only as stale', async () => {
    const successStore = new MemoryCleanupStore();
    successStore.add({ uploadId: 'stale-success', ownerAccountId: OWNER_A });
    successStore.markCleanupSucceeded = async () => false;
    const success = await new UploadMultipartCleanupWorker({
      store: successStore,
      backend: { abortMultipart: async () => undefined },
      onError: () => undefined,
    }).tick();
    expect(success).toMatchObject({ claimed: 1, succeeded: 0, retried: 0, stale: 1 });

    const retryStore = new MemoryCleanupStore();
    retryStore.add({ uploadId: 'stale-retry', ownerAccountId: OWNER_A });
    retryStore.retryCleanup = async () => 'stale';
    const retry = await new UploadMultipartCleanupWorker({
      store: retryStore,
      backend: { abortMultipart: async () => { throw new Error('provider outage'); } },
      onError: () => undefined,
    }).tick();
    expect(retry).toMatchObject({ claimed: 1, succeeded: 0, retried: 0, terminalFailed: 0, stale: 1 });
  });
});
