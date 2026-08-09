import { resolveAgentByUsername, type AuthSession } from '@eden3/core';
import { pg, type Account, type Agent } from '@eden3/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError, logSafeRequestWarning, sendError } from '../errors';
import { isUniqueViolation, pgToIso } from '../route-helpers';
import {
  attachedSkillRows,
  commitAgentSkillSelection,
  skillColumns,
  SkillInstallError,
  type SkillDefinitionRow,
} from '../services/agent-skills';
import { reconcileAgentRuntime } from '../services/agent-runtime-sync';
import { isPlatformEve } from '../services/default-assistant';

const skillSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    'slug must be canonical lowercase letters, digits, "-", "_" and start alphanumeric',
  );

const skillParamsSchema = z.object({ slug: skillSlugSchema });
const agentSkillsParamsSchema = z.object({ username: z.string().trim().min(1).max(200) });

const createUserSkillBodySchema = z.object({
  slug: skillSlugSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(),
  body: z.string().min(20).max(50_000),
});

const reviewBodySchema = z.object({
  status: z.enum(['approved', 'rejected']),
});

const setAgentSkillsBodySchema = z.object({
  slugs: z.array(skillSlugSchema).max(50),
});

function skillDto(row: SkillDefinitionRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    body: row.body,
    source: row.source,
    status: row.status,
    ownerId: row.owner_id,
    reviewerId: row.reviewer_id,
    reviewedAt: row.reviewed_at ? pgToIso(row.reviewed_at) : null,
    createdAt: pgToIso(row.created_at),
    updatedAt: pgToIso(row.updated_at),
  };
}

function canManage(viewer: AuthSession | null, account: Account, agent: Agent): boolean {
  if (isPlatformEve(account, agent)) return false;
  if (!viewer) return false;
  if (viewer.isAdmin) return true;
  return viewer.accountId === agent.ownerId || viewer.accountId === account.id;
}

