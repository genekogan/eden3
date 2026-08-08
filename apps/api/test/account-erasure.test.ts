import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/errors';
import {
  accountErasureRequestSchema,
  requestAccountErasure,
  type AccountErasureRequestStore,
} from '../src/services/account-erasure';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

function store(
  implementation: AccountErasureRequestStore['beginSelfErasure'] = async () => ({
    jobId: JOB_ID,
    status: 'pending',
  }),
): AccountErasureRequestStore {
  return { beginSelfErasure: vi.fn(implementation) };
}

describe('account erasure admission', () => {
  it('accepts only an explicit current-username confirmation and no target selector', () => {
    expect(accountErasureRequestSchema.parse({ confirmUsername: 'gene' })).toEqual({
      confirmUsername: 'gene',
    });
    expect(() =>
      accountErasureRequestSchema.parse({ confirmUsername: 'gene', accountId: JOB_ID }),
    ).toThrow();
    expect(() => accountErasureRequestSchema.parse({})).toThrow();
  });

  it('derives the only target from the authenticated principal', async () => {
    const repository = store();
    await expect(
      requestAccountErasure(
        {
          actorAccountId: ACTOR_ID,
          actorUsername: 'Gene',
          actorIsAdmin: false,
          confirmUsername: 'gene',
        },
        repository,
      ),
    ).resolves.toEqual({ jobId: JOB_ID, status: 'pending' });
    expect(repository.beginSelfErasure).toHaveBeenCalledWith({
      accountId: ACTOR_ID,
      confirmUsername: 'gene',
    });
  });

  it('refuses admin self-erasure before any store mutation', async () => {
    const repository = store();
    await expect(
      requestAccountErasure(
        {
          actorAccountId: ACTOR_ID,
          actorUsername: 'gene',
          actorIsAdmin: true,
          confirmUsername: 'gene',
        },
        repository,
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'protected_account',
    } satisfies Partial<ApiError>);
    expect(repository.beginSelfErasure).not.toHaveBeenCalled();
  });

  it('rejects a mismatched confirmation before any store mutation', async () => {
    const repository = store();
    await expect(
      requestAccountErasure(
        {
          actorAccountId: ACTOR_ID,
          actorUsername: 'gene',
          actorIsAdmin: false,
          confirmUsername: 'not-gene',
        },
        repository,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'confirmation_mismatch',
    } satisfies Partial<ApiError>);
    expect(repository.beginSelfErasure).not.toHaveBeenCalled();
  });

  it('preserves a row-locked store refusal for non-user, deleted, or Eve identities', async () => {
    const repository = store(async () => {
      throw new ApiError(403, 'protected_account', 'This account cannot be deleted');
    });
    await expect(
      requestAccountErasure(
        {
          actorAccountId: ACTOR_ID,
          actorUsername: 'gene',
          actorIsAdmin: false,
          confirmUsername: 'gene',
        },
        repository,
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'protected_account',
    } satisfies Partial<ApiError>);
  });
});
