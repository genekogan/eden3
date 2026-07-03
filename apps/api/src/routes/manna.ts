import { numericToNumber } from '@eden3/core';
import { db, mannaAccounts, pg } from '@eden3/db';
import { feedQuerySchema } from '@eden3/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

import {
  mannaTransactionDtoFromRow,
  nextCursorFrom,
  parseCursorParam,
  type MannaTransactionRow,
} from '../route-helpers';

/**
 * Manna API (auth required — everything is scoped to the signed-in account).
 *
 *   GET /manna              — {accountId, balance, subscriptionBalance,
 *                             updatedAt}; accounts without a manna row yet
 *                             report zeros (mirrors @eden3/core getBalance).
 *   GET /manna/transactions — append-only ledger, newest first, keyset
 *                             (created_at, id) cursor.
 */

export const mannaRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: app.requireAuth }, async (req) => {
    const accountId = req.account?.accountId;
    if (accountId === undefined) return null; // unreachable — requireAuth replied 401
    const [row] = await db
      .select()
      .from(mannaAccounts)
      .where(eq(mannaAccounts.accountId, accountId))
      .limit(1);
    return {
      accountId,
      balance: row ? numericToNumber(row.balance) : 0,
      subscriptionBalance: row ? numericToNumber(row.subscriptionBalance) : 0,
      updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
    };
  });

  app.get('/transactions', { preHandler: app.requireAuth }, async (req) => {
    const accountId = req.account?.accountId;
    if (accountId === undefined) return null; // unreachable — requireAuth replied 401
    const { cursor, limit } = feedQuerySchema.parse(req.query);
    const after = parseCursorParam(cursor);

    const rows = await pg<MannaTransactionRow[]>`
      select t.id, t.manna_account_id, t.amount, t.type, t.task_external_id,
             t.refunds_transaction_id, t.created_at
      from manna_transactions t
      join manna_accounts m on m.id = t.manna_account_id
      where m.account_id = ${accountId}
        ${
          after !== null
            ? pg`and t.created_at <= ${after.createdAt}
                 and (t.created_at < ${after.createdAt} or t.id < ${after.id})`
            : pg``
        }
      order by t.created_at desc nulls last, t.id desc
      limit ${limit + 1}
    `;

    return {
      items: rows.slice(0, limit).map(mannaTransactionDtoFromRow),
      nextCursor: nextCursorFrom(rows, limit),
    };
  });
};
