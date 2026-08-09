import { pg } from '@eden3/db';

import { ApiError } from '../errors';

type PgTransaction = Parameters<Parameters<typeof pg.begin>[1]>[0];

export const CHANNEL_ACCOUNT_LOCK_PREFIX = 'channel-account:';
export const CHANNEL_ACCOUNT_LOCK_SEED = 0;

export class ChannelConnectionQuotaExceededError extends ApiError {
  constructor(readonly limit: number) {
    super(429, 'channel_quota_exceeded', `Channel connection limit reached (${limit} connections)`);
    this.name = 'ChannelConnectionQuotaExceededError';
  }
}

/**
 * Serialize every connection writer for one owner before any narrower
 * provider-credential lock. The count and eventual insert must share this
 * transaction; otherwise hosted, X, and managed-Telegram creates can all
 * admit against the same stale count.
 */
export async function lockAndAssertChannelConnectionQuota(
  tx: PgTransaction,
  input: {
    accountId: string;
    limit: number;
    bypassAccountQuota: boolean;
  },
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`${CHANNEL_ACCOUNT_LOCK_PREFIX}${input.accountId}`}, ${CHANNEL_ACCOUNT_LOCK_SEED}))`;
  if (input.bypassAccountQuota) return;

  const counts = await tx<{ count: number }[]>`
    select count(*)::int as count
    from channel_connections
    where account_id = ${input.accountId}
  `;
  if ((counts[0]?.count ?? 0) >= input.limit) {
    throw new ChannelConnectionQuotaExceededError(input.limit);
  }
}
