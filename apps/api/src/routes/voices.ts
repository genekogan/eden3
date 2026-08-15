import { getEnv } from '@eden3/core';
import { voiceAssignmentModeSchema, voiceIdSchema } from '@eden3/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { serviceAuthenticatedCallback } from '../auth-plugin';
import { ApiError, sendError } from '../errors';
import { isValidChannelRuntimeAuthorization } from '../services/channel-runtime-auth';
import { VoiceKernel, VoiceKernelError } from '../services/voice-kernel';

export interface VoiceRoutesOptions {
  kernel: VoiceKernel;
  runtimeToken?: string;
  autoStartReconciler?: boolean;
}

const quoteSchema = z.object({
  operation: z.enum(['preview', 'chat', 'discord', 'telegram']),
  voiceId: voiceIdSchema,
  text: z.string().min(1).max(4_000),
}).strict();

const previewSchema = z.object({
  quoteId: z.string().uuid(),
  text: z.string().min(1).max(500),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

const assignmentSchema = z.object({
  voiceId: voiceIdSchema,
  chatMode: voiceAssignmentModeSchema.default('on_demand'),
  discordMode: voiceAssignmentModeSchema.default('off'),
  telegramMode: voiceAssignmentModeSchema.default('off'),
}).strict();

const cloneSchema = z.object({
  name: z.string().trim().min(1).max(120),
  storageObjectId: z.string().uuid(),
  consentVersion: z.literal('eden-voice-consent-v1'),
  consentAttested: z.literal(true),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

const idempotencySchema = z.object({ idempotencyKey: z.string().min(8).max(200) }).strict();
const usernameParams = z.object({ username: z.string().trim().min(1).max(200) });
const cloneParams = z.object({ id: z.string().uuid() });
const messageParams = z.object({ sessionId: z.string().uuid(), messageId: z.string().uuid() });
const turnParams = z.object({ turnId: z.string().uuid() });
const channelBody = z.object({
  voiceOperationId: z.string().uuid(),
  connectionId: z.string().uuid(),
  bindingId: z.string().uuid().optional(),
  text: z.string().min(1).max(2_000),
}).strict();

async function boundary<T>(task: () => Promise<T>): Promise<T> {
  try { return await task(); }
  catch (error) {
    if (error instanceof VoiceKernelError) throw new ApiError(error.statusCode, error.code, error.message);
    throw error;
  }
}

export const voiceRoutes: FastifyPluginAsync<VoiceRoutesOptions> = async (app, options) => {
  const kernel = options.kernel;
  const expectedRuntimeToken = options.runtimeToken ?? getEnv().OPENCLAW_GATEWAY_TOKEN;
  const requireRuntime = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isValidChannelRuntimeAuthorization(request.headers.authorization, expectedRuntimeToken)) {
      return sendError(reply, 401, 'runtime_unauthorized', 'Runtime authorization required');
    }
  };

  app.get('/voices/catalog', async () => kernel.catalog());

  app.post('/voices/quotes', { preHandler: app.requireAuth }, async (request) => {
    const body = quoteSchema.parse(request.body);
    return await boundary(() => kernel.quote(request.account!.accountId, body.operation, body.voiceId, body.text));
  });

  app.post('/voices/previews', { preHandler: app.requireAuth }, async (request) => {
    const body = previewSchema.parse(request.body);
    return await boundary(() => kernel.synthesize({
      ownerAccountId: request.account!.accountId,
      operation: 'preview',
      quoteId: body.quoteId,
      text: body.text,
      idempotencyKey: body.idempotencyKey,
    }));
  });

  app.put('/agents/:username/voice-assignment', { preHandler: app.requireAuth }, async (request) => {
    const { username } = usernameParams.parse(request.params);
    const body = assignmentSchema.parse(request.body);
    return await boundary(() => kernel.assignment(request.account!.accountId, username, body));
  });

  app.delete('/agents/:username/voice-assignment', { preHandler: app.requireAuth }, async (request, reply) => {
    const { username } = usernameParams.parse(request.params);
    await boundary(() => kernel.deleteAssignment(request.account!.accountId, username));
    return reply.code(204).send();
  });

  app.post('/sessions/:sessionId/messages/:messageId/voice-note', { preHandler: app.requireAuth }, async (request) => {
    const params = messageParams.parse(request.params);
    const body = idempotencySchema.parse(request.body);
    const execution = await boundary(() => kernel.directVoiceNote(request.account!.accountId, params.sessionId, params.messageId, body.idempotencyKey));
    app.eventsBus.publish(params.sessionId, { type: 'session.messages.changed', sessionId: params.sessionId, messageId: params.messageId });
    return execution;
  });

  app.post('/voices/clones/quote', { preHandler: app.requireAuth }, async (request) => {
    const body = z.object({ storageObjectId: z.string().uuid() }).strict().parse(request.body);
    return await boundary(() => kernel.cloneQuote(request.account!.accountId, body.storageObjectId));
  });

  app.post('/voices/clones', { preHandler: app.requireAuth }, async (request, reply) => {
    const body = cloneSchema.parse(request.body);
    const clone = await boundary(() => kernel.createClone({ ownerAccountId: request.account!.accountId, ...body }));
    return reply.code(clone.status === 'ready' ? 201 : 202).send(clone);
  });

  app.get('/voices/clones', { preHandler: app.requireAuth }, async (request) => ({ items: await kernel.listClones(request.account!.accountId) }));
  app.get('/voices/clones/:id', { preHandler: app.requireAuth }, async (request) => {
    const { id } = cloneParams.parse(request.params);
    return await boundary(() => kernel.getClone(request.account!.accountId, id));
  });
  app.post('/voices/clones/:id/revoke', { preHandler: app.requireAuth }, async (request, reply) => {
    const { id } = cloneParams.parse(request.params);
    return reply.code(202).send(await boundary(() => kernel.revokeClone(request.account!.accountId, id)));
  });
  app.delete('/voices/clones/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const { id } = cloneParams.parse(request.params);
    return reply.code(202).send(await boundary(() => kernel.deleteClone(request.account!.accountId, id)));
  });

  app.post('/channels/runtime/turns/:turnId/voice-note', serviceAuthenticatedCallback(requireRuntime), async (request) => {
    const { turnId } = turnParams.parse(request.params);
    const body = channelBody.parse(request.body);
    const execution = await boundary(() => kernel.channelVoiceNote({
      turnId,
      text: body.text,
      idempotencyKey: `channel:${body.voiceOperationId}`,
      connectionId: body.connectionId,
      ...(body.bindingId ? { bindingId: body.bindingId } : {}),
    }));
    return {
      ok: true,
      voiceOperationId: body.voiceOperationId,
      execution,
      attachment: {
        url: execution.url,
        mime: execution.mime,
        durationSecs: execution.durationMs === null ? null : execution.durationMs / 1000,
        waveform: execution.waveform,
      },
      native: execution.purpose === 'discord'
        ? { channel: 'discord', flags: 1 << 13, content: null, attachmentCount: 1, enforceNonce: true }
        : { channel: 'telegram', method: 'sendVoice', multipart: true },
    };
  });
};
