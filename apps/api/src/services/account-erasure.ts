import { z } from 'zod';

import { ApiError } from '../errors';

export const accountErasureRequestSchema = z
  .object({
    confirmUsername: z.string().trim().min(1).max(128),
  })
  .strict();

export interface AccountErasureRequestResult {
  jobId: string;
  status: 'pending' | 'claimed' | 'succeeded' | 'failed';
}

export interface AccountErasureRequestStore {
  /**
   * Row-lock and revalidate the account, then atomically seal it and create
   * the complete erasure inventory. The account id is always auth-derived.
   */
  beginSelfErasure(input: {
    accountId: string;
    confirmUsername: string;
  }): Promise<AccountErasureRequestResult>;
}

export interface AccountErasureAdmission {
  actorAccountId: string;
  actorUsername: string;
  actorIsAdmin: boolean;
  confirmUsername: string;
}

/** Admission shared by the HTTP route and deterministic non-HTTP callers. */
export async function requestAccountErasure(
  input: AccountErasureAdmission,
  store: AccountErasureRequestStore,
): Promise<AccountErasureRequestResult> {
  if (input.actorIsAdmin) {
    throw new ApiError(403, 'protected_account', 'Administrator accounts cannot be deleted');
  }
  const confirmation = input.confirmUsername.trim();
  if (confirmation.toLocaleLowerCase('en-US') !== input.actorUsername.toLocaleLowerCase('en-US')) {
    throw new ApiError(400, 'confirmation_mismatch', 'Account username confirmation does not match');
  }
  return store.beginSelfErasure({
    accountId: input.actorAccountId,
    confirmUsername: confirmation,
  });
}
