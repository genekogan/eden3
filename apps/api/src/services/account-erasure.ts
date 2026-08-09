import { z } from 'zod';
import { createHash } from 'node:crypto';

import { ApiError } from '../errors';

export const ACCOUNT_ERASURE_LEDGER_SCHEMA_VERSION = 'eden3.account-erasure@v1' as const;
export const ACCOUNT_ERASURE_RECOVERY_MANIFEST_SCHEMA_VERSION =
  'eden3.account-erasure-recovery@v1' as const;
export const ACCOUNT_ERASURE_SINK_TIMEOUT_MS = 15_000;

export const accountErasureRequestSchema = z
  .object({
    confirmUsername: z.string().trim().min(1).max(128),
  })
  .strict();

export interface AccountErasureIntent {
  jobId: string;
  accountId: string;
  acceptedAt: string;
  state: 'intent_pending';
}

export interface AccountErasureLedgerRecord {
  schemaVersion: typeof ACCOUNT_ERASURE_LEDGER_SCHEMA_VERSION;
  jobId: string;
  accountId: string;
  acceptedAt: string;
}

export interface AccountErasureLedgerConfirmation {
  /** Exact record read back from the WORM sink, not the caller's input object. */
  record: AccountErasureLedgerRecord;
  confirmedAt: string;
  sha256: string;
  /** Sink-keyed MAC over the same canonical bytes; app validates shape while sink readback verifies it. */
  macSha256: string;
}

export interface AccountErasureRequestResult {
  jobId: string;
  status: 'pending';
}

export interface AccountErasureRecoveryLocator {
  kind:
    | 'clerk_identity'
    | 'stripe_customer'
    | 'channel_runtime'
    | 'agent_runtime'
    | 'storage_object'
    | 'legacy_media_asset'
    | 'legacy_concept_asset';
  resourceId: string;
  /** Ephemeral plaintext passed only to the dedicated encrypting sink. */
  locator: string;
}

export interface AccountErasureRecoveryManifest {
  schemaVersion: typeof ACCOUNT_ERASURE_RECOVERY_MANIFEST_SCHEMA_VERSION;
  jobId: string;
  accountId: string;
  inventoriedAt: string;
  inventorySha256: string;
  locators: readonly AccountErasureRecoveryLocator[];
}

export interface AccountErasureSealedInventory {
  jobId: string;
  accountId: string;
  status: 'recovery_manifest_pending';
  recoveryManifest: AccountErasureRecoveryManifest;
}

export interface AccountErasureRecoveryManifestConfirmation {
  /** Read-back binding only; plaintext locators are never returned or persisted in SQL. */
  schemaVersion: typeof ACCOUNT_ERASURE_RECOVERY_MANIFEST_SCHEMA_VERSION;
  jobId: string;
  accountId: string;
  inventorySha256: string;
  /** SHA-256 of the exact canonical plaintext manifest authenticated as AAD. */
  manifestSha256: string;
  confirmedAt: string;
  ciphertextSha256: string;
  macSha256: string;
  keyVersion: number;
}

/** Versioned, property-order-independent WORM ledger bytes. */
export function canonicalAccountErasureLedger(record: AccountErasureLedgerRecord): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    jobId: record.jobId,
    accountId: record.accountId,
    acceptedAt: record.acceptedAt,
  });
}

export function accountErasureLedgerSha256(record: AccountErasureLedgerRecord): string {
  return createHash('sha256').update(canonicalAccountErasureLedger(record)).digest('hex');
}

export function canonicalAccountErasureManifest(
  manifest: AccountErasureRecoveryManifest,
): string {
  const utf8Order = (left: string, right: string): number =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    jobId: manifest.jobId,
    accountId: manifest.accountId,
    inventoriedAt: manifest.inventoriedAt,
    inventorySha256: manifest.inventorySha256,
    locators: [...manifest.locators]
      .map((entry) => ({
        kind: entry.kind,
        resourceId: entry.resourceId,
        locator: entry.locator,
      }))
      .sort((a, b) => utf8Order(
        `${a.kind}\u0000${a.resourceId}\u0000${a.locator}`,
        `${b.kind}\u0000${b.resourceId}\u0000${b.locator}`,
      )),
  });
}

export function accountErasureManifestSha256(manifest: AccountErasureRecoveryManifest): string {
  return createHash('sha256').update(canonicalAccountErasureManifest(manifest)).digest('hex');
}

export interface AccountErasureManifestPendingIntent {
  jobId: string;
  accountId: string;
  acceptedAt: string;
  state: 'manifest_pending';
  recoveryManifest: AccountErasureRecoveryManifest;
}

export interface ClaimedAccountErasureIntent {
  intent: AccountErasureIntent | AccountErasureManifestPendingIntent;
  claimToken: string;
  claimExpiresAt: string;
}

