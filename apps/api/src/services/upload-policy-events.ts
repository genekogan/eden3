import type {
  ClaimedPolicyEvent,
  UploadPolicyEventStore,
} from './upload-repository';

export interface UploadPolicyEventSink {
  deliver(event: {
    /** Stable delivery idempotency key. */
    eventId: string;
    objectId: string;
    ownerAccountId: string;
    policyCode: string;
  }): Promise<void>;
}
export interface UploadPolicyEventWorkerOptions {
  store: UploadPolicyEventStore;
  sink: UploadPolicyEventSink;
  now?: () => Date;
  maxAttempts?: number;
  batchSize?: number;
  leaseMs?: number;
  retryBaseMs?: number;
}

/** Bounded, lease-fenced dispatcher for the durable quarantine outbox. */
export class UploadPolicyEventWorker {
  private readonly store: UploadPolicyEventStore;
  private readonly sink: UploadPolicyEventSink;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly retryBaseMs: number;

  constructor(options: UploadPolicyEventWorkerOptions) {
    if (!options.sink) throw new Error('Upload policy event sink is required');
    this.store = options.store;
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 5;
    this.batchSize = options.batchSize ?? 20;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
  }

  async tick(): Promise<{ claimed: number; delivered: number; retried: number }> {
    const now = this.now();
    await this.store.recoverExpiredPolicyEvents(now, this.maxAttempts);
    const claims = await this.store.claimDuePolicyEvents({
      now,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
      maxAttempts: this.maxAttempts,
    });
    let delivered = 0;
    let retried = 0;
    for (const event of claims) {
      if (await this.deliver(event, now)) delivered += 1;
      else retried += 1;
    }
    return { claimed: claims.length, delivered, retried };
  }

  private async deliver(event: ClaimedPolicyEvent, now: Date): Promise<boolean> {
    try {
      await this.sink.deliver({
        eventId: event.id,
        objectId: event.objectId,
        ownerAccountId: event.ownerAccountId,
        policyCode: event.policyCode,
      });
      await this.store.markPolicyEventDelivered(event.id, event.claimToken, now);
      return true;
    } catch {
      const exponent = Math.max(0, event.attemptCount - 1);
      const delay = Math.min(60 * 60 * 1000, this.retryBaseMs * 2 ** exponent);
      await this.store.retryPolicyEvent({
        eventId: event.id,
        claimToken: event.claimToken,
        now,
        nextAttemptAt: new Date(now.getTime() + delay),
        maxAttempts: this.maxAttempts,
        errorCode: 'delivery_failed',
      });
      return false;
    }
  }
}
