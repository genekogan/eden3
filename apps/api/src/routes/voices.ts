import { createHmac, timingSafeEqual } from 'node:crypto';

import { getEnv } from '@eden3/core';
import { voiceAssignmentModeSchema, voiceIdSchema } from '@eden3/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { serviceAuthenticatedCallback } from '../auth-plugin';
import { ApiError, sendError } from '../errors';
import { isValidChannelRuntimeAuthorization } from '../services/channel-runtime-auth';
import { hashSessionShareToken } from '../services/session-shares';
import { VoiceKernel, VoiceKernelError, type VoiceOutputBytes } from '../services/voice-kernel';
import { applyPrivateCapabilityHeaders } from '../services/share-cache-policy';

export interface VoiceRoutesOptions {
  kernel: VoiceKernel;
  runtimeToken?: string;
  autoStartReconciler?: boolean;
}

const quoteSchema = z.object({
  purpose: z.enum(['preview', 'chat', 'discord', 'telegram']),
  voiceId: voiceIdSchema,
  text: z.string().min(1).max(4_000),
}).strict();

const previewSchema = z.object({
  voiceId: voiceIdSchema,
  text: z.string().min(1).max(500),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

const assignmentSchema = z.object({
  voiceId: voiceIdSchema,
  delivery: z.object({
    chat: voiceAssignmentModeSchema.default('on_demand'),
    discord: z.enum(['off', 'always']).default('off'),
    telegram: z.enum(['off', 'always']).default('off'),
  }).strict(),
}).strict();

const cloneSchema = z.object({
  name: z.string().trim().min(1).max(120),
  clipObjectIds: z.array(z.string().uuid()).min(1).max(5),
  consent: z.object({
    version: z.literal('voice-clone-consent-v1'),
    attested: z.literal(true),
  }).strict(),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

const idempotencySchema = z.object({ idempotencyKey: z.string().min(8).max(200) }).strict();
const usernameParams = z.object({ username: z.string().trim().min(1).max(200) });
const cloneParams = z.object({ id: z.string().uuid() });
const messageParams = z.object({ sessionId: z.string().uuid(), messageId: z.string().uuid() });
const turnParams = z.object({ turnId: z.string().uuid() });
const executionParams = z.object({ executionId: z.string().uuid() });
const sharedExecutionParams = executionParams.extend({
  token: z.string().regex(/^[A-Za-z0-9_-]{32,200}$/),
});
const runtimeAudioParams = z.object({
  turnId: z.string().uuid(),
  executionId: z.string().uuid(),
  operationId: z.string().uuid(),
  expires: z.string().regex(/^\d{10}$/),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});
const channelBody = z.object({
  voiceOperationId: z.string().uuid(),
  connectionId: z.string().uuid(),
  runtimeAccountId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(200),
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

const VOICE_CAPABILITY_TTL_SECONDS = 5 * 60;
function capabilityPayload(input: { turnId: string; executionId: string; operationId: string; expires: string }): string {
  return ['eden3-channel-voice-v1', input.turnId, input.executionId, input.operationId, input.expires].join('\n');
}
function capabilitySignature(secret: string, input: { turnId: string; executionId: string; operationId: string; expires: string }): string {
  if (secret.length < 16 || secret.length > 8_192) throw new Error('channel voice capability key unavailable');
  return createHmac('sha256', secret).update(capabilityPayload(input)).digest('hex');
}
function channelVoiceCapabilityPathAtExpiry(
  secret: string,
  input: { turnId: string; executionId: string; operationId: string; expires: string },
): string {
  const signature = capabilitySignature(secret, input);
  return `/media/runtime/voice/${input.turnId}/${input.executionId}/${input.operationId}/${input.expires}/${signature}.ogg`;
}
function channelVoiceCapabilityPath(secret: string, turnId: string, executionId: string, operationId: string, now = Date.now()): string {
  const expires = String(Math.floor(now / 1000) + VOICE_CAPABILITY_TTL_SECONDS);
  return channelVoiceCapabilityPathAtExpiry(secret, { turnId, executionId, operationId, expires });
}
function validCapability(secret: string, input: z.infer<typeof runtimeAudioParams>, now = Date.now()): boolean {
  if (secret.length < 16 || secret.length > 8_192) return false;
  const expires = Number(input.expires);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(expires) || expires < nowSeconds || expires > nowSeconds + VOICE_CAPABILITY_TTL_SECONDS) return false;
  const expected = Buffer.from(capabilitySignature(secret, input), 'hex');
  const received = Buffer.from(input.signature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

interface ByteRange { start: number; end: number }
function parseVoiceRange(value: string | undefined, size: number): ByteRange | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size === 0) throw new ApiError(416, 'invalid_range', 'Requested range is not satisfiable');
  const [, startText, endText] = match;
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ApiError(416, 'invalid_range', 'Requested range is not satisfiable');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new ApiError(416, 'invalid_range', 'Requested range is not satisfiable');
    end = Math.min(end, size - 1);
  }
  if (start < 0 || start >= size || end < start) throw new ApiError(416, 'invalid_range', 'Requested range is not satisfiable');
  return { start, end };
}

function sendVoiceBytes(request: FastifyRequest, reply: FastifyReply, output: VoiceOutputBytes, allowRange: boolean) {
  reply.header('content-type', output.mime);
  reply.header('etag', `"${output.sha256}"`);
  reply.header('cache-control', 'private, no-store');
  reply.header('cdn-cache-control', 'no-store');
  reply.header('cross-origin-resource-policy', 'same-origin');
  reply.header('referrer-policy', 'no-referrer');
  const rawRange = allowRange ? request.headers.range : undefined;
  const range = parseVoiceRange(Array.isArray(rawRange) ? rawRange[0] : rawRange, output.sizeBytes);
  if (allowRange) reply.header('accept-ranges', 'bytes');
  if (range) {
    reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${output.sizeBytes}`);
    reply.header('content-length', String(range.end - range.start + 1));
  } else {
    reply.header('content-length', String(output.sizeBytes));
  }
  if (request.method === 'HEAD') return reply.send();
  return reply.send(range ? output.bytes.subarray(range.start, range.end + 1) : output.bytes);
}

export const voiceRoutes: FastifyPluginAsync<VoiceRoutesOptions> = async (app, options) => {
  const kernel = options.kernel;
  const expectedRuntimeToken = options.runtimeToken ?? getEnv().OPENCLAW_GATEWAY_TOKEN ?? '';
  const requireRuntime = async (request: FastifyRequest, reply: FastifyReply) => {
    if (expectedRuntimeToken.length < 16 || expectedRuntimeToken.length > 8_192 ||
        !isValidChannelRuntimeAuthorization(request.headers.authorization, expectedRuntimeToken)) {
      return sendError(reply, 401, 'runtime_unauthorized', 'Runtime authorization required');
    }
  };

  app.get('/voices/catalog', { preHandler: app.requireAuth }, async (request) => {
    return await boundary(() => kernel.catalog(request.account!.accountId));
  });

  app.post('/voices/quotes', { preHandler: app.requireAuth }, async (request) => {
    const body = quoteSchema.parse(request.body);
    const quote = await boundary(() => kernel.quote(request.account!.accountId, body.purpose, body.voiceId, body.text));
    return { ...quote, characters: quote.characterCount };
  });

  app.post('/voices/previews', { preHandler: app.requireAuth }, async (request, reply) => {
    const body = previewSchema.parse(request.body);
    const quote = await boundary(() => kernel.quote(request.account!.accountId, 'preview', body.voiceId, body.text));
    const execution = await boundary(() => kernel.synthesize({
      ownerAccountId: request.account!.accountId,
      operation: 'preview',
      voiceId: body.voiceId,
      quoteId: quote.quoteId,
      text: body.text,
      idempotencyKey: body.idempotencyKey,
    }));
    return reply.code(execution.replayed ? 200 : 201).send({ execution });
  });

  const ownerAudio = async (request: FastifyRequest, reply: FastifyReply) => {
    const { executionId } = executionParams.parse(request.params);
    reply.header('vary', 'Cookie, Authorization');
    const output = await boundary(() => kernel.ownerVoiceOutput(request.account!.accountId, executionId));
    return sendVoiceBytes(request, reply, output, true);
  };
  const sharedAudio = async (request: FastifyRequest, reply: FastifyReply) => {
    applyPrivateCapabilityHeaders(reply);
    const { token, executionId } = sharedExecutionParams.parse(request.params);
    const output = await boundary(() => kernel.sharedVoiceOutput(
      hashSessionShareToken(token),
      executionId,
    ));
    return sendVoiceBytes(request, reply, output, true);
  };
  app.get('/media/share/voice/:token/:executionId', { exposeHeadRoute: false }, sharedAudio);
  app.head('/media/share/voice/:token/:executionId', sharedAudio);
  app.get('/media/voice/:executionId', { exposeHeadRoute: false, preHandler: app.requireAuth }, ownerAudio);
  app.head('/media/voice/:executionId', { preHandler: app.requireAuth }, ownerAudio);

  app.get('/media/runtime/voice/:turnId/:executionId/:operationId/:expires/:signature.ogg', { exposeHeadRoute: false }, async (request, reply) => {
    applyPrivateCapabilityHeaders(reply);
    const parsed = runtimeAudioParams.safeParse(request.params);
    if (!parsed.success || !validCapability(expectedRuntimeToken, parsed.data)) {
      throw new ApiError(404, 'voice_output_not_found', 'Voice output not found');
    }
    const output = await boundary(() => kernel.channelVoiceOutput(
      parsed.data.turnId,
      parsed.data.executionId,
      parsed.data.operationId,
    ));
    if (output.mime !== 'audio/ogg') throw new ApiError(404, 'voice_output_not_found', 'Voice output not found');
    return sendVoiceBytes(request, reply, output, false);
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

  app.post('/sessions/:sessionId/messages/:messageId/voice-note', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = messageParams.parse(request.params);
    const body = idempotencySchema.parse(request.body);
    const result = await boundary(() => kernel.directVoiceNote(request.account!.accountId, params.sessionId, params.messageId, body.idempotencyKey));
    if (result.refreshPending) {
      app.eventsBus.publish(params.sessionId, { type: 'session.messages.changed', sessionId: params.sessionId, messageId: params.messageId });
      await boundary(() => kernel.markDirectVoiceRefreshPublished(params.messageId));
    }
    const { refreshPending: _refreshPending, ...response } = result;
    return reply.code(result.execution.replayed ? 200 : 201).send(response);
  });

  app.post('/voices/clones/quote', { preHandler: app.requireAuth }, async (request) => {
    const body = z.object({ clipObjectIds: z.array(z.string().uuid()).min(1).max(5) }).strict().parse(request.body);
    return await boundary(() => kernel.cloneQuote(request.account!.accountId, body.clipObjectIds));
  });

  app.post('/voices/clones', { preHandler: app.requireAuth }, async (request, reply) => {
    const body = cloneSchema.parse(request.body);
    const clone = await boundary(() => kernel.createClone({
      ownerAccountId: request.account!.accountId,
      name: body.name,
      clipObjectIds: body.clipObjectIds,
      consentVersion: body.consent.version,
      consentAttested: body.consent.attested,
      idempotencyKey: body.idempotencyKey,
    }));
    return reply.code(clone.status === 'ready' ? 201 : 202).send({ clone });
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
      runtimeAccountId: body.runtimeAccountId,
      agentId: body.agentId,
      ...(body.bindingId ? { bindingId: body.bindingId } : {}),
    }));
    return {
      ok: true,
      voiceOperationId: body.voiceOperationId,
      execution,
      attachment: {
        url: channelVoiceCapabilityPath(expectedRuntimeToken, turnId, execution.id, body.voiceOperationId),
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

export const voiceRoutesInternals = {
  channelVoiceCapabilityPath,
  channelVoiceCapabilityPathAtExpiry,
  validCapability,
  parseVoiceRange,
  VOICE_CAPABILITY_TTL_SECONDS,
};
