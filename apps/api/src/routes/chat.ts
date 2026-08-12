import { randomUUID } from 'node:crypto';

import {
  DailyCapExceededError,
  getEnv,
  InsufficientMannaError,
  gatewaySessionKey,
  resolveAgentByUsername,
  resolveSession,
} from '@eden3/core';
import type { AuthSession, DbHandle } from '@eden3/core';
import {
  accounts,
  agents,
  db,
  sessionAgents,
  sessionUsers,
  sessions,
  type Account,
  type Agent,
  type Session,
} from '@eden3/db';
import {
  DEFAULT_AGENT_THINKING_LEVEL,
  DEFAULT_AGENT_TOOL_GROUPS,
  encodeSseComment,
  encodeSseEvent,
} from '@eden3/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import { ApiError, safeRequestErrorCallback } from '../errors';
import { DEFAULT_AGENT_MODEL, type GatewayGlue } from '../gateway-glue';
import { concurrentTurnLimit } from '../services/chat-limits';
import { installDefaultAgentSkills } from '../services/agent-skills';
import { projectAgentConcepts } from '../services/concepts';
import { assertTurnAdmissible, runTurn, type TurnAgent, type TurnSink } from '../services/turns';
import { canAccessSession } from './sessions';
import { enqueueLazyMemoryDistillation } from '../services/memory-distillation';
import { generateSessionTitle } from '../services/session-title';
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  prepareLegacyAssistantImages,
  prepareChatAttachments,
  recentAssistantImageReferences,
} from '../services/chat-attachments';
import type { MediaObjectResolver } from '../services/media-object-repository';

/**
 * POST /sessions/:idOrNew/messages — the chat turn endpoint.
 *
 *   `new` + {content, agentUsername}  → create a session with that agent,
 *                                       then run the first turn.
 *   `<uuid | legacy 24-hex>` + {content} → run a turn in an existing session
 *                                       (legacy permalink ids resolve; the
 *                                       gateway key + continue-priming are
 *                                       handled on first contact).
 *
 * The response body is an SSE stream of @eden3/shared SessionEvents
 * (turn.started → token* → turn.completed | error, with manna.updated and
 * media.pending interleaved). The same events are simultaneously published on
 * the per-session bus (GET /sessions/:id/events). The new/resolved session id
 * is also exposed as an `x-session-id` response header, sent before the first
 * event.
 *
 * Everything that can fail with a *user-addressable* error (unknown agent,
 * access, 402 insufficient manna) happens BEFORE the reply is hijacked, so
 * those come back as normal JSON error envelopes.
 */

const bodySchema = z.object({
  content: z.string().max(20_000).default(''),
  attachments: z.array(z.object({ objectId: z.string().uuid() })).max(8).default([]),
  /** Required for `new`, ignored otherwise. */
  agentUsername: z.string().trim().min(1).optional(),
}).superRefine((value, context) => {
  if (value.content.trim().length === 0 && value.attachments.length === 0) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'content or an attachment is required' });
  }
});

interface ResolvedTarget {
  session: Session;
  agent: TurnAgent;
}

type ChatViewer = Pick<AuthSession, 'accountId' | 'isAdmin'>;
type ChatAgentAccount = Pick<Account, 'id' | 'username'>;
type ChatAgentVisibility = Pick<Agent, 'ownerId' | 'public'>;

/** Public agents are shared; private agents are invocable only by their managers. */
export function isChatAgentVisible(
  viewer: ChatViewer,
  account: ChatAgentAccount,
  agent: ChatAgentVisibility,
): boolean {
  return agent.public || viewer.isAdmin || viewer.accountId === agent.ownerId || viewer.accountId === account.id;
}

export function assertChatAgentVisible(
  viewer: ChatViewer,
  account: ChatAgentAccount,
  agent: ChatAgentVisibility,
): void {
  if (!isChatAgentVisible(viewer, account, agent)) {
    throw new ApiError(404, 'agent_not_found', `No agent named "${account.username}"`);
  }
}

export interface ExistingChatAgentRow extends ChatAgentVisibility {
  accountId: string;
  username: string;
  openclawId: string | null;
  model: Agent['model'];
  thinkingLevel: Agent['thinkingLevel'];
}

