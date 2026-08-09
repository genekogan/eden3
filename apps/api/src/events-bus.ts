import { resolveSession, type AuthSession } from '@eden3/core';
import { encodeSseComment, encodeSseEvent, type SessionEvent } from '@eden3/shared';
import type { FastifyPluginAsync } from 'fastify';

import { sendError } from './errors';
import { canAccessSession } from './routes/sessions';

/**
 * Per-session SSE broadcast bus.
 *
 * Chat/media/manna workers publish {@link SessionEvent}s keyed by session id;
 * every browser tab subscribed to `GET /sessions/:id/events` receives each
 * event as one SSE frame (encoded once per publish via @eden3/shared).
 */

/** Structural sink: anything with a string `write` — in practice `reply.raw`. */
export interface SseSink {
  write(chunk: string): unknown;
}

export class EventsBus {
  private readonly channels = new Map<string, Set<SseSink>>();

  /** Add `sink` to the session's channel; returns an unsubscribe function. */
  subscribe(sessionId: string, sink: SseSink): () => void {
    let sinks = this.channels.get(sessionId);
    if (!sinks) {
      sinks = new Set();
      this.channels.set(sessionId, sinks);
    }
    sinks.add(sink);
    return () => this.unsubscribe(sessionId, sink);
  }

  unsubscribe(sessionId: string, sink: SseSink): void {
    const sinks = this.channels.get(sessionId);
    if (!sinks) return;
    sinks.delete(sink);
    if (sinks.size === 0) this.channels.delete(sessionId);
  }

  /**
   * Broadcast `event` to every subscriber of `sessionId`. The event is
   * validated + encoded once (throws ZodError on a malformed event). Sinks
   * whose write throws are dropped. Returns the number of sinks written.
   */
  publish(sessionId: string, event: SessionEvent): number {
    const sinks = this.channels.get(sessionId);
    if (!sinks || sinks.size === 0) return 0;
    const frame = encodeSseEvent(event);
    let delivered = 0;
    for (const sink of sinks) {
      try {
        sink.write(frame);
        delivered += 1;
      } catch {
        sinks.delete(sink); // dead connection — drop it
      }
    }
    if (sinks.size === 0) this.channels.delete(sessionId);
    return delivered;
  }

  subscriberCount(sessionId: string): number {
    return this.channels.get(sessionId)?.size ?? 0;
  }

  channelCount(): number {
    return this.channels.size;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    eventsBus: EventsBus;
  }
}

export const SESSION_EVENT_AUTHORIZATION_LEASE_MS = 15_000;
export const KEEPALIVE_INTERVAL_MS = 10_000;
export const AUTHORIZATION_CHECK_TIMEOUT_MS =
  SESSION_EVENT_AUTHORIZATION_LEASE_MS - KEEPALIVE_INTERVAL_MS;

interface SessionEventAccessCheck<TSession extends { id: string }> {
  expectedAccountId: string;
  expectedSessionId: string;
  getSession(): Promise<AuthSession | null>;
  resolveSession(): Promise<TSession | null>;
  canAccess(session: TSession, account: AuthSession): Promise<boolean>;
}

/** Revalidate every authority that admitted one long-lived event stream. */
export async function sessionEventAccessStillValid<TSession extends { id: string }>(
  check: SessionEventAccessCheck<TSession>,
): Promise<boolean> {
  const account = await check.getSession();
  if (!account || account.accountId !== check.expectedAccountId) return false;
  const session = await check.resolveSession();
  if (!session || session.id !== check.expectedSessionId) return false;
  return check.canAccess(session, account);
}

/** Single-flight authorization lease for a long-lived session event stream. */
export class SessionEventAuthorizationLease {
  private active = true;
  private checking = false;
  private deadline: NodeJS.Timeout | null = null;
  private resolveDeadline: (() => void) | null = null;

  constructor(
    private readonly check: () => Promise<boolean>,
    private readonly onAuthorized: () => void,
    private readonly onDenied: () => void,
    private readonly checkTimeoutMs = AUTHORIZATION_CHECK_TIMEOUT_MS,
  ) {
    if (
      !Number.isSafeInteger(checkTimeoutMs) ||
      checkTimeoutMs < 1 ||
      checkTimeoutMs > AUTHORIZATION_CHECK_TIMEOUT_MS
    ) {
      throw new Error('session event authorization timeout must be from 1ms to 5000ms');
    }
  }

  async reauthorize(): Promise<void> {
    if (!this.active || this.checking) return;
    this.checking = true;
    try {
      // Attach the rejection handler before racing so a late verifier failure
      // after the deadline is inert instead of becoming an unhandled rejection.
      const guardedCheck = Promise.resolve().then(this.check).catch(() => false);
      const deadline = new Promise<boolean>((resolve) => {
        this.resolveDeadline = () => resolve(false);
        this.deadline = setTimeout(() => this.expireDeadline(), this.checkTimeoutMs);
        this.deadline.unref();
      });
      if (!(await Promise.race([guardedCheck, deadline]))) {
        this.deny();
        return;
      }
      if (this.active) this.onAuthorized();
    } catch {
      this.deny();
    } finally {
      this.clearDeadline();
      this.checking = false;
    }
  }

