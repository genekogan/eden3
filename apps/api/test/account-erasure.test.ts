import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/errors';
import {
  ACCOUNT_ERASURE_LEDGER_SCHEMA_VERSION,
  ACCOUNT_ERASURE_RECOVERY_MANIFEST_SCHEMA_VERSION,
  AccountErasureRecoveryWorker,
  accountErasureRequestSchema,
  requestAccountErasure,
  type AccountErasureIntentStore,
  type AccountErasureLedgerSink,
  type AccountErasureRecoveryManifest,
  type AccountErasureRecoveryManifestSink,
  type AccountErasureRecoveryStore,
} from '../src/services/account-erasure';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const ACCEPTED_AT = '2026-08-08T20:00:00.000Z';
const CONFIRMED_AT = '2026-08-08T20:00:01.000Z';
const CLAIM_EXPIRES_AT = '2026-08-08T20:01:00.000Z';
const CLAIM_TOKEN = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const MAC = 'b'.repeat(64);
const INVENTORY_HASH = 'c'.repeat(64);
const CIPHERTEXT_HASH = 'd'.repeat(64);
const SECRET_LOCATOR = 'clerk_user_secret_locator';

function recoveryManifest(): AccountErasureRecoveryManifest {
  return {
    schemaVersion: ACCOUNT_ERASURE_RECOVERY_MANIFEST_SCHEMA_VERSION,
    jobId: JOB_ID,
    accountId: ACTOR_ID,
    inventoriedAt: CONFIRMED_AT,
    inventorySha256: INVENTORY_HASH,
    locators: [{ kind: 'clerk_identity', resourceId: ACTOR_ID, locator: SECRET_LOCATOR }],
  };
}

function store(): AccountErasureIntentStore {
  return {
    acceptIntent: vi.fn(async () => ({
      jobId: JOB_ID,
      accountId: ACTOR_ID,
      acceptedAt: ACCEPTED_AT,
      state: 'intent_pending' as const,
    })),
    sealAfterLedgerConfirmation: vi.fn(async () => ({
      jobId: JOB_ID,
      accountId: ACTOR_ID,
      status: 'recovery_manifest_pending' as const,
      recoveryManifest: recoveryManifest(),
    })),
    confirmRecoveryManifestUnclaimed: vi.fn(async () => ({
      jobId: JOB_ID,
      status: 'pending' as const,
    })),
  };
}

function manifestSink(): AccountErasureRecoveryManifestSink {
  return {
    encryptWriteAndConfirm: vi.fn(async (manifest) => ({
      schemaVersion: manifest.schemaVersion,
      jobId: manifest.jobId,
      accountId: manifest.accountId,
      inventorySha256: manifest.inventorySha256,
      confirmedAt: CONFIRMED_AT,
      ciphertextSha256: CIPHERTEXT_HASH,
      macSha256: MAC,
      keyVersion: 1,
    })),
  };
}

function sink(): AccountErasureLedgerSink {
  return {
    writeAndConfirm: vi.fn(async (record) => ({
      record,
      confirmedAt: CONFIRMED_AT,
      sha256: HASH,
      macSha256: MAC,
    })),
  };
}

function request(overrides: Partial<Parameters<typeof requestAccountErasure>[0]> = {}) {
  return {
    actorAccountId: ACTOR_ID,
    actorUsername: 'Gene',
    actorIsAdmin: false,
    confirmUsername: 'gene',
    ...overrides,
  };
}

