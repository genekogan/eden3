import { pg } from '@eden3/db';
import type { OwnedSearchKind, OwnedSearchResponseDto } from '@eden3/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

interface SearchRow {
  id: string;
  kind: OwnedSearchKind;
  label: string;
  description: string | null;
  updated_at: string | Date;
  username: string | null;
  score: number;
  kind_rank: number;
}

/** Escape user text for a literal ILIKE match using `!` as the SQL escape. */
export function escapeIlike(value: string): string {
  return value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
}

function hrefFor(row: SearchRow): `/${string}` {
  switch (row.kind) {
    case 'agent':
      return `/agents/${encodeURIComponent(row.username!)}/chats`;
    case 'session':
      return row.username
        ? `/agents/${encodeURIComponent(row.username)}/chats/${encodeURIComponent(row.id)}`
        : `/sessions/${encodeURIComponent(row.id)}`;
    case 'creation':
      return `/creations/${encodeURIComponent(row.id)}`;
    case 'collection':
      return `/collections/${encodeURIComponent(row.id)}`;
    case 'task':
      return row.username
        ? `/agents/${encodeURIComponent(row.username)}/schedule`
        : '/tasks';
  }
}

/**
 * Authenticated own-content search over current durable authority. There is
 * deliberately no derived index in this launch slice: committed writes are
 * visible to the next request, and each UNION arm owns its visibility gate.
 */
export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: app.requireAuth }, async (req): Promise<OwnedSearchResponseDto> => {
    const { q, limit } = searchQuerySchema.parse(req.query);
    const accountId = req.account!.accountId;
    const escaped = escapeIlike(q);
    const contains = `%${escaped}%`;
    const prefix = `${escaped}%`;

    const rows = await pg<SearchRow[]>`
      select id, kind, label, description, updated_at, username, score, kind_rank
      from (
        select a.id, 'agent'::text as kind,
               coalesce(nullif(g.name, ''), '@' || a.username::text) as label,
               nullif(left(coalesce(g.description, '@' || a.username::text), 240), '') as description,
               a.updated_at, a.username::text as username,
               case
                 when lower(a.username::text) = lower(${q})
                   or lower(coalesce(g.name, '')) = lower(${q}) then 1000
                 when a.username::text ilike ${prefix} escape '!'
                   or coalesce(g.name, '') ilike ${prefix} escape '!' then 800
                 else 500
               end as score,
               1 as kind_rank
        from accounts a
        join agents g on g.account_id = a.id
        where a.deleted = false
          and (g.owner_id = ${accountId} or a.id = ${accountId})
          and concat_ws(' ', a.username::text, g.name, g.description)
                ilike ${contains} escape '!'

        union all

        select s.id, 'session'::text as kind,
               coalesce(nullif(s.title, ''), 'Untitled chat') as label,
               case when member_agent.username is null then 'Chat'
                    else 'Chat with @' || member_agent.username end as description,
               s.updated_at, member_agent.username,
               case
                 when lower(coalesce(s.title, '')) = lower(${q}) then 1000
                 when coalesce(s.title, '') ilike ${prefix} escape '!' then 800
                 else 500
               end as score,
               2 as kind_rank
        from sessions s
        left join lateral (
          select a.username::text as username
          from session_agents sa
          join accounts a on a.id = sa.agent_account_id
          where sa.session_id = s.id
          order by a.username
          limit 1
        ) member_agent on true
        where s.deleted = false
          and s.visible is distinct from false
          and (
            s.owner_id = ${accountId}
            or exists (
              select 1 from session_users su
              where su.session_id = s.id and su.user_account_id = ${accountId}
            )
          )
          and coalesce(s.title, '') ilike ${contains} escape '!'

        union all

        select c.id, 'creation'::text as kind,
               coalesce(nullif(c.filename, ''), nullif(c.tool, ''), 'Creation') as label,
               nullif(left(coalesce(c.args->>'prompt', c.tool, ''), 240), '') as description,
               c.updated_at, null::text as username,
               case
                 when lower(coalesce(c.filename, '')) = lower(${q}) then 1000
                 when coalesce(c.filename, '') ilike ${prefix} escape '!' then 800
                 else 500
               end as score,
               3 as kind_rank
        from creations c
        where c.deleted = false
          and c.user_id = ${accountId}
          and concat_ws(' ', c.filename, c.tool, c.args->>'prompt')
                ilike ${contains} escape '!'

        union all

        select k.id, 'collection'::text as kind,
               coalesce(nullif(k.name, ''), 'Untitled collection') as label,
               nullif(left(coalesce(k.description, ''), 240), '') as description,
               k.updated_at, null::text as username,
               case
                 when lower(coalesce(k.name, '')) = lower(${q}) then 1000
                 when coalesce(k.name, '') ilike ${prefix} escape '!' then 800
                 else 500
               end as score,
               4 as kind_rank
        from collections k
        where k.deleted = false
          and k.user_id = ${accountId}
          and concat_ws(' ', k.name, k.description) ilike ${contains} escape '!'

        union all

        select t.id, 'task'::text as kind,
               coalesce(nullif(t.name, ''), 'Untitled task') as label,
               nullif(left(coalesce(t.prompt, ''), 240), '') as description,
               t.updated_at, agent_account.username::text as username,
               case
                 when lower(coalesce(t.name, '')) = lower(${q}) then 1000
                 when coalesce(t.name, '') ilike ${prefix} escape '!' then 800
                 else 500
               end as score,
               5 as kind_rank
        from triggers t
        left join accounts agent_account on agent_account.id = t.agent_id
        where t.deleted = false
          and t.user_id = ${accountId}
          and concat_ws(' ', t.name, t.prompt) ilike ${contains} escape '!'
      ) matches
      order by score desc, updated_at desc, kind_rank asc, id desc
      limit ${limit}
    `;

    return {
      query: q,
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        description: row.description,
        updatedAt: new Date(row.updated_at).toISOString(),
        target: { type: 'navigate', href: hrefFor(row) },
      })),
    };
  });
};
