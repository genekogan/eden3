import type {
  ClaimedPolicyEvent,
  PolicyEventMetrics,
  UploadPolicyEventStore,
} from './upload-repository';

export interface UploadPolicyEventSink {
  deliver(
    event: {
      /** Stable delivery idempotency key. */
      eventId: string;
      objectId: string;
      ownerAccountId: string;
      policyCode: string;
    },
    /** Delivery sinks must stop external work when the bounded claim is cancelled. */
    signal: AbortSignal,
  ): Promise<void>;
}

export interface PolicyEventTickResult {
  recovered: number;
  recoveryFailed: number;
  claimed: number;
  delivered: number;
  retried: number;
  terminalFailed: number;
  stale: number;
  metrics: PolicyEventMetrics;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
export interface UploadPolicyEventWorkerOptions {
  store: UploadPolicyEventStore;
  sink: UploadPolicyEventSink;
  now?: () => Date;
  maxAttempts?: number;
  batchSize?: number;
  leaseMs?: number;
  retryBaseMs?: number;
  deliveryTimeoutMs?: number;
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
  private readonly deliveryTimeoutMs: number;
  private inFlight: Promise<PolicyEventTickResult> | null = null;

  constructor(options: UploadPolicyEventWorkerOptions) {
    if (!options.sink) throw new Error('Upload policy event sink is required');
    this.store = options.store;
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = boundedInteger(options.maxAttempts ?? 5, 1, 100, 'maxAttempts');
    this.batchSize = boundedInteger(options.batchSize ?? 20, 1, 100, 'batchSize');
    this.leaseMs = boundedInteger(options.leaseMs ?? 6 * 60_000, 1_000, 10 * 60_000, 'leaseMs');
    this.retryBaseMs = boundedInteger(options.retryBaseMs ?? 1_000, 100, 60 * 60_000, 'retryBaseMs');
    this.deliveryTimeoutMs = boundedInteger(
      options.deliveryTimeoutMs ?? 15_000,
      1,
      120_000,
      'deliveryTimeoutMs',
    );
    if (this.leaseMs <= this.batchSize * this.deliveryTimeoutMs) {
      throw new Error('leaseMs must outlive the worst-case sequential policy delivery batch');
    }
  }

  tick(): Promise<PolicyEventTickResult> {
    if (this.inFlight) return this.inFlight;
    const running = this.runTick();
    this.inFlight = running;
    void running.finally(() => {
      if (this.inFlight === running) this.inFlight = null;
    }).catch(() => undefined);
    return running;
  }

  private async runTick(): Promise<PolicyEventTickResult> {
    const now = this.now();
    const recovery = await this.store.recoverExpiredPolicyEvents({
      now,
      limit: this.batchSize,
      maxAttempts: this.maxAttempts,
    });
    const claims = await this.store.claimDuePolicyEvents({
      now,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
      maxAttempts: this.maxAttempts,
    });
    let delivered = 0;
    let retried = 0;
    let terminalFailed = 0;
    let stale = 0;
    for (const event of claims) {
      const result = await this.deliver(event, now);
      if (result === 'delivered') delivered += 1;
      else if (result === 'pending') retried += 1;
      else if (result === 'failed') terminalFailed += 1;
      else stale += 1;
    }
    return {
      recovered: recovery.requeued,
      recoveryFailed: recovery.failed,
      claimed: claims.length,
      delivered,
      retried,
      terminalFailed,
      stale,
      metrics: await this.store.policyEventMetrics(now),
    };
  }

  private async deliver(
    event: ClaimedPolicyEvent,
    now: Date,
  ): Promise<'delivered' | 'pending' | 'failed' | 'stale'> {
    try {
      await this.withDeliveryTimeout((signal) => this.sink.deliver(
        {
          eventId: event.id,
          objectId: event.objectId,
          ownerAccountId: event.ownerAccountId,
          policyCode: event.policyCode,
        },
        signal,
      ));
      return await this.store.markPolicyEventDelivered(event.id, event.claimToken, now)
        ? 'delivered'
        : 'stale';
    } catch {
      const exponent = Math.max(0, event.attemptCount - 1);
      const delay = Math.min(60 * 60 * 1000, this.retryBaseMs * 2 ** exponent);
      return this.store.retryPolicyEvent({
        eventId: event.id,
        claimToken: event.claimToken,
        now,
        retryDelayMs: delay,
        maxAttempts: this.maxAttempts,
        errorCode: 'delivery_failed',
      });
    }
  }

  private withDeliveryTimeout(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Upload policy event delivery timed out'));
      }, this.deliveryTimeoutMs);
      timer.unref?.();
      let delivery: Promise<void>;
      try {
        delivery = operation(controller.signal);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      delivery.then(
        () => { clearTimeout(timer); resolve(); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }
}
