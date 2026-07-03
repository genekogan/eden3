import { randomUUID } from 'node:crypto';

import {
  InsufficientMannaError,
  gatewaySessionKey,
  resolveAgentByUsername,
  resolveSession,
} from '@eden3/core';
import { accounts, agents, db, sessionAgents, sessionUsers, sessions, type Session } from '@eden3/db';
import { encodeSseComment, encodeSseEvent } from '@eden3/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors';
import { runTurn, type TurnAgent, type TurnSink } from '../services/turns';
import { canAccessSession } from './sessions';

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

/** Create the session row + memberships for `new` in one transaction. */
async function createSession(
  ownerAccountId: string,
  agentUsername: string,
  content: string,
): Promise<ResolvedTarget> {
  const resolved = await resolveAgentByUsername(agentUsername);
  if (!resolved) throw new ApiError(404, 'agent_not_found', `No agent named "${agentUsername}"`);
  if (!resolved.agent.openclawId) {
    throw new ApiError(
      409,
      'agent_not_provisioned',
      `Agent "${agentUsername}" is not provisioned on the gateway yet`,
    );
  }

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
      .values({ sessionId, agentAccountId: resolved.account.id });
    await tx.insert(sessionUsers).values({ sessionId, userAccountId: ownerAccountId });
    return row;
  });

  return {
    session,
    agent: {
      accountId: resolved.account.id,
      username: resolved.account.username,
      openclawId: resolved.agent.openclawId,
    },
  };
}

/** Resolve an existing session (uuid or legacy hex), authorize, pick its agent. */
async function resolveExisting(
  ref: string,
  account: { accountId: string; isAdmin: boolean },
): Promise<ResolvedTarget> {
  const session = await resolveSession(ref);
  if (!session) throw new ApiError(404, 'not_found', 'Session not found');
  if (!(await canAccessSession(session, account))) {
    throw new ApiError(403, 'forbidden', 'You do not have access to this session');
  }

  const rows = await db
    .select({
      accountId: agents.accountId,
      openclawId: agents.openclawId,
      username: accounts.username,
    })
    .from(sessionAgents)
    .innerJoin(agents, eq(agents.accountId, sessionAgents.agentAccountId))
    .innerJoin(accounts, eq(accounts.id, agents.accountId))
    .where(eq(sessionAgents.sessionId, session.id))
    .orderBy(agents.accountId)
    .limit(8);
  const provisioned = rows.find((row) => row.openclawId !== null);
  if (!provisioned) {
    throw new ApiError(
      409,
      'agent_not_provisioned',
      'No provisioned agent is attached to this session',
    );
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
      openclawId: provisioned.openclawId!,
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
        target = await createSession(account.accountId, body.agentUsername, body.content);
      } else {
        target = await resolveExisting(req.params.idOrNew, account);
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
      } catch (err) {
        // runTurn only throws BEFORE the reply is hijacked (see its contract).
        if (err instanceof InsufficientMannaError) {
          throw new ApiError(
            402,
            'insufficient_manna',
            `Not enough manna: this turn costs ${err.required}, you have ${err.available}`,
          );
        }
        throw err;
      }

      return reply; // hijacked — the SSE sink owns the socket from here
    },
  );
};
