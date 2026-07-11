import { randomUUID } from 'node:crypto';

import { DEV_USER_COOKIE, GATEWAY_SESSION_KEY_PREFIX, getEnv, resetEnvCache } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import {
  messageDto,
  sessionDto,
  tryParseSessionEvent,
  extractSseData,
  type MessageDto,
  type SessionDto,
  type SessionEvent,
} from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';

/**
 * Chat-turn integration tests against the LIVE stack:
 *   - Postgres (localhost:5433) — throwaway fixture rows, hard-deleted after.
 *   - OpenClaw gateway (127.0.0.1:18789) — agent "testbot" (haiku, cheap).
 *
 * Run: pnpm --filter @eden3/api test:integration
 *
 * The server listens on an ephemeral port and is exercised over real HTTP so
 * the SSE streaming path (hijacked replies, headers, framing) is the real
 * thing. Gateway turns regularly take 5-15s; timeouts are generous.
 */

const AGENT_OPENCLAW_ID = 'testbot';
const run = randomUUID().slice(0, 8);
const usernames = {
  owner: `apitest_chat_u_${run}`,
  broke: `apitest_chat_b_${run}`,
  agent: `apitest_chat_a_${run}`,
};

let app: FastifyInstance;
let baseUrl = '';
let ownerId = '';
let brokeId = '';
let agentAccountId = '';
let agentUsername = '';
let createdAgentFixture = false;

// Filled by the tests as the conversation progresses.
let sessionId = '';
const turnIds: string[] = [];
const codename = `zanzibar_${run}`;

// Migrated-session fixture (continue-priming test).
let migratedSessionId = '';
const migratedExternalId = randomUUID().replaceAll('-', '').slice(0, 24);

async function scrubStaleChatFixtures(): Promise<void> {
  const accounts = await pg<{ id: string }[]>`
    select id from accounts
    where username like 'apitest_chat_%' and external_id is null`;
  const accountIds = accounts.map((row) => row.id);
  if (accountIds.length === 0) return;

  const sessionRows = await pg<{ id: string }[]>`
    select id from sessions where owner_id = any(${accountIds}::uuid[])`;
  const sessionIds = sessionRows.map((row) => row.id);
  if (sessionIds.length > 0) {
    await pg`delete from usage_events where session_id = any(${sessionIds}::uuid[])`;
    await pg`delete from messages where session_id = any(${sessionIds}::uuid[])`;
    await pg`delete from session_agents where session_id = any(${sessionIds}::uuid[])`;
    await pg`delete from session_users where session_id = any(${sessionIds}::uuid[])`;
    await pg`delete from sessions where id = any(${sessionIds}::uuid[])`;
  }

  await pg`delete from usage_events where user_id = any(${accountIds}::uuid[]) or agent_id = any(${accountIds}::uuid[])`;
  await pg`
    delete from manna_transactions where manna_account_id in
      (select id from manna_accounts where account_id = any(${accountIds}::uuid[]))`;
  await pg`delete from manna_accounts where account_id = any(${accountIds}::uuid[])`;
  await pg`delete from agents where account_id = any(${accountIds}::uuid[])`;
  await pg`delete from accounts where id = any(${accountIds}::uuid[])`;
}

function cookieFor(accountId: string): string {
  return `${DEV_USER_COOKIE}=${accountId}`;
}

interface StreamedResponse {
  status: number;
  headers: Headers;
  events: SessionEvent[];
  /** Raw body text (SSE frames) for debugging assertions. */
  body: string;
}

function parseSseEvents(body: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const frame of body.split('\n\n')) {
    const payload = extractSseData(frame);
    if (payload === null) continue;
    const event = tryParseSessionEvent(payload);
    if (event) events.push(event);
  }
  return events;
}

/** POST a chat message; the response stream ends when the turn does. */
async function postMessage(
  path: string,
  payload: Record<string, unknown>,
  accountId: string,
): Promise<StreamedResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      cookie: cookieFor(accountId),
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  return { status: res.status, headers: res.headers, events: parseSseEvents(body), body };
}

