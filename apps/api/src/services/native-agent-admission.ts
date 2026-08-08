import type { AuthSession } from '@eden3/core';
import { type SQL, sql } from 'drizzle-orm';

import { ApiError } from '../errors';

export interface NativeAgentAdmissionTransaction {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Authoritative native-agent quota check. The caller must invoke this inside
 * the SAME database transaction that inserts the account/agent rows.
 */
export async function assertNativeAgentCreationAllowed(
  tx: NativeAgentAdmissionTransaction,
  viewer: AuthSession,
  limit: number,
): Promise<void> {
  if (viewer.isAdmin) return;

  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`native-agent-quota:${viewer.accountId}`}, 0)
    )
  `);
  const quotaRows = (await tx.execute(sql`
    select count(*)::int as count
    from agents g
    join accounts a on a.id = g.account_id
    where g.owner_id = ${viewer.accountId}
      and a.external_id is null
      and a.deleted = false
  `)) as { count: number }[];
  if ((quotaRows[0]?.count ?? 0) >= limit) {
    throw new ApiError(
      429,
      'agent_quota_exceeded',
      `Agent creation limit reached (${limit} native agents)`,
    );
  }
}
