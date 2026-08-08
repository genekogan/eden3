import { getBalance } from '@eden3/core';
import { pg } from '@eden3/db';
import type { FastifyPluginAsync } from 'fastify';

import { isAccessGated } from '../auth-plugin';

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (req) => {
    // Closed-alpha gate state rides along so the web can render the
    // closed-beta panel (with identity) instead of a wall of 403s.
    const accessGated = isAccessGated(app.accessAllowlist, req.account);
    if (!req.account) return { user: null, manna: null, accessGated };

    const accountId = req.account.accountId;
    const [row] = await pg<{ type: 'user' | 'agent'; userImage: string | null }[]>`
      select type, user_image as "userImage" from accounts where id = ${accountId} limit 1
    `;

    let manna: { balance: number; subscriptionBalance: number } | null = null;
    try {
      const balance = await getBalance(accountId);
      manna = {
        balance: Number(balance.balance),
        subscriptionBalance: Number(balance.subscriptionBalance),
      };
    } catch {
      manna = null;
    }

    return {
      user: {
        id: accountId,
        username: req.account.username,
        type: row?.type ?? 'user',
        userImage: row?.userImage ?? null,
        isAdmin: req.account.isAdmin ?? false,
      },
      manna,
      accessGated,
    };
  });
};