describe('account erasure admission and ledger ordering', () => {
  it('accepts only an explicit current-username confirmation and no target selector', () => {
    expect(accountErasureRequestSchema.parse({ confirmUsername: 'gene' })).toEqual({
      confirmUsername: 'gene',
    });
    expect(() =>
      accountErasureRequestSchema.parse({ confirmUsername: 'gene', accountId: JOB_ID }),
    ).toThrow();
    expect(() => accountErasureRequestSchema.parse({})).toThrow();
  });

  it('orders intent commit, exact WORM confirmation, then inventory/seal', async () => {
    const repository = store();
    const ledger = sink();
    const recovery = manifestSink();
    const calls: string[] = [];
    vi.mocked(repository.acceptIntent).mockImplementation(async () => {
      calls.push('intent');
      return {
        jobId: JOB_ID,
        accountId: ACTOR_ID,
        acceptedAt: ACCEPTED_AT,
        state: 'intent_pending',
      };
    });
    vi.mocked(ledger.writeAndConfirm).mockImplementation(async (record) => {
      calls.push('ledger');
      return { record, confirmedAt: CONFIRMED_AT, sha256: HASH, macSha256: MAC };
    });
    vi.mocked(repository.sealAfterLedgerConfirmation).mockImplementation(async () => {
      calls.push('seal');
      return {
        jobId: JOB_ID,
        accountId: ACTOR_ID,
        status: 'recovery_manifest_pending',
        recoveryManifest: recoveryManifest(),
      };
    });
    vi.mocked(recovery.encryptWriteAndConfirm).mockImplementation(async (manifest) => {
      calls.push('recovery-manifest');
      return {
        schemaVersion: manifest.schemaVersion,
        jobId: manifest.jobId,
        accountId: manifest.accountId,
        inventorySha256: manifest.inventorySha256,
        confirmedAt: CONFIRMED_AT,
        ciphertextSha256: CIPHERTEXT_HASH,
        macSha256: MAC,
        keyVersion: 1,
      };
    });
    vi.mocked(repository.confirmRecoveryManifestUnclaimed).mockImplementation(async () => {
      calls.push('manifest-confirmed');
      return { jobId: JOB_ID, status: 'pending' };
    });

    await expect(requestAccountErasure(request(), repository, ledger, recovery)).resolves.toEqual({
      jobId: JOB_ID,
      status: 'pending',
    });
    expect(calls).toEqual([
      'intent',
      'ledger',
      'seal',
      'recovery-manifest',
      'manifest-confirmed',
    ]);
    expect(repository.acceptIntent).toHaveBeenCalledWith({
      accountId: ACTOR_ID,
      confirmUsername: 'gene',
    });
    expect(ledger.writeAndConfirm).toHaveBeenCalledWith({
      schemaVersion: ACCOUNT_ERASURE_LEDGER_SCHEMA_VERSION,
      jobId: JOB_ID,
      accountId: ACTOR_ID,
      acceptedAt: ACCEPTED_AT,
    });
    expect(repository.sealAfterLedgerConfirmation).toHaveBeenCalledWith({
      jobId: JOB_ID,
      accountId: ACTOR_ID,
      acceptedAt: ACCEPTED_AT,
      confirmedAt: CONFIRMED_AT,
      ledgerSha256: HASH,
      ledgerMacSha256: MAC,
    });
    expect(recovery.encryptWriteAndConfirm).toHaveBeenCalledWith(recoveryManifest());
    expect(repository.confirmRecoveryManifestUnclaimed).toHaveBeenCalledWith({
      jobId: JOB_ID,
      accountId: ACTOR_ID,
      confirmation: expect.objectContaining({
        ciphertextSha256: CIPHERTEXT_HASH,
        inventorySha256: INVENTORY_HASH,
      }),
    });
  });

  it('does not seal when the WORM write or confirmation fails', async () => {
    const repository = store();
    const ledger = sink();
    const recovery = manifestSink();
    vi.mocked(ledger.writeAndConfirm).mockRejectedValue(new Error('ledger unavailable'));
    await expect(requestAccountErasure(request(), repository, ledger, recovery)).rejects.toThrow(
      'ledger unavailable',
    );
    expect(repository.sealAfterLedgerConfirmation).not.toHaveBeenCalled();
  });

  it('keeps cleanup unclaimable until the separate encrypted recovery manifest confirms', async () => {
    const repository = store();
    const ledger = sink();
    const recovery = manifestSink();
    vi.mocked(recovery.encryptWriteAndConfirm).mockRejectedValue(
      new Error('dedicated recovery sink unavailable'),
    );

    await expect(
      requestAccountErasure(request(), repository, ledger, recovery),
    ).rejects.toThrow('dedicated recovery sink unavailable');
    expect(repository.sealAfterLedgerConfirmation).toHaveBeenCalledTimes(1);
    expect(repository.confirmRecoveryManifestUnclaimed).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(repository.sealAfterLedgerConfirmation).mock.calls)).not.toContain(
      SECRET_LOCATOR,
    );
  });

  it('rejects a recovery-manifest readback mismatch without enabling cleanup', async () => {
    const repository = store();
    const recovery = manifestSink();
    vi.mocked(recovery.encryptWriteAndConfirm).mockImplementation(async (manifest) => ({
      schemaVersion: manifest.schemaVersion,
      jobId: manifest.jobId,
      accountId: OTHER_ID,
      inventorySha256: manifest.inventorySha256,
      confirmedAt: CONFIRMED_AT,
      ciphertextSha256: CIPHERTEXT_HASH,
      macSha256: MAC,
      keyVersion: 1,
    }));
    await expect(
      requestAccountErasure(request(), repository, sink(), recovery),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'erasure_recovery_manifest_mismatch',
    } satisfies Partial<ApiError>);
    expect(repository.confirmRecoveryManifestUnclaimed).not.toHaveBeenCalled();
  });

  it('rejects mismatched ledger readback before any account mutation', async () => {
    const repository = store();
    const ledger = sink();
    const recovery = manifestSink();
    vi.mocked(ledger.writeAndConfirm).mockImplementation(async (record) => ({
      record: { ...record, accountId: OTHER_ID },
      confirmedAt: CONFIRMED_AT,
      sha256: HASH,
      macSha256: MAC,
    }));
    await expect(requestAccountErasure(request(), repository, ledger, recovery)).rejects.toMatchObject({
      statusCode: 503,
      code: 'erasure_ledger_mismatch',
    } satisfies Partial<ApiError>);
    expect(repository.sealAfterLedgerConfirmation).not.toHaveBeenCalled();
  });

  it('converges after a crash between confirmed ledger and transaction 2', async () => {
    const repository = store();
    const ledger = sink();
    const recovery = manifestSink();
    vi.mocked(repository.sealAfterLedgerConfirmation)
      .mockRejectedValueOnce(new Error('process died before tx2'))
      .mockResolvedValueOnce({
        jobId: JOB_ID,
        accountId: ACTOR_ID,
        status: 'recovery_manifest_pending',
        recoveryManifest: recoveryManifest(),
      });

    await expect(requestAccountErasure(request(), repository, ledger, recovery)).rejects.toThrow(
      'process died before tx2',
    );
    await expect(requestAccountErasure(request(), repository, ledger, recovery)).resolves.toEqual({
      jobId: JOB_ID,
      status: 'pending',
    });
    expect(repository.acceptIntent).toHaveBeenCalledTimes(2);
    expect(ledger.writeAndConfirm).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ledger.writeAndConfirm).mock.calls[0]?.[0]).toEqual(
      vi.mocked(ledger.writeAndConfirm).mock.calls[1]?.[0],
    );
    expect(repository.sealAfterLedgerConfirmation).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed integrity evidence before transaction 2', async () => {
    const repository = store();
    const ledger = sink();
    const recovery = manifestSink();
    vi.mocked(ledger.writeAndConfirm).mockImplementation(async (record) => ({
      record,
      confirmedAt: CONFIRMED_AT,
      sha256: 'not-a-sha256',
      macSha256: MAC,
    }));
    await expect(requestAccountErasure(request(), repository, ledger, recovery)).rejects.toMatchObject({
      statusCode: 503,
      code: 'erasure_ledger_mismatch',
    } satisfies Partial<ApiError>);
    expect(repository.sealAfterLedgerConfirmation).not.toHaveBeenCalled();
  });

  it('refuses admin self-erasure before intent or sink mutation', async () => {
    const repository = store();
    const ledger = sink();
    const recovery = manifestSink();
    await expect(
      requestAccountErasure(request({ actorIsAdmin: true }), repository, ledger, recovery),
    ).rejects.toMatchObject({ statusCode: 403, code: 'protected_account' } satisfies Partial<ApiError>);
    expect(repository.acceptIntent).not.toHaveBeenCalled();
    expect(ledger.writeAndConfirm).not.toHaveBeenCalled();
  });

  it('rejects a mismatched confirmation before intent or sink mutation', async () => {
    const repository = store();
    const ledger = sink();
    const recovery = manifestSink();
    await expect(
      requestAccountErasure(request({ confirmUsername: 'not-gene' }), repository, ledger, recovery),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'confirmation_mismatch',
    } satisfies Partial<ApiError>);
    expect(repository.acceptIntent).not.toHaveBeenCalled();
    expect(ledger.writeAndConfirm).not.toHaveBeenCalled();
  });

  it('preserves a row-locked store refusal for non-user, deleted, or Eve identities', async () => {
    const repository = store();
    const ledger = sink();
    const recovery = manifestSink();
    vi.mocked(repository.acceptIntent).mockRejectedValue(
      new ApiError(403, 'protected_account', 'This account cannot be deleted'),
    );
    await expect(requestAccountErasure(request(), repository, ledger, recovery)).rejects.toMatchObject({
      statusCode: 403,
      code: 'protected_account',
    } satisfies Partial<ApiError>);
    expect(ledger.writeAndConfirm).not.toHaveBeenCalled();
  });
});

