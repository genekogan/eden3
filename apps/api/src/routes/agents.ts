import {
  resolveAccountByUsername,
  resolveAgentByUsername,
  type AuthSession,
} from '@eden3/core';
import { accounts, agents, db, pg, type Account, type Agent } from '@eden3/db';
import { feedQuerySchema } from '@eden3/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError, sendError } from '../errors';
import { DEFAULT_AGENT_MODEL } from '../gateway-glue';
import {
  agentDtoFromEntities,
  agentDtoFromRow,
  creationDtoFromRow,
  escapeLike,
  isUniqueViolation,
  nextCursorFrom,
  parseCursorParam,
  type AgentRow,
  type CreationRow,
} from '../route-helpers';

/**
 * Agents API.
 *
 *   GET    /agents            — public directory (search, keyset pagination,
 *                               creation/session counts, is_pilot flag)
 *   GET    /agents/:username  — profile: account+agent join + recent creations
 *   POST   /agents            — create + provision on the OpenClaw gateway
 *   PATCH  /agents/:username  — owner-only persona/name edit + hot re-render
 *
 * Visibility: non-public agents 404 for everyone but their owner (and the
 * agent account itself / admins). Persona text is additionally gated by
 * agents.is_persona_public.
 */

const directoryQuerySchema = feedQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
});

const usernameParamsSchema = z.object({ username: z.string().trim().min(1).max(200) });

/**
 * eden3 agent usernames double as OpenClaw agent ids and workspace dir names,
 * so the shape is the conservative CLI/path-safe one (3-32 chars here).
 * "main" is the gateway's own default agent — never claimable.
 */
const agentUsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9_-]{2,31}$/,
    'username must be 3-32 chars: lowercase letters, digits, "-", "_" (must start alphanumeric)',
  )
  .refine((u) => u !== 'main', { message: 'username "main" is reserved' });

const createBodySchema = z.object({
  username: agentUsernameSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).default(''),
  persona: z.string().max(20_000).default(''),
  greeting: z.string().max(1_000).default(''),
});

const patchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2_000).optional(),
    persona: z.string().max(20_000).optional(),
    greeting: z.string().max(1_000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'no fields to update' });

/** Fresh fragment per query (postgres.js fragments are single-use-safe). */
const agentRowColumns = () => pg`
  a.id, a.external_id, a.username, a.user_image, a.created_at, a.updated_at,
  g.name, g.description, g.persona, g.is_persona_public, g.greeting, g.voice,
  g.public, g.owner_id, g.is_pilot, g.is_synthetic, g.provision_status
`;

interface DirectoryRow extends AgentRow {
  creation_count: number;
  session_count: number;
}

function canManage(viewer: AuthSession | null, account: Account, agent: Agent): boolean {
  if (!viewer) return false;
  if (viewer.isAdmin) return true;
  return viewer.accountId === agent.ownerId || viewer.accountId === account.id;
}

