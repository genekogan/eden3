export interface ClaimedMultipartCleanup {
  uploadId: string;
  ownerAccountId: string;
  backingKey: string;
  backendUploadId: string;
  attemptCount: number;
  claimToken: string;
  enqueuedAt: Date;
}

export interface MultipartCleanupMetrics {
  pending: number;
  claimed: number;
  failed: number;
  oldestPendingAgeMs: number;
  maxAttemptCount: number;
}

export interface MultipartCleanupStore {
  enqueueExpiredUploads(now: Date, limit: number): Promise<number>;
  recoverExpiredClaims(input: {
    limit: number;
    maxAttempts: number;
  }): Promise<{ requeued: number; failed: number }>;
  claimDueCleanups(input: {
    now: Date;
    limit: number;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ClaimedMultipartCleanup[]>;
  markCleanupSucceeded(uploadId: string, claimToken: string, now: Date): Promise<boolean>;
  retryCleanup(input: {
    uploadId: string;
    claimToken: string;
    now: Date;
    retryDelayMs: number;
    maxAttempts: number;
    errorCode: string;
  }): Promise<'pending' | 'failed' | 'stale'>;
  cleanupMetrics(now: Date): Promise<MultipartCleanupMetrics>;
}

export interface MultipartCleanupBackend {
  abortMultipart(input: {
    key: string;
    backendUploadId: string;
    ownerAccountId: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export interface MultipartCleanupErrorContext {
  uploadId: string;
  ownerAccountId: string;
  attemptCount: number;
  terminal: boolean;
}

export interface UploadMultipartCleanupWorkerOptions {
  store: MultipartCleanupStore;
  backend: MultipartCleanupBackend;
  onError: (error: unknown, context: MultipartCleanupErrorContext) => void;
  now?: () => Date;
  maxAttempts?: number;
  batchSize?: number;
  expiryBatchSize?: number;
  leaseMs?: number;
  retryBaseMs?: number;
  abortTimeoutMs?: number;
}

export interface MultipartCleanupTickResult {
  expiredEnqueued: number;
  recovered: number;
  recoveryFailed: number;
  claimed: number;
  succeeded: number;
  retried: number;
  terminalFailed: number;
  stale: number;
  metrics: MultipartCleanupMetrics;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Provider-free scheduler seam for durable multipart abort cleanup.
 *
 * Each provider call is made only from a database-issued lease carrying the
 * immutable tenant/object locator. A crash after provider success deliberately
 * leaves the claim recoverable: AbortMultipartUpload is idempotent, so the next
 * process repeats it before committing success.
 */
export class UploadMultipartCleanupWorker {
  private readonly store: MultipartCleanupStore;
  private readonly backend: MultipartCleanupBackend;
  private readonly onError: UploadMultipartCleanupWorkerOptions['onError'];
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly expiryBatchSize: number;
  private readonly leaseMs: number;
  private readonly retryBaseMs: number;
  private readonly abortTimeoutMs: number;
  private inFlight: Promise<MultipartCleanupTickResult> | null = null;

  constructor(options: UploadMultipartCleanupWorkerOptions) {
    if (!options.onError) throw new Error('Multipart cleanup onError sink is required');
    this.store = options.store;
    this.backend = options.backend;
    this.onError = options.onError;
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = boundedInteger(options.maxAttempts ?? 8, 1, 100, 'maxAttempts');
    this.batchSize = boundedInteger(options.batchSize ?? 20, 1, 100, 'batchSize');
    this.expiryBatchSize = boundedInteger(options.expiryBatchSize ?? 100, 1, 1000, 'expiryBatchSize');
    this.leaseMs = boundedInteger(options.leaseMs ?? 6 * 60_000, 1_000, 10 * 60_000, 'leaseMs');
    this.retryBaseMs = boundedInteger(options.retryBaseMs ?? 5_000, 100, 60 * 60_000, 'retryBaseMs');
    this.abortTimeoutMs = boundedInteger(options.abortTimeoutMs ?? 15_000, 1, 120_000, 'abortTimeoutMs');
    if (this.leaseMs <= this.batchSize * this.abortTimeoutMs) {
      throw new Error('leaseMs must outlive the worst-case sequential cleanup batch');
    }
  }

  tick(): Promise<MultipartCleanupTickResult> {
    if (this.inFlight) return this.inFlight;
    const running = this.runTick();
    this.inFlight = running;
    void running.finally(() => {
      if (this.inFlight === running) this.inFlight = null;
    }).catch(() => undefined);
    return running;
  }

  private async runTick(): Promise<MultipartCleanupTickResult> {
    const now = this.now();
    const expiredEnqueued = await this.store.enqueueExpiredUploads(now, this.expiryBatchSize);
    const recovery = await this.store.recoverExpiredClaims({
      limit: this.batchSize,
      maxAttempts: this.maxAttempts,
    });
    const claims = await this.store.claimDueCleanups({
      now,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
      maxAttempts: this.maxAttempts,
    });
    let succeeded = 0;
    let retried = 0;
    let terminalFailed = 0;
    let stale = 0;

    for (const claim of claims) {
      try {
        await this.withAbortTimeout((signal) =>
          this.backend.abortMultipart({
            key: claim.backingKey,
            backendUploadId: claim.backendUploadId,
            ownerAccountId: claim.ownerAccountId,
            signal,
          }),
        );
      } catch (error) {
        const delay = Math.min(
          60 * 60_000,
          this.retryBaseMs * 2 ** Math.max(0, claim.attemptCount - 1),
        );
        let result: Awaited<ReturnType<MultipartCleanupStore['retryCleanup']>>;
        try {
          result = await this.store.retryCleanup({
            uploadId: claim.uploadId,
            claimToken: claim.claimToken,
            now,
            retryDelayMs: delay,
            maxAttempts: this.maxAttempts,
            errorCode: claim.attemptCount >= this.maxAttempts
              ? 'attempts_exhausted'
              : 'provider_abort_failed',
          });
        } catch (persistenceError) {
          this.onError(error, {
            uploadId: claim.uploadId,
            ownerAccountId: claim.ownerAccountId,
            attemptCount: claim.attemptCount,
            terminal: false,
          });
          throw new AggregateError(
            [error, persistenceError],
            'Provider abort failed and its durable retry could not be recorded',
          );
        }
        const terminal = result === 'failed';
        if (terminal) terminalFailed += 1;
        else if (result === 'pending') retried += 1;
        else stale += 1;
        this.onError(error, {
          uploadId: claim.uploadId,
          ownerAccountId: claim.ownerAccountId,
          attemptCount: claim.attemptCount,
          terminal,
        });
        continue;
      }

      if (await this.store.markCleanupSucceeded(claim.uploadId, claim.claimToken, now)) {
        succeeded += 1;
      } else {
        stale += 1;
        this.onError(new Error('Multipart cleanup success claim was stale'), {
          uploadId: claim.uploadId,
          ownerAccountId: claim.ownerAccountId,
          attemptCount: claim.attemptCount,
          terminal: false,
        });
      }
    }

    return {
      expiredEnqueued,
      recovered: recovery.requeued,
      recoveryFailed: recovery.failed,
      claimed: claims.length,
      succeeded,
      retried,
      terminalFailed,
      stale,
      metrics: await this.store.cleanupMetrics(now),
    };
  }

  private withAbortTimeout(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => {
          controller.abort();
          reject(new Error('Multipart provider abort timed out'));
        },
        this.abortTimeoutMs,
      );
      timer.unref?.();
      operation(controller.signal).then(
        () => { clearTimeout(timer); resolve(); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }
}
