import { buildDevSessionCookie, resolveAccount } from '@eden3/core';
import { pg } from '@eden3/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { sendError } from '../errors';

/**
 * Dev-only routes (real, not stubs): account picker + impersonation for the
 * DevAuthProvider cookie flow. Never mount in a real deployment.
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