export type AccountErasureClaimResult =
  | AccountErasureSealedInventory
  | { jobId: string; status: 'stale' };

export interface AccountErasureIntentStore {
  /** Transaction 1: row-lock/revalidate self and converge on one accepted intent. */
  acceptIntent(input: {
    accountId: string;
    confirmUsername: string;
  }): Promise<AccountErasureIntent>;

  /**
   * Route-only transaction 2 CAS. It may mutate only exact `intent_pending`
   * with no live claim token/expiry; a worker-owned or advanced job is stale.
   */
  sealUnclaimedAfterLedgerConfirmation(input: {
    jobId: string;
    accountId: string;
    acceptedAt: string;
    confirmedAt: string;
    ledgerSha256: string;
    ledgerMacSha256: string;
  }): Promise<AccountErasureClaimResult>;

  /** Route-only CAS: refuses a live recovery claim and makes cleanup claimable. */
  confirmRecoveryManifestUnclaimed(input: {
    jobId: string;
    accountId: string;
    confirmation: AccountErasureRecoveryManifestConfirmation;
  }): Promise<AccountErasureRequestResult | { jobId: string; status: 'stale' }>;
}

export interface AccountErasureRecoveryStore extends AccountErasureIntentStore {
  readonly databaseBoundary?: object;
  /** Optional composition proof that a claimed lease outlives both sink deadlines. */
  readonly claimLeaseMs?: number;
  /** Claim one due intent/backup target with a fenced lease, or null when idle. */
  claimIntentForRecovery(): Promise<
    ClaimedAccountErasureIntent | { jobId: string; status: 'attention' } | null
  >;
  /** Durable operator-truth counts, evaluated against PostgreSQL time. */
  recoveryMetrics?(): Promise<{
    wormOverdue: number;
    targetOverdue: number;
  }>;
  /** Transaction 2 for a worker; token/expiry CAS makes a late lease stale. */
  sealClaimedAfterLedgerConfirmation(input: {
    jobId: string;
    accountId: string;
    acceptedAt: string;
    confirmedAt: string;
    ledgerSha256: string;
    ledgerMacSha256: string;
    claimToken: string;
    claimExpiresAt: string;
  }): Promise<AccountErasureClaimResult>;
  /** Worker-only CAS; exact live claim must still own the manifest-pending job. */
  confirmClaimedRecoveryManifest(input: {
    jobId: string;
    accountId: string;
    confirmation: AccountErasureRecoveryManifestConfirmation;
    claimToken: string;
    claimExpiresAt: string;
  }): Promise<AccountErasureRequestResult | { jobId: string; status: 'stale' }>;
  /** Persist only a safe code and release/attention the exact claim. */
  recordRecoveryFailure(input: {
    jobId: string;
    claimToken: string;
    claimExpiresAt: string;
    errorCode: 'erasure_recovery_failed';
  }): Promise<'retried' | 'attention' | 'stale'>;
}

export interface AccountErasureLedgerSink {
  /** Canonically encode, MAC, WORM-write, then HEAD/read back the exact record. */
  writeAndConfirm(
    record: AccountErasureLedgerRecord,
    signal?: AbortSignal,
  ): Promise<AccountErasureLedgerConfirmation>;
}

export interface AccountErasureRecoveryManifestSink {
  /**
   * Encrypt with a separate erasure key, WORM-write with separate credentials,
   * then read back. Implementations must never log or retain plaintext locators.
   */
  encryptWriteAndConfirm(
    manifest: AccountErasureRecoveryManifest,
    signal?: AbortSignal,
  ): Promise<AccountErasureRecoveryManifestConfirmation>;
}

export interface AccountErasureAdmission {
  actorAccountId: string;
  actorUsername: string;
  actorIsAdmin: boolean;
  confirmUsername: string;
}

const lowercaseSha256 = /^[0-9a-f]{64}$/;

function exactLedgerConfirmation(
  expected: AccountErasureLedgerRecord,
  confirmation: AccountErasureLedgerConfirmation,
): boolean {
  const actual = confirmation.record;
  return (
    Object.keys(actual).sort().join(',') === 'acceptedAt,accountId,jobId,schemaVersion' &&
    actual.schemaVersion === expected.schemaVersion &&
    actual.jobId === expected.jobId &&
    actual.accountId === expected.accountId &&
    actual.acceptedAt === expected.acceptedAt &&
    Number.isFinite(Date.parse(confirmation.confirmedAt)) &&
    Date.parse(confirmation.confirmedAt) >= Date.parse(expected.acceptedAt) &&
    confirmation.sha256 === accountErasureLedgerSha256(expected) &&
    lowercaseSha256.test(confirmation.macSha256)
  );
}