/** Select the same target as before, but revalidate current agent visibility first. */
export function selectChatAgentForInvocation(
  rows: readonly ExistingChatAgentRow[],
  viewer: ChatViewer,
): ExistingChatAgentRow | null {
  const selected = rows.find((row) => row.openclawId !== null) ?? rows[0] ?? null;
  if (!selected) return null;
  assertChatAgentVisible(
    viewer,
    { id: selected.accountId, username: selected.username },
    selected,
  );
  return selected;
}

/** A completed chat may make a previously-too-small seed eligible. */
async function enqueueAutomaticMemoryRetryForAgent(
  agentAccountId: string,
  onError: (err: unknown) => void,
): Promise<void> {
  const [row] = await db
    .select({
      openclawId: agents.openclawId,
      workspacePath: agents.workspacePath,
      provisionStatus: agents.provisionStatus,
      name: agents.name,
      persona: agents.persona,
      username: accounts.username,
    })
    .from(agents)
    .innerJoin(accounts, eq(accounts.id, agents.accountId))
    .where(eq(agents.accountId, agentAccountId))
    .limit(1);
  if (
    !row?.openclawId ||
    !row.workspacePath ||
    row.provisionStatus !== 'ready'
  ) return;
  enqueueLazyMemoryDistillation(
    {
      agentAccountId,
      openclawId: row.openclawId,
      username: row.username,
      name: row.name,
      persona: row.persona,
      workspacePath: row.workspacePath,
    },
    onError,
  );
}

