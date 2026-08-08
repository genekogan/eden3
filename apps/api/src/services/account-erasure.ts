import { z } from 'zod';

import { ApiError } from '../errors';

export const ACCOUNT_ERASURE_LEDGER_SCHEMA_VERSION = 'eden3.account-erasure@v1' as const;

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
  }): Promise<AccountErasureRequestResult>;
}

export interface AccountErasureRecoveryStore extends AccountErasureIntentStore {
  /** Claim one due intent/backup target with a fenced lease, or null when idle. */
  claimIntentForRecovery(): Promise<AccountErasureIntent | null>;
  /** Persist only a safe code and release/attention the exact claim. */
  recordRecoveryFailure(input: {
    jobId: string;
    errorCode: 'erasure_recovery_failed';
  }): Promise<void>;
}

export interface AccountErasureLedgerSink {
  /** Canonically encode, MAC, WORM-write, then HEAD/read back the exact record. */
  writeAndConfirm(
    record: AccountErasureLedgerRecord,
  ): Promise<AccountErasureLedgerConfirmation>;
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

async function confirmAndSealIntent(
  intent: AccountErasureIntent,
  store: Pick<AccountErasureIntentStore, 'sealAfterLedgerConfirmation'>,
  ledger: AccountErasureLedgerSink,
): Promise<AccountErasureRequestResult> {
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
  return store.sealAfterLedgerConfirmation({
    jobId: intent.jobId,
    accountId: intent.accountId,
    acceptedAt: intent.acceptedAt,
    confirmedAt: evidence.confirmedAt,
    ledgerSha256: evidence.sha256,
    ledgerMacSha256: evidence.macSha256,
  });
}

/**
 * Coordinate the two database transactions around the mandatory WORM ledger
 * confirmation. No account mutation is reachable before exact readback.
 */
export async function requestAccountErasure(
  input: AccountErasureAdmission,
  store: AccountErasureIntentStore,
  ledger: AccountErasureLedgerSink,
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
  return confirmAndSealIntent(intent, store, ledger);
}

export interface AccountErasureRecoveryTickResult {
  claimed: number;
  sealed: number;
  failed: number;
}

/** Provider-free recovery for intents stranded before transaction 2. */
export class AccountErasureRecoveryWorker {
  private running = false;

  constructor(
    private readonly store: AccountErasureRecoveryStore,
    private readonly ledger: AccountErasureLedgerSink,
    private readonly batchSize = 25,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error('Account erasure recovery batch size must be between 1 and 100');
    }
  }

  async tick(): Promise<AccountErasureRecoveryTickResult> {
    if (this.running) return { claimed: 0, sealed: 0, failed: 0 };
    this.running = true;
    const result: AccountErasureRecoveryTickResult = { claimed: 0, sealed: 0, failed: 0 };
    try {
      for (let index = 0; index < this.batchSize; index += 1) {
        const intent = await this.store.claimIntentForRecovery();
        if (!intent) break;
        result.claimed += 1;
        try {
          await confirmAndSealIntent(intent, this.store, this.ledger);
          result.sealed += 1;
        } catch {
          await this.store.recordRecoveryFailure({
            jobId: intent.jobId,
            errorCode: 'erasure_recovery_failed',
          });
          // The store applies bounded backoff and moves the target to attention
          // only at the frozen threshold; one failed attempt is not attention.
          result.failed += 1;
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
