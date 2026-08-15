import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventsBus } from '../src/events-bus';
import { voiceRoutes } from '../src/routes/voices';
import type { VoiceKernel } from '../src/services/voice-kernel';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CLIP_A = '22222222-2222-4222-8222-222222222222';
const CLIP_B = '33333333-3333-4333-8333-333333333333';
const CLONE_ID = '44444444-4444-4444-8444-444444444444';
const VOICE_ID = 'deepinfra:kokoro:af_bella:v1';

const apps: ReturnType<typeof Fastify>[] = [];

async function harness() {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest('account', null);
  app.decorate('requireAuth', async (request, reply) => {
    if (!request.account) await reply.code(401).send({ error: { code: 'unauthorized' } });
  });
  app.addHook('onRequest', async (request) => {
    request.account = request.headers['x-test-owner'] === OWNER
      ? { accountId: OWNER, username: 'owner', isAdmin: false }
      : null;
  });
  app.decorate('eventsBus', new EventsBus());
  const quote = {
    quoteId: '55555555-5555-4555-8555-555555555555',
    expiresAt: '2026-08-15T13:00:00.000Z',
    transcriptSha256: 'a'.repeat(64),
    operation: 'preview' as const,
    voiceId: VOICE_ID,
    provider: 'deepinfra',
    model: 'hexgrad/Kokoro-82M',
    characterCount: 5,
    costUsd: 0.0000031,
    manna: 1,
    authorizedMaxManna: 1,
    tableVersion: '2026-08-15.voice-stt-v1',
    pricingEffectiveDate: '2026-08-15',
    estimated: false,
  };
  const execution = {
    id: '66666666-6666-4666-8666-666666666666',
    voiceId: VOICE_ID,
    purpose: 'preview' as const,
    status: 'completed' as const,
    url: '/media/voice.mp3',
    mime: 'audio/mpeg',
    durationMs: 1000,
    sizeBytes: 123,
    characterCount: 5,
    manna: 1,
    replayed: false,
  };
  const clone = {
    id: CLONE_ID,
    voiceId: `clone:${CLONE_ID}`,
    name: 'Mine',
    provider: 'cartesia' as const,
    status: 'cloning' as const,
    clipManifestSha256: 'b'.repeat(64),
    consentVersion: 'voice-clone-consent-v1',
    quarantineCode: null,
    failureCode: null,
    createdAt: '2026-08-15T12:00:00.000Z',
    updatedAt: '2026-08-15T12:00:00.000Z',
    revokedAt: null,
    deletedAt: null,
  };
  const kernel = {
    catalog: vi.fn(async () => ({ version: 'v1', items: [{ id: VOICE_ID }] })),
    quote: vi.fn(async () => quote),
    synthesize: vi.fn(async () => execution),
    assignment: vi.fn(async (_owner, _username, value) => ({ ...value, updatedAt: '2026-08-15T12:00:00.000Z' })),
    deleteAssignment: vi.fn(),
    directVoiceNote: vi.fn(async () => ({ execution, message: { id: '77777777-7777-4777-8777-777777777777' } })),
    cloneQuote: vi.fn(async () => ({ provider: 'cartesia', kind: 'instant', manna: 0, costUsd: 0, expiresAt: quote.expiresAt })),
    createClone: vi.fn(async () => clone),
    listClones: vi.fn(async () => []),
    getClone: vi.fn(async () => clone),
    revokeClone: vi.fn(async () => clone),
    deleteClone: vi.fn(async () => clone),
    channelVoiceNote: vi.fn(),
  };
  await app.register(voiceRoutes, {
    kernel: kernel as unknown as VoiceKernel,
    runtimeToken: 'fake-runtime-token',
    autoStartReconciler: false,
  });
  return { app, kernel, quote, execution };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('voice HTTP contract', () => {
  it('keeps the private catalog and nested assignment contract aligned with the web client', async () => {
    const { app, kernel } = await harness();
    expect((await app.inject({ method: 'GET', url: '/voices/catalog' })).statusCode).toBe(401);
    const catalog = await app.inject({ method: 'GET', url: '/voices/catalog', headers: { 'x-test-owner': OWNER } });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toEqual({ version: 'v1', items: [{ id: VOICE_ID }] });
    expect(kernel.catalog).toHaveBeenCalledWith(OWNER);

    const delivery = { chat: 'on_demand', discord: 'always', telegram: 'off' } as const;
    const assigned = await app.inject({
      method: 'PUT', url: '/agents/rocket/voice-assignment', headers: { 'x-test-owner': OWNER },
      payload: { voiceId: VOICE_ID, delivery },
    });
    expect(assigned.statusCode).toBe(200);
    expect(kernel.assignment).toHaveBeenCalledWith(OWNER, 'rocket', { voiceId: VOICE_ID, delivery });
  });

  it('quotes and previews from the same public request without exposing an internal quote id requirement', async () => {
    const { app, kernel, quote, execution } = await harness();
    const headers = { 'x-test-owner': OWNER };
    const quoted = await app.inject({
      method: 'POST', url: '/voices/quotes', headers,
      payload: { voiceId: VOICE_ID, text: 'hello', purpose: 'preview' },
    });
    expect(quoted.statusCode).toBe(200);
    expect(quoted.json()).toMatchObject({ characters: 5, manna: 1, provider: 'deepinfra' });
    expect(kernel.quote).toHaveBeenCalledWith(OWNER, 'preview', VOICE_ID, 'hello');

    const previewed = await app.inject({
      method: 'POST', url: '/voices/previews', headers,
      payload: { voiceId: VOICE_ID, text: 'hello', idempotencyKey: 'preview-key-123' },
    });
    expect(previewed.statusCode).toBe(201);
    expect(previewed.json()).toEqual({ execution });
    expect(kernel.synthesize).toHaveBeenCalledWith({
      ownerAccountId: OWNER,
      operation: 'preview',
      voiceId: VOICE_ID,
      quoteId: quote.quoteId,
      text: 'hello',
      idempotencyKey: 'preview-key-123',
    });
  });

  it('preserves ordered multi-clip consent and wraps the clone response', async () => {
    const { app, kernel } = await harness();
    const headers = { 'x-test-owner': OWNER };
    const ids = [CLIP_A, CLIP_B];
    const quote = await app.inject({
      method: 'POST', url: '/voices/clones/quote', headers, payload: { clipObjectIds: ids },
    });
    expect(quote.statusCode).toBe(200);
    expect(kernel.cloneQuote).toHaveBeenCalledWith(OWNER, ids);

    const created = await app.inject({
      method: 'POST', url: '/voices/clones', headers,
      payload: {
        name: 'Mine',
        clipObjectIds: ids,
        idempotencyKey: 'clone-key-123',
        consent: { version: 'voice-clone-consent-v1', attested: true },
      },
    });
    expect(created.statusCode).toBe(202);
    expect(created.json()).toHaveProperty('clone.id', CLONE_ID);
    expect(kernel.createClone).toHaveBeenCalledWith({
      ownerAccountId: OWNER,
      name: 'Mine',
      clipObjectIds: ids,
      consentVersion: 'voice-clone-consent-v1',
      consentAttested: true,
      idempotencyKey: 'clone-key-123',
    });
  });

  it('returns the frozen direct-chat voice-note envelope and creation/replay status', async () => {
    const { app, kernel, execution } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/77777777-7777-4777-8777-777777777777/messages/88888888-8888-4888-8888-888888888888/voice-note',
      headers: { 'x-test-owner': OWNER },
      payload: { idempotencyKey: 'voice-note-message-88888888' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ execution, message: { id: '77777777-7777-4777-8777-777777777777' } });
    expect(kernel.directVoiceNote).toHaveBeenCalledWith(
      OWNER,
      '77777777-7777-4777-8777-777777777777',
      '88888888-8888-4888-8888-888888888888',
      'voice-note-message-88888888',
    );

    kernel.directVoiceNote.mockResolvedValueOnce({
      execution: { ...execution, replayed: true },
      message: { id: '77777777-7777-4777-8777-777777777777' },
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/sessions/77777777-7777-4777-8777-777777777777/messages/88888888-8888-4888-8888-888888888888/voice-note',
      headers: { 'x-test-owner': OWNER },
      payload: { idempotencyKey: 'voice-note-message-88888888' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toHaveProperty('execution.replayed', true);
  });
});
