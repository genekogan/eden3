import { resolveAgentByUsername, type AuthSession } from '@eden3/core';
import { pg, type Account, type Agent } from '@eden3/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError, sendError } from '../errors';
import { isUniqueViolation, pgToIso } from '../route-helpers';
import {
  approvedSkillsForAgent,
  attachedSkillRows,
  replaceAgentSkills,
  skillColumns,
  SkillInstallError,
  type SkillDefinitionRow,
} from '../services/agent-skills';

const skillSlugSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(
    z
      .string()
      .min(2)
      .max(64)
      .regex(
        /^[a-z0-9][a-z0-9_-]*$/,
        'slug must be path-safe lowercase letters, digits, "-", "_" and start alphanumeric',
      ),
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
  if (!viewer) return false;
  if (viewer.isAdmin) return true;
  return viewer.accountId === agent.ownerId || viewer.accountId === account.id;
}

export const skillsRoutes: FastifyPluginAsync = async (app) => {
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

    const [row] = await pg<SkillDefinitionRow[]>`
      update skill_definitions
      set status = ${body.status},
          reviewer_id = ${account.accountId},
          reviewed_at = now(),
          updated_at = now()
      where slug = ${slug}
      returning ${skillColumns()}
    `;
    if (!row) return sendError(reply, 404, 'skill_not_found', `No skill "${slug}"`);

    if (body.status === 'rejected') {
      const affected = await pg<{ agent_id: string; openclaw_id: string | null }[]>`
        select aks.agent_id, g.openclaw_id
        from agent_skills aks
        join agents g on g.account_id = aks.agent_id
        where aks.skill_id = ${row.id}
      `;
      await pg`delete from agent_skills where skill_id = ${row.id}`;
      for (const agent of affected) {
        if (!agent.openclaw_id) continue;
        const skills = await approvedSkillsForAgent(agent.agent_id);
        await app.gatewayGlue.skillSync.syncAgentSkills({ openclawId: agent.openclaw_id, skills });
      }
    }

    return { skill: skillDto(row) };
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
      .filter((row) => manager || (row.enabled && row.status === 'approved'))
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
      const result = await replaceAgentSkills({
        agentId: account.id,
        openclawId: agent.openclawId,
        workspacePath: agent.workspacePath,
        slugs: body.slugs,
        skillSync: app.gatewayGlue.skillSync,
      });
      return {
        agent: { id: account.id, username: account.username, openclawId: agent.openclawId },
        skills: result.skills.map((row) => ({ ...skillDto(row), enabled: row.enabled })),
        openclaw: result.openclaw,
      };
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
