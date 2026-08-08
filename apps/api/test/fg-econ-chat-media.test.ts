import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalMediaStore, credit, getBalance } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CHAT_MEDIA_EVENT_TYPE,
  ChatMediaReservationReaper,
  canonicalChatMediaProviderArgs,
  compensateChatMedia,
  quoteChatMediaTool,
  reserveChatMedia,
  verifyPendingStudioMedia,
} from '../src/services/chat-media-authorization';
import { MediaPipeline } from '../src/services/media-pipeline';
import {
  compensateStudioGeneration,
  reserveStudioGeneration,
} from '../src/services/studio-reservations';

loadRootEnv();

const marker = `fg_media_${randomUUID().slice(0, 8)}`;
const mediaDir = mkdtempSync(path.join(tmpdir(), 'eden3-fg-chat-media-store-'));
const sourceDir = mkdtempSync(path.join(tmpdir(), 'eden3-fg-chat-media-src-'));
const ownedAccounts: string[] = [];
const ownedSessions: string[] = [];

async function fixture(fund: number) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await pg<{ id: string }[]>`
    insert into accounts (type, username) values ('user', ${`${marker}_u_${suffix}`}) returning id`;
  const [agent] = await pg<{ id: string }[]>`
    insert into accounts (type, username) values ('agent', ${`${marker}_a_${suffix}`}) returning id`;
  const openclawId = `${marker}-bot-${suffix}`;
  await pg`insert into agents (account_id, owner_id, openclaw_id, provision_status)
           values (${agent!.id}, ${user!.id}, ${openclawId}, 'ready')`;
  const sessionId = randomUUID();
  const sessionKey = `eden3:s:${sessionId}`;
  await pg`insert into sessions (id, owner_id, title, session_type, gateway_session_key)
           values (${sessionId}, ${user!.id}, ${marker}, 'chat', ${sessionKey})`;
  await pg`insert into session_agents (session_id, agent_account_id) values (${sessionId}, ${agent!.id})`;
  await pg`insert into session_users (session_id, user_account_id) values (${sessionId}, ${user!.id})`;
  if (fund > 0) await credit({ accountId: user!.id, amount: fund, type: 'credit:test' });
  ownedAccounts.push(user!.id, agent!.id);
  ownedSessions.push(sessionId);
  return { userId: user!.id, agentId: agent!.id, openclawId, sessionId, sessionKey };
}

function request(
  f: Awaited<ReturnType<typeof fixture>>,
  tool: 'image_generate' | 'video_generate' | 'music_generate' | 'tts',
  args: Record<string, unknown>,
) {
  return {
    runId: randomUUID(),
    toolCallId: randomUUID(),
    sessionKey: `agent:${f.openclawId}:${f.sessionKey}`,
    agentId: f.openclawId,
    tool,
    args,
  };
}