  stop(): void {
    this.active = false;
    this.expireDeadline();
  }

  private deny(): void {
    if (!this.active) return;
    this.active = false;
    try {
      this.onDenied();
    } catch {
      // Denial is already durable in this lease; never revive a failed stream.
    }
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
    this.resolveDeadline = null;
  }

  private expireDeadline(): void {
    const resolve = this.resolveDeadline;
    this.clearDeadline();
    resolve?.();
  }
}

export interface SessionEventsRoutesOptions {
  /** Test-only cadence override; production retains the fixed 15-second lease budget. */
  keepaliveIntervalMs?: number;
}

/**
 * `GET /sessions/:id/events` — the per-session SSE channel.
 *
 * AUTHORIZATION FIRST: this stream carries the session's token deltas, media
 * URLs, and `manna.updated{balance}`, so — exactly like `GET /sessions/:id`
 * (routes/sessions.ts) — the caller must be signed in AND able to access the
 * session (owner, member, or admin) before we hijack the socket. `:id` is
 * permalink-aware (uuid or legacy 24-hex); anonymous → 401, no-access → 403,
 * unknown → 404. All of that happens BEFORE `reply.hijack()` so the failures
 * come back as normal JSON error envelopes rather than a raw-socket stream.
 *
 * Once authorized the reply is hijacked (we own the raw socket); headers
 * staged by earlier hooks (CORS) are merged into the raw writeHead so
 * EventSource works cross-origin from the web app. A reauthorized comment ping
 * starts every 10s and must finish within 5s, bounding the authority lease to
 * 15s while also keeping proxies and idle sockets alive.
 */
export const sessionEventsRoutes: FastifyPluginAsync<SessionEventsRoutesOptions> = async (
  app,
  options,
) => {
  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
  if (
    !Number.isSafeInteger(keepaliveIntervalMs) ||
    keepaliveIntervalMs < 10 ||
    keepaliveIntervalMs > KEEPALIVE_INTERVAL_MS
  ) {
    throw new Error('session event keepalive interval must be an integer from 10ms to 10000ms');
  }
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/events',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const bus = app.eventsBus;

      // Resolve + authorize BEFORE hijacking (mirrors GET /sessions/:id).
      const account = req.account;
      if (!account) return sendError(reply, 401, 'unauthorized', 'Authentication required');
      const session = await resolveSession(req.params.id);
      if (!session) return sendError(reply, 404, 'not_found', 'Session not found');
      if (!(await canAccessSession(session, account))) {
        return sendError(reply, 403, 'forbidden', 'You do not have access to this session');
      }
      // Subscribe by the canonical session uuid — publishers key on it, and a
      // legacy-hex `:id` would otherwise never receive a frame.
      const sessionId = session.id;

      reply.hijack();
      const writable = (): boolean => !reply.raw.destroyed && !reply.raw.writableEnded;

      let closed = false;
      let keepalive: NodeJS.Timeout | null = null;
      let unsubscribe = () => {};
      let authorizationLease: SessionEventAuthorizationLease | null = null;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        unsubscribe();
      };
      const terminate = () => {
        authorizationLease?.stop();
        cleanup();
        try {
          if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
        } catch {
          // The subscriber and timers are already gone; the stream stays dead.
        }
      };
      // Async response failures take the same one-shot terminal path as auth
      // denial instead of leaving a detached interval or subscriber behind.
      reply.raw.on('error', terminate);

      // Preserve headers already staged on the Fastify reply (e.g. by
      // @fastify/cors) — raw writeHead bypasses them otherwise.
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
      });
      reply.raw.write(encodeSseComment('connected'));

      unsubscribe = bus.subscribe(sessionId, reply.raw);
      authorizationLease = new SessionEventAuthorizationLease(
        async () => {
          if (!writable()) return false;
          return sessionEventAccessStillValid({
            expectedAccountId: account.accountId,
            expectedSessionId: sessionId,
            getSession: () => app.authProvider.getSession(req),
            resolveSession: () => resolveSession(sessionId),
            canAccess: canAccessSession,
          });
        },
        () => {
          if (!writable()) {
            terminate();
            return;
          }
          reply.raw.write(encodeSseComment('ping'));
        },
        terminate,
      );
      keepalive = setInterval(() => {
        void authorizationLease.reauthorize();
      }, keepaliveIntervalMs);
      keepalive.unref();

      reply.raw.on('close', () => {
        authorizationLease?.stop();
        cleanup();
      });
    },
  );
};