function eventTypes(events: SessionEvent[]): string[] {
  return events.map((e) => e.type);
}

function tokenText(events: SessionEvent[]): string {
  return events
    .filter((e): e is Extract<SessionEvent, { type: 'token' }> => e.type === 'token')
    .map((e) => e.delta)
    .join('');
}

function completedEvent(events: SessionEvent[]) {
  const completed = events.find(
    (e): e is Extract<SessionEvent, { type: 'turn.completed' }> => e.type === 'turn.completed',
  );
  expect(completed, `expected turn.completed in: ${eventTypes(events).join(', ')}`).toBeDefined();
  return completed!;
}

async function getJson<T>(path: string, accountId: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { accept: 'application/json', cookie: cookieFor(accountId) },
  });
  return { status: res.status, json: (await res.json()) as T };
}

/** Poll until `probe` resolves truthy or the deadline passes. */
async function eventually<T>(
  probe: () => Promise<T | null | undefined | false>,
  { timeoutMs = 45_000, intervalMs = 2_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last as T;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms (last=${JSON.stringify(last)})`);
}

beforeAll(async () => {
  loadRootEnv();
  resetEnvCache();
  await scrubStaleChatFixtures();
  const env = getEnv();
  if (!env.OPENCLAW_GATEWAY_TOKEN) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is not set (env or repo-root .env)');
  }

  // Gateway preflight — fail fast with a readable message.
  const models = await fetch(`${env.OPENCLAW_BASE_URL.replace(/\/+$/, '')}/v1/models`, {
    headers: { authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}` },
  });
  if (!models.ok) throw new Error(`gateway preflight failed: /v1/models -> ${models.status}`);
  const ids = ((await models.json()) as { data?: Array<{ id?: string }> }).data?.map((m) => m.id) ?? [];
  if (!ids.includes(`openclaw/${AGENT_OPENCLAW_ID}`)) {
    throw new Error(`agent "${AGENT_OPENCLAW_ID}" not registered on the gateway (${ids.join(', ')})`);
  }

  // --- fixtures ---------------------------------------------------------
  const [owner] = await pg<{ id: string }[]>`
    insert into accounts (type, username) values ('user', ${usernames.owner}) returning id`;
  ownerId = owner!.id;
  await pg`insert into manna_accounts (account_id, balance) values (${ownerId}, '100.0000')`;

  const [broke] = await pg<{ id: string }[]>`
    insert into accounts (type, username) values ('user', ${usernames.broke}) returning id`;
  brokeId = broke!.id;

  // Reuse an existing testbot agents row when present (unique openclaw_id).
  const existingAgent = await pg<{ accountId: string; username: string }[]>`
    select ag.account_id as "accountId", a.username
    from agents ag join accounts a on a.id = ag.account_id
    where ag.openclaw_id = ${AGENT_OPENCLAW_ID} limit 1`;
  if (existingAgent.length > 0) {
    agentAccountId = existingAgent[0]!.accountId;
    agentUsername = existingAgent[0]!.username;
  } else {
    const [agentAccount] = await pg<{ id: string }[]>`
      insert into accounts (type, username) values ('agent', ${usernames.agent}) returning id`;
    agentAccountId = agentAccount!.id;
    agentUsername = usernames.agent;
    await pg`
      insert into agents (account_id, openclaw_id, provision_status, public, name)
      values (${agentAccountId}, ${AGENT_OPENCLAW_ID}, 'ready', true, 'API test bot')`;
    createdAgentFixture = true;
  }

  // Migrated-session fixture: external_id set, NO gateway key, never primed,
  // with an old transcript only Postgres knows about.
  const [migrated] = await pg<{ id: string }[]>`
    insert into sessions (external_id, owner_id, title, message_count)
    values (${migratedExternalId}, ${ownerId}, 'legacy fruit chat', 2)
    returning id`;
  migratedSessionId = migrated!.id;
  await pg`insert into session_agents (session_id, agent_account_id) values (${migratedSessionId}, ${agentAccountId})`;
  await pg`insert into session_users (session_id, user_account_id) values (${migratedSessionId}, ${ownerId})`;
  await pg`
    insert into messages (session_id, sender_id, role, content, created_at) values
    (${migratedSessionId}, ${ownerId}, 'user', 'Please remember: my favorite fruit is dragonfruit.', now() - interval '30 days'),
    (${migratedSessionId}, ${agentAccountId}, 'assistant', 'Dragonfruit — noted! I will remember that.', now() - interval '30 days' + interval '1 minute')`;

  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no listen address');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  await app?.close(); // stops trailing history-sync timers (onClose hook)

  // Hard-delete fixture rows, children first. Fixture sessions = owned by
  // either fixture user (covers sessions created during the tests).
  const sessionRows = await pg<{ id: string }[]>`
    select id from sessions where owner_id in (${ownerId}, ${brokeId})`;
  const sessionIds = sessionRows.map((row) => row.id);
  if (sessionIds.length > 0) {
    await pg`delete from usage_events where session_id = any(${sessionIds}::uuid[])`;
    await pg`delete from messages where session_id = any(${sessionIds}::uuid[])`;
    await pg`delete from session_agents where session_id = any(${sessionIds}::uuid[])`;
    await pg`delete from session_users where session_id = any(${sessionIds}::uuid[])`;
    await pg`delete from sessions where id = any(${sessionIds}::uuid[])`;
  }
  await pg`
    delete from manna_transactions where manna_account_id in
      (select id from manna_accounts where account_id in (${ownerId}, ${brokeId}))`;
  await pg`delete from manna_accounts where account_id in (${ownerId}, ${brokeId})`;
  if (createdAgentFixture) {
    await pg`delete from agents where account_id = ${agentAccountId}`;
    await pg`delete from accounts where id = ${agentAccountId}`;
  }
  await pg`delete from accounts where id in (${ownerId}, ${brokeId})`;
  await pg.end({ timeout: 5 });
});