function fakePng(name: string): string {
  const file = path.join(sourceDir, name);
  writeFileSync(file, Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex'), Buffer.from(randomUUID())]));
  return file;
}

afterAll(async () => {
  await pg`delete from media_assets where session_id = any(${ownedSessions})`;
  await pg`delete from messages where session_id = any(${ownedSessions})`;
  await pg`delete from creations where user_id = any(${ownedAccounts}) or agent_id = any(${ownedAccounts})`;
  await pg`delete from usage_events where user_id = any(${ownedAccounts})`;
  await pg`delete from session_agents where session_id = any(${ownedSessions})`;
  await pg`delete from session_users where session_id = any(${ownedSessions})`;
  await pg`delete from sessions where id = any(${ownedSessions})`;
  await pg`delete from manna_transactions where manna_account_id in
           (select id from manna_accounts where account_id = any(${ownedAccounts}))`;
  await pg`delete from manna_accounts where account_id = any(${ownedAccounts})`;
  await pg`delete from agents where account_id = any(${ownedAccounts})`;
  await pg`delete from accounts where id = any(${ownedAccounts})`;
  await pg.end({ timeout: 5 });
}, 30_000);

describe('FG-ECON in-chat media authorization', () => {
  it('strictly binds quoted media args to one canonical provider route', () => {
    expect(
      canonicalChatMediaProviderArgs('image_generate', { prompt: 'x' }),
    ).toEqual({ prompt: 'x', model: 'fal/fal-ai/flux/dev' });
    expect(
      canonicalChatMediaProviderArgs('video_generate', {
        prompt: 'x',
        durationSeconds: 10,
      }),
    ).toEqual({
      prompt: 'x',
      durationSeconds: 10,
      model: 'fal/fal-ai/kling-video/v3/pro/text-to-video',
    });
    expect(
      canonicalChatMediaProviderArgs('music_generate', { prompt: 'x', duration: 30 }),
    ).toEqual({
      prompt: 'x',
      durationSeconds: 30,
      model: 'google/lyria-3-clip-preview',
    });
    for (const args of [
      { prompt: 'x', duration: '10' },
      { prompt: 'x', durationSeconds: 11 },
      { prompt: 'x', duration: 5, durationSeconds: 5 },
      { prompt: 'x', durationSeconds: 5, model: 'premium/fallback' },
    ]) {
      expect(() => quoteChatMediaTool('video_generate', args)).toThrow();
    }
  });

  it('FG-ECON-MEDIA-01: near-zero video is denied before provider admission/debit', async () => {
    const quote = quoteChatMediaTool('video_generate', { prompt: 'expensive', duration: 5 });
    const f = await fixture(quote.manna - 1);
    let providerCalls = 0;
    const providerGate = async () => {
      await reserveChatMedia({
        request: request(f, 'video_generate', { prompt: 'expensive', duration: 5 }),
        dailyCap: 100_000,
      });
      providerCalls += 1;
    };
    await expect(providerGate()).rejects.toThrow();
    expect(providerCalls).toBe(0);
    const rows = await pg`select 1 from usage_events where user_id = ${f.userId} and event_type = ${CHAT_MEDIA_EVENT_TYPE}`;
    expect(rows).toHaveLength(0);

    const capped = await fixture(quote.manna + 10);
    await expect(
      reserveChatMedia({
        request: request(capped, 'video_generate', { prompt: 'expensive', duration: 5 }),
        dailyCap: quote.manna - 1,
      }),
    ).rejects.toThrow();
    const cappedRows = await pg`
      select 1 from usage_events
      where user_id = ${capped.userId} and event_type = ${CHAT_MEDIA_EVENT_TYPE}`;
    expect(cappedRows).toHaveLength(0);
  });

  it('FG-ECON-MEDIA-02: funded media reserves before provider and settles quote with attributable usage', async () => {
    const quote = quoteChatMediaTool('image_generate', { prompt: 'a small moon' });
    const f = await fixture(quote.manna + 25);
    const before = await getBalance(f.userId);
    let providerObservedPending = false;
    const auth = await reserveChatMedia({
      request: request(f, 'image_generate', { prompt: 'a small moon' }),
      dailyCap: 100_000,
    });
    const [pending] = await pg<{ status: string; manna: number }[]>`
      select status, manna from usage_events where turn_id = ${auth.authorizationId}`;
    providerObservedPending = pending?.status === 'provider_admitted';
    expect(providerObservedPending).toBe(true);
    expect((await getBalance(f.userId)).total).toBe(before.total - quote.manna);

    const pipeline = new MediaPipeline({
      store: new LocalMediaStore({ mediaDir, baseUrl: 'http://media.test/media' }),
    });
    const ingested = await pipeline.ingestFile(fakePng(`funded-${randomUUID()}.png`), {
      sessionId: f.sessionId,
      agentAccountId: f.agentId,
      tool: 'image_generate',
    });
    expect(ingested.mediaAuthorizationId).toBe(auth.authorizationId);
    const [usage] = await pg<{
      status: string;
      user_id: string;
      agent_id: string;
      session_id: string;
      message_id: string;
      manna: number;
      cost_usd: string;
    }[]>`
      select status, user_id, agent_id, session_id, message_id, manna, cost_usd
      from usage_events where turn_id = ${auth.authorizationId}`;
    expect(usage).toMatchObject({
      status: 'completed',
      user_id: f.userId,
      agent_id: f.agentId,
      session_id: f.sessionId,
      message_id: ingested.message!.id,
      manna: quote.manna,
    });
    expect(Number(usage!.cost_usd)).toBe(quote.costUsd);
  });

  it('FG-ECON-MEDIA-03: concurrent different-cost same-action calls admit one provider/debit', async () => {
    const expensive = quoteChatMediaTool('video_generate', { prompt: 'x', durationSeconds: 10 });
    const f = await fixture(expensive.manna * 3);
    let providerCalls = 0;
    const gate = async (durationSeconds: number) => {
      const result = await reserveChatMedia({
        request: request(f, 'video_generate', { prompt: 'x', durationSeconds }),
        dailyCap: 100_000,
      });
      providerCalls += 1;
      return result;
    };
    const outcomes = await Promise.allSettled([gate(2), gate(10)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(providerCalls).toBe(1);
    const rows = await pg`select 1 from usage_events where user_id = ${f.userId} and event_type = ${CHAT_MEDIA_EVENT_TYPE}`;
    expect(rows).toHaveLength(1);
  });

  it('durably consumes one provider-admission ticket and rejects exact replay', async () => {
    const quote = quoteChatMediaTool('image_generate', { prompt: 'once' });
    const f = await fixture(quote.manna * 2);
    const exactRequest = request(f, 'image_generate', { prompt: 'once' });
    const first = await reserveChatMedia({ request: exactRequest, dailyCap: 100_000 });
    await expect(
      reserveChatMedia({ request: exactRequest, dailyCap: 100_000 }),
    ).rejects.toThrow('provider admission ticket already consumed');
    const rows = await pg<{ status: string }[]>`
      select status from usage_events where turn_id = ${first.authorizationId}`;
    expect(rows).toEqual([{ status: 'provider_admitted' }]);
    const spends = await pg`
      select 1 from manna_transactions
      where idempotency_key = ${first.metadata.reservation.idempotencyKey}`;
    expect(spends).toHaveLength(1);
  });

  it('revokes media authorization for deleted sessions, payers, and agents', async () => {
    for (const revoked of ['session', 'payer', 'agent'] as const) {
      const quote = quoteChatMediaTool('image_generate', { prompt: revoked });
      const f = await fixture(quote.manna + 1);
      if (revoked === 'session') await pg`update sessions set deleted = true where id = ${f.sessionId}`;
      if (revoked === 'payer') await pg`update accounts set deleted = true where id = ${f.userId}`;
      if (revoked === 'agent') await pg`update accounts set deleted = true where id = ${f.agentId}`;
      await expect(
        reserveChatMedia({
          request: request(f, 'image_generate', { prompt: revoked }),
          dailyCap: 100_000,
        }),
      ).rejects.toThrow('session/agent binding unavailable');
      const rows = await pg`
        select 1 from usage_events
        where user_id = ${f.userId} and event_type = ${CHAT_MEDIA_EVENT_TYPE}`;
      expect(rows).toHaveLength(0);
    }
  });

  it('fails closed for deferred in-chat TTS before debit', async () => {
    const f = await fixture(100);
    await expect(
      reserveChatMedia({
        request: request(f, 'tts', { text: 'hello' }),
        dailyCap: 100_000,
      }),
    ).rejects.toThrow('in-chat tts is deferred');
    const rows = await pg`
      select 1 from usage_events
      where user_id = ${f.userId} and event_type = ${CHAT_MEDIA_EVENT_TYPE}`;
    expect(rows).toHaveLength(0);
  });

  it('FG-ECON-MEDIA-04: provider/tool failure restores the exact reservation and terminalizes usage', async () => {
    const quote = quoteChatMediaTool('music_generate', { prompt: 'quiet synth' });
    const f = await fixture(0);
    const subscription = Number((quote.manna / 2).toFixed(4));
    await credit({
      accountId: f.userId,
      amount: subscription,
      type: 'credit:subscription',
      toSubscriptionBalance: true,
    });
    await credit({
      accountId: f.userId,
      amount: Number((quote.manna - subscription + 10).toFixed(4)),
      type: 'credit:test',
    });
    const before = await getBalance(f.userId);
    const auth = await reserveChatMedia({
      request: request(f, 'music_generate', { prompt: 'quiet synth' }),
      dailyCap: 100_000,
    });
    expect(await compensateChatMedia({
      authorizationId: auth.authorizationId,
      errorCode: 'media_tool_failed',
      errorMessage: 'provider failed',
    })).toBe('refunded');
    expect(await getBalance(f.userId)).toEqual(before);
    const [usage] = await pg<{ status: string; manna: number; error_code: string }[]>`
      select status, manna, error_code from usage_events where turn_id = ${auth.authorizationId}`;
    expect(usage).toMatchObject({ status: 'error', manna: 0, error_code: 'media_tool_failed' });
  });

  it('stale chat-media reservations are reaped split-exactly without a provider', async () => {
    const quote = quoteChatMediaTool('image_generate', { prompt: 'lost result' });
    const f = await fixture(quote.manna + 10);
    const before = await getBalance(f.userId);
    const auth = await reserveChatMedia({
      request: request(f, 'image_generate', { prompt: 'lost result' }),
      dailyCap: 100_000,
    });
    await pg`
      update usage_events set created_at = now() - interval '2 hours'
      where turn_id = ${auth.authorizationId}`;
    const reaper = new ChatMediaReservationReaper({ ttlMs: 60 * 60 * 1_000 });
    expect(await reaper.runOnce()).toMatchObject({ scanned: 1, reaped: 1, pending: 0 });
    expect(await getBalance(f.userId)).toEqual(before);
    const [usage] = await pg<{ status: string; manna: number; error_code: string }[]>`
      select status, manna, error_code from usage_events where turn_id = ${auth.authorizationId}`;
    expect(usage).toMatchObject({
      status: 'error',
      manna: 0,
      error_code: 'media_generation_timeout',
    });
  });

  it('admits direct Studio tools only through their exact committed reservation', async () => {
    const quote = quoteChatMediaTool('video_generate', { prompt: 'studio clip', duration: 5 });
    const f = await fixture(quote.manna + 10);
    const turnId = randomUUID();
    await reserveStudioGeneration({
      turnId,
      accountId: f.userId,
      tool: 'video_generate',
      quote,
      reservationKey: `studio:${turnId}:reserve`,
      dailyCap: 100_000,
    });
    await expect(
      verifyPendingStudioMedia({
        request: {
          sessionKey: `agent:main:eden3:studio:${turnId}`,
          agentId: 'main',
          tool: 'video_generate',
          args: { prompt: 'studio clip', duration: 10 },
        },
      }),
    ).rejects.toThrow('Studio reservation identity mismatch');

    const exactRequest = {
      sessionKey: `agent:main:eden3:studio:${turnId}`,
      agentId: 'main',
      tool: 'video_generate' as const,
      args: { prompt: 'studio clip', duration: 5 },
    };
    const raced = await Promise.allSettled([
      verifyPendingStudioMedia({ request: exactRequest }),
      verifyPendingStudioMedia({ request: exactRequest }),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const admitted = raced.find((result) => result.status === 'fulfilled');
    expect(admitted?.status === 'fulfilled' ? admitted.value : null).toMatchObject({
      authorizationId: turnId,
      tool: 'video_generate',
    });
    const [providerAdmitted] = await pg<{ status: string }[]>`
      select status from usage_events
      where event_type = 'studio_generation' and turn_id = ${turnId}`;
    expect(providerAdmitted?.status).toBe('provider_admitted');
    await expect(verifyPendingStudioMedia({ request: exactRequest })).rejects.toThrow(
      'pending Studio authorization unavailable',
    );
    expect(
      await compensateStudioGeneration({
        turnId,
        errorCode: 'test_cleanup',
        errorMessage: 'provider was not invoked in this admission proof',
      }),
    ).toBe('refunded');

    await expect(
      verifyPendingStudioMedia({
        request: {
          sessionKey: `agent:main:eden3:studio:${randomUUID()}`,
          agentId: 'main',
          tool: 'video_generate',
          args: { prompt: 'studio clip', duration: 5 },
        },
      }),
    ).rejects.toThrow('pending Studio authorization unavailable');
  });

  it('serializes Studio output claims globally so reverse completion cannot cross tenants', async () => {
    const quote = quoteChatMediaTool('image_generate', { prompt: 'serialized Studio image' });
    const first = await fixture(quote.manna + 10);
    const second = await fixture(quote.manna + 10);
    const firstTurnId = randomUUID();
    const secondTurnId = randomUUID();
    const beforeFirst = await getBalance(first.userId);
    const beforeSecond = await getBalance(second.userId);
    const reserve = (turnId: string, accountId: string) =>
      reserveStudioGeneration({
        turnId,
        accountId,
        tool: 'image_generate',
        quote,
        reservationKey: `studio:${turnId}:reserve`,
        dailyCap: 100_000,
      });

    const raced = await Promise.allSettled([
      reserve(firstTurnId, first.userId),
      reserve(secondTurnId, second.userId),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = raced[0]?.status === 'fulfilled'
      ? { turnId: firstTurnId, accountId: first.userId, loserId: secondTurnId, loserAccountId: second.userId }
      : { turnId: secondTurnId, accountId: second.userId, loserId: firstTurnId, loserAccountId: first.userId };
    const [active] = await pg<{ turn_id: string; user_id: string; status: string }[]>`
      select turn_id, user_id, status from usage_events
      where event_type = 'studio_generation'
        and turn_id in (${firstTurnId}, ${secondTurnId})`;
    expect(active).toEqual({ turn_id: winner.turnId, user_id: winner.accountId, status: 'pending' });
    expect((await getBalance(winner.accountId)).total).toBe(
      (winner.accountId === first.userId ? beforeFirst.total : beforeSecond.total) - quote.manna,
    );
    expect((await getBalance(winner.loserAccountId)).total).toBe(
      winner.loserAccountId === first.userId ? beforeFirst.total : beforeSecond.total,
    );

    expect(
      await compensateStudioGeneration({
        turnId: winner.turnId,
        errorCode: 'test_serial_release',
        errorMessage: 'release serialized Studio output kind',
      }),
    ).toBe('refunded');
    await expect(reserve(winner.loserId, winner.loserAccountId)).resolves.toMatchObject({
      turnId: winner.loserId,
    });
    expect(
      await compensateStudioGeneration({
        turnId: winner.loserId,
        errorCode: 'test_cleanup',
        errorMessage: 'provider was not invoked in this serialization proof',
      }),
    ).toBe('refunded');
  });

  it('quarantines a Studio output kind durably after provider-admitted failure', async () => {
    const quote = quoteChatMediaTool('image_generate', { prompt: 'late Studio image' });
    const first = await fixture(quote.manna + 10);
    const second = await fixture(quote.manna + 10);
    const firstTurnId = randomUUID();
    const secondTurnId = randomUUID();
    const secondBefore = await getBalance(second.userId);
    const reserve = (turnId: string, accountId: string) =>
      reserveStudioGeneration({
        turnId,
        accountId,
        tool: 'image_generate',
        quote,
        reservationKey: `studio:${turnId}:reserve`,
        dailyCap: 100_000,
      });
    try {
      await reserve(firstTurnId, first.userId);
      await verifyPendingStudioMedia({
        request: {
          sessionKey: `agent:main:eden3:studio:${firstTurnId}`,
          agentId: 'main',
          tool: 'image_generate',
          args: { prompt: 'late Studio image' },
        },
      });
      expect(
        await compensateStudioGeneration({
          turnId: firstTurnId,
          errorCode: 'generation_timeout',
          errorMessage: 'provider admitted but no attributable file arrived',
        }),
      ).toBe('refunded');
      const [quarantined] = await pg<{ status: string; output_kind: string | null }[]>`
        select status, metadata->'outputQuarantine'->>'outputKind' as output_kind
        from usage_events
        where event_type = 'studio_generation' and turn_id = ${firstTurnId}`;
      expect(quarantined).toEqual({ status: 'error', output_kind: 'image' });

      await expect(reserve(secondTurnId, second.userId)).rejects.toMatchObject({
        code: 'studio_output_quarantined',
        outputKind: 'image',
      });
      // A new transaction/process sees the durable terminal marker too; no
      // in-memory lease or wall-clock expiry may reopen the output kind.
      await expect(reserve(secondTurnId, second.userId)).rejects.toMatchObject({
        code: 'studio_output_quarantined',
      });
      expect((await getBalance(second.userId)).total).toBe(secondBefore.total);
      const [loserRows] = await pg<{ count: string }[]>`
        select count(*) from usage_events where turn_id = ${secondTurnId}`;
      expect(Number(loserRows?.count ?? -1)).toBe(0);
    } finally {
      // Test-only cleanup of the indefinite operator quarantine. Production
      // deliberately has no automatic/time-based clear path at M3.
      const [secondUsage] = await pg<{ count: string }[]>`
        select count(*) from usage_events where turn_id = ${secondTurnId}`;
      if (Number(secondUsage?.count ?? 0) > 0) {
        await compensateStudioGeneration({
          turnId: secondTurnId,
          errorCode: 'test_cleanup',
          errorMessage: 'clean up failing-first loser',
        });
      }
      await pg`delete from usage_events
               where event_type = 'studio_generation'
                 and turn_id in (${firstTurnId}, ${secondTurnId})`;
    }
  });
});
