import { sessionShareCreateInputDto } from '@eden3/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { sendError } from '../errors';
import {
  SessionShareService,
  SessionShareServiceError,
  type SessionShareRepository,
} from '../services/session-shares';
import { applyPrivateCapabilityHeaders } from '../services/share-cache-policy';

const sessionParamsSchema = z.object({ sessionId: z.string().trim().min(1).max(200) });
const shareParamsSchema = sessionParamsSchema.extend({ shareId: z.string().uuid() });
const tokenParamsSchema = z.object({ token: z.string() });

export interface SessionShareRoutesOptions {
  repository: SessionShareRepository;
}

function sendShareError(
  reply: Parameters<typeof sendError>[0],
  error: SessionShareServiceError,
) {
  switch (error.code) {
    case 'share_forbidden':
      return sendError(reply, 403, error.code, 'Only a session owner or member can manage shares');
    case 'invalid_boundary':
      return sendError(reply, 400, error.code, 'The snapshot boundary is not in this session');
    case 'share_not_found':
      return sendError(reply, 404, error.code, 'Session or share not found');
  }
}

/** Authenticated management routes plus the unlisted public token lookup. */
export const sessionShareRoutes: FastifyPluginAsync<SessionShareRoutesOptions> = async (
  app,
  options,
) => {
  const service = new SessionShareService(options.repository);

  // This plugin contains only share management and capability routes. Set the
  // policy before auth/validation so private management data and every public
  // token denial/error are uncacheable and referrer-safe.
  app.addHook('onRequest', async (_request, reply) => {
    applyPrivateCapabilityHeaders(reply);
  });

  app.get(
    '/sessions/:sessionId/shares',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { sessionId } = sessionParamsSchema.parse(req.params);
      try {
        return await service.list(sessionId, req.account!.accountId);
      } catch (error) {
        if (error instanceof SessionShareServiceError) return sendShareError(reply, error);
        throw error;
      }
    },
  );

  app.post(
    '/sessions/:sessionId/shares',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { sessionId } = sessionParamsSchema.parse(req.params);
      const input = sessionShareCreateInputDto.parse(req.body);
      try {
        const result = await service.create(sessionId, req.account!.accountId, input);
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof SessionShareServiceError) return sendShareError(reply, error);
        throw error;
      }
    },
  );

  app.delete(
    '/sessions/:sessionId/shares/:shareId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { sessionId, shareId } = shareParamsSchema.parse(req.params);
      try {
        return { share: await service.revoke(sessionId, shareId, req.account!.accountId) };
      } catch (error) {
        if (error instanceof SessionShareServiceError) return sendShareError(reply, error);
        throw error;
      }
    },
  );

  app.get('/shares/:token', async (req, reply) => {
    const { token } = tokenParamsSchema.parse(req.params);
    const result = await service.resolvePublic(token);
    if (!result) return sendError(reply, 404, 'share_not_found', 'Share not found');
    return result;
  });
};
