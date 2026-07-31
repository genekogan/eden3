import { randomUUID } from 'node:crypto';

import {
  DailyCapExceededError,
  getEnv,
  InsufficientMannaError,
  gatewaySessionKey,
  PRICING,
  resolveAgentByUsername,
  resolveSession,
} from '@eden3/core';
import { accounts, agents, db, sessionAgents, sessionUsers, sessions, type Session } from '@eden3/db';
import {
  DEFAULT_AGENT_THINKING_LEVEL,
  DEFAULT_AGENT_TOOL_GROUPS,
  encodeSseComment,
  encodeSseEvent,
} from '@eden3/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors';
import { DEFAULT_AGENT_MODEL, type GatewayGlue } from '../gateway-glue';
import { concurrentTurnLimit, dailyMannaSpend } from '../services/chat-limits';
import { installDefaultAgentSkills } from '../services/agent-skills';
import { projectAgentConcepts } from '../services/concepts';
import { runTurn, type TurnAgent, type TurnSink } from '../services/turns';
import { canAccessSession } from './sessions';
import { enqueueLazyMemoryDistillation } from '../services/memory-distillation';

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
  content: z
    .string()
    .min(1)
    .max(20_000)
    .refine((value) => value.trim().length > 0, 'content must not be blank'),
  /** Required for `new`, ignored otherwise. */
  agentUsername: z.string().trim().min(1).optional(),
});

const NEW_SESSION_TITLE_CHARS = 80;

/** Derive a session title from the first message. */
export function titleFromContent(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > NEW_SESSION_TITLE_CHARS
    ? `${collapsed.slice(0, NEW_SESSION_TITLE_CHARS - 1)}…`
    : collapsed;
}

interface ResolvedTarget {
  session: Session;
  agent: TurnAgent;
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

/** Create the session row + memberships for `new` in one transaction. */
async function ensureChattableAgent(
  resolved: NonNullable<Awaited<ReturnType<typeof resolveAgentByUsername>>>,
  gatewayGlue: GatewayGlue,
): Promise<TurnAgent> {
  const { account, agent } = resolved;
  if (agent.openclawId && agent.provisionStatus === 'ready') {
    return {
      accountId: account.id,
      username: account.username,
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

async function createSession(
  ownerAccountId: string,
  agentUsername: string,
  content: string,
  gatewayGlue: GatewayGlue,
): Promise<ResolvedTarget> {
  const resolved = await resolveAgentByUsername(agentUsername);
  if (!resolved) throw new ApiError(404, 'agent_not_found', `No agent named "${agentUsername}"`);
  const chattable = await ensureChattableAgent(resolved, gatewayGlue);
  const sessionId = randomUUID();
  const key = gatewaySessionKey(sessionId);
  const session = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sessions)
      .values({
        id: sessionId,
        ownerId: ownerAccountId,
        title: titleFromContent(content),
        sessionType: 'chat',
        gatewaySessionKey: key,
      })
      .returning();
    if (!row) throw new Error('session insert returned no row');
    await tx
      .insert(sessionAgents)
      .values({ sessionId, agentAccountId: chattable.accountId });
    await tx.insert(sessionUsers).values({ sessionId, userAccountId: ownerAccountId });
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
  let provisioned = rows.find((row) => row.openclawId !== null);
  if (!provisioned && rows[0]) {
    const resolved = await resolveAgentByUsername(rows[0].username);
    if (!resolved) throw new ApiError(404, 'agent_not_found', `No agent named "${rows[0].username}"`);
    const chattable = await ensureChattableAgent(resolved, gatewayGlue);
    provisioned = {
      accountId: chattable.accountId,
      username: chattable.username,
      openclawId: chattable.openclawId,
      model: chattable.model ?? DEFAULT_AGENT_MODEL,
      thinkingLevel: chattable.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL,
    };
  }
  if (!provisioned) throw new ApiError(409, 'agent_not_provisioned', 'No agent is attached to this session');

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

export const chatRoutes: FastifyPluginAsync = async (app) => {
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

      let target: ResolvedTarget;
      if (req.params.idOrNew === 'new') {
        if (!body.agentUsername) {
          throw new ApiError(400, 'agent_required', 'agentUsername is required to start a new session');
        }
        target = await createSession(account.accountId, body.agentUsername, body.content, app.gatewayGlue);
      } else {
        target = await resolveExisting(req.params.idOrNew, account, app.gatewayGlue);
      }

      const env = getEnv();
      const spentToday = await dailyMannaSpend(account.accountId);
      if (spentToday + PRICING.chatTurn > env.DAILY_MANNA_SPEND_CAP_PER_USER) {
        throw new ApiError(
          429,
          'daily_manna_cap_exceeded',
          `Daily manna cap exceeded: ${spentToday} spent today, cap is ${env.DAILY_MANNA_SPEND_CAP_PER_USER}`,
        );
      }

      const turnLimit = await concurrentTurnLimit(account.accountId);
      const releaseTurn = app.turnLimiter.acquire(account.accountId, turnLimit.limit);
      if (!releaseTurn) {
        throw new ApiError(
          429,
          'turn_concurrency_exceeded',
          `Too many active chat turns: limit is ${turnLimit.limit}${turnLimit.tier ? ` for ${turnLimit.tier}` : ''}`,
        );
      }

      try {
        await runTurn(
          {
            compat: app.gatewayCompat,
            bus: app.eventsBus,
            registry: app.turnRegistry,
            historySync: app.historySync,
            onError: (err, context) => req.log.error({ err, context }, 'chat turn side-error'),
          },
          {
            session: target.session,
            agent: target.agent,
            user: account,
            content: body.content,
            beginStream: () => openSseSink(reply, target.session.id),
          },
        );
        void enqueueAutomaticMemoryRetryForAgent(target.agent.accountId, (err) =>
          req.log.warn({ err }, `memory distillation retry failed for "${target.agent.username}"`),
        ).catch((err) =>
          req.log.warn({ err }, `memory distillation retry lookup failed for "${target.agent.username}"`),
        );
      } catch (err) {
        // runTurn only throws BEFORE the reply is hijacked (see its contract).
        if (err instanceof InsufficientMannaError) {
          throw new ApiError(
            402,
            'insufficient_manna',
            `Not enough manna: this turn costs ${err.required}, you have ${err.available}`,
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
        releaseTurn();
      }

      return reply; // hijacked — the SSE sink owns the socket from here
    },
  );
};
