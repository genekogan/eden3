import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEV_USER_COOKIE, DevAuthProvider, LocalMediaStore, credit, getBalance } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import { GatewayToolError } from '@eden3/gateway';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerAuth } from '../src/auth-plugin';
import { ApiError, errorEnvelope } from '../src/errors';
import { MediaPipeline } from '../src/services/media-pipeline';
import { studioRoutes, GENERATION_TIMEOUTS_MS, STUDIO_TOOLS } from '../src/routes/studio';
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

let invokeCalls: Array<{ tool: string; agentId: string }> = [];
let invokeError: Error | null = null;
const fakeToolsClient = {
  async invokeTool(params: { tool: string; agentId: string; args: Record<string, unknown> }) {
    invokeCalls.push({ tool: params.tool, agentId: params.agentId });
    if (invokeError) throw invokeError;
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
  await credit({ accountId: richUserId, amount: 10, type: 'credit:test' });

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
      getToolsClient: () => fakeToolsClient,
      agentId: 'main',
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
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
  it('lists the four tools with PLAN.md pricing', async () => {
    const res = await app.inject({ method: 'GET', url: '/studio/tools' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tools: Array<{ name: string; costManna: number }>;
      pricing: Record<string, number>;
    };
    expect(body.tools.map((t) => t.name)).toEqual([
      'image_generate',
      'video_generate',
      'music_generate',
      'tts',
    ]);
    const byName = Object.fromEntries(body.tools.map((t) => [t.name, t.costManna]));
    expect(byName).toEqual({ image_generate: 5, video_generate: 25, music_generate: 10, tts: 2 });
    expect(body.pricing.chatTurn).toBe(1);
    expect(STUDIO_TOOLS).toHaveLength(4);
    expect(GENERATION_TIMEOUTS_MS.video_generate).toBe(600_000);
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
    const body = res.json() as { creationId: string; url: string; mime: string };
    expect(body.creationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toMatch(/^http:\/\/media\.test\/media\/[0-9a-f]{64}\.png$/);
    expect(body.mime).toBe('image/png');

    expect(invokeCalls).toEqual([{ tool: 'image_generate', agentId: 'main' }]);

    const [creation] = await pg<
      { userId: string; agentId: string | null; tool: string; url: string; args: unknown }[]
    >`
      select user_id as "userId", agent_id as "agentId", tool, url, args
      from creations where id = ${body.creationId}`;
    expect(creation).toMatchObject({
      userId: richUserId,
      agentId: null,
      tool: 'image_generate',
      url: body.url,
      args: { prompt: 'a plain teal square' },
    });

    const after = await getBalance(richUserId);
    expect(after.total).toBe(before.total - 5);
    const [tx] = await pg<{ type: string; amount: string }[]>`
      select type, amount from manna_transactions
      where manna_account_id in (select id from manna_accounts where account_id = ${richUserId})
        and type = 'spend:image' order by created_at desc limit 1`;
    expect(tx).toMatchObject({ type: 'spend:image', amount: '-5.0000' });
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
    invokeError = null;
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
