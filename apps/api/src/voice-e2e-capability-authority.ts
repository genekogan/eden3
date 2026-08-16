import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { serviceAuthenticatedCallback } from './auth-plugin';
import { sendError } from './errors';
import { voiceRoutesInternals } from './routes/voices';
import { isValidChannelRuntimeAuthorization } from './services/channel-runtime-auth';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactSecret(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Install the isolated-only oracle backed by the exact production capability signer. */
export function registerVoiceE2eCapabilityAuthority(app: FastifyInstance, options: {
  runtimeCapabilityKey: string;
  authorityNonce: string;
}): void {
  const { runtimeCapabilityKey, authorityNonce } = options;
  if (runtimeCapabilityKey.length < 32 || authorityNonce.length < 32) {
    throw new Error('voice E2E capability authority is unavailable');
  }
  const requireCapabilityAuthority = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isValidChannelRuntimeAuthorization(request.headers.authorization, runtimeCapabilityKey) ||
        !exactSecret(request.headers['x-eden3-voice-authority-nonce'], authorityNonce)) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }
  };
  app.post('/__e2e/voice-capability/derive', {
    ...serviceAuthenticatedCallback(requireCapabilityAuthority),
    logLevel: 'silent',
  }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const turnId = typeof body?.turnId === 'string' ? body.turnId : '';
    const executionId = typeof body?.executionId === 'string' ? body.executionId : '';
    const operationId = typeof body?.operationId === 'string' ? body.operationId : '';
    const expires = typeof body?.expires === 'string' ? body.expires : '';
    if (!uuid.test(turnId) || !uuid.test(executionId) || !uuid.test(operationId) || !/^\d{10}$/.test(expires)) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }
    return {
      path: voiceRoutesInternals.channelVoiceCapabilityPathAtExpiry(runtimeCapabilityKey, {
        turnId, executionId, operationId, expires,
      }),
    };
  });
}
