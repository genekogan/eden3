import { randomUUID } from 'node:crypto';

import type { AuthSession } from '@eden3/core';
import { credit, gatewaySessionKey, resetEnvCache } from '@eden3/core';
import { db, pg, sessions, type Session } from '@eden3/db';
import {
  NO_RESPONSE_SENTINEL,
  type ClaudeTranscriptUsageCaptureLike,
  type GatewayTurnEvent,
} from '@eden3/gateway';
import type { AgentRuntime, SessionEvent } from '@eden3/shared';
import { afterAll, describe, expect, it } from 'vitest';

import { EventsBus } from '../src/events-bus';
import { HistorySync } from '../src/services/history-sync';
import { automationMannaSpendLastHour } from '../src/services/automation-budget';
import type { SubscriptionTurnClaimsLike } from '../src/services/subscription-turn-claims';
import { TurnRegistry } from '../src/services/turn-registry';
import { runTurn, type CompatClientLike, type TurnSink } from '../src/services/turns';

const marker = `turnusage_${randomUUID().slice(0, 8)}`;

interface Fixture {
  user: AuthSession;
  agent: {
    accountId: string;
    username: string;
    openclawId: string;
    model: string;
    agentRuntime: AgentRuntime;
    thinkingLevel?: string;
  };
  session: Session;
}

