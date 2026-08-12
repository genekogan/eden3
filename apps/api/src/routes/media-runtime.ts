import { getEnv, type DbHandle } from '@eden3/core';
import type { SessionEvent } from '@eden3/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { serviceAuthenticatedCallback } from '../auth-plugin';
import { ApiError, logSafeRequestWarning } from '../errors';
import { isValidChannelRuntimeAuthorization } from '../services/channel-runtime-auth';
import {
  canonicalChatMediaProviderArgs,
  chatMediaAuthorizationEventContext,
  compensateChatMedia,
  isChatMediaTool,
  reserveChatMedia,
  verifyPendingStudioMedia,
} from '../services/chat-media-authorization';

const hostId = z.string().trim().min(1).max(200);
const authorizeSchema = z
  .object({
    runId: hostId.optional(),
    toolCallId: hostId.optional(),
    sessionKey: z.string().trim().min(1).max(1_000),
    agentId: z.string().trim().min(1).max(200),
    tool: z.string().trim().min(1).max(100),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
const paramsSchema = z.object({ authorizationId: z.string().uuid() });
const failureSchema = z
  .object({
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).default('media_tool_failed'),
  })
  .strict();

/** Stable, non-sensitive diagnostics for failures at the runtime media boundary. */
export function mediaAuthorizationFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('invalid runId')) return 'invalid_run_id';
  if (message.includes('invalid toolCallId')) return 'invalid_tool_call_id';
  if (message.includes('invalid sessionKey')) return 'invalid_session_key';
  if (message.includes('invalid agentId')) return 'invalid_agent_id';
  if (message.includes('session/agent binding unavailable')) return 'session_agent_binding';
  if (message.includes('media action already pending')) return 'media_already_pending';
  if (message.includes('provider admission ticket already consumed')) return 'ticket_consumed';
  if (message.includes('durable authorization refused')) return 'durable_authorization';
  if (message.includes('unsupported image_generate argument')) return 'unsupported_image_argument';
  if (message.includes('unsupported tool')) return 'unsupported_tool';
  if (message.includes('unsupported image aspect ratio')) return 'unsupported_image_aspect_ratio';
  if (message.includes('unsupported image size')) return 'unsupported_image_size';
  if (message.includes('ambiguous image geometry')) return 'ambiguous_image_geometry';
  if (message.includes('unsupported image output format')) return 'unsupported_image_output_format';
  if (message.includes('image count must be one')) return 'invalid_image_count';
  if (message.includes('unsupported image model')) return 'unsupported_image_model';
  if (message.includes('unsupported image route')) return 'unsupported_image_route';
  if (message.includes('invalid tts text')) return 'invalid_tts_text';
  if (message.includes('in-chat tts is deferred')) return 'tts_deferred';
  const name = error instanceof Error ? error.name : '';
  if (name === 'InsufficientMannaError') return 'insufficient_manna';
  if (name === 'DailyCapExceededError') return 'daily_cap';
  if (name === 'RollingSpendCapExceededError') return 'rolling_cap';
  return 'unknown';
}

export interface MediaRuntimeRoutesOptions {
  providerEvidenceDb?: DbHandle;
}

type MediaEventBus = {
  publish(sessionId: string, event: SessionEvent): number;
};

export function publishChatMediaPending(
  bus: MediaEventBus,
  authorization: { sessionId: string; tool: string },
): boolean {
  try {
    bus.publish(authorization.sessionId, {
      type: 'media.pending',
      sessionId: authorization.sessionId,
      tool: authorization.tool,
    });
    return true;
  } catch {
    return false;
  }
}

export function publishChatMediaFailed(
  bus: MediaEventBus,
  context: { sessionId: string; tool: string },
  code: string,
): boolean {
  try {
    bus.publish(context.sessionId, {
      type: 'media.failed',
      sessionId: context.sessionId,
      tool: context.tool,
      code,
      message: 'Media generation failed before producing output.',
    });
    return true;
  } catch {
    return false;
  }
}

