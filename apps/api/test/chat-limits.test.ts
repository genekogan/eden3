import { randomUUID } from 'node:crypto';

import { credit, debit, gatewaySessionKey, resetEnvCache } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { GatewayTurnEvent } from '@eden3/gateway';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import type { ToolsClientLike } from '../src/services/history-sync';
import type { CompatClientLike } from '../src/services/turns';
import {
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertUserAccount,
  makeFakeProvisioner,
  makeFakeSkillSync,
  makeFakeToolSync,
  makeMarker,
} from './fixtures';

loadRootEnv();

const marker = makeMarker('chatlimit');

interface ChatFixture {
  userId: string;
  agentId: string;
  sessionId: string;
}

const emptyTools: ToolsClientLike = {
  sessionsHistory: async () => ({
    sessionKey: '',
    messages: [],
    truncated: false,
    contentTruncated: false,
  }),
};

function withEnv(name: string, value: string): () => void {
  const original = process.env[name];
  process.env[name] = value;
  resetEnvCache();
  return () => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
    resetEnvCache();
  };
}

async function makeFixture(): Promise<ChatFixture> {
  const suffix = randomUUID().slice(0, 8);
  const userId = await insertUserAccount(`${marker}_user_${suffix}`);
  const agentId = await insertAgentAccount(`${marker}_agent_${suffix}`, {
    openclawId: `${marker}_agent_${suffix}`,
    provisionStatus: 'ready',
    public: true,
  });
  const sessionId = randomUUID();
  await pg`
    insert into sessions (id, owner_id, title, session_type, gateway_session_key)
    values (${sessionId}, ${userId}, ${`${marker} session ${suffix}`}, 'chat', ${gatewaySessionKey(sessionId)})
  `;
  await pg`
    insert into session_agents (session_id, agent_account_id)
    values (${sessionId}, ${agentId})
  `;
  await pg`
    insert into session_users (session_id, user_account_id)
    values (${sessionId}, ${userId})
  `;
  await credit({
    accountId: userId,
    // Cover several concurrent worst-case reservations (haiku authorized-max
    // is 61 manna, T08-U02) — these fixtures test limits, not balance.
    amount: 500,
    type: 'credit:test',
    idempotencyKey: `${marker}:credit:${suffix}`,
  });
  return { userId, agentId, sessionId };
}

async function spendCount(userId: string): Promise<number> {
  const [row] = await pg<{ count: string }[]>`
    select count(*)::text as count
    from manna_transactions mt
    join manna_accounts ma on ma.id = mt.manna_account_id
    where ma.account_id = ${userId}
      and mt.type like 'spend%'
  `;
  return Number(row?.count ?? 0);
}

