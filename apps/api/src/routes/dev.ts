import { randomUUID } from 'node:crypto';

import {
  buildDevSessionCookie,
  clearDevSessionCookie,
  credit,
  getBalance,
  resolveAccount,
} from '@eden3/core';
import { pg } from '@eden3/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { sendError } from '../errors';

/**
 * Dev-only routes (real, not stubs): account picker + impersonation for the
 * DevAuthProvider cookie flow. Never mount in a real deployment — server.ts
 * registers this plugin only when AUTH_PROVIDER=dev or EDEN3_DEV_ROUTES=1
 * (the local dev stack sets the flag; deployments must not).
 */

const usersQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
});

const impersonateBodySchema = z.object({
  /** accounts.id uuid (legacy 24-hex Mongo ids also resolve). */
  accountId: z.string().trim().min(1),
});

interface DevUserRow {
  id: string;
  externalId: string | null;
  type: 'user' | 'agent';
  username: string;
  userImage: string | null;
}

/** Escape LIKE metacharacters so `q` matches literally inside %…%. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export const devRoutes: FastifyPluginAsync = async (app) => {
  // GET /dev/users?q= — search accounts by username substring (ILIKE), max 20.
  app.get('/users', async (req) => {
    const { q } = usersQuerySchema.parse(req.query);
    const pattern = `%${escapeLike(q)}%`;
    const rows = await pg<DevUserRow[]>`
      select id,
             external_id as "externalId",
             type,
             username,
             user_image as "userImage"
      from accounts
      where deleted = false
        and username ilike ${pattern}
      order by username asc
      limit 20
    `;
    return { users: [...rows] };
  });

  // GET /dev/me — current impersonated account (from the dev cookie) + manna, or null.
  app.get('/me', async (req) => {
    if (!req.account) return { user: null };
    const accountId = req.account.accountId;
    const [row] = await pg<{ type: 'user' | 'agent'; userImage: string | null }[]>`
      select type, user_image as "userImage" from accounts where id = ${accountId} limit 1
    `;
    let manna: { balance: number; subscriptionBalance: number } | null = null;
    try {
      const b = await getBalance(accountId);
      manna = { balance: Number(b.balance), subscriptionBalance: Number(b.subscriptionBalance) };
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

  // POST /dev/logout — clear the impersonation cookie.
  app.post('/logout', async (_req, reply) => {
    reply.header('set-cookie', clearDevSessionCookie());
    return { ok: true };
  });

  // POST /dev/grant {accountId, amount?, ensure?} — dev-only manna faucet.
  // With `amount`, credits that much. With `ensure`, tops the balance UP TO
  // that floor (no-op when already above it) — what test harnesses want.
  // Never mounted in deployments (see plugin docblock).
  app.post('/grant', async (req, reply) => {
    const body = z
      .object({
        accountId: z.string().trim().min(1),
        amount: z.number().int().positive().max(1_000_000).optional(),
        ensure: z.number().int().positive().max(1_000_000).optional(),
      })
      .refine((b) => (b.amount !== undefined) !== (b.ensure !== undefined), {
        message: 'pass exactly one of amount / ensure',
      })
      .parse(req.body);

    const account = await resolveAccount(body.accountId);
    if (!account) {
      return sendError(reply, 404, 'account_not_found', `No account matches "${body.accountId}"`);
    }

    const before = await getBalance(account.id);
    const amount =
      body.amount !== undefined ? body.amount : Math.max(0, body.ensure! - before.total);
    if (amount === 0) {
      return { ok: true, granted: 0, balance: before.total };
    }
    const result = await credit({
      accountId: account.id,
      amount,
      type: 'credit:dev-grant',
      idempotencyKey: `dev-grant:${randomUUID()}`,
    });
    return { ok: true, granted: amount, balance: result.balance.total };
  });

  // POST /dev/impersonate {accountId} — become that account (sets dev cookie).
  app.post('/impersonate', async (req, reply) => {
    const { accountId } = impersonateBodySchema.parse(req.body);
    const account = await resolveAccount(accountId);
    if (!account) {
      return sendError(reply, 404, 'account_not_found', `No account matches "${accountId}"`);
    }
    reply.header('set-cookie', buildDevSessionCookie(account.id));
    return {
      ok: true,
      account: {
        id: account.id,
        type: account.type,
        username: account.username,
        userImage: account.userImage,
      },
    };
  });
};