export const mediaRuntimeRoutes: FastifyPluginAsync<MediaRuntimeRoutesOptions> = async (app, opts) => {
  const expectedToken = getEnv().OPENCLAW_GATEWAY_TOKEN;
  const requireRuntime = async (req: { headers: { authorization?: string | string[] } }) => {
    if (!isValidChannelRuntimeAuthorization(req.headers.authorization, expectedToken)) {
      throw new ApiError(401, 'runtime_unauthorized', 'Runtime authorization required');
    }
  };

  app.post(
    '/runtime/authorizations',
    {
      ...serviceAuthenticatedCallback(requireRuntime),
    },
    async (req) => {
      const body = authorizeSchema.parse(req.body);
      if (!isChatMediaTool(body.tool)) {
        throw new ApiError(400, 'unsupported_media_tool', 'Media tool is not authorized');
      }
      try {
        const request = { ...body, tool: body.tool };
        const providerArgs = canonicalChatMediaProviderArgs(body.tool, body.args);
        const studio = await verifyPendingStudioMedia({
          request,
          ...(opts.providerEvidenceDb ? { db: opts.providerEvidenceDb } : {}),
        });
        if (studio) {
          return {
            ok: true,
            authorizationOwner: 'studio' as const,
            authorizationId: studio.authorizationId,
            authorizedMaxManna: studio.quote.manna,
            tool: studio.tool,
            action: studio.action,
            provider: studio.quote.provider,
            model: studio.quote.model,
            tableVersion: studio.quote.tableVersion,
            providerArgs,
          };
        }
        const authorization = await reserveChatMedia({
          request,
          dailyCap: getEnv().DAILY_MANNA_SPEND_CAP_PER_USER,
          ...(opts.providerEvidenceDb ? { db: opts.providerEvidenceDb } : {}),
        });
        if (!publishChatMediaPending(app.eventsBus, authorization)) {
          req.log.warn(
            { sessionId: authorization.sessionId },
            'chat media pending UI event could not be published',
          );
        }
        return {
          ok: true,
          authorizationOwner: 'chat' as const,
          authorizationId: authorization.authorizationId,
          authorizedMaxManna: authorization.quote.manna,
          tool: authorization.tool,
          action: authorization.action,
          provider: authorization.quote.provider,
          model: authorization.quote.model,
          tableVersion: authorization.quote.tableVersion,
          providerArgs,
        };
      } catch (err) {
        logSafeRequestWarning(
          req.log,
          err,
          { failureCode: mediaAuthorizationFailureCode(err) },
          'chat media authorization denied',
        );
        throw new ApiError(409, 'media_authorization_denied', 'Media generation is unavailable');
      }
    },
  );

  app.post<{ Params: { authorizationId: string } }>(
    '/runtime/authorizations/:authorizationId/fail',
    {
      ...serviceAuthenticatedCallback(requireRuntime),
    },
    async (req) => {
      const { authorizationId } = paramsSchema.parse(req.params);
      const body = failureSchema.parse(req.body ?? {});
      let context: Awaited<ReturnType<typeof chatMediaAuthorizationEventContext>> = null;
      try {
        context = await chatMediaAuthorizationEventContext({
          authorizationId,
          ...(opts.providerEvidenceDb ? { db: opts.providerEvidenceDb } : {}),
        });
      } catch (err) {
        logSafeRequestWarning(
          req.log,
          err,
          { authorizationId },
          'chat media failure context lookup failed',
        );
      }
      const outcome = await compensateChatMedia({
        authorizationId,
        errorCode: body.errorCode,
        errorMessage: 'Media tool failed before producing an attributable artifact',
        ...(opts.providerEvidenceDb ? { db: opts.providerEvidenceDb } : {}),
      });
      if (context && outcome !== 'terminal') {
        if (!publishChatMediaFailed(app.eventsBus, context, body.errorCode)) {
          req.log.warn(
            { sessionId: context.sessionId },
            'chat media failure UI event could not be published',
          );
        }
      }
      if (outcome === 'refund_pending') {
        throw new ApiError(503, 'media_refund_pending', 'Media refund is pending');
      }
      return { ok: true, outcome };
    },
  );
};
