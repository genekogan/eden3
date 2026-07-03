import { resolveCreation } from '@eden3/core';
import { pg } from '@eden3/db';
import type { AccountSummary } from '@eden3/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { sendError } from '../errors';
import {
  creationDtoFromEntity,
  toAccountSummary,
  type AccountSummaryRow,
} from '../route-helpers';

/**
 * Creations API.
 *
 *   GET /creations/:idOrExternal — permalink resolve: uuid OR legacy 24-hex
 *   Mongo id (`/creations/<hex>` keeps working post-migration). Non-public
 *   creations 404 for everyone but their creator (or an admin).
 */

const paramsSchema = z.object({ idOrExternal: z.string().trim().min(1).max(200) });

/** Batch-fetch account summaries for the embed fields. */
async function accountSummaries(
  ids: (string | null)[],
): Promise<Map<string, AccountSummary>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await pg<AccountSummaryRow[]>`
    select id, type, username, user_image
    from accounts
    where id = any(${wanted}::uuid[])
  `;
  return new Map(rows.map((row) => [row.id, toAccountSummary(row)]));
}

export const creationsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:idOrExternal', async (req, reply) => {
    const { idOrExternal } = paramsSchema.parse(req.params);
    const creation = await resolveCreation(idOrExternal);
    if (!creation) {
      return sendError(reply, 404, 'creation_not_found', `No creation "${idOrExternal}"`);
    }
    const viewer = req.account;
    const canView =
      creation.public ||
      (viewer !== null && (viewer.isAdmin || viewer.accountId === creation.userId));
    if (!canView) {
      return sendError(reply, 404, 'creation_not_found', `No creation "${idOrExternal}"`);
    }

    const summaries = await accountSummaries([creation.userId, creation.agentId]);
    const creator = creation.userId !== null ? summaries.get(creation.userId) : undefined;
    const agent = creation.agentId !== null ? summaries.get(creation.agentId) : undefined;
    return {
      creation: creationDtoFromEntity(creation, {
        ...(creator !== undefined ? { creator } : {}),
        ...(agent !== undefined ? { agent } : {}),
      }),
    };
  });
};