describe('account erasure autonomous recovery', () => {
  function recoveryStore(): AccountErasureRecoveryStore {
    const intent = {
      jobId: JOB_ID,
      accountId: ACTOR_ID,
      acceptedAt: ACCEPTED_AT,
      state: 'intent_pending' as const,
    };
    let claimed = false;
    return {
      ...store(),
      claimIntentForRecovery: vi.fn(async () => {
        if (claimed) return null;
        claimed = true;
        return { intent, claimToken: CLAIM_TOKEN, claimExpiresAt: CLAIM_EXPIRES_AT };
      }),
      sealClaimedAfterLedgerConfirmation: vi.fn(async () => ({
        jobId: JOB_ID,
        accountId: ACTOR_ID,
        status: 'recovery_manifest_pending' as const,
        recoveryManifest: recoveryManifest(),
      })),
      confirmClaimedRecoveryManifest: vi.fn(async () => ({
        jobId: JOB_ID,
        status: 'pending' as const,
      })),
      recordRecoveryFailure: vi.fn(async () => 'retried' as const),
    };
  }

  it('finishes an accepted intent without any caller retry', async () => {
    const repository = recoveryStore();
    const ledger = sink();
    const worker = new AccountErasureRecoveryWorker(repository, ledger, manifestSink());
    await expect(worker.tick()).resolves.toEqual({
      claimed: 1,
      sealed: 1,
      retried: 0,
      attention: 0,
      stale: 0,
    });
    expect(ledger.writeAndConfirm).toHaveBeenCalledTimes(1);
    expect(repository.sealClaimedAfterLedgerConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        claimToken: CLAIM_TOKEN,
        claimExpiresAt: CLAIM_EXPIRES_AT,
      }),
    );
    expect(repository.confirmClaimedRecoveryManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        claimToken: CLAIM_TOKEN,
        claimExpiresAt: CLAIM_EXPIRES_AT,
      }),
    );
    expect(repository.sealAfterLedgerConfirmation).not.toHaveBeenCalled();
    expect(repository.recordRecoveryFailure).not.toHaveBeenCalled();
  });

  it('records a safe durable failure for autonomous retry without raw errors', async () => {
    const repository = recoveryStore();
    const ledger = sink();
    vi.mocked(ledger.writeAndConfirm).mockRejectedValue(
      new Error('secret provider response must not be persisted'),
    );
    const worker = new AccountErasureRecoveryWorker(repository, ledger, manifestSink());
    await expect(worker.tick()).resolves.toEqual({
      claimed: 1,
      sealed: 0,
      retried: 1,
      attention: 0,
      stale: 0,
    });
    expect(repository.recordRecoveryFailure).toHaveBeenCalledWith({
      jobId: JOB_ID,
      claimToken: CLAIM_TOKEN,
      claimExpiresAt: CLAIM_EXPIRES_AT,
      errorCode: 'erasure_recovery_failed',
    });
  });

  it('recovers a manifest-pending inventory without rewriting the initial ledger', async () => {
    const repository = recoveryStore();
    const ledger = sink();
    const recovery = manifestSink();
    vi.mocked(repository.claimIntentForRecovery).mockResolvedValueOnce({
      intent: {
        jobId: JOB_ID,
        accountId: ACTOR_ID,
        acceptedAt: ACCEPTED_AT,
        state: 'manifest_pending',
        recoveryManifest: recoveryManifest(),
      },
      claimToken: CLAIM_TOKEN,
      claimExpiresAt: CLAIM_EXPIRES_AT,
    });
    const worker = new AccountErasureRecoveryWorker(repository, ledger, recovery, 1);
    await expect(worker.tick()).resolves.toEqual({
      claimed: 1,
      sealed: 1,
      retried: 0,
      attention: 0,
      stale: 0,
    });
    expect(ledger.writeAndConfirm).not.toHaveBeenCalled();
    expect(repository.sealClaimedAfterLedgerConfirmation).not.toHaveBeenCalled();
    expect(recovery.encryptWriteAndConfirm).toHaveBeenCalledWith(recoveryManifest());
    expect(repository.confirmClaimedRecoveryManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        claimToken: CLAIM_TOKEN,
        claimExpiresAt: CLAIM_EXPIRES_AT,
      }),
    );
  });

  it('coalesces overlapping recovery ticks', async () => {
    const repository = recoveryStore();
    const ledger = sink();
    let release!: () => void;
    vi.mocked(ledger.writeAndConfirm).mockImplementation(
      (record) =>
        new Promise((resolve) => {
          release = () =>
            resolve({ record, confirmedAt: CONFIRMED_AT, sha256: HASH, macSha256: MAC });
        }),
    );
    const worker = new AccountErasureRecoveryWorker(repository, ledger, manifestSink());
    const first = worker.tick();
    const second = worker.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await expect(first).resolves.toEqual({
      claimed: 1,
      sealed: 1,
      retried: 0,
      attention: 0,
      stale: 0,
    });
    await expect(second).resolves.toEqual({
      claimed: 0,
      sealed: 0,
      retried: 0,
      attention: 0,
      stale: 0,
    });
  });

  it('makes both late success and late failure stale after another worker reclaims', async () => {
    const repository = recoveryStore();
    const ledger = sink();
    const oldToken = CLAIM_TOKEN;
    const newToken = '55555555-5555-4555-8555-555555555555';
    const newExpiry = '2026-08-08T20:02:00.000Z';
    const oldClaim = {
      intent: {
        jobId: JOB_ID,
        accountId: ACTOR_ID,
        acceptedAt: ACCEPTED_AT,
        state: 'intent_pending' as const,
      },
      claimToken: oldToken,
      claimExpiresAt: CLAIM_EXPIRES_AT,
    };
    const newClaim = { ...oldClaim, claimToken: newToken, claimExpiresAt: newExpiry };
    vi.mocked(repository.claimIntentForRecovery)
      .mockResolvedValueOnce(oldClaim)
      .mockResolvedValueOnce(newClaim)
      .mockResolvedValue(null);
    vi.mocked(repository.sealClaimedAfterLedgerConfirmation).mockImplementation(
      async ({ claimToken }) =>
        claimToken === newToken
          ? {
              jobId: JOB_ID,
              accountId: ACTOR_ID,
              status: 'recovery_manifest_pending',
              recoveryManifest: recoveryManifest(),
            }
          : { jobId: JOB_ID, status: 'stale' },
    );
    vi.mocked(repository.confirmClaimedRecoveryManifest).mockImplementation(
      async ({ claimToken }) =>
        claimToken === newToken
          ? { jobId: JOB_ID, status: 'pending' }
          : { jobId: JOB_ID, status: 'stale' },
    );
    vi.mocked(repository.recordRecoveryFailure).mockImplementation(async ({ claimToken }) =>
      claimToken === oldToken ? 'stale' : 'retried',
    );
    let releaseOld!: () => void;
    vi.mocked(ledger.writeAndConfirm)
      .mockImplementationOnce(
        (record) =>
          new Promise((resolve) => {
            releaseOld = () =>
              resolve({ record, confirmedAt: CONFIRMED_AT, sha256: HASH, macSha256: MAC });
          }),
      )
      .mockImplementationOnce(async (record) => ({
        record,
        confirmedAt: CONFIRMED_AT,
        sha256: HASH,
        macSha256: MAC,
      }));

    const oldWorker = new AccountErasureRecoveryWorker(repository, ledger, manifestSink(), 1);
    const newWorker = new AccountErasureRecoveryWorker(repository, ledger, manifestSink(), 1);
    const oldSuccess = oldWorker.tick();
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf('function'));
    await expect(newWorker.tick()).resolves.toMatchObject({ claimed: 1, sealed: 1, stale: 0 });
    expect(repository.confirmClaimedRecoveryManifest).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: newToken, claimExpiresAt: newExpiry }),
    );
    releaseOld();
    await expect(oldSuccess).resolves.toMatchObject({ claimed: 1, sealed: 0, stale: 1 });

    vi.mocked(repository.claimIntentForRecovery).mockResolvedValueOnce(oldClaim);
    vi.mocked(ledger.writeAndConfirm).mockRejectedValueOnce(new Error('late old failure'));
    await expect(oldWorker.tick()).resolves.toMatchObject({ claimed: 1, stale: 1 });
    expect(repository.recordRecoveryFailure).toHaveBeenLastCalledWith({
      jobId: JOB_ID,
      claimToken: oldToken,
      claimExpiresAt: CLAIM_EXPIRES_AT,
      errorCode: 'erasure_recovery_failed',
    });
  });
});
