import { resolveSession } from '@eden3/core';
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

export const KEEPALIVE_INTERVAL_MS = 15_000;

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
 * EventSource works cross-origin from the web app. A comment ping goes out
 * every 15s to keep proxies and idle sockets alive.
 */
export const sessionEventsRoutes: FastifyPluginAsync = async (app) => {
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
      // A client that disconnects mid-stream destroys the socket; subsequent
      // keepalive writes emit async 'error' events on reply.raw — swallow them
      // so an abrupt disconnect can't take the process down (mirrors chat.ts).
      reply.raw.on('error', () => {});
      const writable = (): boolean => !reply.raw.destroyed && !reply.raw.writableEnded;

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

      const unsubscribe = bus.subscribe(sessionId, reply.raw);
      const keepalive = setInterval(() => {
        if (writable()) reply.raw.write(encodeSseComment('ping'));
      }, KEEPALIVE_INTERVAL_MS);
      keepalive.unref();

      reply.raw.on('close', () => {
        clearInterval(keepalive);
        unsubscribe();
      });
    },
  );
};
