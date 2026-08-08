import { encodeSseComment } from '@eden3/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { KEEPALIVE_INTERVAL_MS } from '../events-bus';
import { sendError } from '../errors';
import {
  type AppNotificationStore,
  notificationChannel,
  PostgresAppNotificationStore,
} from '../services/app-notifications';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const idParamsSchema = z.object({ id: z.string().uuid() });

export interface NotificationsRoutesOptions {
  store?: AppNotificationStore;
}

export const notificationsRoutes: FastifyPluginAsync<NotificationsRoutesOptions> = async (
  app,
  opts,
) => {
  const store = opts.store ?? new PostgresAppNotificationStore();

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
    return { ok: true };
  });

  app.post('/read-all', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!req.account) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    return { ok: true, updated: await store.markAllRead(req.account.accountId) };
  });

  app.delete('/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!req.account) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    const { id } = idParamsSchema.parse(req.params);
    if (!(await store.dismiss(req.account.accountId, id))) {
      return sendError(reply, 404, 'not_found', 'Notification not found');
    }
    return reply.code(204).send();
  });

  app.get('/events', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!req.account) return sendError(reply, 401, 'unauthorized', 'Authentication required');
    const channel = notificationChannel(req.account.accountId);

    reply.hijack();
    reply.raw.on('error', () => {});
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

    const unsubscribe = app.eventsBus.subscribe(channel, reply.raw);
    const keepalive = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(encodeSseComment('ping'));
      }
    }, KEEPALIVE_INTERVAL_MS);
    keepalive.unref();
    reply.raw.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });
};
