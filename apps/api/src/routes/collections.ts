import { resolveAccountByUsername, resolveCollection } from '@eden3/core';
import { pg } from '@eden3/db';
import { feedQuerySchema, type CreationDto } from '@eden3/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { sendError } from '../errors';
import {
  collectionDtoFromRow,
  creationDtoFromRow,
  encodeOffsetCursor,
  nextCursorFrom,
  parseCursorParam,
  parseOffsetCursorParam,
  type CollectionRow,
  type CreationRow,
} from '../route-helpers';

/**
 * Collections API. Registered WITHOUT a prefix — it spans two path roots:
 *
 *   GET /collections/:idOrExternal   — detail + members page (position order,
 *                                      offset cursor; uuid or legacy hex id)
 *   GET /users/:username/collections — a user's collections (keyset by
 *                                      created_at desc, cover thumbnails)
 *
 * Visibility: non-public collections 404 for everyone but their owner; member
 * / cover creations are restricted to public+not-deleted for non-owners.
 */

const detailParamsSchema = z.object({ idOrExternal: z.string().trim().min(1).max(200) });
const userParamsSchema = z.object({ username: z.string().trim().min(1).max(200) });

const membersQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

/** Cover thumbnails per collection on the list endpoint. */
const COVER_LIMIT = 4;

interface MemberRow extends CreationRow {
  collection_id: string;
}

export const collectionsRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /collections/:idOrExternal --------------------------------------
  app.get('/collections/:idOrExternal', async (req, reply) => {
    const { idOrExternal } = detailParamsSchema.parse(req.params);
    const { cursor, limit } = membersQuerySchema.parse(req.query);
    const offset = parseOffsetCursorParam(cursor);

    const collection = await resolveCollection(idOrExternal);
    if (!collection) {
      return sendError(reply, 404, 'collection_not_found', `No collection "${idOrExternal}"`);
    }
    const viewer = req.account;
    const isOwner =
      viewer !== null && (viewer.isAdmin || viewer.accountId === collection.userId);
    if (!collection.public && !isOwner) {
      return sendError(reply, 404, 'collection_not_found', `No collection "${idOrExternal}"`);
    }

    const memberVisibility = isOwner ? pg`` : pg`and c.public = true`;
    const rows = await pg<CreationRow[]>`
      select c.id, c.external_id, c.user_id, c.agent_id, c.tool, c.filename,
             c.url, c.thumbnail_url, c.media_attributes, c.like_count, c.public,
             c.created_at, c.updated_at
      from collection_creations cc
      join creations c on c.id = cc.creation_id
      where cc.collection_id = ${collection.id}
        and c.deleted = false
        ${memberVisibility}
      order by cc.position asc nulls last, c.created_at asc, c.id asc
      limit ${limit + 1} offset ${offset}
    `;

    const [countRow] = await pg<{ count: number }[]>`
      select count(*)::int as count
      from collection_creations cc
      join creations c on c.id = cc.creation_id
      where cc.collection_id = ${collection.id}
        and c.deleted = false
        ${isOwner ? pg`` : pg`and c.public = true`}
    `;

    const collectionRow: CollectionRow = {
      id: collection.id,
      external_id: collection.externalId,
      user_id: collection.userId,
      name: collection.name,
      description: collection.description,
      public: collection.public,
      created_at: collection.createdAt.toISOString(),
      updated_at: collection.updatedAt.toISOString(),
    };
    return {
      collection: collectionDtoFromRow(collectionRow, {
        creationCount: countRow?.count ?? 0,
      }),
      creations: rows.slice(0, limit).map(creationDtoFromRow),
      nextCursor: rows.length > limit ? encodeOffsetCursor(offset + limit) : null,
    };
  });

  // ---- GET /users/:username/collections ------------------------------------
  app.get('/users/:username/collections', async (req, reply) => {
    const { username } = userParamsSchema.parse(req.params);
    const { cursor, limit } = feedQuerySchema.parse(req.query);
    const after = parseCursorParam(cursor);

    const account = await resolveAccountByUsername(username);
    if (!account) {
      return sendError(reply, 404, 'user_not_found', `No account named "${username}"`);
    }
    const viewer = req.account;
    const isOwner = viewer !== null && (viewer.isAdmin || viewer.accountId === account.id);

    const rows = await pg<(CollectionRow & { creation_count: number })[]>`
      select k.id, k.external_id, k.user_id, k.name, k.description, k.public,
             k.created_at, k.updated_at,
             (select count(*)::int
                from collection_creations cc
                join creations c on c.id = cc.creation_id
               where cc.collection_id = k.id
                 and c.deleted = false
                 and (c.public = true or ${isOwner})) as creation_count
      from collections k
      where k.user_id = ${account.id}
        and k.deleted = false
        ${isOwner ? pg`` : pg`and k.public = true`}
        ${
          after !== null
            ? pg`and k.created_at <= ${after.createdAt}
                 and (k.created_at < ${after.createdAt} or k.id < ${after.id})`
            : pg``
        }
      order by k.created_at desc nulls last, k.id desc
      limit ${limit + 1}
    `;

    const page = rows.slice(0, limit);
    const covers = await coverCreationsFor(page.map((row) => row.id));
    return {
      items: page.map((row) =>
        collectionDtoFromRow(row, {
          creationCount: row.creation_count,
          coverCreations: covers.get(row.id) ?? [],
        }),
      ),
      nextCursor: nextCursorFrom(rows, limit),
    };
  });
};

/** First {@link COVER_LIMIT} public members per collection, position order. */
async function coverCreationsFor(
  collectionIds: string[],
): Promise<Map<string, CreationDto[]>> {
  const out = new Map<string, CreationDto[]>();
  if (collectionIds.length === 0) return out;
  const rows = await pg<MemberRow[]>`
    select * from (
      select c.id, c.external_id, c.user_id, c.agent_id, c.tool, c.filename,
             c.url, c.thumbnail_url, c.media_attributes, c.like_count, c.public,
             c.created_at, c.updated_at,
             cc.collection_id,
             row_number() over (
               partition by cc.collection_id
               order by cc.position asc nulls last, c.created_at asc, c.id asc
             ) as rn
      from collection_creations cc
      join creations c on c.id = cc.creation_id
      where cc.collection_id = any(${collectionIds}::uuid[])
        and c.deleted = false
        and c.public = true
    ) ranked
    where ranked.rn <= ${COVER_LIMIT}
  `;
  for (const row of rows) {
    const list = out.get(row.collection_id) ?? [];
    list.push(creationDtoFromRow(row));
    out.set(row.collection_id, list);
  }
  return out;
}