async function confirmedLedgerInput(
  intent: AccountErasureIntent,
  ledger: AccountErasureLedgerSink,
  timeoutMs = ACCOUNT_ERASURE_SINK_TIMEOUT_MS,
): Promise<{
  jobId: string;
  accountId: string;
  acceptedAt: string;
  confirmedAt: string;
  ledgerSha256: string;
  ledgerMacSha256: string;
}> {
  const record: AccountErasureLedgerRecord = {
    schemaVersion: ACCOUNT_ERASURE_LEDGER_SCHEMA_VERSION,
    jobId: intent.jobId,
    accountId: intent.accountId,
    acceptedAt: intent.acceptedAt,
  };
  let evidence: AccountErasureLedgerConfirmation;
  try {
    evidence = await withSinkTimeout(timeoutMs, (signal) => ledger.writeAndConfirm(record, signal));
  } catch {
    throw new ApiError(503, 'erasure_ledger_unavailable', 'Account erasure ledger is unavailable');
  }
  if (!exactLedgerConfirmation(record, evidence)) {
    throw new ApiError(503, 'erasure_ledger_mismatch', 'Account erasure ledger confirmation failed');
  }
  return {
    jobId: intent.jobId,
    accountId: intent.accountId,
    acceptedAt: intent.acceptedAt,
    confirmedAt: evidence.confirmedAt,
    ledgerSha256: evidence.sha256,
    ledgerMacSha256: evidence.macSha256,
  };
}

function exactRecoveryManifestConfirmation(
  expected: AccountErasureRecoveryManifest,
  actual: AccountErasureRecoveryManifestConfirmation,
): boolean {
  return (
    actual.schemaVersion === expected.schemaVersion &&
    actual.jobId === expected.jobId &&
    actual.accountId === expected.accountId &&
    actual.inventorySha256 === expected.inventorySha256 &&
    actual.manifestSha256 === accountErasureManifestSha256(expected) &&
    Number.isFinite(Date.parse(actual.confirmedAt)) &&
    Date.parse(actual.confirmedAt) >= Date.parse(expected.inventoriedAt) &&
    lowercaseSha256.test(actual.ciphertextSha256) &&
    lowercaseSha256.test(actual.macSha256) &&
    Number.isSafeInteger(actual.keyVersion) &&
    actual.keyVersion >= 1
  );
}

async function confirmedRecoveryManifest(
  manifest: AccountErasureRecoveryManifest,
  sink: AccountErasureRecoveryManifestSink,
  timeoutMs = ACCOUNT_ERASURE_SINK_TIMEOUT_MS,
): Promise<AccountErasureRecoveryManifestConfirmation> {
  let confirmation: AccountErasureRecoveryManifestConfirmation;
  try {
    confirmation = await withSinkTimeout(
      timeoutMs,
      (signal) => sink.encryptWriteAndConfirm(manifest, signal),
    );
  } catch {
    throw new ApiError(
      503,
      'erasure_recovery_manifest_unavailable',
      'Account erasure recovery custody is unavailable',
    );
  }
  if (!exactRecoveryManifestConfirmation(manifest, confirmation)) {
    throw new ApiError(
      503,
      'erasure_recovery_manifest_mismatch',
      'Account erasure recovery manifest confirmation failed',
    );
  }
  return confirmation;
}

async function withSinkTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error('Account erasure sink timeout must be between 1 second and 2 minutes');
  }
  const controller = new AbortController();
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(new Error('account erasure sink timed out'));
  }, timeoutMs);
  timer.unref();
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Coordinate the two database transactions around the mandatory WORM ledger
 * confirmation. No account mutation is reachable before exact readback.
 */
export async function requestAccountErasure(
  input: AccountErasureAdmission,
  store: AccountErasureIntentStore,
  ledger: AccountErasureLedgerSink,
  recoveryManifestSink: AccountErasureRecoveryManifestSink,
): Promise<AccountErasureRequestResult> {
  if (input.actorIsAdmin) {
    throw new ApiError(403, 'protected_account', 'Administrator accounts cannot be deleted');
  }
  const confirmation = input.confirmUsername.trim();
  if (confirmation.toLocaleLowerCase('en-US') !== input.actorUsername.toLocaleLowerCase('en-US')) {
    throw new ApiError(400, 'confirmation_mismatch', 'Account username confirmation does not match');
  }

  const intent = await store.acceptIntent({
    accountId: input.actorAccountId,
    confirmUsername: confirmation,
  });
  if (intent.accountId !== input.actorAccountId) {
    throw new ApiError(503, 'erasure_intent_mismatch', 'Account erasure intent did not match');
  }
  let inventory: AccountErasureClaimResult;
  try {
    inventory = await store.sealUnclaimedAfterLedgerConfirmation(
      await confirmedLedgerInput(intent, ledger),
    );
  } catch (error) {
    // Tx1 is already durable and freezes new work. Canonical terminalizers may
    // still need to converge provider/money state; the recovery loop owns that
    // restart-safe continuation and the caller never has to resubmit deletion.
    if (error instanceof ApiError && error.code === 'erasure_work_in_flight') {
      return { jobId: intent.jobId, status: 'pending' };
    }
    throw error;
  }
  if (inventory.status === 'stale') {
    throw new ApiError(409, 'erasure_recovery_claimed', 'Account erasure recovery is in progress');
  }
  const manifestConfirmation = await confirmedRecoveryManifest(
    inventory.recoveryManifest,
    recoveryManifestSink,
  );
  const completed = await store.confirmRecoveryManifestUnclaimed({
    jobId: inventory.jobId,
    accountId: inventory.accountId,
    confirmation: manifestConfirmation,
  });
  if (completed.status === 'stale') {
    throw new ApiError(409, 'erasure_recovery_claimed', 'Account erasure recovery is in progress');
  }
  return completed;
}