describe('POST /sessions/new/messages (live gateway + postgres)', () => {
  it('streams the first turn of a new session and exposes x-session-id', async () => {
    const res = await postMessage(
      '/sessions/new/messages',
      {
        content: `Hi! My name is ${codename}. Please remember it. Reply with a short greeting.`,
        agentUsername,
      },
      ownerId,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const headerSessionId = res.headers.get('x-session-id');
    expect(headerSessionId).toBeTruthy();
    sessionId = headerSessionId!;

    // turn.started first, carrying the same session id as the header.
    const started = res.events[0];
    expect(started?.type).toBe('turn.started');
    if (started?.type !== 'turn.started') throw new Error('unreachable');
    expect(started.sessionId).toBe(sessionId);
    turnIds.push(started.turnId);

    // manna debited: 100 -> 99, broadcast on the same stream.
    const manna = res.events.find(
      (e): e is Extract<SessionEvent, { type: 'manna.updated' }> => e.type === 'manna.updated',
    );
    expect(manna).toBeDefined();
    expect(manna!.accountId).toBe(ownerId);
    expect(manna!.balance).toBe(99);

    // Real streamed tokens and a completed turn with usage from the gateway tail.
    expect(res.events.some((e) => e.type === 'token')).toBe(true);
    expect(tokenText(res.events).length).toBeGreaterThan(0);
    const completed = completedEvent(res.events);
    expect(completed.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(completed.usage?.promptTokens).toBeGreaterThan(0);
    expect(completed.usage?.completionTokens).toBeGreaterThan(0);
    expect(res.events.filter((e) => e.type === 'error')).toEqual([]);

    // Turn registry window is live for the media watcher.
    const active = app.turnRegistry.get(`${GATEWAY_SESSION_KEY_PREFIX}${sessionId}`);
    expect(active?.sessionId).toBe(sessionId);
    expect(active?.agentOpenclawId).toBe(AGENT_OPENCLAW_ID);
  });

  it('keeps continuity on the second turn AND mirrors events on the session bus', async () => {
    expect(sessionId).not.toBe('');

    // Subscribe to GET /sessions/:id/events BEFORE posting: the events route
    // registers the sink before flushing headers, so once this fetch resolves
    // the subscription is live.
    // SSE IDOR guard (live): the channel leaks token deltas + manna balances,
    // so anonymous and non-member callers must be rejected before any stream.
    const anon = await fetch(`${baseUrl}/sessions/${sessionId}/events`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(anon.status).toBe(401);
    await anon.body?.cancel();
    const wrongUser = await fetch(`${baseUrl}/sessions/${sessionId}/events`, {
      headers: { accept: 'text/event-stream', cookie: cookieFor(brokeId) },
    });
    expect(wrongUser.status).toBe(403);
    await wrongUser.body?.cancel();

    const controller = new AbortController();
    const busEvents: SessionEvent[] = [];
    // The SSE channel now requires auth + session access (SSE IDOR fix): send
    // the owner's cookie, exactly like every other authenticated request.
    const subscription = await fetch(`${baseUrl}/sessions/${sessionId}/events`, {
      headers: { accept: 'text/event-stream', cookie: cookieFor(ownerId) },
      signal: controller.signal,
    });
    expect(subscription.status).toBe(200);
    const busDone = (async () => {
      const reader = subscription.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const payload = extractSseData(frame);
            if (payload === null) continue;
            const event = tryParseSessionEvent(payload);
            if (event) busEvents.push(event);
            if (event?.type === 'turn.completed') return;
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    })().catch(() => {});

    const res = await postMessage(
      `/sessions/${sessionId}/messages`,
      { content: 'What is my name? Reply with only my name.' },
      ownerId,
    );
    expect(res.status).toBe(200);
    const completed = completedEvent(res.events);
    const started = res.events.find(
      (e): e is Extract<SessionEvent, { type: 'turn.started' }> => e.type === 'turn.started',
    )!;
    turnIds.push(started.turnId);

    // Continuity: only the newest message was sent; recall proves gateway
    // session state (x-openclaw-session-key + server-side history).
    expect(tokenText(res.events).toLowerCase()).toContain(codename.toLowerCase());

    // The bus saw the same turn (bounded wait — the POST already finished, so
    // the bus copy of turn.completed is at most milliseconds behind).
    await Promise.race([busDone, new Promise((resolve) => setTimeout(resolve, 20_000))]);
    controller.abort();
    const busStarted = busEvents.find(
      (e): e is Extract<SessionEvent, { type: 'turn.started' }> => e.type === 'turn.started',
    );
    expect(busStarted?.turnId).toBe(started.turnId);
    const busCompleted = busEvents.find(
      (e): e is Extract<SessionEvent, { type: 'turn.completed' }> => e.type === 'turn.completed',
    );
    expect(busCompleted?.messageId).toBe(completed.messageId);
    expect(busEvents.some((e) => e.type === 'token')).toBe(true);
  }, 120_000);

  it('persisted both turns: messages, counters, gateway key, manna ledger', async () => {
    const [session] = await pg<
      {
        ownerId: string;
        gatewaySessionKey: string;
        gatewayPrimedAt: Date | null;
        messageCount: number;
        lastMessageAt: Date | null;
        title: string | null;
      }[]
    >`
      select owner_id as "ownerId", gateway_session_key as "gatewaySessionKey",
             gateway_primed_at as "gatewayPrimedAt", message_count as "messageCount",
             last_message_at as "lastMessageAt", title
      from sessions where id = ${sessionId}`;
    expect(session).toBeDefined();
    expect(session!.ownerId).toBe(ownerId);
    expect(session!.gatewaySessionKey).toBe(`${GATEWAY_SESSION_KEY_PREFIX}${sessionId}`);
    expect(session!.gatewayPrimedAt).toBeNull(); // native session — never primed
    expect(session!.messageCount).toBeGreaterThanOrEqual(4);
    expect(session!.lastMessageAt).not.toBeNull();
    expect(session!.title).toContain(codename); // derived from the first message

    const rows = await pg<
      { role: string; content: string; senderId: string; edenMessageData: unknown }[]
    >`
      select role, content, sender_id as "senderId", eden_message_data as "edenMessageData"
      from messages where session_id = ${sessionId} order by created_at asc`;
    const users = rows.filter((r) => r.role === 'user');
    const assistants = rows.filter((r) => r.role === 'assistant');
    expect(users.length).toBe(2);
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    expect(users[0]!.content).toContain(codename);
    expect(users.every((r) => r.senderId === ownerId)).toBe(true);
    expect(assistants.every((r) => r.senderId === agentAccountId)).toBe(true);
    expect(assistants.every((r) => (r.content ?? '').length > 0)).toBe(true);
    // usage lands in eden_message_data (no dedicated column). History sync may
    // also insert gateway-only assistant rows whose metadata is null, and their
    // gateway timestamp can sort before the locally persisted turn. Select the
    // row by the durable turn id instead of depending on assistant row order.
    const firstTurnAssistant = assistants.find((row) => {
      const data = row.edenMessageData as { turnId?: string } | null;
      return data?.turnId === turnIds[0];
    });
    expect(firstTurnAssistant).toBeDefined();
    const meta = firstTurnAssistant!.edenMessageData as {
      kind?: string;
      turnId?: string;
      usage?: { promptTokens?: number };
    };
    expect(meta.kind).toBe('chat_turn');
    expect(meta.turnId).toBe(turnIds[0]);
    expect(meta.usage?.promptTokens).toBeGreaterThan(0);

    const usage = await pg<{ turnId: string; status: string; manna: number | null }[]>`
      select turn_id as "turnId", status, manna
      from usage_events
      where turn_id = any(${turnIds}::uuid[])
      order by created_at asc`;
    expect(usage).toHaveLength(2);
    expect(usage.map((row) => row.turnId)).toEqual(turnIds);
    expect(usage.every((row) => row.status === 'completed' && row.manna !== null)).toBe(true);
    const meteredManna = usage.reduce((sum, row) => sum + (row.manna ?? 0), 0);

    // Manna: each turn reserves 1 upfront, then settles to usage_events.manna.
    const ledger = await pg<{ amount: string; type: string; idempotencyKey: string }[]>`
      select mt.amount, mt.type, mt.idempotency_key as "idempotencyKey"
      from manna_transactions mt
      join manna_accounts ma on ma.id = mt.manna_account_id
      where ma.account_id = ${ownerId} order by mt.created_at asc`;
    const reserves = ledger.filter((tx) => tx.type === 'spend:chat');
    expect(reserves.map((tx) => [Number(tx.amount), tx.idempotencyKey])).toEqual(
      turnIds.map((id) => [-1, id]),
    );
    const netMannaCharged = -ledger.reduce((sum, tx) => sum + Number(tx.amount), 0);
    expect(netMannaCharged).toBe(meteredManna);
    const [balance] = await pg<{ balance: string; subscriptionBalance: string }[]>`
      select balance, subscription_balance as "subscriptionBalance"
      from manna_accounts where account_id = ${ownerId}`;
    expect(Number(balance!.balance) + Number(balance!.subscriptionBalance)).toBe(100 - meteredManna);
  });

  it('trailing history-sync backfills gateway message ids onto streamed rows', async () => {
    // The post-turn trailing sync (120s window / 15s cadence, first pass
    // immediate) matches our rows by (role, content) and stamps gw:<id>.
    const synced = await eventually(async () => {
      const rows = await pg<{ count: string }[]>`
        select count(*) from messages
        where session_id = ${sessionId} and external_id like 'gw:%'`;
      const count = Number(rows[0]!.count);
      return count >= 4 ? count : null;
    });
    expect(synced).toBeGreaterThanOrEqual(4);
  }, 60_000);
});

describe('GET /sessions + GET /sessions/:id (live postgres)', () => {
  it('lists the session for its owner (valid DTOs, newest first)', async () => {
    const { status, json } = await getJson<{ sessions: SessionDto[]; nextCursor: string | null }>(
      '/sessions',
      ownerId,
    );
    expect(status).toBe(200);
    const mine = json.sessions.find((s) => s.id === sessionId);
    expect(mine).toBeDefined();
    sessionDto.parse(mine); // contract check
    expect(mine!.agentIds).toContain(agentAccountId);
    expect(mine!.agents?.some((a) => a.username === agentUsername)).toBe(true);
    expect(mine!.userIds).toContain(ownerId);
    expect(mine!.messageCount).toBeGreaterThanOrEqual(4);
    // Ordering: last_message_at desc (nulls last) — our fresh session precedes
    // the 30-day-old migrated fixture.
    const ids = json.sessions.map((s) => s.id);
    expect(ids.indexOf(sessionId)).toBeLessThan(ids.indexOf(migratedSessionId));
  });

  it('pages the session list with the keyset cursor', async () => {
    const first = await getJson<{ sessions: SessionDto[]; nextCursor: string | null }>(
      '/sessions?limit=1',
      ownerId,
    );
    expect(first.status).toBe(200);
    expect(first.json.sessions).toHaveLength(1);
    expect(first.json.sessions[0]!.id).toBe(sessionId); // newest activity first
    expect(first.json.nextCursor).toBeTruthy();

    const second = await getJson<{ sessions: SessionDto[]; nextCursor: string | null }>(
      `/sessions?limit=1&cursor=${encodeURIComponent(first.json.nextCursor!)}`,
      ownerId,
    );
    expect(second.status).toBe(200);
    expect(second.json.sessions.some((s) => s.id === migratedSessionId)).toBe(true);
    expect(second.json.sessions.some((s) => s.id === sessionId)).toBe(false); // no overlap

    const bad = await getJson<{ error: { code: string } }>('/sessions?cursor=%25garbage', ownerId);
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('bad_cursor');
  });

  it('does not leak the session to another user (list + detail 403)', async () => {
    const list = await getJson<{ sessions: SessionDto[] }>('/sessions', brokeId);
    expect(list.status).toBe(200);
    expect(list.json.sessions.find((s) => s.id === sessionId)).toBeUndefined();

    const detail = await getJson<{ error: { code: string } }>(`/sessions/${sessionId}`, brokeId);
    expect(detail.status).toBe(403);
    expect(detail.json.error.code).toBe('forbidden');
  });

  it('returns the session detail with messages ascending + embedded senders', async () => {
    const { status, json } = await getJson<{
      session: SessionDto;
      messages: MessageDto[];
      nextCursor: string | null;
    }>(`/sessions/${sessionId}`, ownerId);
    expect(status).toBe(200);
    sessionDto.parse(json.session);
    expect(json.messages.length).toBeGreaterThanOrEqual(4);
    for (const message of json.messages) messageDto.parse(message);

    const times = json.messages.map((m) => new Date(m.createdAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times); // ascending
    expect(json.messages[0]!.role).toBe('user');
    expect(json.messages[0]!.content).toContain(codename);
    expect(json.messages[0]!.sender?.username).toBe(usernames.owner);
    const assistant = json.messages.find((m) => m.role === 'assistant');
    expect(assistant?.sender?.username).toBe(agentUsername);
  });

  it('pages messages with the keyset cursor (older page via nextCursor)', async () => {
    const first = await getJson<{ messages: MessageDto[]; nextCursor: string | null }>(
      `/sessions/${sessionId}?limit=2`,
      ownerId,
    );
    expect(first.status).toBe(200);
    expect(first.json.messages.length).toBe(2);
    expect(first.json.nextCursor).toBeTruthy();

    const older = await getJson<{ messages: MessageDto[]; nextCursor: string | null }>(
      `/sessions/${sessionId}?limit=2&cursor=${encodeURIComponent(first.json.nextCursor!)}`,
      ownerId,
    );
    expect(older.status).toBe(200);
    expect(older.json.messages.length).toBeGreaterThanOrEqual(1);
    const newestOfOlder = new Date(older.json.messages.at(-1)!.createdAt).getTime();
    const oldestOfFirst = new Date(first.json.messages[0]!.createdAt).getTime();
    expect(newestOfOlder).toBeLessThanOrEqual(oldestOfFirst);
    const ids = new Set(first.json.messages.map((m) => m.id));
    expect(older.json.messages.some((m) => ids.has(m.id))).toBe(false); // no overlap
  });

  it('resolves a legacy 24-hex permalink id', async () => {
    const { status, json } = await getJson<{ session: SessionDto }>(
      `/sessions/${migratedExternalId}`,
      ownerId,
    );
    expect(status).toBe(200);
    expect(json.session.id).toBe(migratedSessionId);
    expect(json.session.externalId).toBe(migratedExternalId);
  });
});

describe('manna guard + continue-priming (live gateway + postgres)', () => {
  it('402s with the envelope when the account cannot afford the turn', async () => {
    const res = await fetch(`${baseUrl}/sessions/new/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieFor(brokeId) },
      body: JSON.stringify({ content: 'hello?', agentUsername }),
    });
    expect(res.status).toBe(402);
    const json = (await res.json()) as { error: { code: string; statusCode: number } };
    expect(json.error.code).toBe('insufficient_manna');
    expect(json.error.statusCode).toBe(402);

    // No debit happened; the pre-created session row exists but is empty
    // (documented ordering: session creation precedes the debit).
    const txs = await pg<{ count: string }[]>`
      select count(*) from manna_transactions mt
      join manna_accounts ma on ma.id = mt.manna_account_id
      where ma.account_id = ${brokeId}`;
    expect(Number(txs[0]!.count)).toBe(0);
    const msgs = await pg<{ count: string }[]>`
      select count(*) from messages m
      join sessions s on s.id = m.session_id
      where s.owner_id = ${brokeId}`;
    expect(Number(msgs[0]!.count)).toBe(0);
  });

  it('primes a migrated session on first contact (recall from Postgres-only history)', async () => {
    // Before: no gateway key, never primed — the gateway has NEVER seen this
    // conversation. The dragonfruit fact exists only in migrated Postgres rows.
    const res = await postMessage(
      `/sessions/${migratedSessionId}/messages`,
      { content: 'What is my favorite fruit? Answer with just the fruit name.' },
      ownerId,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-session-id')).toBe(migratedSessionId);
    completedEvent(res.events);
    expect(res.events.filter((e) => e.type === 'error')).toEqual([]);

    // Recall proves the primer block reached the agent.
    expect(tokenText(res.events).toLowerCase()).toContain('dragonfruit');

    const [row] = await pg<
      { gatewaySessionKey: string | null; gatewayPrimedAt: Date | null; messageCount: number }[]
    >`
      select gateway_session_key as "gatewaySessionKey",
             gateway_primed_at as "gatewayPrimedAt",
             message_count as "messageCount"
      from sessions where id = ${migratedSessionId}`;
    expect(row!.gatewaySessionKey).toBe(`${GATEWAY_SESSION_KEY_PREFIX}${migratedSessionId}`);
    expect(row!.gatewayPrimedAt).not.toBeNull(); // marked once the gateway accepted
    expect(row!.messageCount).toBeGreaterThanOrEqual(4); // 2 old + user + assistant

    // The user message row is VERBATIM (primer is gateway-only).
    const [userRow] = await pg<{ content: string }[]>`
      select content from messages
      where session_id = ${migratedSessionId} and role = 'user'
      order by created_at desc limit 1`;
    expect(userRow!.content).toBe('What is my favorite fruit? Answer with just the fruit name.');

    // Second contact must NOT re-prime (gateway_primed_at set) — and the
    // trailing sync must not have duplicated the primed user message.
    const dupes = await pg<{ count: string }[]>`
      select count(*) from messages
      where session_id = ${migratedSessionId}
        and role = 'user' and content like '%Resumed Eden conversation%'`;
    expect(Number(dupes[0]!.count)).toBe(0);
  }, 120_000);
});
