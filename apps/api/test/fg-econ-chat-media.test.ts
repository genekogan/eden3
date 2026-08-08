import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalMediaStore, credit, getBalance } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CHAT_MEDIA_EVENT_TYPE,
  compensateChatMedia,
  quoteChatMediaTool,
  reserveChatMedia,
} from '../src/services/chat-media-authorization';
import { MediaPipeline } from '../src/services/media-pipeline';

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
    providerObservedPending = pending?.status === 'pending';
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
    const expensive = quoteChatMediaTool('tts', { text: 'x'.repeat(1_000) });
    const f = await fixture(expensive.manna * 3);
    let providerCalls = 0;
    const gate = async (text: string) => {
      const result = await reserveChatMedia({
        request: request(f, 'tts', { text }),
        dailyCap: 100_000,
      });
      providerCalls += 1;
      return result;
    };
    const outcomes = await Promise.allSettled([gate('short'), gate('x'.repeat(1_000))]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(providerCalls).toBe(1);
    const rows = await pg`select 1 from usage_events where user_id = ${f.userId} and event_type = ${CHAT_MEDIA_EVENT_TYPE}`;
    expect(rows).toHaveLength(1);
  });

  it('FG-ECON-MEDIA-04: provider/tool failure restores the exact reservation and terminalizes usage', async () => {
    const quote = quoteChatMediaTool('music_generate', { prompt: 'quiet synth' });
    const f = await fixture(quote.manna + 10);
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
    expect((await getBalance(f.userId)).total).toBe(before.total);
    const [usage] = await pg<{ status: string; manna: number; error_code: string }[]>`
      select status, manna, error_code from usage_events where turn_id = ${auth.authorizationId}`;
    expect(usage).toMatchObject({ status: 'error', manna: 0, error_code: 'media_tool_failed' });
  });
});
