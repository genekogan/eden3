import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEV_USER_COOKIE, DevAuthProvider, LocalMediaStore, credit, getBalance } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerAuth } from '../src/auth-plugin';
import { ApiError, errorEnvelope } from '../src/errors';
import { MediaPipeline } from '../src/services/media-pipeline';
import { studioRoutes } from '../src/routes/studio';
import {
  MediaClaimTimeoutError,
  type MediaClaim,
  type MediaClaimOptions,
  type MediaFileEvent,
} from '../src/workers/media-watcher';

import { oracleStudioQuote, type OracleStudioTool } from './helpers/econ-oracle';

loadRootEnv();

/**
 * T08-U03 — FG-ECON studio battery. Studio is the pre-kernel upfront-debit
 * class whose money invariant is quote == settle (T-BILL deterministic media).
 * Expectations come from the INDEPENDENT oracle. Real Postgres + real
 * MediaPipeline over a temp store; the gateway/watcher are faked at the route
 * seam. NB (checkpoint-#1 finding 11): studio has NO durable authorization /
 * reaper — crash durability is explicitly out of this unit's scope (DEBT,
 * owner T08-U05).
 */

const marker = `fgeconstudio_${randomUUID().slice(0, 8)}`;
const mediaDir = mkdtempSync(path.join(tmpdir(), 'eden3-fgecon-studio-'));
const srcDir = mkdtempSync(path.join(tmpdir(), 'eden3-fgecon-studio-src-'));

let app: FastifyInstance;

let nextClaim: (opts: MediaClaimOptions) => MediaClaim;
const claimResolving = (file: MediaFileEvent) => (): MediaClaim => ({
  promise: Promise.resolve(file),
  cancel() {},
});
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

