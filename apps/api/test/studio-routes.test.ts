import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEV_USER_COOKIE,
  DevAuthProvider,
  LocalMediaStore,
  credit,
  getBalance,
  reverseReservation,
} from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import { GatewayHttpError, GatewayToolError } from '@eden3/gateway';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerAuth } from '../src/auth-plugin';
import { ApiError, errorEnvelope } from '../src/errors';
import { MediaPipeline } from '../src/services/media-pipeline';
import { compensateStudioGeneration } from '../src/services/studio-reservations';
import { feedRoutes } from '../src/routes/feed';
import {
  studioRoutes,
  GENERATION_TIMEOUTS_MS,
  STUDIO_TOOLS,
  quoteStudioGeneration,
  type StudioToolName,
  type TtsFallbackGenerator,
} from '../src/routes/studio';
import {
  MediaClaimTimeoutError,
  type MediaClaim,
  type MediaClaimOptions,
  type MediaFileEvent,
} from '../src/workers/media-watcher';

loadRootEnv();

/**
 * Studio route tests: real Postgres (manna ledger + creations) and a real
 * MediaPipeline over a temp store, with the gateway and the watcher faked at
 * the route's injection seams.
 */

const marker = `studiotest_${randomUUID().slice(0, 8)}`;
const mediaDir = mkdtempSync(path.join(tmpdir(), 'eden3-studio-store-'));
const srcDir = mkdtempSync(path.join(tmpdir(), 'eden3-studio-src-'));

let app: FastifyInstance;
let richUserId = '';
let brokeUserId = '';
const imageQuote = quoteStudioGeneration('image_generate', { prompt: 'x' });

// -- fakes -------------------------------------------------------------------

/** Behavior of the NEXT claimNext() call. */
let nextClaim: (opts: MediaClaimOptions) => MediaClaim;
const claimResolving = (file: MediaFileEvent) => (): MediaClaim => ({
  promise: Promise.resolve(file),
  cancel() {},
});
const claimTimingOut = (): MediaClaim => ({
  promise: Promise.reject(new MediaClaimTimeoutError(123)),
  cancel() {},
});
const claimUnused = (): MediaClaim => ({
  promise: new Promise<MediaFileEvent>(() => {}), // never settles; cancelled by the route
  cancel() {},
});

/** When set, the next claimSource.start() rejects (watcher startup failure). */
let startError: Error | null = null;
const fakeWatcher = {
  async start(): Promise<void> {
    if (startError) throw startError;
  },
  async stop(): Promise<void> {},
  claimNext(opts: MediaClaimOptions): MediaClaim {
    return nextClaim(opts);
  },
};