afterAll(async () => {
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('chat rate limits', () => {
  it('lazy-provisions a pending public agent on first chat access', async () => {
    const suffix = randomUUID().slice(0, 8);
    const username = `${marker}_lazy_${suffix}`.replace(/_/g, '-');
    const userId = await insertUserAccount(`${marker}_lazy_user_${suffix}`);
    await insertAgentAccount(username, {
      ownerId: userId,
      name: 'Lazy Agent',
      description: 'waits for first chat',
      persona: 'You are Lazy Agent.',
      greeting: 'ready when called',
      public: true,
      provisionStatus: 'pending',
      openclawId: null,
    });
    await credit({
      accountId: userId,
      amount: 100,
      type: 'credit:test',
      idempotencyKey: `${marker}:lazy-credit:${suffix}`,
    });
    const provisioner = makeFakeProvisioner();
    const skillSync = makeFakeSkillSync();
    const toolSync = makeFakeToolSync();
    const compat: CompatClientLike = {
      async *chatTurn(params): AsyncGenerator<GatewayTurnEvent, void, void> {
        expect(params.agentId).toBe(username);
        yield { type: 'turn.started' };
        yield { type: 'token', delta: 'awake' };
        yield {
          type: 'turn.completed',
          text: 'awake',
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
    const app = await buildServer({
      gateway: { compat, tools: emptyTools },
      provisioning: { provisioner, skillSync, toolSync },
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/new/messages',
        headers: { cookie: devCookie(userId) },
        payload: { content: 'wake up', agentUsername: username },
      });
      expect(res.statusCode).toBe(200);
      expect(provisioner.provisions[0]).toMatchObject({
        openclawId: username,
        name: 'Lazy Agent',
        persona: 'You are Lazy Agent.',
        thinkingLevel: 'balanced',
      });
      // eden-safe-base retired to the platform layer — lazy provision attaches
      // no default skills.
      expect(skillSync.calls).toContainEqual({
        openclawId: username,
        skills: [],
      });
      expect(toolSync.calls).toContainEqual({
        openclawId: username,
        toolGroups: [
          'group:runtime',
          'group:fs',
          'group:web',
          'group:sessions',
          'group:memory',
          'group:media',
          'group:ui',
          'group:automation',
          'group:agents',
          'group:plugins',
        ],
      });
      const [row] = await pg<
        { openclawId: string | null; status: string; workspacePath: string | null }[]
      >`
        select openclaw_id as "openclawId", provision_status as status,
               workspace_path as "workspacePath"
        from agents where account_id = (
          select id from accounts where username = ${username}
        )
      `;
      expect(row).toMatchObject({
        openclawId: username,
        status: 'ready',
        workspacePath: `/tmp/fake-workspaces/workspace-${username}`,
      });
      const sessionId = res.headers['x-session-id'];
      expect(typeof sessionId).toBe('string');
      const [assistant] = await pg<{ content: string | null }[]>`
        select content from messages
        where session_id = ${String(sessionId)} and role = 'assistant'
        order by created_at desc limit 1
      `;
      expect(assistant?.content).toBe('awake');
    } finally {
      await app.close();
    }
  });

  it('rejects the N+1 concurrent turn with a 429 before opening a second gateway turn', async () => {
    const restore = withEnv('MAX_CONCURRENT_TURNS_PER_USER', '1');
    const fixture = await makeFixture();
    let app: FastifyInstance | null = null;
    let unblock!: () => void;
    let entered!: () => void;
    const enteredGateway = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const unblockGateway = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let calls = 0;
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        calls += 1;
        entered();
        yield { type: 'turn.started' };
        await unblockGateway;
        yield { type: 'token', delta: 'ok' };
        yield {
          type: 'turn.completed',
          text: 'ok',
          emptyTurn: false,
          finishReason: 'stop',
        };
      },
    };

    try {
      app = await buildServer({ gateway: { compat, tools: emptyTools } });
      await app.ready();

      const first = app.inject({
        method: 'POST',
        url: `/sessions/${fixture.sessionId}/messages`,
        headers: { cookie: devCookie(fixture.userId) },
        payload: { content: 'first' },
      });
      await enteredGateway;

      const second = await app.inject({
        method: 'POST',
        url: `/sessions/${fixture.sessionId}/messages`,
        headers: { cookie: devCookie(fixture.userId) },
        payload: { content: 'second' },
      });

      expect(second.statusCode).toBe(429);
      expect((second.json() as { error: { code: string } }).error.code).toBe(
        'turn_concurrency_exceeded',
      );
      expect(calls).toBe(1);

      unblock();
      const firstRes = await first;
      expect(firstRes.statusCode).toBe(200);
      expect(await spendCount(fixture.userId)).toBe(1);
    } finally {
      unblock?.();
      await app?.close();
      restore();
    }
  });

  it('uses the active subscription tier for concurrent turn caps', async () => {
    const restores = [
      withEnv('MAX_CONCURRENT_TURNS_PER_USER', '1'),
      withEnv('MAX_CONCURRENT_TURNS_PRO', '2'),
    ];
    const fixture = await makeFixture();
    await pg`
      insert into billing_subscriptions (
        account_id, stripe_subscription_id, status, tier, monthly_manna
      )
      values (${fixture.userId}, ${`${marker}:sub:${randomUUID()}`}, 'active', 'pro', 1000)
    `;
    let app: FastifyInstance | null = null;
    let unblock!: () => void;
    let enteredCount = 0;
    let enteredTwo!: () => void;
    const twoEntered = new Promise<void>((resolve) => {
      enteredTwo = resolve;
    });
    const unblockGateway = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let calls = 0;
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        calls += 1;
        enteredCount += 1;
        if (enteredCount === 2) enteredTwo();
        yield { type: 'turn.started' };
        await unblockGateway;
        yield {
          type: 'turn.completed',
          text: 'ok',
          emptyTurn: false,
          finishReason: 'stop',
        };
      },
    };

    try {
      app = await buildServer({ gateway: { compat, tools: emptyTools } });
      await app.ready();

      const first = app.inject({
        method: 'POST',
        url: `/sessions/${fixture.sessionId}/messages`,
        headers: { cookie: devCookie(fixture.userId) },
        payload: { content: 'first' },
      });
      const second = app.inject({
        method: 'POST',
        url: `/sessions/${fixture.sessionId}/messages`,
        headers: { cookie: devCookie(fixture.userId) },
        payload: { content: 'second' },
      });
      await twoEntered;

      const third = await app.inject({
        method: 'POST',
        url: `/sessions/${fixture.sessionId}/messages`,
        headers: { cookie: devCookie(fixture.userId) },
        payload: { content: 'third' },
      });

      expect(third.statusCode).toBe(429);
      expect((third.json() as { error: { code: string; message: string } }).error).toMatchObject({
        code: 'turn_concurrency_exceeded',
        message: expect.stringContaining('limit is 2 for pro'),
      });
      expect(calls).toBe(2);

      unblock();
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);
    } finally {
      unblock?.();
      await app?.close();
      for (const restore of restores.reverse()) restore();
    }
  });

  it('rejects over-daily-cap turns before gateway or ledger side effects', async () => {
    // Discriminating numbers (checkpoint-#2): 45 spent of a 100 cap leaves
    // plenty of room for the OLD flat 1-manna reserve but NOT for the
    // worst-case 61-manna authorization — only the kernel rejects this turn.
    const restore = withEnv('DAILY_MANNA_SPEND_CAP_PER_USER', '100');
    const fixture = await makeFixture();
    await debit({
      accountId: fixture.userId,
      amount: 45,
      type: 'spend:chat',
      idempotencyKey: `${marker}:prior-spend:${randomUUID()}`,
    });
    const beforeSpendRows = await spendCount(fixture.userId);
    let gatewayCalled = false;
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        gatewayCalled = true;
        throw new Error('gateway should not be called over daily cap');
      },
    };
    let app: FastifyInstance | null = null;
    try {
      app = await buildServer({ gateway: { compat, tools: emptyTools } });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/sessions/${fixture.sessionId}/messages`,
        headers: { cookie: devCookie(fixture.userId) },
        payload: { content: 'blocked' },
      });

      expect(res.statusCode).toBe(429);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'daily_manna_cap_exceeded',
      );
      expect(gatewayCalled).toBe(false);
      expect(await spendCount(fixture.userId)).toBe(beforeSpendRows);
    } finally {
      await app?.close();
      restore();
    }
  });
});
