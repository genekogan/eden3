import { encodeSseComment } from '@eden3/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  accountEventAccessStillValid,
  KEEPALIVE_INTERVAL_MS,
  SessionEventAuthorizationLease,
} from '../events-bus';
import { sendError } from '../errors';
import {
  type AppNotificationStore,
  notificationChannel,
  publishNotificationChanged,
  PostgresAppNotificationStore,
} from '../services/app-notifications';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const idParamsSchema = z.object({ id: z.string().uuid() });

export interface NotificationsRoutesOptions {
  store?: AppNotificationStore;
  /** Test-only cadence override; production retains the fixed 15-second lease budget. */
  keepaliveIntervalMs?: number;
}

export const notificationsRoutes: FastifyPluginAsync<NotificationsRoutesOptions> = async (
  app,
  opts,
) => {
  const store = opts.store ?? new PostgresAppNotificationStore();
  const keepaliveIntervalMs = opts.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
  if (
    !Number.isSafeInteger(keepaliveIntervalMs) ||
    keepaliveIntervalMs < 10 ||
    keepaliveIntervalMs > KEEPALIVE_INTERVAL_MS
  ) {
    throw new Error('notification keepalive interval must be an integer from 10ms to 10000ms');
  }

  app.get('/', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!req.account) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    const { limit } = listQuerySchema.parse(req.query);
    return store.list(req.account.accountId, limit);
  });

  app.post('/:id/read', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!req.account) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    const { id } = idParamsSchema.parse(req.params);
    if (!(await store.markRead(req.account.accountId, id))) {
      return sendError(reply, 404, 'not_found', 'Notification not found');
    }
    publishNotificationChanged(app.eventsBus, req.account.accountId);
    return { ok: true };
  });

  app.post('/read-all', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!req.account) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    const updated = await store.markAllRead(req.account.accountId);
    publishNotificationChanged(app.eventsBus, req.account.accountId);
    return { ok: true, updated };
  });

  app.delete('/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!req.account) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    const { id } = idParamsSchema.parse(req.params);
    if (!(await store.dismiss(req.account.accountId, id))) {
      return sendError(reply, 404, 'not_found', 'Notification not found');
    }
    publishNotificationChanged(app.eventsBus, req.account.accountId);
    return reply.code(204).send();
  });

  app.get('/events', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account;
    if (!account) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    const channel = notificationChannel(account.accountId);

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
        if (writable()) reply.raw.end();
      } catch {
        // The subscriber and timers are already gone; the stream stays dead.
      }
    };
    reply.raw.on('error', terminate);
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

    unsubscribe = app.eventsBus.subscribe(channel, reply.raw);
    authorizationLease = new SessionEventAuthorizationLease(
      async () => {
        if (!writable()) return false;
        return accountEventAccessStillValid({
          expectedAccountId: account.accountId,
          getSession: () => app.authProvider.getSession(req),
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
  });
};