let invokeCalls: Array<{
  tool: string;
  agentId: string;
  sessionKey?: string;
  args?: Record<string, unknown>;
}> = [];
let invokeError: Error | null = null;
let invokeHang = false;
let reversalError: Error | null = null;
let forcedRequestId: string | null = null;
let toolsFactoryError: ApiError | null = null;
let nextTtsFallback: TtsFallbackGenerator | null = null;
const fakeToolsClient = {
  async invokeTool(params: {
    tool: string;
    agentId: string;
    args: Record<string, unknown>;
    sessionKey?: string;
    signal?: AbortSignal;
  }) {
    invokeCalls.push({
      tool: params.tool,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      args: params.args,
    });
    if (invokeError) throw invokeError;
    if (invokeHang) {
      await new Promise<never>((_resolve, reject) => {
        params.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return { async: true, taskId: 'task-1', details: {} };
  },
};

function fakePngFile(name: string): MediaFileEvent {
  const unique = Buffer.from(randomUUID());
  const buf = Buffer.alloc(24 + unique.length);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(4, 16);
  buf.writeUInt32BE(4, 20);
  unique.copy(buf, 24);
  const filePath = path.join(srcDir, name);
  writeFileSync(filePath, buf);
  return { path: filePath, basename: name, mime: 'image/png', kind: 'image' };
}

function fakeMediaFile(
  name: string,
  mime: string,
  kind: MediaFileEvent['kind'],
): MediaFileEvent {
  const filePath = path.join(srcDir, name);
  writeFileSync(filePath, Buffer.from(`${name}:${randomUUID()}`));
  return { path: filePath, basename: name, mime, kind };
}

// -- setup --------------------------------------------------------------------

beforeAll(async () => {
  const rows = await pg<{ id: string }[]>`
    insert into accounts (type, username) values
      ('user', ${`${marker}_rich`}),
      ('user', ${`${marker}_broke`})
    returning id
  `;
  richUserId = rows[0]!.id;
  brokeUserId = rows[1]!.id;
  await credit({ accountId: richUserId, amount: 5_000, type: 'credit:test' });

  app = Fastify({ logger: false });
  // Mirror the server's error envelope (ZodError -> 400) — buildServer isn't
  // used here because studio deps are injected at the plugin seam.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send(errorEnvelope(err.statusCode, err.code, err.message));
    }
    if (err instanceof ZodError) {
      return reply.code(400).send(errorEnvelope(400, 'bad_request', 'invalid body'));
    }
    const message = err instanceof Error ? err.message : 'internal error';
    return reply.code(500).send(errorEnvelope(500, 'internal_error', message));
  });
  registerAuth(app, {
    provider: new DevAuthProvider({
      lookupAccount: async (ref) => {
        const [row] = await pg<{ id: string; username: string; deleted: boolean }[]>`
          select id, username, deleted from accounts where id = ${ref}`;
        return row ?? null;
      },
    }),
  });
  await app.register(studioRoutes, {
    prefix: '/studio',
    deps: {
      pipeline: new MediaPipeline({
        store: new LocalMediaStore({ mediaDir, baseUrl: 'http://media.test/media' }),
      }),
      watcher: fakeWatcher,
      getToolsClient: () => {
        if (toolsFactoryError) throw toolsFactoryError;
        return fakeToolsClient;
      },
      agentId: 'main',
      timeoutsMs: { image_generate: 50 },
      reverseDebit: async (params) => {
        if (reversalError) throw reversalError;
        return await reverseReservation(params);
      },
      requestId: () => forcedRequestId ?? randomUUID(),
      ttsFallback: (params) => {
        if (nextTtsFallback === null) throw new Error('unexpected tts fallback');
        return nextTtsFallback(params);
      },
    },
  });
  await app.register(feedRoutes, { prefix: '/feed' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pg`delete from usage_events where user_id in (${richUserId}, ${brokeUserId})`;
  await pg`delete from media_assets where creation_id in
           (select id from creations where user_id in (${richUserId}, ${brokeUserId}))`;
  await pg`delete from creations where user_id in (${richUserId}, ${brokeUserId})`;
  await pg`delete from manna_transactions where manna_account_id in
           (select id from manna_accounts where account_id in (${richUserId}, ${brokeUserId}))`;
  await pg`delete from manna_accounts where account_id in (${richUserId}, ${brokeUserId})`;
  await pg`delete from accounts where username like ${`${marker}%`}`;
  await pg.end({ timeout: 5 });
});

function asUser(id: string): { cookie: string } {
  return { cookie: `${DEV_USER_COOKIE}=${id}` };
}

// -- tests ---------------------------------------------------------------------

describe('GET /studio/tools', () => {
  it('lists the four tools with metered launch pricing', async () => {
    const res = await app.inject({ method: 'GET', url: '/studio/tools' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tools: Array<{ name: string; costManna: number; metering?: { provider: string; model: string } }>;
      pricing: Record<string, number>;
    };
    expect(body.tools.map((t) => t.name)).toEqual([
      'image_generate',
      'video_generate',
      'music_generate',
      'tts',
    ]);
    const byName = Object.fromEntries(body.tools.map((t) => [t.name, t.costManna]));
    expect(byName).toEqual({
      image_generate: quoteStudioGeneration('image_generate', { prompt: 'x' }).manna,
      video_generate: quoteStudioGeneration('video_generate', { prompt: 'x' }).manna,
      music_generate: quoteStudioGeneration('music_generate', { prompt: 'x' }).manna,
      tts: STUDIO_TOOLS.find((tool) => tool.name === 'tts')!.costManna,
    });
    expect(body.pricing.image_generate).toBe(imageQuote.manna);
    expect(body.tools[0]!.metering).toMatchObject({
      provider: 'fal',
      model: 'fal-ai/flux/dev',
    });
    expect(STUDIO_TOOLS).toHaveLength(4);
    expect(GENERATION_TIMEOUTS_MS.video_generate).toBe(600_000);
  });

  it('quotes submitted args before generation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/studio/quote',
      payload: { tool: 'tts', args: { text: 'hello world' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { quote: { provider: string; model: string; manna: number; units: Record<string, number> } };
    expect(body.quote).toMatchObject({
      provider: 'elevenlabs',
      model: 'tts',
      units: { audio_character: 11 },
    });
    expect(body.quote.manna).toBe(3);
  });

  it('quotes the cheap flux default and the labeled gemini premium opt-in (C4 reprice)', async () => {
    const standard = await app.inject({
      method: 'POST',
      url: '/studio/quote',
      payload: { tool: 'image_generate', args: { prompt: 'x' } },
    });
    expect(standard.statusCode).toBe(200);
    expect((standard.json() as { quote: Record<string, unknown> }).quote).toMatchObject({
      provider: 'fal',
      model: 'fal-ai/flux/dev',
      manna: 34,
    });

    const premium = await app.inject({
      method: 'POST',
      url: '/studio/quote',
      payload: { tool: 'image_generate', args: { prompt: 'x', model: 'gemini-pro' } },
    });
    expect(premium.statusCode).toBe(200);
    expect((premium.json() as { quote: Record<string, unknown> }).quote).toMatchObject({
      provider: 'google',
      model: 'gemini-3-pro-image-preview',
      manna: 181,
    });

    const unknown = await app.inject({
      method: 'POST',
      url: '/studio/quote',
      payload: { tool: 'image_generate', args: { prompt: 'x', model: 'dall-e-1' } },
    });
    expect(unknown.statusCode).toBe(400);
  });
});

describe('POST /studio/generate', () => {
  it('401s without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      payload: { tool: 'image_generate', args: { prompt: 'x' } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400s on a malformed body (unknown tool / missing prompt)', async () => {
    const bad1 = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(richUserId),
      payload: { tool: 'world_peace', args: { prompt: 'x' } },
    });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(richUserId),
      payload: { tool: 'image_generate', args: {} },
    });
    expect(bad2.statusCode).toBe(400);
    expect(invokeCalls).toHaveLength(0); // nothing reached the gateway
  });

  it('402s (without charging) when the balance cannot cover the tool', async () => {
    nextClaim = claimUnused;
    const res = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(brokeUserId),
      payload: { tool: 'image_generate', args: { prompt: 'x' } },
    });
    expect(res.statusCode).toBe(402);
    expect((res.json() as { error: { code: string } }).error.code).toBe('insufficient_manna');
    const [countRow] = await pg<{ count: string }[]>`
      select count(*) from manna_transactions
      where manna_account_id in (select id from manna_accounts where account_id = ${brokeUserId})`;
    expect(Number(countRow!.count)).toBe(0);
    expect(invokeCalls).toHaveLength(0);
  });

  it('generates: debit -> invoke(main) -> claimed file -> creation owned by the caller', async () => {
    invokeCalls = [];
    invokeError = null;
    nextClaim = claimResolving(fakePngFile('happy.png'));
    const before = await getBalance(richUserId);

    const res = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(richUserId),
      payload: { tool: 'image_generate', args: { prompt: 'a plain teal square' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      creationId: string;
      url: string;
      mime: string;
      metering: { provider: string; model: string; manna: number; costUsd: number };
      settlement: { status: string; reservedManna: number; meteredManna: number; chargedManna: number };
    };
    expect(body.creationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toMatch(/^http:\/\/media\.test\/media\/[0-9a-f]{64}\.png$/);
    expect(body.mime).toBe('image/png');
    expect(body.metering).toMatchObject({
      provider: 'fal',
      model: 'fal-ai/flux/dev',
      manna: imageQuote.manna,
      costUsd: imageQuote.costUsd,
    });
    expect(body.settlement).toMatchObject({
      status: 'settled',
      reservedManna: imageQuote.manna,
      meteredManna: imageQuote.manna,
      chargedManna: imageQuote.manna,
    });

    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0]).toMatchObject({ tool: 'image_generate', agentId: 'main' });
    // The billed default (fal-ai/flux/dev) is also the routed one: the invoke
    // carries the OpenClaw per-request model ref.
    expect(invokeCalls[0]!.args).toMatchObject({ model: 'fal/fal-ai/flux/dev' });
    expect(invokeCalls[0]!.sessionKey).toMatch(/^eden3:studio:[0-9a-f-]{36}$/);

    const [creation] = await pg<
      { userId: string; agentId: string | null; tool: string; url: string; args: unknown; public: boolean }[]
    >`
      select user_id as "userId", agent_id as "agentId", tool, url, args, public
      from creations where id = ${body.creationId}`;
    expect(creation).toMatchObject({
      userId: richUserId,
      agentId: null,
      tool: 'image_generate',
      url: body.url,
      args: { prompt: 'a plain teal square' },
      public: true,
    });
    const feed = await app.inject({
      method: 'GET',
      url: `/feed/creations?user=${richUserId}&limit=5`,
    });
    expect(feed.statusCode).toBe(200);
    expect(
      (feed.json() as { items: Array<{ id: string; url: string | null }> }).items,
    ).toContainEqual(expect.objectContaining({ id: body.creationId, url: body.url }));

    const after = await getBalance(richUserId);
    expect(after.total).toBe(before.total - imageQuote.manna);
    const [tx] = await pg<{ type: string; amount: string }[]>`
      select type, amount from manna_transactions
      where manna_account_id in (select id from manna_accounts where account_id = ${richUserId})
        and type = 'spend:image' order by created_at desc limit 1`;
    expect(tx).toMatchObject({ type: 'spend:image', amount: (-imageQuote.manna).toFixed(4) });

    const [usage] = await pg<
      Array<{
        eventType: string;
        status: string;
        userId: string | null;
        agentId: string | null;
        provider: string;
        model: string;
        costUsd: string;
        manna: number;
        latencyMs: number | null;
        errorCode: string | null;
        errorMessage: string | null;
        metadata: { tool?: string; creationId?: string | null } | null;
      }>
    >`
      select event_type as "eventType", status, user_id as "userId", agent_id as "agentId",
             provider, model, cost_usd as "costUsd", manna, latency_ms as "latencyMs",
             error_code as "errorCode", error_message as "errorMessage", metadata
      from usage_events
      where user_id = ${richUserId} and event_type = 'studio_generation'
      order by created_at desc limit 1`;
    expect(usage).toMatchObject({
      eventType: 'studio_generation',
      status: 'completed',
      userId: richUserId,
      agentId: null,
      provider: 'fal',
      model: 'fal-ai/flux/dev',
      costUsd: imageQuote.costUsd.toFixed(8),
      manna: imageQuote.manna,
      errorCode: null,
      errorMessage: null,
    });
    expect(usage!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(usage!.metadata).toMatchObject({
      tool: 'image_generate',
      creationId: body.creationId,
    });
  });

  it.each([
    {
      tool: 'video_generate' as const,
      args: { prompt: 'a neon wave rolling through a gallery', duration: 2 },
      file: () => fakeMediaFile('studio-video.mp4', 'video/mp4', 'video'),
      expectedMime: 'video/mp4',
    },
    {
      tool: 'music_generate' as const,
      args: { prompt: 'slow glass bells over a deep bass pulse' },
      file: () => fakeMediaFile('studio-music.mp3', 'audio/mpeg', 'audio'),
      expectedMime: 'audio/mpeg',
    },
  ] satisfies Array<{
    tool: StudioToolName;
    args: Record<string, unknown>;
    file: () => MediaFileEvent;
    expectedMime: string;
  }>)('generates and settles $tool outputs', async ({ tool, args, file, expectedMime }) => {
    invokeCalls = [];
    invokeError = null;
    nextClaim = claimResolving(file());
    const quote = quoteStudioGeneration(tool, args);
    const before = await getBalance(richUserId);

    const res = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(richUserId),
      payload: { tool, args },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      creationId: string;
      url: string;
      mime: string;
      metering: { provider: string; model: string; manna: number; costUsd: number };
      settlement: { status: string; reservedManna: number; meteredManna: number; chargedManna: number };
    };
    expect(body.mime).toBe(expectedMime);
    expect(body.metering.manna).toBe(quote.manna);
    expect(body.settlement).toMatchObject({
      status: 'settled',
      reservedManna: quote.manna,
      meteredManna: quote.manna,
      chargedManna: quote.manna,
    });
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0]).toMatchObject({ tool, agentId: 'main' });

    const [creation] = await pg<
      { userId: string; tool: string; url: string; args: unknown; public: boolean }[]
    >`
      select user_id as "userId", tool, url, args, public
      from creations where id = ${body.creationId}`;
    expect(creation).toMatchObject({
      userId: richUserId,
      tool,
      url: body.url,
      args,
      public: true,
    });
    expect((await getBalance(richUserId)).total).toBe(before.total - quote.manna);
  });

  it('routes Studio TTS directly to its quoted ElevenLabs adapter', async () => {
    invokeCalls = [];
    invokeError = new GatewayHttpError(404, 'gateway responded 404 to /tools/invoke (tts)');
    nextClaim = claimUnused;
    nextTtsFallback = async ({ args }) => {
      expect(args).toEqual({ text: 'Fallback speech.' });
      return fakeMediaFile('studio-fallback-voice.mp3', 'audio/mpeg', 'audio');
    };
    const quote = quoteStudioGeneration('tts', { text: 'Fallback speech.' });
    const before = await getBalance(richUserId);

    const res = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(richUserId),
      payload: { tool: 'tts', args: { text: 'Fallback speech.' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      creationId: string;
      url: string;
      mime: string;
      metering: { provider: string; model: string; manna: number };
    };
    expect(body.mime).toBe('audio/mpeg');
    expect(body.metering).toMatchObject({ provider: 'elevenlabs', model: 'tts', manna: quote.manna });
    expect(invokeCalls).toHaveLength(0);

    const [creation] = await pg<
      { userId: string; tool: string; url: string; args: unknown; public: boolean }[]
    >`
      select user_id as "userId", tool, url, args, public
      from creations where id = ${body.creationId}`;
    expect(creation).toMatchObject({
      userId: richUserId,
      tool: 'tts',
      url: body.url,
      args: { text: 'Fallback speech.' },
      public: true,
    });
    expect((await getBalance(richUserId)).total).toBe(before.total - quote.manna);

    const [usage] = await pg<
      Array<{ status: string; provider: string; model: string; manna: number; errorCode: string | null }>
    >`
      select status, provider, model, manna, error_code as "errorCode"
      from usage_events
      where user_id = ${richUserId}
        and event_type = 'studio_generation'
        and metadata->>'creationId' = ${body.creationId}
      order by created_at desc limit 1`;
    expect(usage).toMatchObject({
      status: 'completed',
      provider: 'elevenlabs',
      model: 'tts',
      manna: quote.manna,
      errorCode: null,
    });

    invokeError = null;
    nextTtsFallback = null;
  });

  it('502s and refunds when the gateway invoke fails', async () => {
    invokeError = new GatewayToolError('fal exploded', 'image_generate');
    nextClaim = claimUnused;
    const before = await getBalance(richUserId);

    const res = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(richUserId),
      payload: { tool: 'image_generate', args: { prompt: 'x' } },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { code: string } }).error.code).toBe('gateway_error');
    expect((await getBalance(richUserId)).total).toBe(before.total); // refunded
    const [countRow] = await pg<{ count: string }[]>`
      select count(*) from manna_transactions
      where manna_account_id in (select id from manna_accounts where account_id = ${richUserId})
        and type = 'refund:image'`;
    expect(Number(countRow!.count)).toBe(1);
    const [usage] = await pg<
      Array<{
        eventType: string;
        status: string;
        userId: string | null;
        provider: string;
        model: string;
        costUsd: string;
        manna: number;
        latencyMs: number | null;
        errorCode: string | null;
        errorMessage: string | null;
      }>
    >`
      select event_type as "eventType", status, user_id as "userId", provider, model,
             cost_usd as "costUsd", manna, latency_ms as "latencyMs",
             error_code as "errorCode", error_message as "errorMessage"
      from usage_events
      where user_id = ${richUserId}
        and event_type = 'studio_generation'
        and error_code = 'gateway_error'
      order by created_at desc limit 1`;
    expect(usage).toMatchObject({
      eventType: 'studio_generation',
      status: 'error',
      userId: richUserId,
      provider: 'fal',
      model: 'fal-ai/flux/dev',
      costUsd: '0.00000000',
      manna: 0,
      errorCode: 'gateway_error',
      errorMessage: expect.stringContaining('fal exploded'),
    });
    expect(usage!.latencyMs).toBeGreaterThanOrEqual(0);
    invokeError = null;
  });

  it('fails loudly and records the outstanding charge when reversal fails', async () => {
    invokeError = new GatewayToolError('provider exploded', 'image_generate');
    reversalError = new Error('ledger unavailable');
    nextClaim = claimUnused;
    const before = await getBalance(richUserId);
    let refundPendingTurnId: string | null = null;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/studio/generate',
        headers: asUser(richUserId),
        payload: { tool: 'image_generate', args: { prompt: 'x' } },
      });

      expect(res.statusCode).toBe(503);
      const error = (res.json() as { error: { code: string; message: string } }).error;
      expect(error.code).toBe('refund_pending');
      expect(error.message).toContain('refund is pending');
      expect(error.message).not.toContain('ledger unavailable');
      expect((await getBalance(richUserId)).total).toBe(before.total - imageQuote.manna);

      const [usage] = await pg<Array<{ turnId: string; status: string; manna: number; errorCode: string }>>`
        select turn_id as "turnId", status, manna, error_code as "errorCode"
        from usage_events
        where user_id = ${richUserId}
          and event_type = 'studio_generation'
          and error_code = 'refund_pending'
        order by created_at desc limit 1`;
      expect(usage).toEqual({
        turnId: expect.any(String),
        status: 'refund_pending',
        manna: imageQuote.manna,
        errorCode: 'refund_pending',
      });
      refundPendingTurnId = usage?.turnId ?? null;
    } finally {
      invokeError = null;
      reversalError = null;
      if (refundPendingTurnId) {
        expect(
          await compensateStudioGeneration({
            turnId: refundPendingTurnId,
            errorCode: 'provider_error',
            errorMessage: 'provider exploded',
          }),
        ).toBe('refunded');
      }
    }
  });

  it('never reaches the provider when the durable authorization row is refused', async () => {
    forcedRequestId = randomUUID();
    invokeCalls = [];
    const before = await getBalance(richUserId);
    try {
      await pg`
        insert into usage_events (event_type, status, user_id, turn_id)
        values ('studio_generation', 'error', ${richUserId}, ${forcedRequestId})`;
      const res = await app.inject({
        method: 'POST',
        url: '/studio/generate',
        headers: asUser(richUserId),
        payload: { tool: 'image_generate', args: { prompt: 'must never run' } },
      });
      expect(res.statusCode).toBe(500);
      expect(invokeCalls).toHaveLength(0);
      expect((await getBalance(richUserId)).total).toBe(before.total);
      const [ledger] = await pg<{ count: string }[]>`
        select count(*) from manna_transactions
        where idempotency_key = ${`studio:${forcedRequestId}:reserve`}`;
      expect(Number(ledger?.count ?? -1)).toBe(0);
    } finally {
      forcedRequestId = null;
    }
  });

  it('immediately refunds and terminalizes when no gateway token can construct a provider client', async () => {
    toolsFactoryError = new ApiError(
      503,
      'gateway_not_configured',
      'OPENCLAW_GATEWAY_TOKEN is not set — studio generation is unavailable',
    );
    invokeCalls = [];
    nextClaim = claimUnused;
    const before = await getBalance(richUserId);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/studio/generate',
        headers: asUser(richUserId),
        payload: { tool: 'image_generate', args: { prompt: 'must not run without a token' } },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'gateway_not_configured',
      );
      expect(invokeCalls).toHaveLength(0);
      expect((await getBalance(richUserId)).total).toBe(before.total);

      const [usage] = await pg<
        { status: string; manna: number; errorCode: string; errorMessage: string }[]
      >`
        select status, manna, error_code as "errorCode", error_message as "errorMessage"
        from usage_events
        where user_id = ${richUserId}
          and event_type = 'studio_generation'
          and error_code = 'gateway_not_configured'
        order by created_at desc limit 1`;
      expect(usage).toEqual({
        status: 'error',
        manna: 0,
        errorCode: 'gateway_not_configured',
        errorMessage: expect.stringContaining('OPENCLAW_GATEWAY_TOKEN is not set'),
      });
    } finally {
      toolsFactoryError = null;
    }
  });

  it('504s and refunds when the gateway invocation hangs past the generation timeout', async () => {
    invokeHang = true;
    nextClaim = claimResolving(fakePngFile('claimed-before-hang.png'));
    const before = await getBalance(richUserId);

    const res = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(richUserId),
      payload: { tool: 'image_generate', args: { prompt: 'x' } },
    });
    expect(res.statusCode).toBe(504);
    expect((res.json() as { error: { code: string } }).error.code).toBe('generation_timeout');
    expect((await getBalance(richUserId)).total).toBe(before.total); // refunded
    invokeHang = false;
  });

  it('504s and refunds when no file lands before the timeout', async () => {
    nextClaim = claimTimingOut;
    const before = await getBalance(richUserId);

    const res = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(richUserId),
      payload: { tool: 'image_generate', args: { prompt: 'x' } },
    });
    expect(res.statusCode).toBe(504);
    expect((res.json() as { error: { code: string } }).error.code).toBe('generation_timeout');
    expect((await getBalance(richUserId)).total).toBe(before.total); // refunded
  });

  it('500s and refunds when ingest fails after a claimed file', async () => {
    nextClaim = claimResolving({
      path: path.join(srcDir, 'does-not-exist.png'),
      basename: 'does-not-exist.png',
      mime: 'image/png',
      kind: 'image',
    });
    const before = await getBalance(richUserId);

    const res = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(richUserId),
      payload: { tool: 'image_generate', args: { prompt: 'x' } },
    });
    expect(res.statusCode).toBe(500);
    expect((await getBalance(richUserId)).total).toBe(before.total); // refunded
  });

  it('refunds when the watcher fails to start (throw between debit and claim)', async () => {
    // Regression for W2 finding #3 (studio side): claimSource.start() runs
    // AFTER the debit — a throw there must refund, or the manna orphans.
    startError = new Error('chokidar exploded on start');
    nextClaim = claimUnused; // never reached
    invokeCalls = [];
    const before = await getBalance(richUserId);

    const res = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(richUserId),
      payload: { tool: 'image_generate', args: { prompt: 'x' } },
    });
    expect(res.statusCode).toBe(500);
    expect(invokeCalls).toHaveLength(0); // the tool was never invoked
    expect((await getBalance(richUserId)).total).toBe(before.total); // fully refunded

    const [countRow] = await pg<{ count: string }[]>`
      select count(*) from manna_transactions
      where manna_account_id in (select id from manna_accounts where account_id = ${richUserId})
        and type = 'refund:image'`;
    expect(Number(countRow!.count)).toBeGreaterThanOrEqual(1);
    startError = null;
  });
});
