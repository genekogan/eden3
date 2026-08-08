import { resolveCreation, type AuthSession } from '@eden3/core';
import { pg, type Creation } from '@eden3/db';
import type { AccountSummary } from '@eden3/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError, sendError } from '../errors';
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
const reportBodySchema = z.object({
  reason: z.string().trim().max(1_000).optional(),
});

const PUBLIC_NSFW_THRESHOLD = 0.85;

function nsfwScore(attributes: unknown): number | null {
  if (typeof attributes !== 'object' || attributes === null) return null;
  const value = (attributes as Record<string, unknown>).nsfw_score;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function passesPublicModeration(creation: Creation): boolean {
  const score = nsfwScore(creation.attributes);
  return score === null || score < PUBLIC_NSFW_THRESHOLD;
}

function isPubliclyReachableCreation(creation: Creation): boolean {
  return creation.public && !creation.deleted && passesPublicModeration(creation);
}

function canViewCreation(creation: Creation, viewer: AuthSession | null): boolean {
  if (viewer !== null && (viewer.isAdmin || viewer.accountId === creation.userId)) return true;
  return isPubliclyReachableCreation(creation);
}

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

async function viewerHasLikedCreation(
  creationId: string,
  viewer: AuthSession | null,
): Promise<boolean> {
  if (viewer === null) return false;
  const [row] = await pg<{ liked: boolean }[]>`
    select exists(
      select 1 from creation_likes
      where creation_id = ${creationId} and user_id = ${viewer.accountId}
    ) as liked
  `;
  return row?.liked ?? false;
}

async function creationPayload(creation: Creation, viewer: AuthSession | null) {
  const summaries = await accountSummaries([creation.userId, creation.agentId]);
  const creator = creation.userId !== null ? summaries.get(creation.userId) : undefined;
  const agent = creation.agentId !== null ? summaries.get(creation.agentId) : undefined;
  const viewerHasLiked = await viewerHasLikedCreation(creation.id, viewer);
  return {
    creation: creationDtoFromEntity(creation, {
      ...(creator !== undefined ? { creator } : {}),
      ...(agent !== undefined ? { agent } : {}),
      viewerHasLiked,
      reportable: isPubliclyReachableCreation(creation),
    }),
  };
}

export const creationsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:idOrExternal', async (req, reply) => {
    const { idOrExternal } = paramsSchema.parse(req.params);
    const creation = await resolveCreation(idOrExternal);
    if (!creation) {
      return sendError(reply, 404, 'creation_not_found', `No creation "${idOrExternal}"`);
    }
    const viewer = req.account;
    if (!canViewCreation(creation, viewer)) {
      return sendError(reply, 404, 'creation_not_found', `No creation "${idOrExternal}"`);
    }

    return creationPayload(creation, viewer);
  });

  app.post('/:idOrExternal/report', { preHandler: app.requireAuth }, async (req, reply) => {
    const { idOrExternal } = paramsSchema.parse(req.params);
    const body = reportBodySchema.parse(req.body ?? {});
    const creation = await resolveCreation(idOrExternal);
    // Reports are for content that is actually public. Returning the same 404
    // for private, deleted, moderated, and missing rows avoids disclosing why
    // a guessed reference is unavailable.
    if (!creation || !isPubliclyReachableCreation(creation)) {
      return sendError(reply, 404, 'creation_not_found', `No creation "${idOrExternal}"`);
    }

    const { report, inserted } = await pg.begin(async (sql) => {
      const lockKey = `content-report:${req.account!.accountId}:creation:${creation.id}`;
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const [current] = await sql<
        { public: boolean; deleted: boolean; attributes: unknown }[]
      >`
        select public, deleted, attributes
        from creations
        where id = ${creation.id}
        for share
      `;
      const currentNsfwScore = current ? nsfwScore(current.attributes) : null;
      if (
        !current ||
        !current.public ||
        current.deleted ||
        (currentNsfwScore !== null && currentNsfwScore >= PUBLIC_NSFW_THRESHOLD)
      ) {
        throw new ApiError(404, 'creation_not_found', `No creation "${idOrExternal}"`);
      }
      const [existing] = await sql<
        { id: string; targetId: string; status: string; reason: string | null; createdAt: string }[]
      >`
        select id, target_id as "targetId", status, reason, created_at as "createdAt"
        from content_reports
        where reporter_id = ${req.account!.accountId}
          and target_type = 'creation'
          and target_id = ${creation.id}
          and status = 'open'
        order by created_at desc, id desc
        limit 1
      `;
      if (existing) return { report: existing, inserted: false };

      const [created] = await sql<
        { id: string; targetId: string; status: string; reason: string | null; createdAt: string }[]
      >`
        insert into content_reports (reporter_id, target_type, target_id, reason)
        values (${req.account!.accountId}, 'creation', ${creation.id}, ${body.reason ?? null})
        returning id, target_id as "targetId", status, reason, created_at as "createdAt"
      `;
      return { report: created!, inserted: true };
    });
    reply.code(inserted ? 201 : 200);
    return { report };
  });

  app.delete('/:idOrExternal', { preHandler: app.requireAuth }, async (req, reply) => {
    const { idOrExternal } = paramsSchema.parse(req.params);
    const creation = await resolveCreation(idOrExternal, { includeDeleted: true });
    if (!creation) {
      return sendError(reply, 404, 'creation_not_found', `No creation "${idOrExternal}"`);
    }
    const canTakeDown = req.account!.isAdmin || req.account!.accountId === creation.userId;
    if (!canTakeDown) {
      return sendError(reply, 403, 'forbidden', 'Only the creator or an admin can take down this creation');
    }
    await pg`
      update creations
      set deleted = true, updated_at = now()
      where id = ${creation.id}
    `;
    return { ok: true, creationId: creation.id, deleted: true };
  });

  app.post('/:idOrExternal/like', { preHandler: app.requireAuth }, async (req, reply) => {
    const { idOrExternal } = paramsSchema.parse(req.params);
    const creation = await resolveCreation(idOrExternal);
    if (!creation || !canViewCreation(creation, req.account)) {
      return sendError(reply, 404, 'creation_not_found', `No creation "${idOrExternal}"`);
    }

    await pg.begin(async (sql) => {
      const inserted = await sql<{ inserted: number }[]>`
        insert into creation_likes (user_id, creation_id)
        values (${req.account!.accountId}, ${creation.id})
        on conflict do nothing
        returning 1 as inserted
      `;
      if (inserted.length > 0) {
        await sql`
          update creations
          set like_count = like_count + 1, updated_at = now()
          where id = ${creation.id}
        `;
      }
    });

    const fresh = await resolveCreation(creation.id);
    if (!fresh) return sendError(reply, 404, 'creation_not_found', `No creation "${idOrExternal}"`);
    return creationPayload(fresh, req.account);
  });

  app.delete('/:idOrExternal/like', { preHandler: app.requireAuth }, async (req, reply) => {
    const { idOrExternal } = paramsSchema.parse(req.params);
    const creation = await resolveCreation(idOrExternal);
    if (!creation || !canViewCreation(creation, req.account)) {
      return sendError(reply, 404, 'creation_not_found', `No creation "${idOrExternal}"`);
    }

    await pg.begin(async (sql) => {
      const deleted = await sql<{ deleted: number }[]>`
        delete from creation_likes
        where user_id = ${req.account!.accountId} and creation_id = ${creation.id}
        returning 1 as deleted
      `;
      if (deleted.length > 0) {
        await sql`
          update creations
          set like_count = greatest(like_count - 1, 0), updated_at = now()
          where id = ${creation.id}
        `;
      }
    });

    const fresh = await resolveCreation(creation.id);
    if (!fresh) return sendError(reply, 404, 'creation_not_found', `No creation "${idOrExternal}"`);
    return creationPayload(fresh, req.account);
  });
};