function makeDeps(
  compat: CompatClientLike,
  claudeUsageCapture?: ClaudeTranscriptUsageCaptureLike,
  subscriptionTurnClaims: SubscriptionTurnClaimsLike = {
    acquire: async () => ({ release: async () => {} }),
  },
) {
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
    subscriptionTurnClaims,
    ...(claudeUsageCapture ? { claudeUsageCapture } : {}),
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
      model: 'anthropic/claude-haiku-4-5',
      agentRuntime: 'openclaw',
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
  it('fails and fully refunds an actual token charge that exceeds the post-reserve daily cap', async () => {
    const fixture = await makeFixture();
    const previous = process.env.DAILY_MANNA_SPEND_CAP_PER_USER;
    process.env.DAILY_MANNA_SPEND_CAP_PER_USER = '2';
    resetEnvCache();
    const emitted: SessionEvent[] = [];
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'must not become an under-billed success',
          emptyTurn: false,
          usage: { promptTokens: 40_000, completionTokens: 0, totalTokens: 40_000 },
        };
      },
    };
    try {
      const outcome = await runTurn(makeDeps(compat), {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'daily cap edge',
        source: {
          kind: 'scheduled_task',
          triggerId: randomUUID(),
        },
        beginStream: () => ({
          emit(event) {
            emitted.push(event);
          },
          end() {},
        }),
      });

      expect(outcome).toMatchObject({
        assistantMessageId: null,
        errorCode: 'daily_manna_cap_exceeded',
      });
      expect(emitted).toContainEqual(
        expect.objectContaining({ type: 'error', code: 'daily_manna_cap_exceeded' }),
      );
      const [usage] = await pg<{
        status: string;
        manna: number | null;
        metadata: { settlement?: { chargedManna?: number; meteredManna?: number } } | null;
      }[]>`
        select status, manna, metadata from usage_events where turn_id = ${outcome.turnId}
      `;
      expect(usage).toMatchObject({
        status: 'error',
        manna: 0,
        metadata: { settlement: { chargedManna: 0 } },
      });
      expect(usage!.metadata?.settlement?.meteredManna).toBeGreaterThan(2);
      const [net] = await pg<{ spend: string }[]>`
        select coalesce(sum(case
          when type like 'spend%' and amount < 0 then -amount
          when type like 'refund%' and amount > 0 then -amount
          else 0 end), 0)::text as spend
        from manna_transactions
        where manna_account_id in (
          select id from manna_accounts where account_id = ${fixture.user.accountId}
        )
      `;
      expect(Number(net!.spend)).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.DAILY_MANNA_SPEND_CAP_PER_USER;
      else process.env.DAILY_MANNA_SPEND_CAP_PER_USER = previous;
      resetEnvCache();
    }
  });

  it('serializes concurrent actual-cost settlements under the strict agent-hour cap', async () => {
    const fixture = await makeFixture();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'bounded automation output',
          emptyTurn: false,
          // Haiku input pricing makes this 54 manna: each fits alone, but two
          // concurrent settlements cannot both fit the 80-manna rolling cap.
          usage: { promptTokens: 40_000, completionTokens: 0, totalTokens: 40_000 },
        };
      },
    };
    const run = () =>
      runTurn(makeDeps(compat), {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'concurrent automation',
        source: { kind: 'scheduled_task' as const, triggerId: randomUUID() },
        beginStream: sink,
      });

    const outcomes = await Promise.all([run(), run()]);
    expect(outcomes.map((outcome) => outcome.errorCode).sort()).toEqual([
      null,
      'automation_hourly_budget_exceeded',
    ].sort());
    expect(await automationMannaSpendLastHour(fixture.agent.accountId)).toBe(54);
    const rows = await pg<{ status: string; manna: number | null }[]>`
      select status, manna from usage_events
      where turn_id in (${outcomes[0]!.turnId}, ${outcomes[1]!.turnId})
      order by status, manna
    `;
    expect(rows).toEqual([
      { status: 'completed', manna: 54 },
      { status: 'error', manna: 0 },
    ]);
    expect(outcomes.filter((outcome) => outcome.assistantMessageId !== null)).toHaveLength(1);
  });

  it.each([
    ['openclaw', 'provider-api'],
    ['claude-cli', 'notional-subscription'],
  ] as const)(
    'records a memory_dream usage row and dedicated ledger types under %s',
    async (agentRuntime, expectedBasis) => {
      const fixture = await makeFixture();
      const compatCalls: Array<{ modelOverride?: string }> = [];
      const compat: CompatClientLike = {
        async *chatTurn(params): AsyncGenerator<GatewayTurnEvent, void, void> {
          compatCalls.push(params);
          yield { type: 'turn.started' };
          yield {
            type: 'turn.completed',
            text: 'REM complete',
            emptyTurn: false,
            usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
          };
        },
      };
      const outcome = await runTurn(
        makeDeps(compat, { capture: async () => undefined }),
        {
          session: fixture.session,
          agent: {
            ...fixture.agent,
            model: 'anthropic/claude-sonnet-4-6',
            gatewayModelOverride: 'anthropic/claude-sonnet-4-6',
            agentRuntime,
          },
          user: fixture.user,
          content: 'internal REM sweep',
          source: { kind: 'memory_dream', sweepId: randomUUID(), runId: randomUUID() },
          beginStream: sink,
        },
      );

      expect(compatCalls).toEqual([
        expect.objectContaining({ modelOverride: 'anthropic/claude-sonnet-4-6' }),
      ]);
      const [usage] = await pg<{
        event_type: string;
        model: string | null;
        pricing_basis: string;
        metadata: { source?: { kind?: string } } | null;
      }[]>`
        select event_type, model, pricing_basis, metadata
        from usage_events where turn_id = ${outcome.turnId}
      `;
      expect(usage).toMatchObject({
        event_type: 'memory_dream',
        model: 'claude-sonnet-4-6',
        pricing_basis: expectedBasis,
        metadata: { source: { kind: 'memory_dream' } },
      });
      const ledger = await pg<{ type: string }[]>`
        select type from manna_transactions
        where idempotency_key = ${outcome.turnId}
      `;
      expect(ledger).toEqual([{ type: 'spend:memory-dream' }]);
    },
  );

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
        pricing_basis: string;
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
             provider, model, pricing_basis, prompt_tokens, completion_tokens, total_tokens,
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
      pricing_basis: 'provider-api',
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
        metadata: {
          agentConfig?: {
            model?: string;
            agentRuntime?: AgentRuntime;
            pricingBasis?: string;
            thinkingLevel?: string;
          };
        } | null;
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
      agentRuntime: 'openclaw',
      pricingBasis: 'provider-api',
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

  it('uses deduped Claude transcript usage and snapshots notional subscription pricing', async () => {
    const fixture = await makeFixture();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'subscription answer',
          emptyTurn: false,
          finishReason: 'stop',
          // Deliberately incomplete: transcript capture must replace this tail.
          usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        };
      },
    };
    const captureCalls: Array<{ agentId: string; sessionKey: string; startedAtMs: number }> = [];
    const capture: ClaudeTranscriptUsageCaptureLike = {
      async capture(params) {
        captureCalls.push(params);
        return {
          claudeSessionId: 'claude-session-test-1234',
          providerMessageIds: ['msg_1', 'msg_2'],
          models: ['claude-sonnet-4-6'],
          usage: {
            promptTokens: 1_000_000,
            cachedTokens: 900_000,
            cacheWriteTokens: 200_000,
            completionTokens: 10_000,
            totalTokens: 1_210_000,
          },
        };
      },
    };

    const outcome = await runTurn(makeDeps(compat, capture), {
      session: fixture.session,
      agent: {
        ...fixture.agent,
        model: 'anthropic/claude-sonnet-4-6',
        agentRuntime: 'claude-cli',
      },
      user: fixture.user,
      content: 'use my subscription',
      beginStream: sink,
    });

    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({
      agentId: fixture.agent.openclawId,
      sessionKey: fixture.session.gatewaySessionKey,
    });
    expect(captureCalls[0]!.startedAtMs).toBeGreaterThan(0);
    const [row] = await pg<
      Array<{
        pricingBasis: string;
        promptTokens: number | null;
        cachedTokens: number | null;
        cacheWriteTokens: number | null;
        completionTokens: number | null;
        costUsd: string | null;
        manna: number | null;
        metadata: {
          usageSource?: string;
          agentConfig?: { agentRuntime?: string; pricingBasis?: string };
          claudeTranscript?: {
            claudeSessionId?: string;
            providerMessageIds?: string[];
          };
        } | null;
      }>
    >`
      select pricing_basis as "pricingBasis",
             prompt_tokens as "promptTokens",
             cached_tokens as "cachedTokens",
             cache_write_tokens as "cacheWriteTokens",
             completion_tokens as "completionTokens",
             cost_usd as "costUsd", manna, metadata
      from usage_events
      where turn_id = ${outcome.turnId}
    `;

    expect(row).toMatchObject({
      pricingBasis: 'notional-subscription',
      promptTokens: 1_000_000,
      cachedTokens: 900_000,
      cacheWriteTokens: 200_000,
      completionTokens: 10_000,
      costUsd: '1.47000000',
      manna: 1985,
    });
    expect(row?.metadata).toMatchObject({
      usageSource: 'claude-transcript',
      agentConfig: {
        agentRuntime: 'claude-cli',
        pricingBasis: 'notional-subscription',
      },
      claudeTranscript: {
        claudeSessionId: 'claude-session-test-1234',
        providerMessageIds: ['msg_1', 'msg_2'],
      },
    });
  });

  it('rejects a concurrent same-session Claude turn before debit or transcript capture', async () => {
    const fixture = await makeFixture();
    let enterGateway!: () => void;
    const gatewayEntered = new Promise<void>((resolve) => {
      enterGateway = resolve;
    });
    let finishGateway!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      finishGateway = resolve;
    });
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        enterGateway();
        await mayFinish;
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'serialized answer',
          emptyTurn: false,
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        };
      },
    };
    let owner: string | null = null;
    const claims: SubscriptionTurnClaimsLike = {
      async acquire({ turnId }) {
        if (owner !== null) return null;
        owner = turnId;
        return {
          release: async () => {
            if (owner === turnId) owner = null;
          },
        };
      },
    };
    let captures = 0;
    const capture: ClaudeTranscriptUsageCaptureLike = {
      async capture() {
        captures += 1;
        return undefined;
      },
    };
    const turnParams = {
      session: fixture.session,
      agent: {
        ...fixture.agent,
        model: 'anthropic/claude-sonnet-4-6',
        agentRuntime: 'claude-cli' as const,
      },
      user: fixture.user,
      content: 'only once',
      beginStream: sink,
    };

    const first = runTurn(makeDeps(compat, capture, claims), turnParams);
    await gatewayEntered;
    await expect(
      runTurn(makeDeps(compat, capture, claims), turnParams),
    ).rejects.toMatchObject({ statusCode: 409, code: 'session_turn_in_progress' });
    expect(captures).toBe(0);

    finishGateway();
    const outcome = await first;
    expect(outcome.errorCode).toBeNull();
    expect(captures).toBe(1);
    expect(owner).toBeNull();
    const [messageCounts] = await pg<{ users: string; assistants: string }[]>`
      select
        count(*) filter (where role = 'user')::text as users,
        count(*) filter (where role = 'assistant')::text as assistants
      from messages where session_id = ${fixture.session.id}
    `;
    expect(messageCounts).toMatchObject({ users: '1', assistants: '1' });
    const [spendCount] = await pg<{ count: string }[]>`
      select count(*)::text as count
      from manna_transactions
      where manna_account_id in (
        select id from manna_accounts where account_id = ${fixture.user.accountId}
      ) and type = 'spend:chat'
    `;
    expect(Number(spendCount!.count)).toBe(1);
  });

  it('keeps compat-tail usage as the notional fallback when no transcript row is available', async () => {
    const fixture = await makeFixture();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'tail answer',
          emptyTurn: false,
          usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        };
      },
    };
    const capture: ClaudeTranscriptUsageCaptureLike = { capture: async () => undefined };
    const outcome = await runTurn(makeDeps(compat, capture), {
      session: fixture.session,
      agent: {
        ...fixture.agent,
        model: 'anthropic/claude-sonnet-4-6',
        agentRuntime: 'claude-cli',
      },
      user: fixture.user,
      content: 'fallback to tail',
      beginStream: sink,
    });
    const [row] = await pg<
      Array<{ pricingBasis: string; promptTokens: number | null; metadata: { usageSource?: string } | null }>
    >`
      select pricing_basis as "pricingBasis", prompt_tokens as "promptTokens", metadata
      from usage_events where turn_id = ${outcome.turnId}
    `;
    expect(row).toMatchObject({
      pricingBasis: 'notional-subscription',
      promptTokens: 100,
      metadata: { usageSource: 'compat-tail' },
    });
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
        agent: {
          ...fixture.agent,
          model: 'anthropic/claude-sonnet-4-6',
          agentRuntime: 'claude-cli',
        },
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
    const usageRows = await pg<{ status: string; pricing_basis: string; count: string }[]>`
      select min(status) as status, min(pricing_basis) as pricing_basis, count(*)::text as count
      from usage_events
      where turn_id = ${outcome.turnId}
    `;
    expect(usageRows[0]).toMatchObject({
      status: 'error',
      pricing_basis: 'notional-subscription',
      count: '1',
    });
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