/** Resolve a ready runtime or provision one, only after current visibility passes. */
export async function ensureChattableAgent(
  viewer: ChatViewer,
  resolved: NonNullable<Awaited<ReturnType<typeof resolveAgentByUsername>>>,
  gatewayGlue: GatewayGlue,
): Promise<TurnAgent> {
  const { account, agent } = resolved;
  // Defense in depth: every lazy-provision/runtime entry crosses this check,
  // even if a caller omits its earlier friendly authorization pre-check.
  assertChatAgentVisible(viewer, account, agent);
  if (agent.openclawId && agent.provisionStatus === 'ready') {
    return {
      accountId: account.id,
      username: account.username,
      ownerId: agent.ownerId,
      openclawId: agent.openclawId,
      model: agent.model,
      agentRuntime: await gatewayGlue.modelRuntime.getRuntime(agent.model),
      thinkingLevel: agent.thinkingLevel,
    };
  }

  // Respect a pre-assigned slug (the ETL slugifies migrated usernames and
  // resolves collisions; environments may namespace them) — only derive from
  // the username when no slug was ever assigned.
  const openclawId = agent.openclawId ?? account.username;
  await db
    .update(agents)
    .set({ openclawId, provisionStatus: 'provisioning' })
    .where(eq(agents.accountId, account.id));

  try {
    const result = await gatewayGlue.provisioner.provisionAgent({
      openclawId,
      name: agent.name ?? account.username,
      username: account.username,
      description: agent.description ?? '',
      persona: agent.persona ?? '',
      greeting: agent.greeting ?? '',
      voice: agent.voice ?? '',
      thinkingLevel: agent.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL,
      model: agent.model ?? DEFAULT_AGENT_MODEL,
    });
    await installDefaultAgentSkills({
      agentId: account.id,
      openclawId,
      workspacePath: result.hostWorkspaceDir,
      skillSync: gatewayGlue.skillSync,
    });
    await gatewayGlue.toolSync.syncAgentToolGroups({
      openclawId,
      toolGroups: agent.toolGroups ?? DEFAULT_AGENT_TOOL_GROUPS,
    });
    await db
      .update(agents)
      .set({
        openclawId,
        workspacePath: result.hostWorkspaceDir,
        provisionStatus: 'ready',
        provisionedAt: new Date(),
      })
      .where(eq(agents.accountId, account.id));
    // Concepts created while the agent was dormant (workspace_path was null, so
    // the mutation's projection no-opped) get their first projection here, now
    // that the workspace exists. Best-effort: never block the first turn.
    try {
      await projectAgentConcepts(account.id);
    } catch (err) {
      // Self-heals on the owner's next concept mutation.
      void err;
    }
    enqueueLazyMemoryDistillation(
      {
        agentAccountId: account.id,
        openclawId,
        username: account.username,
        name: agent.name,
        persona: agent.persona,
        workspacePath: result.hostWorkspaceDir,
      },
      () => {},
    );
    return {
      accountId: account.id,
      username: account.username,
      ownerId: agent.ownerId,
      openclawId,
      model: agent.model,
      agentRuntime: await gatewayGlue.modelRuntime.getRuntime(agent.model),
      thinkingLevel: agent.thinkingLevel,
    };
  } catch (err) {
    await db
      .update(agents)
      .set({ provisionStatus: 'failed' })
      .where(eq(agents.accountId, account.id));
    throw new ApiError(
      503,
      'agent_provision_failed',
      `Agent "${account.username}" could not be provisioned: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

type ChatAgentResolver = (
  username: string,
) => ReturnType<typeof resolveAgentByUsername>;

export async function createSession(
  viewer: ChatViewer,
  agentUsername: string,
  content: string,
  gatewayGlue: GatewayGlue,
  resolver: ChatAgentResolver = resolveAgentByUsername,
): Promise<ResolvedTarget> {
  // The friendly route precheck precedes a potentially blocking funding read.
  // Resolve again here so a concurrent public -> private change is authoritative
  // before provisioning, session persistence, model lookup, or provider work.
  const resolved = await resolver(agentUsername);
  if (!resolved) throw new ApiError(404, 'agent_not_found', `No agent named "${agentUsername}"`);
  assertChatAgentVisible(viewer, resolved.account, resolved.agent);
  const chattable = await ensureChattableAgent(viewer, resolved, gatewayGlue);
  const sessionId = randomUUID();
  const key = gatewaySessionKey(sessionId);
  const session = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sessions)
      .values({
        id: sessionId,
        ownerId: viewer.accountId,
        // Null is an explicit short-lived "title pending" state. The web
        // renders New Chat / animated dots until the isolated Haiku title
        // compare-and-swap completes.
        title: null,
        sessionType: 'chat',
        gatewaySessionKey: key,
      })
      .returning();
    if (!row) throw new Error('session insert returned no row');
    await tx
      .insert(sessionAgents)
      .values({ sessionId, agentAccountId: chattable.accountId });
    await tx.insert(sessionUsers).values({ sessionId, userAccountId: viewer.accountId });
    return row;
  });

  return {
    session,
    agent: chattable,
  };
}

/** Resolve an existing session (uuid or legacy hex), authorize, pick its agent. */
async function resolveExisting(
  ref: string,
  account: { accountId: string; isAdmin: boolean },
  gatewayGlue: GatewayGlue,
): Promise<ResolvedTarget> {
  const session = await resolveSession(ref);
  if (!session) throw new ApiError(404, 'not_found', 'Session not found');
  if (!(await canAccessSession(session, account))) {
    throw new ApiError(403, 'forbidden', 'You do not have access to this session');
  }
  if (session.channelConnectionId !== null || session.sessionType === 'channel') {
    throw new ApiError(
      409,
      'channel_session_read_only',
      'External channel conversations are read-only in Eden',
    );
  }

  const rows = await db
    .select({
      accountId: agents.accountId,
      ownerId: agents.ownerId,
      public: agents.public,
      openclawId: agents.openclawId,
      model: agents.model,
      thinkingLevel: agents.thinkingLevel,
      username: accounts.username,
    })
    .from(sessionAgents)
    .innerJoin(agents, eq(agents.accountId, sessionAgents.agentAccountId))
    .innerJoin(accounts, eq(accounts.id, agents.accountId))
    .where(eq(sessionAgents.sessionId, session.id))
    .orderBy(agents.accountId)
    .limit(8);
  const selected = selectChatAgentForInvocation(rows, account);
  if (!selected) {
    throw new ApiError(409, 'agent_not_provisioned', 'No agent is attached to this session');
  }
  let provisioned = selected.openclawId !== null ? selected : null;
  if (!provisioned) {
    const resolved = await resolveAgentByUsername(selected.username);
    if (!resolved) throw new ApiError(404, 'agent_not_found', `No agent named "${selected.username}"`);
    const chattable = await ensureChattableAgent(account, resolved, gatewayGlue);
    provisioned = {
      accountId: chattable.accountId,
      ownerId: chattable.ownerId ?? resolved.agent.ownerId,
      public: resolved.agent.public,
      username: chattable.username,
      openclawId: chattable.openclawId,
      model: chattable.model ?? DEFAULT_AGENT_MODEL,
      thinkingLevel: chattable.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL,
    };
  }

  // Migrated sessions have no gateway key until first contact — backfill the
  // deterministic `eden3:s:<session uuid>` key now.
  let current = session;
  if (!current.gatewaySessionKey) {
    const [updated] = await db
      .update(sessions)
      .set({ gatewaySessionKey: gatewaySessionKey(session.id), updatedAt: new Date() })
      .where(eq(sessions.id, session.id))
      .returning();
    if (updated) current = updated;
  }

  return {
    session: current,
    agent: {
      accountId: provisioned.accountId,
      username: provisioned.username,
      ownerId: provisioned.ownerId,
      openclawId: provisioned.openclawId!,
      model: provisioned.model,
      agentRuntime: await gatewayGlue.modelRuntime.getRuntime(
        provisioned.model ?? DEFAULT_AGENT_MODEL,
      ),
      thinkingLevel: provisioned.thinkingLevel,
    },
  };
}

/** Hijack the reply into an SSE stream (mirrors events-bus framing). */
function openSseSink(reply: FastifyReply, sessionId: string): TurnSink {
  reply.hijack();
  // A client that disconnects mid-turn destroys the socket; writes after that
  // emit async 'error' events — swallow them (the turn itself keeps running
  // so the assistant reply still gets persisted).
  reply.raw.on('error', () => {});
  const writable = (): boolean => !reply.raw.destroyed && !reply.raw.writableEnded;
  // Preserve headers already staged by earlier hooks (CORS) — raw writeHead
  // bypasses the Fastify reply otherwise.
  const staged: Record<string, number | string | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) staged[name] = value;
  }
  reply.raw.writeHead(200, {
    ...staged,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-session-id': sessionId,
  });
  reply.raw.write(encodeSseComment('turn'));
  return {
    emit(event) {
      if (writable()) reply.raw.write(encodeSseEvent(event));
    },
    end() {
      if (writable()) reply.raw.end();
    },
  };
}

export interface ChatRoutesOptions {
  providerEvidenceDb?: DbHandle;
  mediaResolver?: MediaObjectResolver;
}

export const chatRoutes: FastifyPluginAsync<ChatRoutesOptions> = async (app, opts) => {
  app.post<{ Params: { idOrNew: string } }>(
    '/:idOrNew/messages',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = bodySchema.parse(req.body);
      const account = req.account!;

      if (!app.gatewayCompat || !app.historySync) {
        throw new ApiError(
          503,
          'gateway_not_configured',
          'OPENCLAW_GATEWAY_TOKEN is not configured — chat is unavailable',
        );
      }

      // Validate explicit objects before a new-session insert or any economic
      // reservation. Contextual images require the resolved session below.
      const explicitObjectIds = body.attachments.map((attachment) => attachment.objectId);
      const explicitAttachments = await prepareChatAttachments({
        objectIds: explicitObjectIds,
        viewerAccountId: account.accountId,
        resolver: opts.mediaResolver,
      });

      let target: ResolvedTarget;
      if (req.params.idOrNew === 'new') {
        if (!body.agentUsername) {
          throw new ApiError(400, 'agent_required', 'agentUsername is required to start a new session');
        }
        // Friendly authorization pre-check BEFORE the session insert, so a
        // user who cannot fund the first turn does not mint empty sessions.
        // (Race-free authority stays the in-debit reservation check.)
        const preResolved = await resolveAgentByUsername(body.agentUsername);
        if (!preResolved) {
          throw new ApiError(404, 'agent_not_found', `No agent named "${body.agentUsername}"`);
        }
        assertChatAgentVisible(account, preResolved.account, preResolved.agent);
        await assertTurnAdmissible(account.accountId, preResolved.agent.model ?? undefined);
        target = await createSession(account, body.agentUsername, body.content, app.gatewayGlue);
        const titleLogContext = { sessionId: target.session.id };
        void generateSessionTitle({
          compat: app.gatewayCompat,
          agentId: target.agent.openclawId,
          sessionId: target.session.id,
          firstMessage: body.content.trim() || `${body.attachments.length} attached file${body.attachments.length === 1 ? '' : 's'}`,
          forbiddenTitles: [target.agent.username],
          persistIfCurrent: async (title) => {
            const [updated] = await db
              .update(sessions)
              .set({ title, updatedAt: new Date() })
              .where(sql`${sessions.id} = ${target.session.id} and ${sessions.title} is null and ${sessions.deleted} = false`)
              .returning({ id: sessions.id });
            return updated !== undefined;
          },
        }).catch(
          safeRequestErrorCallback(
            req.log,
            titleLogContext,
            'session title generation failed',
            'warn',
          ),
        );
      } else {
        target = await resolveExisting(req.params.idOrNew, account, app.gatewayGlue);
        await assertTurnAdmissible(
          account.accountId,
          target.agent.gatewayModelOverride ?? target.agent.model,
        );
      }

      const contextualReferences = explicitObjectIds.length === 0
        ? await recentAssistantImageReferences(target.session.id)
        : { objectIds: [], legacy: [] };
      const contextualImages = await prepareChatAttachments({
        objectIds: contextualReferences.objectIds,
        viewerAccountId: account.accountId,
        resolver: opts.mediaResolver,
      });
      const legacyContextualImages = await prepareLegacyAssistantImages(
        contextualReferences.legacy,
        getEnv().MEDIA_DIR,
      );
      if (contextualImages.totalBytes + legacyContextualImages.totalBytes > MAX_CHAT_ATTACHMENT_BYTES) {
        throw new ApiError(413, 'chat_attachments_too_large', 'Chat attachments may total at most 20 MiB');
      }

      const turnLimit = await concurrentTurnLimit(account.accountId);
      const queueAbort = new AbortController();
      const abortQueuedTurn = () => queueAbort.abort();
      reply.raw.once('close', abortQueuedTurn);
      const admission = await app.turnLimiter.admit(account.accountId, turnLimit.limit, {
        signal: queueAbort.signal,
      });
      reply.raw.off('close', abortQueuedTurn);
      if (!admission.admitted && admission.reason === 'per_account_limit') {
        throw new ApiError(
          429,
          'turn_concurrency_exceeded',
          `Too many active chat turns: limit is ${turnLimit.limit}${turnLimit.tier ? ` for ${turnLimit.tier}` : ''}`,
        );
      }
      if (!admission.admitted) {
        reply.header('retry-after', '1');
        throw new ApiError(
          503,
          admission.reason === 'queue_timeout' ? 'turn_queue_timeout' : 'turn_capacity_exceeded',
          admission.reason === 'queue_timeout'
            ? 'The agent-turn queue timed out before provider admission; retry shortly'
            : 'Agent-turn capacity is temporarily unavailable; retry shortly',
        );
      }
      reply.header('x-eden3-turn-queue-ms', String(admission.queueWaitMs));

      try {
        await runTurn(
          {
            compat: app.gatewayCompat,
            bus: app.eventsBus,
            registry: app.turnRegistry,
            historySync: app.historySync,
            ...(opts.providerEvidenceDb ? { db: opts.providerEvidenceDb } : {}),
            onError: safeRequestErrorCallback(req.log, {}, 'chat turn side-error'),
          },
          {
            session: target.session,
            agent: target.agent,
            user: account,
            content: body.content,
            attachments: explicitAttachments.persisted,
            gatewayImages: [
              ...explicitAttachments.images,
              ...contextualImages.images,
              ...legacyContextualImages.images,
            ],
            gatewayAttachmentText: explicitAttachments.supplementalText,
            beginStream: () => openSseSink(reply, target.session.id),
          },
        );
        const memoryLogContext = { accountId: target.agent.accountId };
        void enqueueAutomaticMemoryRetryForAgent(
          target.agent.accountId,
          safeRequestErrorCallback(
            req.log,
            memoryLogContext,
            'memory distillation retry failed',
            'warn',
          ),
        ).catch(safeRequestErrorCallback(
          req.log,
          memoryLogContext,
          'memory distillation retry lookup failed',
          'warn',
        ));
      } catch (err) {
        // runTurn only throws BEFORE the reply is hijacked (see its contract).
        if (err instanceof InsufficientMannaError) {
          throw new ApiError(
            402,
            'insufficient_manna',
            `Not enough manna: this turn reserves up to ${err.required} ` +
              `(unused is refunded when the turn settles), you have ${err.available}`,
          );
        }
        // The reservation's in-transaction cap check (race-free, unlike the
        // fast pre-check above) can also reject the turn.
        if (err instanceof DailyCapExceededError) {
          throw new ApiError(
            429,
            'daily_manna_cap_exceeded',
            `Daily manna cap exceeded: ${err.spentToday} spent today, cap is ${err.cap}`,
          );
        }
        throw err;
      } finally {
        admission.release();
      }

      return reply; // hijacked — the SSE sink owns the socket from here
    },
  );
};
