import { isHex24, isUuid, resolveAccount, resolveAccountByUsername } from '@eden3/core';
import { pg } from '@eden3/db';
import { feedQuerySchema } from '@eden3/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  agentDtoFromRow,
  creationDtoFromRow,
  nextCursorFrom,
  parseCursorParam,
  pgToIso,
  type AgentRow,
  type CreationRow,
} from '../route-helpers';

/**
 * Feed API (public, anonymous-friendly).
 *
 *   GET /feed/creations — public+not-deleted creations, keyset (created_at,id)
 *                         desc; optional agent/user filter (username, uuid, or
 *                         legacy 24-hex id). Stored URLs are served verbatim —
 *                         legacy CloudFront links pass straight through.
 *   GET /feed/agents    — recently-active public agents (activity = latest
 *                         public creation inside the newest slice of the feed).
 *
 * Query shape note: predicates spell `created_at <= $cursor AND (created_at <
 * $cursor OR id < $id)` with `ORDER BY created_at DESC NULLS LAST` so the
 * partial feed index serves pages in ~0.1ms (row-comparison syntax and plain
 * `DESC` both force a 900k-row top-N sort on this dataset).
 */

const feedCreationsQuerySchema = feedQuerySchema.extend({
  /** Filter by agent (username, accounts.id uuid, or legacy 24-hex id). */
  agent: z.string().trim().min(1).max(200).optional(),
  /** Filter by creator user (same reference shapes). */
  user: z.string().trim().min(1).max(200).optional(),
});

const feedAgentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

/** Resolve a filter reference to an accounts.id, or null when unknown. */
async function resolveAccountRef(ref: string): Promise<string | null> {
  if (isUuid(ref)) return ref.toLowerCase();
  if (isHex24(ref)) return (await resolveAccount(ref))?.id ?? null;
  return (await resolveAccountByUsername(ref))?.id ?? null;
}

export const feedRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /feed/creations -------------------------------------------------
  app.get('/creations', async (req) => {
    const { cursor, limit, agent, user } = feedCreationsQuerySchema.parse(req.query);
    const after = parseCursorParam(cursor);

    let agentId: string | null = null;
    if (agent !== undefined) {
      agentId = await resolveAccountRef(agent);
      if (agentId === null) return { items: [], nextCursor: null };
    }
    let userId: string | null = null;
    if (user !== undefined) {
      userId = await resolveAccountRef(user);
      if (userId === null) return { items: [], nextCursor: null };
    }

    const rows = await pg<CreationRow[]>`
      select c.id, c.external_id, c.user_id, c.agent_id, c.tool, c.filename,
             c.url, c.thumbnail_url, c.media_attributes, c.like_count, c.public,
             c.created_at, c.updated_at,
             cu.id as creator_id, cu.type as creator_type,
             cu.username as creator_username, cu.user_image as creator_user_image,
             ag.id as agent_acct_id, ag.type as agent_acct_type,
             ag.username as agent_acct_username, ag.user_image as agent_acct_user_image
      from creations c
      left join accounts cu on cu.id = c.user_id
      left join accounts ag on ag.id = c.agent_id
      where c.public = true and c.deleted = false
        ${agentId !== null ? pg`and c.agent_id = ${agentId}` : pg``}
        ${userId !== null ? pg`and c.user_id = ${userId}` : pg``}
        ${
          after !== null
            ? pg`and c.created_at <= ${after.createdAt}
                 and (c.created_at < ${after.createdAt} or c.id < ${after.id})`
            : pg``
        }
      order by c.created_at desc nulls last, c.id desc
      limit ${limit + 1}
    `;

    return {
      items: rows.slice(0, limit).map(creationDtoFromRow),
      nextCursor: nextCursorFrom(rows, limit),
    };
  });

  // ---- GET /feed/agents — recently active ---------------------------------
  app.get('/agents', async (req) => {
    const { limit } = feedAgentsQuerySchema.parse(req.query);

    // "Active" = has a public creation among the newest 1000 feed entries —
    // one bounded index scan instead of a per-agent lateral over 741 agents.
    const rows = await pg<(AgentRow & { last_creation_at: string })[]>`
      with recent as (
        select sub.agent_id, max(sub.created_at) as last_creation_at
        from (
          select agent_id, created_at
          from creations
          where public = true and deleted = false and agent_id is not null
          order by created_at desc nulls last
          limit 1000
        ) sub
        group by sub.agent_id
      )
      select a.id, a.external_id, a.username, a.user_image, a.created_at, a.updated_at,
             g.name, g.description, g.persona, g.is_persona_public, g.greeting, g.voice,
             g.public, g.owner_id, g.is_pilot, g.is_synthetic, g.provision_status,
             recent.last_creation_at
      from recent
      join accounts a on a.id = recent.agent_id and a.deleted = false
      join agents g on g.account_id = a.id and g.public = true
      order by recent.last_creation_at desc
      limit ${limit}
    `;

    return {
      items: rows.map((row) => ({
        ...agentDtoFromRow(row, { includePersona: row.is_persona_public }),
        lastCreationAt: pgToIso(row.last_creation_at),
      })),
      nextCursor: null,
    };
  });
};
