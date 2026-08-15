import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors';
import { FixedWindowRateLimiter } from '../services/http-hardening';
import {
  TRANSCRIPTION_MAX_CHUNK_BYTES,
  TranscriptionService,
} from '../services/transcriptions';

export interface TranscriptionRoutesOptions {
  service: TranscriptionService;
  rateLimit: { windowMs: number; max: number };
}

const sessionParams = z.object({ id: z.string().uuid() });
const chunkParams = sessionParams.extend({
  chunkNumber: z.coerce.number().int().min(0).max(60_000),
});
const createBody = z.object({
  language: z.literal('en').optional(),
  maxDurationMs: z.number().int().min(1_000).max(600_000).optional(),
}).strict();
const finalizeBody = z.object({
  finalChunkNumber: z.number().int().min(0).max(60_000),
}).strict();
const uuidHeader = z.string().uuid();
const shaHeader = z.string().regex(/^[0-9a-f]{64}$/);

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function idempotencyKey(request: FastifyRequest): string {
  const parsed = uuidHeader.safeParse(singleHeader(request.headers['idempotency-key']));
  if (!parsed.success) {
    throw new ApiError(400, 'idempotency_key_required', 'A UUID Idempotency-Key header is required');
  }
  return parsed.data;
}

function chunkSha256(request: FastifyRequest): string {
  const parsed = shaHeader.safeParse(singleHeader(request.headers['x-chunk-sha256']));
  if (!parsed.success) {
    throw new ApiError(400, 'chunk_checksum_required', 'A lowercase SHA-256 chunk checksum is required');
  }
  return parsed.data;
}

function contentLength(request: FastifyRequest): number {
  const raw = singleHeader(request.headers['content-length']);
  if (!raw || !/^[1-9]\d*$/.test(raw)) {
    throw new ApiError(411, 'chunk_content_length_required', 'A canonical Content-Length is required');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > TRANSCRIPTION_MAX_CHUNK_BYTES) {
    throw new ApiError(413, 'audio_chunk_too_large', 'Audio chunk exceeds the size limit');
  }
  return parsed;
}

export const transcriptionsRoutes: FastifyPluginAsync<TranscriptionRoutesOptions> = async (
  app,
  options,
) => {
  if (!options.service) throw new Error('transcriptionsRoutes requires a TranscriptionService');
  const limiter = new FixedWindowRateLimiter(options.rateLimit);
  const admit = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.requireAuth(request, reply);
    if (reply.sent || !request.account) return;
    const result = limiter.hit(`stt:${request.account.accountId}`);
    reply.header('x-ratelimit-limit', String(result.limit));
    reply.header('x-ratelimit-remaining', String(result.remaining));
    reply.header('x-ratelimit-reset', String(Math.ceil(result.resetAt / 1_000)));
    if (!result.allowed) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000))));
      throw new ApiError(429, 'transcription_rate_limited', 'Too many transcription requests');
    }
  };

  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: TRANSCRIPTION_MAX_CHUNK_BYTES },
      (_request, body, done) => done(null, body),
    );
  }

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('cross-origin-resource-policy', 'same-origin');
    return payload;
  });

  app.post('/', { onRequest: admit, preHandler: app.requireAuth }, async (request, reply) => {
    const result = await options.service.create(request.account!.accountId, {
      idempotencyKey: idempotencyKey(request),
      ...createBody.parse(request.body ?? {}),
    });
    return reply.code(201).send(result);
  });

  app.get('/:id', { onRequest: admit, preHandler: app.requireAuth }, async (request) => {
    const { id } = sessionParams.parse(request.params);
    return await options.service.get(request.account!.accountId, id);
  });

  app.put(
    '/:id/chunks/:chunkNumber',
    {
      onRequest: admit,
      preHandler: app.requireAuth,
      bodyLimit: TRANSCRIPTION_MAX_CHUNK_BYTES,
      preParsing: async (request, _reply, payload) => {
        if (request.headers['content-type'] !== 'application/octet-stream') {
          throw new ApiError(415, 'invalid_audio_content_type', 'Audio chunks must be application/octet-stream');
        }
        contentLength(request);
        chunkSha256(request);
        return payload;
      },
    },
    async (request, reply) => {
      const { id, chunkNumber } = chunkParams.parse(request.params);
      const declaredLength = contentLength(request);
      if (!Buffer.isBuffer(request.body)) {
        throw new ApiError(415, 'invalid_audio_content_type', 'Audio chunks must be application/octet-stream');
      }
      if (request.body.length !== declaredLength) {
        throw new ApiError(400, 'chunk_size_mismatch', 'Chunk body does not match Content-Length');
      }
      const ack = await options.service.appendChunk(
        request.account!.accountId,
        id,
        chunkNumber,
        { body: request.body, sha256: chunkSha256(request) },
      );
      return reply.code(ack.replayed ? 200 : 201).send(ack);
    },
  );

  app.post('/:id/finalize', { onRequest: admit, preHandler: app.requireAuth }, async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const result = await options.service.finalize(request.account!.accountId, id, {
      idempotencyKey: idempotencyKey(request),
      ...finalizeBody.parse(request.body),
    });
    return reply.code(202).send(result);
  });

  app.delete('/:id', { onRequest: admit, preHandler: app.requireAuth }, async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const result = await options.service.delete(request.account!.accountId, id);
    return reply.code(result.status === 'processing' ? 202 : 200).send(result);
  });
};