let invokeCalls: Array<{ tool: string; args?: Record<string, unknown> }> = [];
let invokeError: Error | null = null;
const fakeToolsClient = {
  async invokeTool(params: { tool: string; agentId: string; args: Record<string, unknown>; sessionKey?: string; signal?: AbortSignal }) {
    invokeCalls.push({ tool: params.tool, args: params.args });
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

async function makeUser(fund: { durable?: number; subscription?: number }): Promise<string> {
  const [row] = await pg<{ id: string }[]>`
    insert into accounts (type, username) values ('user', ${`${marker}_${randomUUID().slice(0, 8)}`}) returning id`;
  const id = row!.id;
  if (fund.durable && fund.durable > 0) await credit({ accountId: id, amount: fund.durable, type: 'credit:test' });
  if (fund.subscription && fund.subscription > 0) {
    await credit({ accountId: id, amount: fund.subscription, type: 'credit:subscription', toSubscriptionBalance: true });
  }
  return id;
}

function asUser(id: string) {
  return { cookie: `${DEV_USER_COOKIE}=${id}` };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.statusCode).send(errorEnvelope(err.statusCode, err.code, err.message));
    if (err instanceof ZodError) return reply.code(400).send(errorEnvelope(400, 'bad_request', 'invalid body'));
    const message = err instanceof Error ? err.message : 'internal error';
    return reply.code(500).send(errorEnvelope(500, 'internal_error', message));
  });
  registerAuth(app, {
    provider: new DevAuthProvider({
      lookupAccount: async (ref) => {
        const [r] = await pg<{ id: string; username: string; deleted: boolean }[]>`
          select id, username, deleted from accounts where id = ${ref}`;
        return r ?? null;
      },
    }),
  });
  await app.register(studioRoutes, {
    prefix: '/studio',
    deps: {
      pipeline: new MediaPipeline({ store: new LocalMediaStore({ mediaDir, baseUrl: 'http://media.test/media' }) }),
      watcher: fakeWatcher,
      getToolsClient: () => fakeToolsClient,
      agentId: 'main',
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pg`delete from usage_events where user_id in (select id from accounts where username like ${`${marker}%`})`;
  await pg`delete from media_assets where creation_id in (select id from creations where user_id in (select id from accounts where username like ${`${marker}%`}))`;
  await pg`delete from creations where user_id in (select id from accounts where username like ${`${marker}%`})`;
  await pg`delete from manna_transactions where manna_account_id in (select id from manna_accounts where account_id in (select id from accounts where username like ${`${marker}%`}))`;
  await pg`delete from manna_accounts where account_id in (select id from accounts where username like ${`${marker}%`})`;
  await pg`delete from accounts where username like ${`${marker}%`}`;
  await pg.end({ timeout: 5 });
});

describe('FG-ECON studio battery (quote == settle, T-BILL deterministic media)', () => {
  // FG-ECON-STUDIO-01: /studio/quote == the independent oracle, per tool/route,
  // and a happy generate settles EXACTLY the quote (adjustment ≡ 0).
  const quoteCases: Array<{ name: string; tool: OracleStudioTool; args: Record<string, unknown> }> = [
    { name: 'image flux default', tool: 'image_generate', args: { prompt: 'x' } },
    { name: 'image gemini premium', tool: 'image_generate', args: { prompt: 'x', model: 'gemini-pro' } },
    { name: 'video 5s', tool: 'video_generate', args: { prompt: 'x', duration: 5 } },
    { name: 'video 2s (boundary)', tool: 'video_generate', args: { prompt: 'x', duration: 2 } },
    { name: 'music clip', tool: 'music_generate', args: { prompt: 'x' } },
    { name: 'tts 200 chars', tool: 'tts', args: { text: 'y'.repeat(200) } },
  ];
  it.each(quoteCases)('FG-ECON-STUDIO-01[$name]: /studio/quote == oracle', async ({ tool, args }) => {
    const expected = oracleStudioQuote(tool, args);
    const res = await app.inject({ method: 'POST', url: '/studio/quote', payload: { tool: `${tool}`, args } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { quote: { manna: number; provider: string; model: string } };
    expect(body.quote.manna).toBe(expected.manna);
    expect(body.quote.provider).toBe(expected.provider);
    expect(body.quote.model).toBe(expected.model);
  });

  it('FG-ECON-STUDIO-01b: a happy image generate settles EXACTLY the oracle quote (quote == settle)', async () => {
    const expected = oracleStudioQuote('image_generate', { prompt: 'x' });
    const userId = await makeUser({ durable: expected.manna + 500 });
    invokeCalls = [];
    invokeError = null;
    nextClaim = claimResolving(fakePngFile(`happy-${randomUUID().slice(0, 8)}.png`));
    const before = await getBalance(userId);
    const res = await app.inject({
      method: 'POST',
      url: '/studio/generate',
      headers: asUser(userId),
      payload: { tool: 'image_generate', args: { prompt: 'a plain teal square' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metering: { manna: number }; settlement: { chargedManna: number; reservedManna: number; meteredManna: number } };
    expect(body.metering.manna).toBe(expected.manna);
    expect(body.settlement).toMatchObject({ chargedManna: expected.manna, reservedManna: expected.manna, meteredManna: expected.manna });
    expect(invokeCalls).toHaveLength(1);
    expect((await getBalance(userId)).total).toBe(before.total - expected.manna);
  });

  // FG-ECON-STUDIO-02: two concurrent generates on a one-quote balance — the
  // ledger admits exactly one debit and the provider is invoked exactly once;
  // the loser gets 402 without a charge (studio's upfront debit is race-free
  // via the ledger's advisory lock + balance guard).
  it('FG-ECON-STUDIO-02: concurrent double-generate on a one-quote balance charges once, invokes once', async () => {
    const quote = oracleStudioQuote('image_generate', { prompt: 'x' }).manna;
    const userId = await makeUser({ durable: Math.floor(quote * 1.5) }); // funds one, not two
    invokeCalls = [];
    invokeError = null;
    nextClaim = () => ({ promise: Promise.resolve(fakePngFile(`race-${randomUUID().slice(0, 8)}.png`)), cancel() {} });
    const fire = () =>
      app.inject({ method: 'POST', url: '/studio/generate', headers: asUser(userId), payload: { tool: 'image_generate', args: { prompt: 'race' } } });
    const [a, b] = await Promise.all([fire(), fire()]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 402]);
    const the402 = a.statusCode === 402 ? a : b;
    expect((the402.json() as { error: { code: string } }).error.code).toBe('insufficient_manna');
    // Exactly one provider invoke and exactly one net debit.
    expect(invokeCalls).toHaveLength(1);
    expect((await getBalance(userId)).total).toBe(Math.floor(quote * 1.5) - quote);
  });

  // FG-ECON-STUDIO-04: studio spend counts against the same daily cap as chat —
  // a second op with no headroom is rejected 429 (shared-cap admission). True
  // cross-class (studio+chat) sharing is proven jointly with the chat daily-cap
  // test (turns-usage) which reads the same netSpendSince window.
  it('FG-ECON-STUDIO-04: studio spend counts against the daily cap (429 with no headroom)', async () => {
    const quote = oracleStudioQuote('image_generate', { prompt: 'x' }).manna;
    const userId = await makeUser({ durable: 100_000 });
    const prev = process.env.DAILY_MANNA_SPEND_CAP_PER_USER;
    // Cap admits exactly one image quote, not two.
    process.env.DAILY_MANNA_SPEND_CAP_PER_USER = String(quote + 1);
    try {
      const { resetEnvCache } = await import('@eden3/core');
      resetEnvCache();
      invokeCalls = [];
      invokeError = null;
      nextClaim = () => ({ promise: Promise.resolve(fakePngFile(`cap-${randomUUID().slice(0, 8)}.png`)), cancel() {} });
      const first = await app.inject({ method: 'POST', url: '/studio/generate', headers: asUser(userId), payload: { tool: 'image_generate', args: { prompt: 'one' } } });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: 'POST', url: '/studio/generate', headers: asUser(userId), payload: { tool: 'image_generate', args: { prompt: 'two' } } });
      expect(second.statusCode).toBe(429);
      expect((second.json() as { error: { code: string } }).error.code).toBe('daily_manna_cap_exceeded');
      // Only the first op invoked the provider.
      expect(invokeCalls).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.DAILY_MANNA_SPEND_CAP_PER_USER;
      else process.env.DAILY_MANNA_SPEND_CAP_PER_USER = prev;
      const { resetEnvCache } = await import('@eden3/core');
      resetEnvCache();
    }
  });

  // FG-ECON-STUDIO-LAUNDER: DEBT EVIDENCE (checkpoint-#1 finding 5). Studio
  // debits subscription-first but refunds on failure via the generic durable
  // refund path — converting expiring subscription manna into permanent durable
  // manna. Aggregate is net-zero (no value created), so this is not a red gate;
  // it DOCUMENTS the laundering vector for the owner unit (T08-U04 pot lots /
  // studio settle path). When U04 lands split-exact studio refunds, the pot
  // assertions below flip to "subscription restored" and this becomes a
  // regression guard.
  it('FG-ECON-STUDIO-LAUNDER: a failed subscription-funded studio op refunds to DURABLE (documents the sub→durable laundering vector)', async () => {
    const quote = oracleStudioQuote('image_generate', { prompt: 'x' }).manna;
    const userId = await makeUser({ subscription: quote }); // subscription-only funding
    invokeCalls = [];
    invokeError = new Error('provider exploded'); // force the failure→refund path
    nextClaim = () => ({ promise: Promise.reject(new MediaClaimTimeoutError(1)), cancel() {} });
    const before = await getBalance(userId);
    expect(before.subscriptionBalance).toBe(quote);
    expect(before.balance).toBe(0);

    const res = await app.inject({ method: 'POST', url: '/studio/generate', headers: asUser(userId), payload: { tool: 'image_generate', args: { prompt: 'fail me' } } });
    expect(res.statusCode).toBeGreaterThanOrEqual(500); // provider/timeout failure

    const after = await getBalance(userId);
    // Aggregate net-zero (no value created or destroyed) — the money invariant
    // that DOES hold today.
    expect(after.total).toBe(before.total);
    // The laundering vector: subscription manna was debited, then refunded to
    // DURABLE. Documented; owned by T08-U04. (DEBT filed in orchestration/DEBT.md.)
    expect(after.subscriptionBalance).toBe(0);
    expect(after.balance).toBe(quote);
  });
});
