import { randomUUID } from 'node:crypto';

import type { AuthSession } from '@eden3/core';
import { credit, gatewaySessionKey } from '@eden3/core';
import { db, pg, sessions, type Session } from '@eden3/db';
import { NO_RESPONSE_SENTINEL, type GatewayTurnEvent } from '@eden3/gateway';
import type { SessionEvent } from '@eden3/shared';
import { afterAll, describe, expect, it } from 'vitest';

import { EventsBus } from '../src/events-bus';
import { HistorySync } from '../src/services/history-sync';
import { TurnRegistry } from '../src/services/turn-registry';
import { runTurn, type CompatClientLike, type TurnSink } from '../src/services/turns';

const marker = `turnusage_${randomUUID().slice(0, 8)}`;

interface Fixture {
  user: AuthSession;
  agent: { accountId: string; username: string; openclawId: string; model?: string; thinkingLevel?: string };
  session: Session;
}

function makeDeps(compat: CompatClientLike) {
  return {
    compat,
    bus: new EventsBus(),
    registry: new TurnRegistry(),
    historySync: new HistorySync({
      tools: {
        sessionsHistory: async () => ({
          sessionKey: '',
          messages: [],
          truncated: false,
          contentTruncated: false,
        }),
      },
    }),
  };
}

function sink(): TurnSink {
  return { emit() {}, end() {} };
}

async function makeFixture(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await pg<{ id: string; username: string }[]>`
    insert into accounts (type, username)
    values ('user', ${`${marker}_user_${suffix}`})
    returning id, username`;
  const [agentAccount] = await pg<{ id: string; username: string }[]>`
    insert into accounts (type, username)
    values ('agent', ${`${marker}_agent_${suffix}`})
    returning id, username`;
  if (!user || !agentAccount) throw new Error('fixture account insert failed');

  await pg`
    insert into agents (account_id, openclaw_id, provision_status)
    values (${agentAccount.id}, ${`${marker}_agent_${suffix}`}, 'ready')`;

  const sessionId = randomUUID();
  const [session] = await db
    .insert(sessions)
    .values({
      id: sessionId,
      ownerId: user.id,
      title: `${marker} session ${suffix}`,
      sessionType: 'chat',
      gatewaySessionKey: gatewaySessionKey(sessionId),
    })
    .returning();
  if (!session) throw new Error('fixture session insert failed');

  await pg`
    insert into session_agents (session_id, agent_account_id)
    values (${session.id}, ${agentAccount.id})`;
  await pg`
    insert into session_users (session_id, user_account_id)
    values (${session.id}, ${user.id})`;
  await credit({ accountId: user.id, amount: 5_000, type: 'credit:test' });

  return {
    user: { accountId: user.id, username: user.username, isAdmin: false },
    agent: {
      accountId: agentAccount.id,
      username: agentAccount.username,
      openclawId: `${marker}_agent_${suffix}`,
    },
    session,
  };
}

afterAll(async () => {
  await pg`delete from usage_events where user_id in
           (select id from accounts where username::text like ${`${marker}%`})
           or agent_id in (select id from accounts where username::text like ${`${marker}%`})`;
  await pg`delete from messages where session_id in
           (select id from sessions where title like ${`${marker}%`})`;
  await pg`delete from session_agents where session_id in
           (select id from sessions where title like ${`${marker}%`})`;
  await pg`delete from session_users where session_id in
           (select id from sessions where title like ${`${marker}%`})`;
  await pg`delete from sessions where title like ${`${marker}%`}`;
  await pg`delete from manna_transactions where manna_account_id in
           (select m.id from manna_accounts m join accounts a on a.id = m.account_id
            where a.username::text like ${`${marker}%`})`;
  await pg`delete from manna_accounts where account_id in
           (select id from accounts where username::text like ${`${marker}%`})`;
  await pg`delete from agents where account_id in
           (select id from accounts where username::text like ${`${marker}%`})`;
  await pg`delete from accounts where username::text like ${`${marker}%`}`;
  await pg.end({ timeout: 5 });
}, 30_000);