export const agentsRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /agents — public directory ------------------------------------
  app.get('/', async (req) => {
    const { q, cursor, limit } = directoryQuerySchema.parse(req.query);
    const after = parseCursorParam(cursor);
    const pattern = q !== undefined && q !== '' ? `%${escapeLike(q)}%` : null;

    // `nulls last` matches the index direction (created_at is NOT NULL, so
    // semantics are unchanged — but the planner needs the exact sort order).
    const rows = await pg<DirectoryRow[]>`
      select ${agentRowColumns()},
             (select count(*)::int from creations c
               where c.agent_id = a.id and c.public = true and c.deleted = false) as creation_count,
             (select count(*)::int from session_agents sa
               where sa.agent_account_id = a.id) as session_count
      from accounts a
      join agents g on g.account_id = a.id
      where a.deleted = false
        and g.public = true
        ${pattern !== null ? pg`and (a.username ilike ${pattern} or g.name ilike ${pattern})` : pg``}
        ${
          after !== null
            ? pg`and a.created_at <= ${after.createdAt}
                 and (a.created_at < ${after.createdAt} or a.id < ${after.id})`
            : pg``
        }
      order by a.created_at desc nulls last, a.id desc
      limit ${limit + 1}
    `;

    const items = rows.slice(0, limit).map((row) => ({
      ...agentDtoFromRow(row, { includePersona: row.is_persona_public }),
      creationCount: row.creation_count,
      sessionCount: row.session_count,
    }));
    return { items, nextCursor: nextCursorFrom(rows, limit) };
  });

  // ---- GET /agents/:username — profile ------------------------------------
  app.get('/:username', async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const resolved = await resolveAgentByUsername(username);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }
    const { account, agent } = resolved;
    const manager = canManage(req.account, account, agent);
    if (!agent.public && !manager) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }

    const creationRows = await pg<CreationRow[]>`
      select c.id, c.external_id, c.user_id, c.agent_id, c.tool, c.filename,
             c.url, c.thumbnail_url, c.media_attributes, c.like_count, c.public,
             c.created_at, c.updated_at
      from creations c
      where c.agent_id = ${account.id} and c.public = true and c.deleted = false
      order by c.created_at desc nulls last, c.id desc
      limit 12
    `;

    return {
      agent: agentDtoFromEntities(account, agent, {
        includePersona: agent.isPersonaPublic || manager,
      }),
      recentCreations: creationRows.map(creationDtoFromRow),
    };
  });

  // ---- POST /agents — create + provision ----------------------------------
  app.post('/', { preHandler: app.requireAuth }, async (req, reply) => {
    const viewer = req.account;
    if (!viewer) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    const body = createBodySchema.parse(req.body);

    // Fail fast (503) when the gateway is unconfigured — before any rows land.
    const provisioner = app.gatewayGlue.provisioner;

    // Friendly pre-check; the citext unique constraint is the real guard.
    const taken = await resolveAccountByUsername(body.username, { includeDeleted: true });
    if (taken) {
      return sendError(reply, 409, 'username_taken', `Username "${body.username}" is taken`);
    }

    let created: { account: Account; agent: Agent };
    try {
      created = await db.transaction(async (tx) => {
        const [account] = await tx
          .insert(accounts)
          .values({ type: 'agent', username: body.username })
          .returning();
        if (!account) throw new Error('accounts insert returned no row');
        const [agent] = await tx
          .insert(agents)
          .values({
            accountId: account.id,
            ownerId: viewer.accountId,
            name: body.name,
            description: body.description === '' ? null : body.description,
            persona: body.persona === '' ? null : body.persona,
            greeting: body.greeting === '' ? null : body.greeting,
            public: true,
            openclawId: body.username,
            provisionStatus: 'provisioning',
          })
          .returning();
        if (!agent) throw new Error('agents insert returned no row');
        return { account, agent };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return sendError(reply, 409, 'username_taken', `Username "${body.username}" is taken`);
      }
      throw err;
    }

    let provisionStatus: 'ready' | 'failed' = 'ready';
    let workspacePath: string | null = null;
    try {
      const result = await provisioner.provisionAgent({
        openclawId: body.username,
        name: body.name,
        username: body.username,
        description: body.description,
        persona: body.persona,
        greeting: body.greeting,
        model: DEFAULT_AGENT_MODEL,
      });
      workspacePath = result.hostWorkspaceDir;
    } catch (err) {
      provisionStatus = 'failed';
      req.log.error({ err }, `provisioning failed for agent "${body.username}"`);
    }

    const [updatedAgent] = await db
      .update(agents)
      .set({
        provisionStatus,
        ...(provisionStatus === 'ready'
          ? { provisionedAt: new Date(), workspacePath }
          : {}),
      })
      .where(eq(agents.accountId, created.account.id))
      .returning();

    return reply.code(201).send({
      agent: agentDtoFromEntities(created.account, updatedAgent ?? created.agent, {
        includePersona: true,
      }),
    });
  });

  // ---- PATCH /agents/:username — owner-only edit + hot re-render ----------
  app.patch('/:username', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const body = patchBodySchema.parse(req.body);

    const resolved = await resolveAgentByUsername(username);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }
    const { account, agent } = resolved;
    const manager = canManage(req.account, account, agent);
    if (!manager) {
      // Hide the existence of private agents from non-owners.
      if (!agent.public) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
      }
      return sendError(reply, 403, 'forbidden', 'Only the owner can edit this agent');
    }

    const updatedAgent = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(agents)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description === '' ? null : body.description }
            : {}),
          ...(body.persona !== undefined
            ? { persona: body.persona === '' ? null : body.persona }
            : {}),
          ...(body.greeting !== undefined
            ? { greeting: body.greeting === '' ? null : body.greeting }
            : {}),
        })
        .where(eq(agents.accountId, account.id))
        .returning();
      if (!row) throw new ApiError(404, 'agent_not_found', `No agent named "${username}"`);
      const [freshAccount] = await tx
        .update(accounts)
        .set({ updatedAt: new Date() })
        .where(eq(accounts.id, account.id))
        .returning();
      return { agent: row, account: freshAccount ?? account };
    });

    // Hot persona re-render (SOUL.md + IDENTITY.md). Best-effort: agents that
    // were never provisioned (no workspace yet) keep their DB update.
    if (agent.openclawId !== null) {
      try {
        await app.gatewayGlue.provisioner.updateAgentPersona({
          openclawId: agent.openclawId,
          name: updatedAgent.agent.name ?? account.username,
          username: account.username,
          description: updatedAgent.agent.description ?? '',
          persona: updatedAgent.agent.persona ?? '',
          greeting: updatedAgent.agent.greeting ?? '',
        });
      } catch (err) {
        req.log.warn({ err }, `persona re-render skipped for "${account.username}"`);
      }
    }

    return {
      agent: agentDtoFromEntities(updatedAgent.account, updatedAgent.agent, {
        includePersona: true,
      }),
    };
  });
};
