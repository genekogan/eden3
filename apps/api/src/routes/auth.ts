import { getBalance } from '@eden3/core';
import { pg } from '@eden3/db';
import type { FastifyPluginAsync } from 'fastify';

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (req) => {
    if (!req.account) return { user: null, manna: null };

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
    };
  });
};