export const skillsRoutes: FastifyPluginAsync = async (app) => {
  const reconcileSkillRuntime = (accountId: string, logger: typeof app.log) =>
    reconcileAgentRuntime(accountId, {
      // Preserve degraded boot: constructing the real provisioner may require
      // credentials, so resolve each seam only inside the reconciler's caught
      // runtime mutation block.
      provisioner: {
        provisionAgent: (params, options) =>
          app.gatewayGlue.provisioner.provisionAgent(params, options),
        updateAgentPersona: (params) =>
          app.gatewayGlue.provisioner.updateAgentPersona(params),
      },
      toolSync: {
        syncAgentToolGroups: (params) =>
          app.gatewayGlue.toolSync.syncAgentToolGroups(params),
      },
      skillSync: {
        syncAgentSkills: (params) =>
          app.gatewayGlue.skillSync.syncAgentSkills(params),
      },
      logger,
    });

  app.get('/skills', async (req) => {
    const viewer = req.account;
    const rows = await pg<SkillDefinitionRow[]>`
      select ${skillColumns()}
      from skill_definitions
      where ${
        viewer?.isAdmin
          ? pg`true`
          : viewer
            ? pg`status = 'approved' or owner_id = ${viewer.accountId}`
            : pg`status = 'approved'`
      }
      order by case status when 'approved' then 0 when 'pending' then 1 else 2 end,
               source asc, slug asc
    `;
    return { items: rows.map(skillDto) };
  });

  app.post('/skills/user', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const body = createUserSkillBodySchema.parse(req.body);
    try {
      const [row] = await pg<SkillDefinitionRow[]>`
        insert into skill_definitions (
          slug, name, description, body, source, status, owner_id
        )
        values (
          ${body.slug}, ${body.name}, ${body.description ?? null}, ${body.body},
          'user', 'pending', ${account.accountId}
        )
        returning ${skillColumns()}
      `;
      return reply.code(201).send({ skill: skillDto(row!) });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return sendError(reply, 409, 'skill_slug_taken', `Skill "${body.slug}" already exists`);
      }
      throw err;
    }
  });

  app.post('/skills/:slug/review', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    if (!account.isAdmin) return sendError(reply, 403, 'forbidden', 'Only admins can review skills');
    const { slug } = skillParamsSchema.parse(req.params);
    const body = reviewBodySchema.parse(req.body);

    const reviewed = await pg.begin(async (sql) => {
      // Updating the definition takes an exclusive row lock. Owner attachment
      // commits take FOR SHARE on the same row, so rejection cannot miss a
      // just-attached skill and leave its runtime allowlist enabled.
      const [row] = await sql<SkillDefinitionRow[]>`
        update skill_definitions
        set status = ${body.status},
            reviewer_id = ${account.accountId},
            reviewed_at = now(),
            updated_at = now()
        where slug = ${slug}
        returning ${skillColumns()}
      `;
      if (!row) return null;
      if (body.status !== 'rejected') {
        return {
          row,
          affectedAgentIds: [] as string[],
          immediateAgentIds: [] as string[],
        };
      }

      const affected = await sql<{
        agent_id: string;
        provision_status: string;
        openclaw_id: string | null;
        workspace_path: string | null;
      }[]>`
        select distinct aks.agent_id, g.provision_status, g.openclaw_id, g.workspace_path
        from agent_skills aks
        join agents g on g.account_id = aks.agent_id
        where aks.skill_id = ${row.id} and aks.enabled = true
        order by aks.agent_id
      `;
      const affectedAgentIds = affected.map((agent) => agent.agent_id);
      const immediateAgentIds = affected
        .filter(
          (agent) =>
            agent.provision_status === 'ready' &&
            agent.openclaw_id !== null &&
            agent.workspace_path !== null,
        )
        .map((agent) => agent.agent_id);
      // Consistent UUID order avoids deadlocks when admins reject different
      // skills that overlap the same agent fleet.
      for (const agentId of affectedAgentIds) {
        await sql`select pg_advisory_xact_lock(hashtextextended(${agentId}::text, 91))`;
      }
      await sql`
        update agent_skills
        set enabled = false
        where skill_id = ${row.id} and enabled = true
      `;
      if (affectedAgentIds.length > 0) {
        await sql`
          update agents
          set runtime_sync_version = runtime_sync_version + 1,
              runtime_sync_lease_expires_at = null,
              runtime_sync_error = null
          where account_id = any(${affectedAgentIds}::uuid[])
        `;
      }
      return { row, affectedAgentIds, immediateAgentIds };
    });
    if (!reviewed) return sendError(reply, 404, 'skill_not_found', `No skill "${slug}"`);

    // Desired state is already durable. Immediate convergence shortens the UI
    // delay; any crash/outage stays scheduler-visible via the bumped revision.
    for (const agentId of reviewed.immediateAgentIds) {
      try {
        await reconcileSkillRuntime(agentId, req.log);
      } catch (err) {
        logSafeRequestWarning(
          req.log,
          err,
          { accountId: agentId },
          'skill rejection saved; agent runtime convergence deferred',
        );
      }
    }

    return { skill: skillDto(reviewed.row) };
  });

  app.get('/agents/:username/skills', async (req, reply) => {
    const { username } = agentSkillsParamsSchema.parse(req.params);
    const resolved = await resolveAgentByUsername(username);
    if (!resolved) return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    const { account, agent } = resolved;
    const manager = canManage(req.account, account, agent);
    if (!agent.public && !manager) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }

    const attached = (await attachedSkillRows(account.id))
      .filter((row) => row.enabled && (manager || row.status === 'approved'))
      .map((row) => ({ ...skillDto(row), enabled: row.enabled }));

    const available = manager
      ? (
          await pg<SkillDefinitionRow[]>`
            select ${skillColumns()}
            from skill_definitions
            where status = 'approved'
               or owner_id = ${req.account!.accountId}
               or ${req.account!.isAdmin}
            order by source asc, slug asc
          `
        ).map(skillDto)
      : undefined;

    return {
      agent: {
        id: account.id,
        username: account.username,
        ownerId: agent.ownerId,
        public: agent.public,
      },
      attached,
      ...(available ? { available } : {}),
    };
  });

  app.post('/agents/:username/skills', { preHandler: app.requireAuth }, async (req, reply) => {
    const viewer = req.account!;
    const { username } = agentSkillsParamsSchema.parse(req.params);
    const body = setAgentSkillsBodySchema.parse(req.body);

    const resolved = await resolveAgentByUsername(username);
    if (!resolved) return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    const { account, agent } = resolved;
    if (!canManage(viewer, account, agent)) {
      if (!agent.public) return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
      return sendError(reply, 403, 'forbidden', 'Only the owner can manage this agent');
    }
    if (!agent.openclawId || !agent.workspacePath || agent.provisionStatus !== 'ready') {
      return sendError(
        reply,
        409,
        'agent_not_ready',
        'Agent must be provisioned before skills can be installed',
      );
    }

    try {
      const skills = await commitAgentSkillSelection({
        agentId: account.id,
        slugs: body.slugs,
      });
      const sync = await reconcileSkillRuntime(account.id, req.log);
      return reply.code(sync.status === 'pending' || sync.status === 'ineligible' ? 202 : 200).send({
        agent: { id: account.id, username: account.username, openclawId: agent.openclawId },
        skills: skills.map((row) => ({ ...skillDto(row), enabled: row.enabled })),
        runtimeSync: sync.status,
      });
    } catch (err) {
      if (err instanceof SkillInstallError) {
        return sendError(reply, err.statusCode, err.code, err.message);
      }
      throw new ApiError(
        503,
        'skill_sync_failed',
        err instanceof Error ? err.message : 'OpenClaw skill sync failed',
      );
    }
  });
};
