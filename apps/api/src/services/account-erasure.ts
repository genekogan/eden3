import { z } from 'zod';

import { ApiError } from '../errors';

export const ACCOUNT_ERASURE_LEDGER_SCHEMA_VERSION = 'eden3.account-erasure@v1' as const;
export const ACCOUNT_ERASURE_RECOVERY_MANIFEST_SCHEMA_VERSION =
  'eden3.account-erasure-recovery@v1' as const;

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
  macSha256: string;
}

export interface AccountErasureRequestResult {
  jobId: string;
  status: 'pending';
}

export interface AccountErasureRecoveryLocator {
  kind: 'clerk_identity' | 'stripe_customer' | 'channel_runtime' | 'agent_runtime';
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
  confirmedAt: string;
  ciphertextSha256: string;
  macSha256: string;
  keyVersion: number;
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
   * Transaction 2: verify the confirmed ledger evidence, inventory current
   * rows, reconcile money, revoke access, and seal the account atomically.
   */
  sealAfterLedgerConfirmation(input: {
    jobId: string;
    accountId: string;
    acceptedAt: string;
    confirmedAt: string;
    ledgerSha256: string;
    ledgerMacSha256: string;
  }): Promise<AccountErasureSealedInventory>;

  /** Route-only CAS: refuses a live recovery claim and makes cleanup claimable. */
  confirmRecoveryManifestUnclaimed(input: {
    jobId: string;
    accountId: string;
    confirmation: AccountErasureRecoveryManifestConfirmation;
  }): Promise<AccountErasureRequestResult | { jobId: string; status: 'stale' }>;
}

export interface AccountErasureRecoveryStore extends AccountErasureIntentStore {
  /** Claim one due intent/backup target with a fenced lease, or null when idle. */
  claimIntentForRecovery(): Promise<ClaimedAccountErasureIntent | null>;
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
  ): Promise<AccountErasureLedgerConfirmation>;
}

export interface AccountErasureRecoveryManifestSink {
  /**
   * Encrypt with a separate erasure key, WORM-write with separate credentials,
   * then read back. Implementations must never log or retain plaintext locators.
   */
  encryptWriteAndConfirm(
    manifest: AccountErasureRecoveryManifest,
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
    actual.schemaVersion === expected.schemaVersion &&
    actual.jobId === expected.jobId &&
    actual.accountId === expected.accountId &&
    actual.acceptedAt === expected.acceptedAt &&
    Number.isFinite(Date.parse(confirmation.confirmedAt)) &&
    lowercaseSha256.test(confirmation.sha256) &&
    lowercaseSha256.test(confirmation.macSha256)
  );
}

async function confirmedLedgerInput(
  intent: AccountErasureIntent,
  ledger: AccountErasureLedgerSink,
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
  const evidence = await ledger.writeAndConfirm(record);
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
    Number.isFinite(Date.parse(actual.confirmedAt)) &&
    lowercaseSha256.test(actual.ciphertextSha256) &&
    lowercaseSha256.test(actual.macSha256) &&
    Number.isSafeInteger(actual.keyVersion) &&
    actual.keyVersion >= 1
  );
}

async function confirmedRecoveryManifest(
  manifest: AccountErasureRecoveryManifest,
  sink: AccountErasureRecoveryManifestSink,
): Promise<AccountErasureRecoveryManifestConfirmation> {
  const confirmation = await sink.encryptWriteAndConfirm(manifest);
  if (!exactRecoveryManifestConfirmation(manifest, confirmation)) {
    throw new ApiError(
      503,
      'erasure_recovery_manifest_mismatch',
      'Account erasure recovery manifest confirmation failed',
    );
  }
  return confirmation;
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
  const inventory = await store.sealAfterLedgerConfirmation(
    await confirmedLedgerInput(intent, ledger),
  );
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
}

/** Provider-free recovery for intents stranded before transaction 2. */
export class AccountErasureRecoveryWorker {
  private running = false;

  constructor(
    private readonly store: AccountErasureRecoveryStore,
    private readonly ledger: AccountErasureLedgerSink,
    private readonly recoveryManifestSink: AccountErasureRecoveryManifestSink,
    private readonly batchSize = 25,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error('Account erasure recovery batch size must be between 1 and 100');
    }
  }

  async tick(): Promise<AccountErasureRecoveryTickResult> {
    if (this.running) return { claimed: 0, sealed: 0, retried: 0, attention: 0, stale: 0 };
    this.running = true;
    const result: AccountErasureRecoveryTickResult = {
      claimed: 0,
      sealed: 0,
      retried: 0,
      attention: 0,
      stale: 0,
    };
    try {
      for (let index = 0; index < this.batchSize; index += 1) {
        const claim = await this.store.claimIntentForRecovery();
        if (!claim) break;
        result.claimed += 1;
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
            const confirmed = await confirmedLedgerInput(claim.intent, this.ledger);
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
