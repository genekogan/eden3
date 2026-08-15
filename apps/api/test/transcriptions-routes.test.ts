import { createHash, randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError, errorEnvelope } from '../src/errors';
import { transcriptionsRoutes } from '../src/routes/transcriptions';
import {
  DeterministicTranscriptionProvider,
  MemoryTranscriptionRepository,
  TranscriptionService,
} from '../src/services/transcriptions';

const apps: ReturnType<typeof Fastify>[] = [];
const ownerId = '11111111-1111-4111-8111-111111111111';

async function appHarness(rateMax = 120) {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest('account', null);
  app.decorate('requireAuth', async (request, reply) => {
    if (!request.account) {
      await reply.code(401).send(errorEnvelope(401, 'unauthorized', 'Authentication required'));
    }
  });
  app.addHook('onRequest', async (request) => {
    const accountId = request.headers['x-test-owner'];
    request.account = typeof accountId === 'string'
      ? { accountId, username: 'test', isAdmin: false }
      : null;
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof ApiError ? error.statusCode : 500;
    const code = error instanceof ApiError ? error.code : 'internal_error';
    const message = error instanceof Error ? error.message : 'Internal server error';
    void reply.code(status).send(errorEnvelope(status, code, message));
  });
  const repository = new MemoryTranscriptionRepository();
  const service = new TranscriptionService({
    repository,
    provider: new DeterministicTranscriptionProvider(),
  });
  await app.register(transcriptionsRoutes, {
    prefix: '/transcriptions',
    service,
    rateLimit: { windowMs: 60_000, max: rateMax },
  });
  return { app, repository };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('transcriptions HTTP contract', () => {
  it('authenticates before accepting audio and never returns a public locator', async () => {
    const { app } = await appHarness();
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/transcriptions',
      headers: { 'idempotency-key': randomUUID() },
      payload: {},
    });
    expect(unauthorized.statusCode).toBe(401);

    const created = await app.inject({
      method: 'POST',
      url: '/transcriptions',
      headers: { 'x-test-owner': ownerId, 'idempotency-key': randomUUID() },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.json()).not.toHaveProperty('url');
    expect(created.json()).not.toHaveProperty('uploadUrl');
  });

  it('returns durable chunk acknowledgements and stable idempotency statuses', async () => {
    const { app } = await appHarness();
    const created = await app.inject({
      method: 'POST',
      url: '/transcriptions',
      headers: { 'x-test-owner': ownerId, 'idempotency-key': randomUUID() },
      payload: {},
    });
    const sessionId = created.json().id as string;
    const body = Buffer.alloc(3_200, 3);
    const checksum = createHash('sha256').update(body).digest('hex');
    const headers = {
      'x-test-owner': ownerId,
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      'x-chunk-sha256': checksum,
    };
    const first = await app.inject({ method: 'PUT', url: `/transcriptions/${sessionId}/chunks/0`, headers, payload: body });
    const replay = await app.inject({ method: 'PUT', url: `/transcriptions/${sessionId}/chunks/0`, headers, payload: body });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ acknowledgedThrough: 0, nextChunkNumber: 1, replayed: true });

    const finalized = await app.inject({
      method: 'POST',
      url: `/transcriptions/${sessionId}/finalize`,
      headers: { 'x-test-owner': ownerId, 'idempotency-key': randomUUID() },
      payload: { finalChunkNumber: 0 },
    });
    expect(finalized.statusCode).toBe(202);
    expect(finalized.json()).toMatchObject({ status: 'queued', acknowledgedThrough: 0 });
  });

  it('hides other owners and enforces the STT-specific rate limit', async () => {
    const { app } = await appHarness(1);
    const created = await app.inject({
      method: 'POST',
      url: '/transcriptions',
      headers: { 'x-test-owner': ownerId, 'idempotency-key': randomUUID() },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const limited = await app.inject({
      method: 'GET',
      url: `/transcriptions/${created.json().id}`,
      headers: { 'x-test-owner': ownerId },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'transcription_rate_limited' } });

    const other = await app.inject({
      method: 'GET',
      url: `/transcriptions/${created.json().id}`,
      headers: { 'x-test-owner': '22222222-2222-4222-8222-222222222222' },
    });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ error: { code: 'transcription_not_found' } });
  });
});
