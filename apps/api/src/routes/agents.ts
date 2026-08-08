import path from 'node:path';

import {
  LocalMediaStore,
  getEnv,
  normalizeMime,
  probeImageSize,
  resolveAccountByUsername,
  resolveAgentByUsername,
  type AuthSession,
  type MediaStore,
} from '@eden3/core';
import { agentProvisionJobs, accounts, agents, db, pg, type Account, type Agent } from '@eden3/db';
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_THINKING_LEVEL,
  DEFAULT_AGENT_TOOL_GROUPS,
  agentModelSchema,
  agentThinkingLevelSchema,
  agentToolGroupsSchema,
  feedQuerySchema,
  type AgentModel,
} from '@eden3/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError, sendError } from '../errors';
import { defaultOpenclawDataDir } from '../gateway-glue';
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
import {
  DEFAULT_AGENT_SKILL_SLUGS,
  RETIRED_SKILL_SLUGS,
  exportedSkillBundlesForAgent,
  installDefaultAgentSkills,
  replaceAgentSkills,
} from '../services/agent-skills';
import { reconcileAgentRuntime } from '../services/agent-runtime-sync';
import { DEFAULT_EVE_USERNAME, isPlatformEve } from '../services/default-assistant';
import {
  agentMemorySnapshot,
  agentMemoryStatus,
  enqueueLazyMemoryDistillation,
  saveAgentMemory,
  shouldRetryAutomaticMemoryDistillation,
} from '../services/memory-distillation';
import { runMemoryRetrievalProbe } from '../services/memory-retrieval';
import { publishNotificationChanged } from '../services/app-notifications';
import { assertNativeAgentCreationAllowed } from '../services/native-agent-admission';

/**
 * Agents API.
 *
 *   GET    /agents            — directory (search, keyset pagination,
 *                               creation/session counts, is_pilot flag);
 *                               ?scope=mine lists the viewer's own agents
 *                               including private ones (auth required)
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
  // "public" (default) = the browsable directory of public agents.
  // "mine" = the viewer's own agents, INCLUDING private ones — requires auth.
  scope: z.enum(['public', 'mine']).default('public'),
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
  .refine((u) => !['main', DEFAULT_EVE_USERNAME, 'new', 'builder', 'edit', 'api', 'media'].includes(u), {
    message: 'username is reserved',
  });

const createBodySchema = z.object({
  username: agentUsernameSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).default(''),
  persona: z.string().max(20_000).default(''),
  greeting: z.string().max(1_000).default(''),
  voice: z.string().max(200).default(''),
  model: agentModelSchema.default(DEFAULT_AGENT_MODEL),
  thinkingLevel: agentThinkingLevelSchema.default(DEFAULT_AGENT_THINKING_LEVEL),
  toolGroups: agentToolGroupsSchema.default(DEFAULT_AGENT_TOOL_GROUPS),
});

const patchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2_000).optional(),
    persona: z.string().max(20_000).optional(),
    greeting: z.string().max(1_000).optional(),
    voice: z.string().max(200).optional(),
    model: agentModelSchema.optional(),
    thinkingLevel: agentThinkingLevelSchema.optional(),
    toolGroups: agentToolGroupsSchema.optional(),
    // Owner-controlled visibility: private agents vanish from every public
    // surface and 404 for non-owners (UX-1, decided 2026-07-09).
    public: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'no fields to update' });

const memoryBodySchema = z.object({
  memory: z.string().trim().min(1).max(100_000),
});

const memoryReseedBodySchema = z.object({ confirm: z.literal('reseed') }).strict();
const memorySearchProbeBodySchema = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    maxResults: z.number().int().min(1).max(20).default(5),
  })
  .strict();

const skillBundleSchema = z
  .object({
    id: z.string().trim().min(1).max(200).optional(),
    slug: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().default(true),
  })
  .passthrough()
  .refine((skill) => skill.id !== undefined || skill.slug !== undefined, {
    message: 'skill bundle entries need id or slug',
  });

const agentExportBundleSchema = z
  .object({
    kind: z.literal('eden3.agent.bundle'),
    version: z.literal(1),
    agent: z.object({
      username: z.string().trim().min(1).max(200).optional(),
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2_000).nullable().optional(),
      persona: z.string().max(20_000).nullable().optional(),
      greeting: z.string().max(1_000).nullable().optional(),
      voice: z.string().max(200).nullable().optional(),
      public: z.boolean().optional(),
      model: agentModelSchema.optional(),
      thinkingLevel: agentThinkingLevelSchema.optional(),
      toolGroups: agentToolGroupsSchema.optional(),
    }),
    memory: z
      .object({
        summary: z.string().max(20_000).nullable().optional(),
        items: z.array(z.unknown()).default([]),
      })
      .default({ items: [] }),
    skills: z.array(skillBundleSchema).default([]),
  })
  .passthrough();

const importBodySchema = z.object({
  username: agentUsernameSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  bundle: agentExportBundleSchema,
});

// ---- Avatar upload (mirrors the concept-image validation) -----------------
const ALLOWED_AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
/** base64 inflates ~4/3; 12MB leaves room for the JSON envelope around 8MB. */
const AVATAR_UPLOAD_BODY_LIMIT_BYTES = 12 * 1024 * 1024;

