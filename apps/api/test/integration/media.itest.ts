import { randomUUID } from 'node:crypto';

import { DEV_USER_COOKIE, credit, getBalance, getEnv } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import { quoteStudioGeneration } from '../../src/routes/studio';

loadRootEnv();

/**
 * Media integration test against the FULL live stack:
 *
 *   - Postgres (localhost:5433)
 *   - OpenClaw gateway (OPENCLAW_BASE_URL, bearer OPENCLAW_GATEWAY_TOKEN)
 *   - the real media watcher polling infra/openclaw/data/media (sshfs bind)
 *
 * POST /studio/generate performs ONE real image generation through the
 * gateway's `main` agent (fal, ~cents — accepted cost of this test) and waits
 * for the async file to land on disk (~10-120s), so the vitest config allows
 * 300s per test. Run: pnpm --filter @eden3/api test:integration
 *
 * The stored media file in MEDIA_DIR is intentionally left behind
 * (content-addressed, harmless); all database fixture rows are deleted.
 */

const AGENT_ID = 'main';
const marker = `mediaitest_${randomUUID().slice(0, 8)}`;
const imageQuote = quoteStudioGeneration('image_generate', { prompt: 'x' });

let app: FastifyInstance;
let userId = '';
const cleanupCreationIds: string[] = [];

beforeAll(async () => {
  const env = getEnv();
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error(
      'OPENCLAW_GATEWAY_TOKEN is not set (env or repo-root .env) — cannot run media integration tests',
    );
  }

  // Preflight: fail fast (and clearly) when the gateway is down or the
  // "main" agent is missing, instead of an opaque 300s timeout later.
  const res = await fetch(`${env.OPENCLAW_BASE_URL.replace(/\/+$/, '')}/v1/models`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`gateway preflight failed: GET /v1/models responded ${res.status}`);
  }
  const models = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (models.data ?? []).map((m) => m.id);
  if (!ids.includes(`openclaw/${AGENT_ID}`)) {
    throw new Error(`agent "${AGENT_ID}" is not registered on the gateway (models: ${ids.join(', ')})`);
  }

  const rows = await pg<{ id: string }[]>`
    insert into accounts (type, username) values ('user', ${marker}) returning id`;
  userId = rows[0]!.id;
  await credit({ accountId: userId, amount: 500, type: 'credit:test' });

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (cleanupCreationIds.length > 0) {
    await pg`delete from media_assets where creation_id in ${pg(cleanupCreationIds)}`;
  }
  await pg`delete from usage_events where user_id = ${userId}`;
  await pg`delete from creations where user_id = ${userId}`;
  await pg`delete from manna_transactions where manna_account_id in
           (select id from manna_accounts where account_id = ${userId})`;
  await pg`delete from manna_accounts where account_id = ${userId}`;
  await pg`delete from accounts where username = ${marker}`;
  await pg.end({ timeout: 5 });
});