export interface AccountErasureRecoveryTickResult {
  claimed: number;
  sealed: number;
  retried: number;
  attention: number;
  stale: number;
  wormOverdue: number;
  targetOverdue: number;
}

/** Provider-free recovery for intents stranded before transaction 2. */
export class AccountErasureRecoveryWorker {
  private running = false;

  constructor(
    private readonly store: AccountErasureRecoveryStore,
    private readonly ledger: AccountErasureLedgerSink,
    private readonly recoveryManifestSink: AccountErasureRecoveryManifestSink,
    private readonly batchSize = 25,
    private readonly sinkTimeoutMs = ACCOUNT_ERASURE_SINK_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error('Account erasure recovery batch size must be between 1 and 100');
    }
    if (!Number.isSafeInteger(sinkTimeoutMs) || sinkTimeoutMs < 1_000 || sinkTimeoutMs > 120_000) {
      throw new Error('Account erasure sink timeout must be between 1 second and 2 minutes');
    }
    if (
      store.claimLeaseMs !== undefined &&
      store.claimLeaseMs <= sinkTimeoutMs * 2 + 5_000
    ) {
      throw new Error('Account erasure claim lease must outlive both sink deadlines');
    }
  }

  async tick(): Promise<AccountErasureRecoveryTickResult> {
    if (this.running) return {
      claimed: 0, sealed: 0, retried: 0, attention: 0, stale: 0,
      wormOverdue: 0, targetOverdue: 0,
    };
    this.running = true;
    const result: AccountErasureRecoveryTickResult = {
      claimed: 0,
      sealed: 0,
      retried: 0,
      attention: 0,
      stale: 0,
      wormOverdue: 0,
      targetOverdue: 0,
    };
    try {
      if (this.store.recoveryMetrics) {
        const metrics = await this.store.recoveryMetrics();
        result.wormOverdue = metrics.wormOverdue;
        result.targetOverdue = metrics.targetOverdue;
      }
      for (let index = 0; index < this.batchSize; index += 1) {
        const claim = await this.store.claimIntentForRecovery();
        if (!claim) break;
        result.claimed += 1;
        if ('status' in claim) {
          result.attention += 1;
          continue;
        }
        try {
          let inventory: AccountErasureSealedInventory | { jobId: string; status: 'stale' };
          if (claim.intent.state === 'manifest_pending') {
            inventory = {
              jobId: claim.intent.jobId,
              accountId: claim.intent.accountId,
              status: 'recovery_manifest_pending',
              recoveryManifest: claim.intent.recoveryManifest,
            };
          } else {
            const confirmed = await confirmedLedgerInput(claim.intent, this.ledger, this.sinkTimeoutMs);
            inventory = await this.store.sealClaimedAfterLedgerConfirmation({
              ...confirmed,
              claimToken: claim.claimToken,
              claimExpiresAt: claim.claimExpiresAt,
            });
          }
          if (inventory.status === 'stale') {
            result.stale += 1;
            continue;
          }
          const manifestConfirmation = await confirmedRecoveryManifest(
            inventory.recoveryManifest,
            this.recoveryManifestSink,
            this.sinkTimeoutMs,
          );
          const completed = await this.store.confirmClaimedRecoveryManifest({
            jobId: inventory.jobId,
            accountId: inventory.accountId,
            confirmation: manifestConfirmation,
            claimToken: claim.claimToken,
            claimExpiresAt: claim.claimExpiresAt,
          });
          if (completed.status === 'stale') result.stale += 1;
          else result.sealed += 1;
        } catch {
          const failure = await this.store.recordRecoveryFailure({
            jobId: claim.intent.jobId,
            claimToken: claim.claimToken,
            claimExpiresAt: claim.claimExpiresAt,
            errorCode: 'erasure_recovery_failed',
          });
          result[failure] += 1;
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