/** Only a fully provisioned row pointing at its derived workspace is live-editable. */
function canHotUpdateAgent(agent: Agent): agent is Agent & { openclawId: string; workspacePath: string } {
  if (
    agent.provisionStatus !== 'ready' ||
    agent.openclawId === null ||
    agent.workspacePath === null
  ) {
    return false;
  }
  const canonicalWorkspace = path.join(
    defaultOpenclawDataDir(),
    `workspace-${agent.openclawId}`,
  );
  return path.resolve(agent.workspacePath) === path.resolve(canonicalWorkspace);
}

const avatarBodySchema = z.object({
  filename: z.string().trim().min(1).max(300).optional(),
  mime: z.string().trim().min(1).max(200),
  /** Raw base64 (a data: URL prefix is tolerated and stripped). */
  dataBase64: z.string().min(1),
});

/** Decode base64 (tolerating a `data:` URL prefix); null on empty/invalid. */
function decodeUploadData(dataBase64: string): Buffer | null {
  const raw =
    dataBase64.includes(',') && dataBase64.trimStart().startsWith('data:')
      ? dataBase64.slice(dataBase64.indexOf(',') + 1)
      : dataBase64;
  try {
    const buffer = Buffer.from(raw, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

/** Fresh fragment per query (postgres.js fragments are single-use-safe). */
const agentRowColumns = () => pg`
  a.id, a.external_id, a.username, a.user_image, a.created_at, a.updated_at,
  g.name, g.description, g.persona, g.is_persona_public, g.greeting, g.voice,
  g.model, g.thinking_level, g.tool_groups, g.public, g.owner_id, g.is_pilot,
  g.is_synthetic, g.provision_status
`;

interface DirectoryRow extends AgentRow {
  creation_count: number;
  session_count: number;
}

interface AgentInteractionRow {
  like_count: number;
  viewer_has_liked: boolean;
}

/** Owner/admin gate shared with the workspace routes (routes/workspace.ts). */
export function canManage(viewer: AuthSession | null, account: Account, agent: Agent): boolean {
  // Eve is platform-owned, not admin-owned. Returning false here hides every
  // generic settings affordance and makes every direct configuration alias
  // hit the same server-side owner denial.
  if (isPlatformEve(account, agent)) return false;
  if (!viewer) return false;
  if (viewer.isAdmin) return true;
  return viewer.accountId === agent.ownerId || viewer.accountId === account.id;
}

async function agentInteraction(
  agentId: string,
  viewer: AuthSession | null,
): Promise<AgentInteractionRow> {
  const [row] = await pg<AgentInteractionRow[]>`
    select
      (select count(*)::int from agent_likes where agent_id = ${agentId}) as like_count,
      ${
        viewer !== null
          ? pg`exists(
              select 1 from agent_likes
              where agent_id = ${agentId} and user_id = ${viewer.accountId}
            )`
          : pg`false`
      } as viewer_has_liked
  `;
  return row ?? { like_count: 0, viewer_has_liked: false };
}

function bundleFilename(username: string): string {
  return `${username}-eden3-agent.json`.replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function agentExportBundle(account: Account, agent: Agent) {
  return {
    kind: 'eden3.agent.bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    source: {
      platform: 'eden3',
      accountId: account.id,
      externalId: account.externalId,
      username: account.username,
    },
    agent: {
      username: account.username,
      name: agent.name ?? account.username,
      description: agent.description ?? '',
      persona: agent.persona ?? '',
      greeting: agent.greeting ?? '',
      voice: agent.voice,
      public: agent.public,
      model: agent.model ?? DEFAULT_AGENT_MODEL,
      thinkingLevel: agent.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL,
      toolGroups: agentToolGroupsSchema.parse(agent.toolGroups ?? DEFAULT_AGENT_TOOL_GROUPS),
    },
    memory: {
      summary: null,
      items: [],
    },
    skills: await exportedSkillBundlesForAgent(account.id),
    workspaceFiles: {
      SOUL: agent.persona ?? '',
      IDENTITY: {
        name: agent.name ?? account.username,
        username: account.username,
        description: agent.description ?? '',
        greeting: agent.greeting ?? '',
      },
    },
  };
}

function importSkillSlugs(bundle: z.infer<typeof agentExportBundleSchema>): string[] {
  const retired = new Set<string>(RETIRED_SKILL_SLUGS);
  const slugs = bundle.skills
    .filter((skill) => skill.enabled)
    .map((skill) => skill.slug ?? skill.id)
    .filter((slug): slug is string => typeof slug === 'string' && slug.trim() !== '')
    // Old bundles may still carry a retired baseline (e.g. eden-safe-base); it's
    // no longer an installable skill, so drop it rather than 404 the import.
    .filter((slug) => !retired.has(slug));
  return [...new Set([...DEFAULT_AGENT_SKILL_SLUGS, ...slugs])];
}

function suggestedImportUsername(raw: string | undefined): string {
  const base = (raw ?? 'agent')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 21);
  const safe = base.length >= 3 ? base : 'agent';
  const suffix = Math.random().toString(36).slice(2, 8);
  return agentUsernameSchema.parse(`${safe}-${suffix}`.slice(0, 32));
}

export interface AgentsRoutesOptions {
  /** Media store override (tests). Default: LocalMediaStore over env MEDIA_DIR. */
  store?: MediaStore;
}

export const agentsRoutes: FastifyPluginAsync<AgentsRoutesOptions> = async (app, opts) => {
  let lazyStore: MediaStore | null = opts.store ?? null;
  const getStore = (): MediaStore => {
    lazyStore ??= new LocalMediaStore();
    return lazyStore;
  };
  const effectiveModel = (model: string | null | undefined): AgentModel => {
    const parsed = agentModelSchema.safeParse(model);
    return parsed.success ? parsed.data : DEFAULT_AGENT_MODEL;
  };
  const runtimeForModel = (model: string | null | undefined) =>
    app.gatewayGlue.modelRuntime.getRuntime(effectiveModel(model));
  const runtimeCatalog = async () =>
    new Map(
      (await app.gatewayGlue.modelRuntime.getCatalog()).map((entry) => [
        entry.model,
        entry.agentRuntime,
      ]),
    );

  // ---- GET /agents — directory (public, or scope=mine for own agents) -----
  app.get('/', async (req, reply) => {
    const { q, cursor, limit, scope } = directoryQuerySchema.parse(req.query);
    const after = parseCursorParam(cursor);
    const pattern = q !== undefined && q !== '' ? `%${escapeLike(q)}%` : null;
    const viewerId = req.account?.accountId ?? null;

    if (scope === 'mine' && viewerId === null) {
      return sendError(reply, 401, 'auth_required', 'Sign in to see your own agents');
    }

    // `nulls last` matches the index direction (created_at is NOT NULL, so
    // semantics are unchanged — but the planner needs the exact sort order).
    const rows = await pg<DirectoryRow[]>`
      select ${agentRowColumns()},
             (select count(*)::int from creations c
               where c.agent_id = a.id and c.public = true and c.deleted = false) as creation_count,
             (select count(*)::int from session_agents sa
               where sa.agent_account_id = a.id) as session_count,
             (select count(*)::int from agent_likes al
               where al.agent_id = a.id) as like_count,
             ${
               viewerId !== null
                 ? pg`exists(
                     select 1 from agent_likes al
                     where al.agent_id = a.id and al.user_id = ${viewerId}
                   )`
                 : pg`false`
             } as viewer_has_liked
      from accounts a
      join agents g on g.account_id = a.id
      where a.deleted = false
        ${
          scope === 'mine'
            ? // Owned agents plus the agent-self case (an agent account viewing
              // itself), mirroring canManage(). Private rows are included — the
              // viewer owns them.
              pg`and (g.owner_id = ${viewerId} or a.id = ${viewerId})`
            : pg`and g.public = true`
        }
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

    const runtimes = await runtimeCatalog();
    const items = rows.slice(0, limit).map((row) => ({
      // In mine scope the viewer manages every returned row, so private
      // persona text is theirs to see (mirrors the profile route's gate).
      ...agentDtoFromRow(row, {
        includePersona: scope === 'mine' || row.is_persona_public,
        agentRuntime: runtimes.get(effectiveModel(row.model)),
      }),
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
    const interaction = await agentInteraction(account.id, req.account);
    const memory = manager ? await agentMemoryStatus(agent.openclawId, agent.workspacePath) : null;
    if (
      manager &&
      agent.openclawId !== null &&
      agent.workspacePath !== null &&
      agent.provisionStatus === 'ready' &&
      shouldRetryAutomaticMemoryDistillation(memory)
    ) {
      enqueueLazyMemoryDistillation(
        {
          agentAccountId: account.id,
          openclawId: agent.openclawId,
          username: account.username,
          name: agent.name,
          persona: agent.persona,
          workspacePath: agent.workspacePath,
        },
        (err) => req.log.warn({ err }, `memory distillation failed for "${account.username}"`),
      );
    }

    const creationRows = await pg<CreationRow[]>`
      select c.id, c.external_id, c.user_id, c.agent_id, c.tool, c.filename,
             c.url, c.thumbnail_url, c.media_attributes, c.like_count, c.public,
             c.created_at, c.updated_at
      from creations c
      where c.agent_id = ${account.id} and c.public = true and c.deleted = false
        ${
          manager
            ? pg``
            : pg`and (
                c.attributes->>'nsfw_score' is null
                or (c.attributes->>'nsfw_score') !~ '^[0-9]+(\\.[0-9]+)?$'
                or (c.attributes->>'nsfw_score')::double precision < 0.85
              )`
        }
      order by c.created_at desc nulls last, c.id desc
      limit 12
    `;

    return {
      agent: agentDtoFromEntities(account, agent, {
        includePersona: agent.isPersonaPublic || manager,
        likeCount: interaction.like_count,
        viewerHasLiked: interaction.viewer_has_liked,
        agentRuntime: await runtimeForModel(agent.model),
      }),
      memory,
      recentCreations: creationRows.map(creationDtoFromRow),
    };
  });

  // ---- POST/DELETE /agents/:username/like — v1 social interaction --------
  // ---- GET/PUT/POST /agents/:username/memory — owner steering ------------
  app.get('/:username/memory', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const resolved = await resolveAgentByUsername(username);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }
    const { account, agent } = resolved;
    if (!canManage(req.account, account, agent)) {
      if (!agent.public) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
      }
      return sendError(reply, 403, 'forbidden', 'Only the owner can inspect this agent memory');
    }
    if (!agent.openclawId || !agent.workspacePath) {
      return sendError(reply, 409, 'memory_unavailable', 'Agent memory is available after provisioning');
    }
    return { memory: await agentMemorySnapshot(agent.openclawId, agent.workspacePath) };
  });

  app.put('/:username/memory', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const body = memoryBodySchema.parse(req.body);
    const resolved = await resolveAgentByUsername(username);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }
    const { account, agent } = resolved;
    if (!canManage(req.account, account, agent)) {
      if (!agent.public) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
      }
      return sendError(reply, 403, 'forbidden', 'Only the owner can steer this agent memory');
    }
    if (!agent.openclawId || !agent.workspacePath) {
      return sendError(reply, 409, 'memory_unavailable', 'Agent memory is available after provisioning');
    }
    return {
      memory: await saveAgentMemory({
        agentAccountId: account.id,
        openclawId: agent.openclawId,
        username: account.username,
        workspacePath: agent.workspacePath,
        memory: body.memory,
        actorAccountId: req.account!.accountId,
      }),
    };
  });

  // ---- POST /agents/:username/repair — re-assert the runtime (owner) ------
  // The owner-facing "restart" button enqueues a new durable desired revision
  // and converges it through the same per-agent runtime fence as PATCH. This
  // prevents a stale repair snapshot from landing after a concurrent edit.
  app.post('/:username/repair', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const resolved = await resolveAgentByUsername(username);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }
    const { account, agent } = resolved;
    if (!canManage(req.account, account, agent)) {
      if (!agent.public) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
      }
      return sendError(reply, 403, 'forbidden', 'Only the owner can repair this agent');
    }
    if (!canHotUpdateAgent(agent)) {
      return sendError(reply, 409, 'agent_not_provisioned', 'This agent has no runtime yet — open its profile to provision it');
    }
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${account.id}::text, 91))`,
        );
        await tx
          .update(agents)
          .set({
            runtimeSyncVersion: sql`${agents.runtimeSyncVersion} + 1`,
            runtimeSyncLeaseExpiresAt: null,
            runtimeSyncError: null,
          })
          .where(eq(agents.accountId, account.id));
      });
      const sync = await reconcileAgentRuntime(account.id, {
        provisioner: app.gatewayGlue.provisioner,
        toolSync: app.gatewayGlue.toolSync,
        skillSync: app.gatewayGlue.skillSync,
        logger: req.log,
      });
      if (sync.status === 'ineligible') {
        return sendError(reply, 409, 'repair_unavailable', 'The agent workspace is not eligible for repair');
      }
      return reply.code(sync.status === 'pending' ? 202 : 200).send({
        ok: true,
        repaired: agent.openclawId,
        runtimeSync: sync.status,
      });
    } catch (err) {
      req.log.error({ err }, `repair failed for "${account.username}"`);
      return sendError(
        reply,
        502,
        'repair_failed',
        err instanceof Error ? err.message : 'The runtime did not accept the repair',
      );
    }
  });

  // ---- POST /agents/:username/retry-provision — retry a failed first build
  // This is deliberately stricter than the general manager gate: an admin may
  // inspect a failed public profile, but only the human owner can spend another
  // provisioning attempt. The job and agent rows move together under row locks.
  app.post('/:username/retry-provision', { preHandler: app.requireAuth }, async (req, reply) => {
    const viewer = req.account;
    if (!viewer) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    const { username } = usernameParamsSchema.parse(req.params);

    const outcome = await pg.begin(async (tx) => {
      const accountsMatched = await tx<{ account_id: string }[]>`
        select a.id as account_id
        from accounts a
        join agents g on g.account_id = a.id
        where a.username = ${username}
          and a.deleted = false
      `;
      const accountId = accountsMatched[0]?.account_id;
      if (!accountId) return { kind: 'not_found' as const };

      // Match the worker's job -> agent lock order. A retry can race the
      // terminal failure commit without creating an agent/job deadlock.
      const jobsLocked = await tx<{ state: string }[]>`
        select state
        from agent_provision_jobs
        where agent_account_id = ${accountId}
        for update
      `;
      const rows = await tx<
        {
          account_id: string;
          owner_id: string | null;
          public: boolean;
          provision_status: string;
        }[]
      >`
        select a.id as account_id, g.owner_id, g.public,
               g.provision_status
        from accounts a
        join agents g on g.account_id = a.id
        where a.id = ${accountId}
          and a.deleted = false
        for update of g
      `;
      const row = rows[0];
      if (!row) return { kind: 'not_found' as const };
      if (row.owner_id !== viewer.accountId) {
        return { kind: row.public ? ('forbidden' as const) : ('not_found' as const) };
      }
      // A concurrent retry can replace a failed row while this request waits
      // on the agent lock. Re-read a previously missing job after that wait so
      // duplicate retries converge on the new pending/running cycle.
      const jobsRechecked =
        jobsLocked.length > 0
          ? jobsLocked
          : await tx<{ state: string }[]>`
              select state
              from agent_provision_jobs
              where agent_account_id = ${row.account_id}
              for update
            `;
      const jobState = jobsRechecked[0]?.state ?? null;
      if (
        row.provision_status === 'provisioning' &&
        (jobState === 'pending' || jobState === 'running')
      ) {
        return { kind: 'queued' as const, changed: false, accountId: row.account_id };
      }
      if (
        row.provision_status !== 'failed' ||
        (jobState !== null && jobState !== 'failed')
      ) {
        return { kind: 'not_failed' as const };
      }

      // 0034 makes a terminal job row immutable. A deliberate owner retry is
      // a new attempt cycle, so replace the locked terminal row atomically
      // instead of weakening the lifecycle trigger or rewriting its history.
      // Older import/lazy-provision failure paths have no job row; creating
      // their first durable cycle makes the same owner action recover them.
      if (jobState === 'failed') {
        const jobs = await tx<{ agent_account_id: string }[]>`
          delete from agent_provision_jobs
          where agent_account_id = ${row.account_id}
            and state = 'failed'
          returning agent_account_id
        `;
        if (!jobs[0]) throw new Error('failed provisioning job changed during retry');
      }
      await tx`
        insert into agent_provision_jobs (agent_account_id)
        values (${row.account_id})
      `;
      const agentsUpdated = await tx<{ account_id: string }[]>`
        update agents
        set provision_status = 'provisioning', provisioned_at = null,
            workspace_path = null
        where account_id = ${row.account_id}
          and provision_status = 'failed'
        returning account_id
      `;
      if (!agentsUpdated[0]) throw new Error('failed agent changed during retry');
      await tx`
        delete from app_notifications
        where account_id = ${viewer.accountId}
          and source_agent_id = ${row.account_id}
          and kind = 'agent_build_failed'
      `;
      return { kind: 'queued' as const, changed: true, accountId: row.account_id };
    });

    if (outcome.kind === 'not_found') {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }
    if (outcome.kind === 'forbidden') {
      return sendError(reply, 403, 'forbidden', 'Only the owner can retry this agent build');
    }
    if (outcome.kind === 'not_failed') {
      return sendError(reply, 409, 'agent_not_failed', 'This agent does not have a failed build');
    }

    if (outcome.changed) publishNotificationChanged(app.eventsBus, viewer.accountId);
    app.agentProvisioningWorker.wake();
    return reply.code(outcome.changed ? 202 : 200).send({
      ok: true,
      status: 'provisioning',
      queued: true,
    });
  });

  // ---- GET /agents/:username/activity — owner logs peek -------------------
  // Recent runtime activity for ONE agent, visible to its owner: turn/
  // generation events with status, model, manna, latency, and error detail.
  // This is the "what has my agent been doing / why did it fail" surface.
  app.get('/:username/activity', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const resolved = await resolveAgentByUsername(username);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }
    const { account, agent } = resolved;
    if (!canManage(req.account, account, agent)) {
      if (!agent.public) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
      }
      return sendError(reply, 403, 'forbidden', 'Only the owner can view agent activity');
    }
    const rows = await pg<
      {
        id: string;
        event_type: string;
        status: string;
        session_id: string | null;
        model: string | null;
        manna: number | null;
        latency_ms: number | null;
        error_code: string | null;
        error_message: string | null;
        created_at: string;
      }[]
    >`
      select id, event_type, status, session_id, model, manna, latency_ms,
             error_code, error_message, created_at
      from usage_events
      where agent_id = ${account.id}
      order by created_at desc
      limit 25
    `;
    return {
      items: rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        status: row.status,
        sessionId: row.session_id,
        model: row.model,
        manna: row.manna,
        latencyMs: row.latency_ms,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    };
  });

  app.post('/:username/memory/rebuild', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    memoryReseedBodySchema.parse(req.body);
    const resolved = await resolveAgentByUsername(username);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }
    const { account, agent } = resolved;
    if (!canManage(req.account, account, agent)) {
      if (!agent.public) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
      }
      return sendError(reply, 403, 'forbidden', 'Only the owner can rebuild this agent memory');
    }
    if (!agent.openclawId || !agent.workspacePath || agent.provisionStatus !== 'ready') {
      return sendError(reply, 409, 'memory_unavailable', 'Agent memory is available after provisioning');
    }
    const queued = enqueueLazyMemoryDistillation(
      {
        agentAccountId: account.id,
        openclawId: agent.openclawId,
        username: account.username,
        name: agent.name,
        persona: agent.persona,
        workspacePath: agent.workspacePath,
        mode: 'manual-reseed',
        actorAccountId: req.account!.accountId,
      },
      (err) => req.log.warn({ err }, `memory rebuild failed for "${account.username}"`),
    );
    const memory = await agentMemoryStatus(agent.openclawId, agent.workspacePath);
    return reply.code(202).send({ queued, memory });
  });

  app.post('/:username/memory/search-probe', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const body = memorySearchProbeBodySchema.parse(req.body);
    const resolved = await resolveAgentByUsername(username);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }
    const { account, agent } = resolved;
    if (!canManage(req.account, account, agent)) {
      if (!agent.public) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
      }
      return sendError(reply, 403, 'forbidden', 'Only the owner can probe this agent memory');
    }
    if (!agent.openclawId || agent.provisionStatus !== 'ready') {
      return sendError(reply, 409, 'memory_unavailable', 'Agent memory is available after provisioning');
    }
    return {
      probe: await runMemoryRetrievalProbe({
        memoryRuntime: app.gatewayGlue.memoryRuntime,
        agentAccountId: account.id,
        openclawId: agent.openclawId,
        query: body.query,
        maxResults: body.maxResults,
      }),
    };
  });

  // ---- POST/DELETE /agents/:username/like — v1 social interaction --------
  app.post('/:username/like', { preHandler: app.requireAuth }, async (req, reply) => {
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

    await pg`
      insert into agent_likes (user_id, agent_id)
      values (${req.account!.accountId}, ${account.id})
      on conflict do nothing
    `;
    const interaction = await agentInteraction(account.id, req.account);
    return {
      agent: agentDtoFromEntities(account, agent, {
        includePersona: agent.isPersonaPublic || manager,
        likeCount: interaction.like_count,
        viewerHasLiked: interaction.viewer_has_liked,
        agentRuntime: await runtimeForModel(agent.model),
      }),
    };
  });

  app.delete('/:username/like', { preHandler: app.requireAuth }, async (req, reply) => {
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

    await pg`
      delete from agent_likes
      where user_id = ${req.account!.accountId} and agent_id = ${account.id}
    `;
    const interaction = await agentInteraction(account.id, req.account);
    return {
      agent: agentDtoFromEntities(account, agent, {
        includePersona: agent.isPersonaPublic || manager,
        likeCount: interaction.like_count,
        viewerHasLiked: interaction.viewer_has_liked,
        agentRuntime: await runtimeForModel(agent.model),
      }),
    };
  });

  // ---- GET /agents/:username/export — portable owner bundle ---------------
  app.get('/:username/export', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const resolved = await resolveAgentByUsername(username);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }
    const { account, agent } = resolved;
    if (!canManage(req.account, account, agent)) {
      if (!agent.public) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
      }
      return sendError(reply, 403, 'forbidden', 'Only the owner can export this agent');
    }

    reply.header('content-disposition', `attachment; filename="${bundleFilename(account.username)}"`);
    return { bundle: await agentExportBundle(account, agent) };
  });

  // ---- POST /agents — create + provision ----------------------------------
  app.post('/', { preHandler: app.requireAuth }, async (req, reply) => {
    const viewer = req.account;
    if (!viewer) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    const body = createBodySchema.parse(req.body);

    // Fail fast (503) when the gateway is unconfigured — before any rows land.
    void app.gatewayGlue.provisioner;
    const agentRuntime = await runtimeForModel(body.model);
    // Friendly pre-check; the citext unique constraint is the real guard.
    const taken = await resolveAccountByUsername(body.username, { includeDeleted: true });
    if (taken) {
      return sendError(reply, 409, 'username_taken', `Username "${body.username}" is taken`);
    }

    let created: { account: Account; agent: Agent };
    try {
      created = await db.transaction(async (tx) => {
        // This lock + count + inserts are one transaction. Concurrent create
        // and import requests for the same owner cannot all pass a stale
        // route-level count and exceed the durable quota.
        await assertNativeAgentCreationAllowed(
          tx,
          viewer,
          getEnv().MAX_NATIVE_AGENTS_PER_USER,
        );
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
            voice: body.voice === '' ? null : body.voice,
            model: body.model,
            thinkingLevel: body.thinkingLevel,
            toolGroups: body.toolGroups,
            public: true,
            openclawId: body.username,
            provisionStatus: 'provisioning',
          })
          .returning();
        if (!agent) throw new Error('agents insert returned no row');
        await tx.insert(agentProvisionJobs).values({ agentAccountId: account.id });
        return { account, agent };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return sendError(reply, 409, 'username_taken', `Username "${body.username}" is taken`);
      }
      throw err;
    }

    app.agentProvisioningWorker.wake();
    return reply.code(201).send({
      agent: agentDtoFromEntities(created.account, created.agent, {
        includePersona: true,
        agentRuntime,
      }),
    });
  });

  // ---- POST /agents/import — create from portable bundle ------------------
  app.post('/import', { preHandler: app.requireAuth }, async (req, reply) => {
    const viewer = req.account;
    if (!viewer) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    const body = importBodySchema.parse(req.body);
    const bundleAgent = body.bundle.agent;
    const username = body.username ?? suggestedImportUsername(bundleAgent.username);
    const name = body.name ?? bundleAgent.name;
    const description = bundleAgent.description ?? '';
    const persona = bundleAgent.persona ?? '';
    const greeting = bundleAgent.greeting ?? '';
    const isPublic = bundleAgent.public ?? true;
    const model = bundleAgent.model ?? DEFAULT_AGENT_MODEL;
    const thinkingLevel = bundleAgent.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL;
    const toolGroups = agentToolGroupsSchema.parse(bundleAgent.toolGroups ?? DEFAULT_AGENT_TOOL_GROUPS);

    const taken = await resolveAccountByUsername(username, { includeDeleted: true });
    if (taken) {
      return sendError(reply, 409, 'username_taken', `Username "${username}" is taken`);
    }

    let created: { account: Account; agent: Agent };
    try {
      created = await db.transaction(async (tx) => {
        await assertNativeAgentCreationAllowed(
          tx,
          viewer,
          getEnv().MAX_NATIVE_AGENTS_PER_USER,
        );
        const [account] = await tx
          .insert(accounts)
          .values({ type: 'agent', username })
          .returning();
        if (!account) throw new Error('accounts insert returned no row');
        const [agent] = await tx
          .insert(agents)
          .values({
            accountId: account.id,
            ownerId: viewer.accountId,
            name,
            description: description === '' ? null : description,
            persona: persona === '' ? null : persona,
            greeting: greeting === '' ? null : greeting,
            voice: bundleAgent.voice ?? null,
            model,
            thinkingLevel,
            toolGroups,
            public: isPublic,
            openclawId: username,
            provisionStatus: 'provisioning',
          })
          .returning();
        if (!agent) throw new Error('agents insert returned no row');
        return { account, agent };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return sendError(reply, 409, 'username_taken', `Username "${username}" is taken`);
      }
      throw err;
    }

    let provisionStatus: 'ready' | 'failed' = 'ready';
    let workspacePath: string | null = null;
    try {
      const result = await app.gatewayGlue.provisioner.provisionAgent({
        openclawId: username,
        name,
        username,
        description,
        persona,
        greeting,
        voice: bundleAgent.voice ?? '',
        thinkingLevel,
        model,
      });
      workspacePath = result.hostWorkspaceDir;
      const requestedImportSkills = importSkillSlugs(body.bundle);
      await replaceAgentSkills({
        agentId: created.account.id,
        openclawId: username,
        workspacePath,
        slugs: requestedImportSkills,
        skillSync: app.gatewayGlue.skillSync,
      });
      await app.gatewayGlue.toolSync.syncAgentToolGroups({ openclawId: username, toolGroups });
    } catch (err) {
      provisionStatus = 'failed';
      req.log.error({ err }, `import provisioning failed for agent "${username}"`);
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
        agentRuntime: await runtimeForModel((updatedAgent ?? created.agent).model),
      }),
      imported: {
        bundleVersion: body.bundle.version,
        sourceUsername: body.bundle.agent.username ?? null,
        skills: body.bundle.skills.length,
        memoryItems: body.bundle.memory.items.length,
      },
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

    const personaChanged =
      body.name !== undefined ||
      body.description !== undefined ||
      body.persona !== undefined ||
      body.greeting !== undefined ||
      body.voice !== undefined ||
      body.thinkingLevel !== undefined;
    const runtimeRelevantChanged =
      personaChanged || body.model !== undefined || body.toolGroups !== undefined;

    // Postgres is the durable authority. Commit the desired row and increment
    // a monotonic runtime revision before touching files/config. A process
    // death, partial provisioner restore, or gateway outage therefore leaves
    // an explicit pending revision instead of an undetectably divergent
    // workspace. The fenced reconciler below (and its background loop) always
    // renders the newest committed row.
    const updatedAgent = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${account.id}::text, 91))`,
      );
      const [lockedAgent] = await tx
        .select()
        .from(agents)
        .where(eq(agents.accountId, account.id))
        .limit(1);
      if (!lockedAgent) {
        throw new ApiError(404, 'agent_not_found', `No agent named "${username}"`);
      }
      // Even a pending/provisioning/failed agent needs a durable desired
      // revision. Once provisioning commits a canonical ready workspace, the
      // scheduler can converge the newest DB row instead of leaving a stale
      // initial render permanently marked 0==0.
      const requiresRuntimeSync = runtimeRelevantChanged;
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
          ...(body.voice !== undefined ? { voice: body.voice === '' ? null : body.voice } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.thinkingLevel !== undefined ? { thinkingLevel: body.thinkingLevel } : {}),
          ...(body.toolGroups !== undefined ? { toolGroups: body.toolGroups } : {}),
          ...(body.public !== undefined ? { public: body.public } : {}),
          ...(requiresRuntimeSync
            ? {
                runtimeSyncVersion: sql`${agents.runtimeSyncVersion} + 1`,
                runtimeSyncLeaseExpiresAt: null,
                runtimeSyncError: null,
              }
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

    if (runtimeRelevantChanged && canHotUpdateAgent(updatedAgent.agent)) {
      const sync = await reconcileAgentRuntime(account.id, {
        provisioner: app.gatewayGlue.provisioner,
        toolSync: app.gatewayGlue.toolSync,
        skillSync: app.gatewayGlue.skillSync,
        logger: req.log,
      });
      if (sync.status === 'pending') {
        req.log.warn(
          { accountId: account.id, version: sync.version },
          `agent edit saved; runtime convergence pending for "${account.username}"`,
        );
      }
    }

    return {
      agent: agentDtoFromEntities(updatedAgent.account, updatedAgent.agent, {
        includePersona: true,
        agentRuntime: await runtimeForModel(updatedAgent.agent.model),
      }),
    };
  });

  // ---- POST /agents/:username/avatar — owner/admin avatar upload ----------
  // Base64-JSON upload (png/jpeg/webp ≤ 8MB) stored through the same
  // content-addressed media store as concept images / studio media, then
  // written to accounts.user_image. Returns the refreshed agent DTO.
  app.post(
    '/:username/avatar',
    { preHandler: app.requireAuth, bodyLimit: AVATAR_UPLOAD_BODY_LIMIT_BYTES },
    async (req, reply) => {
      const { username } = usernameParamsSchema.parse(req.params);
      const body = avatarBodySchema.parse(req.body);
      const resolved = await resolveAgentByUsername(username);
      if (!resolved) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
      }
      const { account, agent } = resolved;
      if (!canManage(req.account, account, agent)) {
        if (!agent.public) {
          return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
        }
        return sendError(reply, 403, 'forbidden', 'Only the owner can change this agent avatar');
      }

      const mime = normalizeMime(body.mime);
      if (!ALLOWED_AVATAR_MIMES.has(mime)) {
        return sendError(
          reply,
          400,
          'unsupported_image_type',
          `Unsupported image type "${mime}" — expected png, jpeg, or webp`,
        );
      }
      const buffer = decodeUploadData(body.dataBase64);
      if (!buffer) {
        return sendError(reply, 400, 'invalid_image_data', 'dataBase64 is not valid base64');
      }
      if (buffer.length > MAX_AVATAR_BYTES) {
        return sendError(
          reply,
          400,
          'image_too_large',
          `Image is ${buffer.length} bytes — the limit is ${MAX_AVATAR_BYTES} (8MB)`,
        );
      }
      if (!probeImageSize(buffer)) {
        return sendError(
          reply,
          400,
          'invalid_image_data',
          'File does not look like a valid png/jpeg/webp image',
        );
      }

      const stored = await getStore().put(buffer, { mime });
      const [updatedAccount] = await db
        .update(accounts)
        .set({ userImage: stored.url, updatedAt: new Date() })
        .where(eq(accounts.id, account.id))
        .returning();

      return {
        agent: agentDtoFromEntities(updatedAccount ?? account, agent, {
          includePersona: true,
          agentRuntime: await runtimeForModel(agent.model),
        }),
      };
    },
  );

  // ---- DELETE /agents/:username/avatar — clear the avatar ----------------
  app.delete('/:username/avatar', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const resolved = await resolveAgentByUsername(username);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    }
    const { account, agent } = resolved;
    if (!canManage(req.account, account, agent)) {
      if (!agent.public) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
      }
      return sendError(reply, 403, 'forbidden', 'Only the owner can change this agent avatar');
    }

    const [updatedAccount] = await db
      .update(accounts)
      .set({ userImage: null, updatedAt: new Date() })
      .where(eq(accounts.id, account.id))
      .returning();

    return {
      agent: agentDtoFromEntities(updatedAccount ?? account, agent, {
        includePersona: true,
        agentRuntime: await runtimeForModel(agent.model),
      }),
    };
  });
};