describe('studio media pipeline (live gateway + watcher + postgres)', () => {
  it('GET /studio/tools serves the catalog without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/studio/tools' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tools: Array<{ name: string }>; pricing: { image_generate: number } };
    expect(body.tools).toHaveLength(4);
    expect(body.pricing.image_generate).toBe(imageQuote.manna);
  });

  it(
    'POST /studio/generate produces a REAL image: creation row + served file + manna debit',
    async () => {
      const before = await getBalance(userId);
      expect(before.total).toBe(500);

      const generate = () =>
        app.inject({
          method: 'POST',
          url: '/studio/generate',
          headers: { cookie: `${DEV_USER_COOKIE}=${userId}` },
          payload: {
            tool: 'image_generate',
            args: { prompt: 'a plain solid teal square on a white background, flat color, minimal' },
          },
        });

      // fal latency is usually 10-30s but the tail can exceed the route's
      // 120s image budget (observed 2m43s on a warm queue). A 504 is a
      // CORRECT outcome (refund verified below) — retry once before failing.
      let res = await generate();
      if (res.statusCode === 504) {
        // eslint-disable-next-line no-console
        console.info('[itest] first generation timed out (504) — verifying refund, retrying once');
        expect((await getBalance(userId)).total).toBe(500); // fully refunded
        res = await generate();
      }

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        creationId: string;
        url: string;
        mime: string;
        metering: { manna: number; provider: string; model: string };
        settlement: { chargedManna: number };
      };
      expect(body.creationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.mime).toMatch(/^image\//);
      expect(body.metering).toMatchObject({
        manna: imageQuote.manna,
        provider: imageQuote.provider,
        model: imageQuote.model,
      });
      expect(body.settlement.chargedManna).toBe(imageQuote.manna);
      cleanupCreationIds.push(body.creationId);

      // creations row: owned by the caller, no session/agent, tool + args kept.
      const [creation] = await pg<
        {
          userId: string | null;
          agentId: string | null;
          tool: string | null;
          url: string | null;
          filename: string | null;
        }[]
      >`
        select user_id as "userId", agent_id as "agentId", tool, url, filename
        from creations where id = ${body.creationId}`;
      expect(creation).toBeDefined();
      expect(creation!.userId).toBe(userId);
      expect(creation!.agentId).toBeNull();
      expect(creation!.tool).toBe('image_generate');
      expect(creation!.url).toBe(body.url);

      // media_assets ledger row: content-addressed, correlated to the creation,
      // parked without a session (studio flow), source path in the gateway dir.
      const [asset] = await pg<
        // size_bytes is bigint — postgres.js returns it as a string in raw queries.
        { sha256: string | null; sessionId: string | null; sourcePath: string | null; sizeBytes: string }[]
      >`
        select sha256, session_id as "sessionId", source_path as "sourcePath",
               size_bytes as "sizeBytes"
        from media_assets where creation_id = ${body.creationId}`;
      expect(asset).toBeDefined();
      expect(asset!.sessionId).toBeNull();
      const sizeBytes = Number(asset!.sizeBytes);
      expect(sizeBytes).toBeGreaterThan(1000);
      expect(asset!.sourcePath).toContain('media');
      expect(body.url).toContain(asset!.sha256!);

      // The file is served under the /media/ static route. MEDIA_BASE_URL is
      // the same-origin relative "/media" in local dev, so body.url may be a
      // bare path — resolve against a dummy origin.
      const mediaPath = new URL(body.url, 'http://media.local').pathname;
      expect(mediaPath.startsWith('/media/')).toBe(true);
      const served = await app.inject({ method: 'GET', url: mediaPath });
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toMatch(/^image\//);
      expect(served.rawPayload.length).toBe(sizeBytes);

      // Manna: net exactly ONE unrefunded metered debit (a timed-out attempt,
      // if any, was fully refunded above).
      const after = await getBalance(userId);
      expect(after.total).toBe(500 - imageQuote.manna);
      const txs = await pg<{ type: string; amount: string }[]>`
        select type, amount from manna_transactions
        where manna_account_id in (select id from manna_accounts where account_id = ${userId})
        order by created_at asc`;
      const spends = txs.filter((t) => t.type === 'spend:image');
      const refunds = txs.filter((t) => t.type === 'refund:image');
      expect(spends.length - refunds.length).toBe(1);
      expect(spends.at(-1)!.amount).toBe((-imageQuote.manna).toFixed(4));

      const [usage] = await pg<{ eventType: string; status: string; manna: number }[]>`
        select event_type as "eventType", status, manna
        from usage_events
        where user_id = ${userId} and event_type = 'studio_generation'
        order by created_at desc limit 1`;
      expect(usage).toMatchObject({
        eventType: 'studio_generation',
        status: 'completed',
        manna: imageQuote.manna,
      });
    },
    280_000, // room for one 120s timeout + one retried generation
  );
});
