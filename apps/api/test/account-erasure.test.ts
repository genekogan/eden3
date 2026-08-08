import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/errors';
import {
  ACCOUNT_ERASURE_LEDGER_SCHEMA_VERSION,
  accountErasureRequestSchema,
  requestAccountErasure,
  type AccountErasureIntentStore,
  type AccountErasureLedgerSink,
} from '../src/services/account-erasure';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const ACCEPTED_AT = '2026-08-08T20:00:00.000Z';
const CONFIRMED_AT = '2026-08-08T20:00:01.000Z';
const HASH = 'a'.repeat(64);
const MAC = 'b'.repeat(64);

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
      status: 'pending' as const,
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
      return { jobId: JOB_ID, status: 'pending' };
    });

    await expect(requestAccountErasure(request(), repository, ledger)).resolves.toEqual({
      jobId: JOB_ID,
      status: 'pending',
    });
    expect(calls).toEqual(['intent', 'ledger', 'seal']);
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
  });

  it('does not seal when the WORM write or confirmation fails', async () => {
    const repository = store();
    const ledger = sink();
    vi.mocked(ledger.writeAndConfirm).mockRejectedValue(new Error('ledger unavailable'));
    await expect(requestAccountErasure(request(), repository, ledger)).rejects.toThrow(
      'ledger unavailable',
    );
    expect(repository.sealAfterLedgerConfirmation).not.toHaveBeenCalled();
  });

  it('rejects mismatched ledger readback before any account mutation', async () => {
    const repository = store();
    const ledger = sink();
    vi.mocked(ledger.writeAndConfirm).mockImplementation(async (record) => ({
      record: { ...record, accountId: OTHER_ID },
      confirmedAt: CONFIRMED_AT,
      sha256: HASH,
      macSha256: MAC,
    }));
    await expect(requestAccountErasure(request(), repository, ledger)).rejects.toMatchObject({
      statusCode: 503,
      code: 'erasure_ledger_mismatch',
    } satisfies Partial<ApiError>);
    expect(repository.sealAfterLedgerConfirmation).not.toHaveBeenCalled();
  });

  it('refuses admin self-erasure before intent or sink mutation', async () => {
    const repository = store();
    const ledger = sink();
    await expect(
      requestAccountErasure(request({ actorIsAdmin: true }), repository, ledger),
    ).rejects.toMatchObject({ statusCode: 403, code: 'protected_account' } satisfies Partial<ApiError>);
    expect(repository.acceptIntent).not.toHaveBeenCalled();
    expect(ledger.writeAndConfirm).not.toHaveBeenCalled();
  });

  it('rejects a mismatched confirmation before intent or sink mutation', async () => {
    const repository = store();
    const ledger = sink();
    await expect(
      requestAccountErasure(request({ confirmUsername: 'not-gene' }), repository, ledger),
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
    vi.mocked(repository.acceptIntent).mockRejectedValue(
      new ApiError(403, 'protected_account', 'This account cannot be deleted'),
    );
    await expect(requestAccountErasure(request(), repository, ledger)).rejects.toMatchObject({
      statusCode: 403,
      code: 'protected_account',
    } satisfies Partial<ApiError>);
    expect(ledger.writeAndConfirm).not.toHaveBeenCalled();
  });
});