describe('runTurn usage events', () => {
  it('records completed chat usage, cost, manna, and attribution in Postgres', async () => {
    const fixture = await makeFixture();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield { type: 'token', delta: 'hello' };
        yield {
          type: 'turn.completed',
          text: 'hello back',
          emptyTurn: false,
          finishReason: 'stop',
          usage: {
            promptTokens: 1_000_000,
            completionTokens: 100_000,
            totalTokens: 1_100_000,
          },
        };
      },
    };

    const outcome = await runTurn(makeDeps(compat), {
      session: fixture.session,
      agent: fixture.agent,
      user: fixture.user,
      content: 'hello',
      beginStream: sink,
    });

    const rows = await pg<
      Array<{
        event_type: string;
        status: string;
        user_id: string;
        agent_id: string;
        session_id: string;
        message_id: string | null;
        provider: string | null;
        model: string | null;
        prompt_tokens: number | null;
        completion_tokens: number | null;
        total_tokens: number | null;
        cost_usd: string | null;
        manna: number | null;
        latency_ms: number | null;
        metadata: { metering?: { status?: string; costUsd?: number } } | null;
      }>
    >`
      select event_type, status, user_id, agent_id, session_id, message_id,
             provider, model, prompt_tokens, completion_tokens, total_tokens,
             cost_usd, manna, latency_ms, metadata
      from usage_events
      where turn_id = ${outcome.turnId}`;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'chat_turn',
      status: 'completed',
      user_id: fixture.user.accountId,
      agent_id: fixture.agent.accountId,
      session_id: fixture.session.id,
      message_id: outcome.assistantMessageId,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      prompt_tokens: 1_000_000,
      completion_tokens: 100_000,
      total_tokens: 1_100_000,
      cost_usd: '1.50000000',
      manna: 2025,
    });
    expect(rows[0]!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(rows[0]!.metadata?.metering).toMatchObject({ status: 'metered', costUsd: 1.5 });

    const ledger = await pg<{ type: string; amount: string; idempotency_key: string | null }[]>`
      select type, amount, idempotency_key
      from manna_transactions
      where manna_account_id in (select id from manna_accounts where account_id = ${fixture.user.accountId})
      order by created_at asc`;
    expect(ledger.map((row) => [row.type, Number(row.amount), row.idempotency_key])).toContainEqual([
      'spend:chat',
      -1,
      outcome.turnId,
    ]);
    expect(ledger.map((row) => [row.type, Number(row.amount), row.idempotency_key])).toContainEqual([
      'spend:chat:settle',
      -2024,
      `${outcome.turnId}:settle`,
    ]);
  });

  it('persists empty media turns without the OpenClaw filler and emits media.pending', async () => {
    const fixture = await makeFixture();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: '',
          emptyTurn: true,
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 0,
            totalTokens: 10,
          },
        };
      },
    };
    const emitted: SessionEvent[] = [];

    const outcome = await runTurn(makeDeps(compat), {
      session: fixture.session,
      agent: fixture.agent,
      user: fixture.user,
      content: 'make an image',
      beginStream: () => ({
        emit(event) {
          emitted.push(event);
        },
        end() {},
      }),
    });

    expect(outcome.assistantMessageId).toBeTruthy();
    const [assistant] = await pg<
      { content: string | null; edenMessageData: { emptyTurn?: boolean } | null }[]
    >`
      select content, eden_message_data as "edenMessageData"
      from messages where id = ${outcome.assistantMessageId}`;
    expect(assistant?.content).toBe('');
    expect(assistant?.content).not.toBe(NO_RESPONSE_SENTINEL);
    expect(assistant?.edenMessageData?.emptyTurn).toBe(true);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'media.pending', sessionId: fixture.session.id }),
        expect.objectContaining({ type: 'turn.completed', messageId: outcome.assistantMessageId }),
      ]),
    );
    expect(JSON.stringify(emitted)).not.toContain(NO_RESPONSE_SENTINEL);
  });

  it('records the selected agent model and thinking level in usage metadata', async () => {
    const fixture = await makeFixture();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield { type: 'token', delta: 'deep' };
        yield {
          type: 'turn.completed',
          text: 'deep answer',
          emptyTurn: false,
          finishReason: 'stop',
          usage: {
            promptTokens: 100_000,
            completionTokens: 10_000,
            totalTokens: 110_000,
          },
        };
      },
    };

    const outcome = await runTurn(makeDeps(compat), {
      session: fixture.session,
      agent: {
        ...fixture.agent,
        model: 'anthropic/claude-sonnet-4-5',
        thinkingLevel: 'deep',
      },
      user: fixture.user,
      content: 'think harder',
      beginStream: sink,
    });

    const [row] = await pg<
      {
        model: string | null;
        cost_usd: string | null;
        manna: number | null;
        metadata: { agentConfig?: { model?: string; thinkingLevel?: string } } | null;
      }[]
    >`
      select model, cost_usd, manna, metadata
      from usage_events
      where turn_id = ${outcome.turnId}
    `;

    expect(row).toMatchObject({
      model: 'claude-sonnet-4-5',
      cost_usd: '0.45000000',
      manna: 608,
    });
    expect(row?.metadata?.agentConfig).toEqual({
      model: 'anthropic/claude-sonnet-4-5',
      thinkingLevel: 'deep',
    });
  });

  it('records cached prompt tokens and charges them at the cache-read rate', async () => {
    const fixture = await makeFixture();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'warm cache answer',
          emptyTurn: false,
          finishReason: 'stop',
          usage: {
            promptTokens: 1_000_000,
            cachedTokens: 900_000,
            completionTokens: 0,
            totalTokens: 1_000_000,
          },
        };
      },
    };

    const outcome = await runTurn(makeDeps(compat), {
      session: fixture.session,
      agent: fixture.agent,
      user: fixture.user,
      content: 'repeat context',
      beginStream: sink,
    });

    const [row] = await pg<
      Array<{
        cachedTokens: number | null;
        costUsd: string | null;
        manna: number | null;
        metadata: {
          metering?: {
            status?: string;
            lineItems?: Array<{ unit: string; quantity: number; costUsd: number }>;
          };
        } | null;
      }>
    >`
      select cached_tokens as "cachedTokens", cost_usd as "costUsd", manna, metadata
      from usage_events
      where turn_id = ${outcome.turnId}
    `;

    expect(row).toMatchObject({
      cachedTokens: 900_000,
      costUsd: '0.19000000',
      manna: 257,
    });
    expect(row?.metadata?.metering).toMatchObject({ status: 'metered' });
    const cacheLine = row?.metadata?.metering?.lineItems?.find(
      (line) => line.unit === 'cache_read_1m_tokens',
    );
    expect(cacheLine).toMatchObject({ quantity: 0.9 });
    expect(cacheLine!.costUsd).toBeCloseTo(0.09, 10);
  });

  it('ignores duplicate gateway completion events without double-persisting or double-charging', async () => {
    const fixture = await makeFixture();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'once',
          emptyTurn: false,
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 1,
            totalTokens: 11,
          },
        };
        yield {
          type: 'turn.completed',
          text: 'twice',
          emptyTurn: false,
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 1,
            totalTokens: 11,
          },
        };
      },
    };
    const sideErrors: string[] = [];

    const outcome = await runTurn(
      {
        ...makeDeps(compat),
        onError: (_err, context) => sideErrors.push(context),
      },
      {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'hello',
        beginStream: sink,
      },
    );

    expect(outcome.errorCode).toBeNull();
    expect(sideErrors).toContain('duplicate gateway completion');
    const assistantRows = await pg<{ content: string | null }[]>`
      select content from messages
      where session_id = ${fixture.session.id} and role = 'assistant'
    `;
    expect(assistantRows.map((row) => row.content)).toEqual(['once']);
    const [usageCount] = await pg<{ count: string }[]>`
      select count(*)::text as count from usage_events where turn_id = ${outcome.turnId}
    `;
    expect(Number(usageCount!.count)).toBe(1);
    const [spendCount] = await pg<{ count: string }[]>`
      select count(*)::text as count
      from manna_transactions
      where manna_account_id in (select id from manna_accounts where account_id = ${fixture.user.accountId})
        and type like 'spend%'
        and idempotency_key = ${outcome.turnId}
    `;
    expect(Number(spendCount!.count)).toBe(1);
  });

  it('continues persisting and settling after the POST SSE sink disconnects', async () => {
    const fixture = await makeFixture();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield { type: 'token', delta: 'still ' };
        yield { type: 'token', delta: 'running' };
        yield {
          type: 'turn.completed',
          text: 'still running',
          emptyTurn: false,
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 1,
            totalTokens: 11,
          },
        };
      },
    };
    const sideErrors: string[] = [];

    const outcome = await runTurn(
      {
        ...makeDeps(compat),
        onError: (_err, context) => sideErrors.push(context),
      },
      {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'hello',
        beginStream: () => ({
          emit() {
            throw new Error('client disconnected');
          },
          end() {
            throw new Error('client disconnected');
          },
        }),
      },
    );

    expect(outcome.errorCode).toBeNull();
    expect(sideErrors).toContain('sse sink emit');
    expect(sideErrors).toContain('sse sink end');
    const [assistant] = await pg<{ content: string | null }[]>`
      select content from messages where id = ${outcome.assistantMessageId}
    `;
    expect(assistant?.content).toBe('still running');
    const [usage] = await pg<{ status: string; count: string }[]>`
      select min(status) as status, count(*)::text as count
      from usage_events
      where turn_id = ${outcome.turnId}
    `;
    expect(usage).toMatchObject({ status: 'completed', count: '1' });
    const ledger = await pg<{ type: string; amount: string }[]>`
      select type, amount
      from manna_transactions
      where manna_account_id in (select id from manna_accounts where account_id = ${fixture.user.accountId})
      order by created_at asc
    `;
    expect(ledger.filter((row) => row.type === 'spend:chat' && Number(row.amount) === -1)).toHaveLength(1);
    expect(ledger.some((row) => row.type === 'refund:chat')).toBe(false);
  });

  it('treats the first terminal event as final: error then completion refunds only once', async () => {
    const fixture = await makeFixture();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield { type: 'error', code: 'gateway_upstream_error', message: 'provider failed' };
        yield { type: 'token', delta: 'too late' };
        yield {
          type: 'turn.completed',
          text: 'too late',
          emptyTurn: false,
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 1,
            totalTokens: 11,
          },
        };
      },
    };
    const sideErrors: string[] = [];

    const outcome = await runTurn(
      {
        ...makeDeps(compat),
        onError: (_err, context) => sideErrors.push(context),
      },
      {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'hello',
        beginStream: sink,
      },
    );

    expect(outcome.errorCode).toBe('gateway_upstream_error');
    expect(outcome.assistantMessageId).toBeNull();
    expect(sideErrors).toEqual(
      expect.arrayContaining(['post-terminal gateway token', 'post-error gateway completion']),
    );
    const assistantRows = await pg<{ count: string }[]>`
      select count(*)::text as count
      from messages
      where session_id = ${fixture.session.id} and role = 'assistant'
    `;
    expect(Number(assistantRows[0]!.count)).toBe(0);
    const usageRows = await pg<{ status: string; count: string }[]>`
      select min(status) as status, count(*)::text as count
      from usage_events
      where turn_id = ${outcome.turnId}
    `;
    expect(usageRows[0]).toMatchObject({ status: 'error', count: '1' });
    const ledger = await pg<{ type: string; amount: string }[]>`
      select type, amount
      from manna_transactions
      where manna_account_id in (select id from manna_accounts where account_id = ${fixture.user.accountId})
      order by created_at asc
    `;
    expect(ledger.map((row) => [row.type, Number(row.amount)])).toEqual(
      expect.arrayContaining([
        ['spend:chat', -1],
        ['refund:chat', 1],
      ]),
    );
    expect(ledger.filter((row) => row.type === 'refund:chat')).toHaveLength(1);
  });

  it('treats the first terminal event as final: completion then error never refunds success', async () => {
    const fixture = await makeFixture();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'done',
          emptyTurn: false,
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 1,
            totalTokens: 11,
          },
        };
        yield { type: 'error', code: 'late_error', message: 'too late' };
      },
    };
    const sideErrors: string[] = [];

    const outcome = await runTurn(
      {
        ...makeDeps(compat),
        onError: (_err, context) => sideErrors.push(context),
      },
      {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'hello',
        beginStream: sink,
      },
    );

    expect(outcome.errorCode).toBeNull();
    expect(sideErrors).toContain('post-terminal gateway error');
    const [assistant] = await pg<{ content: string | null }[]>`
      select content from messages where id = ${outcome.assistantMessageId}
    `;
    expect(assistant?.content).toBe('done');
    const [usage] = await pg<{ status: string; count: string }[]>`
      select min(status) as status, count(*)::text as count
      from usage_events
      where turn_id = ${outcome.turnId}
    `;
    expect(usage).toMatchObject({ status: 'completed', count: '1' });
    const refunds = await pg<{ count: string }[]>`
      select count(*)::text as count
      from manna_transactions
      where manna_account_id in (select id from manna_accounts where account_id = ${fixture.user.accountId})
        and type = 'refund:chat'
    `;
    expect(Number(refunds[0]!.count)).toBe(0);
  });
});
