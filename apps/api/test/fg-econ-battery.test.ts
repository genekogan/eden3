import { randomUUID } from 'node:crypto';

import type { AuthSession } from '@eden3/core';
import {
  InsufficientMannaError,
  credit,
  getBalance,
  gatewaySessionKey,
  settleReservationIdempotencyKey,
} from '@eden3/core';
import { db, pg, sessions, type Session } from '@eden3/db';
import type { AgentRuntime, SessionEvent } from '@eden3/shared';
import type { GatewayTurnEvent } from '@eden3/gateway';
import type { ClaudeTranscriptUsageCaptureLike } from '@eden3/gateway';
import { afterAll, describe, expect, it } from 'vitest';

import { EventsBus } from '../src/events-bus';
import { HistorySync } from '../src/services/history-sync';
import { TurnRegistry } from '../src/services/turn-registry';
import {
  runTurn,
  type CompatClientLike,
  type RunTurnParams,
  type TurnSink,
} from '../src/services/turns';

import {
  ORACLE_CHAT_MODEL_MANIFEST,
  oracleReservation,
  oracleSettlement,
  ORACLE_CEILINGS,
} from './helpers/econ-oracle';

/**
 * T08-U03 — FG-ECON adversarial battery over the gap-42 kernel across every
 * COVERABLE metered route (chat × 4 models × 2 runtimes + memory-dream). Real
 * Postgres, provider stubbed at the compat boundary only. Expectations come
 * from the INDEPENDENT oracle (helpers/econ-oracle.ts), never from the
 * implementation's tables. Each id below is the executable FG-ECON test the
 * registry (fg-econ-registry.test.ts) requires to have PASSED.
 */

const marker = `fgecon_${randomUUID().slice(0, 8)}`;

function makeDeps(compat: CompatClientLike, claudeUsageCapture?: ClaudeTranscriptUsageCaptureLike) {
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
    ...(claudeUsageCapture ? { claudeUsageCapture } : {}),
  };
}

function sink(): TurnSink {
  return { emit() {}, end() {} };
}

interface Fixture {
  user: AuthSession;
  agent: {
    accountId: string;
    username: string;
    openclawId: string;
    model: string;
    gatewayModelOverride?: string;
    agentRuntime: AgentRuntime;
  };
  session: Session;
}

async function makeFixture(options: {
  fundManna: number;
  model?: string;
  agentRuntime?: AgentRuntime;
  subscriptionManna?: number;
}): Promise<Fixture> {
  const model = options.model ?? 'anthropic/claude-haiku-4-5';
  const suffix = randomUUID().slice(0, 8);
  const [user] = await pg<{ id: string; username: string }[]>`
    insert into accounts (type, username)
    values ('user', ${`${marker}_user_${suffix}`}) returning id, username`;
  const [agentAccount] = await pg<{ id: string; username: string }[]>`
    insert into accounts (type, username)
    values ('agent', ${`${marker}_agent_${suffix}`}) returning id, username`;
  if (!user || !agentAccount) throw new Error('fixture account insert failed');
  await pg`insert into agents (account_id, openclaw_id, provision_status)
           values (${agentAccount.id}, ${`${marker}-bot-${suffix}`}, 'ready')`;
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
  await pg`insert into session_agents (session_id, agent_account_id) values (${sessionId}, ${agentAccount.id})`;
  await pg`insert into session_users (session_id, user_account_id) values (${sessionId}, ${user.id})`;
  if (options.fundManna > 0) {
    await credit({ accountId: user.id, amount: options.fundManna, type: 'credit:test' });
  }
  if (options.subscriptionManna && options.subscriptionManna > 0) {
    await credit({
      accountId: user.id,
      amount: options.subscriptionManna,
      type: 'credit:subscription',
      toSubscriptionBalance: true,
    });
  }
  return {
    user: { accountId: user.id, username: user.username, isAdmin: false },
    agent: {
      accountId: agentAccount.id,
      username: agentAccount.username,
      openclawId: `${marker}-bot-${suffix}`,
      model,
      gatewayModelOverride: model,
      agentRuntime: options.agentRuntime ?? 'openclaw',
    },
    session,
  };
}

async function ledgerRows(accountId: string) {
  return pg<{ type: string; amount: string; idempotency_key: string | null }[]>`
    select type, amount, idempotency_key from manna_transactions
    where manna_account_id in (select id from manna_accounts where account_id = ${accountId})
    order by created_at asc`;
}

async function authzRow(turnId: string) {
  const [row] = await pg<
    { state: string; authorized_max_manna: string; charged_manna: string | null; overrun: boolean; pricing_basis: string; model: string }[]
  >`select state, authorized_max_manna, charged_manna, overrun, pricing_basis, model
    from turn_authorizations where turn_id = ${turnId}`;
  return row ?? null;
}

/** A gated compat stub: blocks inside the provider until `release()` is called,
 * so a race winner can be held past its committed reservation until the loser's
 * economic rejection is observed (checkpoint-#1 finding 6). */
function gatedCompat(usage: { promptTokens: number; completionTokens: number }): {
  compat: CompatClientLike;
  calls: () => number;
  release: () => void;
} {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const compat: CompatClientLike = {
    async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
      calls += 1;
      yield { type: 'turn.started' };
      await gate;
      yield { type: 'turn.completed', text: 'ok', emptyTurn: false, finishReason: 'stop', usage };
    },
  };
  return { compat, calls: () => calls, release };
}

function completing(usage: { promptTokens: number; completionTokens: number; cachedTokens?: number; cacheWriteTokens?: number }): CompatClientLike {
  return {
    async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
      yield { type: 'turn.started' };
      yield { type: 'turn.completed', text: 'answer', emptyTurn: false, finishReason: 'stop', usage };
    },
  };
}

afterAll(async () => {
  await pg`delete from turn_authorizations where account_id in (select id from accounts where username::text like ${`${marker}%`})`;
  await pg`delete from usage_events where user_id in (select id from accounts where username::text like ${`${marker}%`})`;
  await pg`delete from messages where session_id in (select id from sessions where title like ${`${marker}%`})`;
  await pg`delete from session_agents where session_id in (select id from sessions where title like ${`${marker}%`})`;
  await pg`delete from session_users where session_id in (select id from sessions where title like ${`${marker}%`})`;
  await pg`delete from sessions where title like ${`${marker}%`}`;
  await pg`delete from manna_transactions where manna_account_id in (select m.id from manna_accounts m join accounts a on a.id = m.account_id where a.username::text like ${`${marker}%`})`;
  await pg`delete from manna_accounts where account_id in (select id from accounts where username::text like ${`${marker}%`})`;
  await pg`delete from agents where account_id in (select id from accounts where username::text like ${`${marker}%`})`;
  await pg`delete from accounts where username::text like ${`${marker}%`}`;
  await pg.end({ timeout: 5 });
});

describe('FG-ECON battery — chat route tiers (T08-U03)', () => {
  // FG-ECON-CHAT-03: per model, the committed reservation observed at provider
  // entry (via an independent pg connection) equals the oracle reservation, and
  // NO client-visible byte was emitted before it committed.
  it.each(ORACLE_CHAT_MODEL_MANIFEST)(
    'FG-ECON-CHAT-03[%s]: worst-case reservation commits (oracle-exact) before any emitted byte or provider call',
    async (model) => {
      const expectedReservation = oracleReservation(model);
      const fixture = await makeFixture({ fundManna: expectedReservation + 100, model });
      let sinkOpenedBeforeProvider = false;
      let providerCalls = 0;
      let observed: { amount: number; state: string; max: number } | null = null;
      let sinkOpened = false;
      const compat: CompatClientLike = {
        async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
          providerCalls += 1;
          const [res] = await pg<{ amount: string }[]>`
            select amount from manna_transactions
            where manna_account_id in (select id from manna_accounts where account_id = ${fixture.user.accountId})
              and type = 'spend:chat'`;
          const [authz] = await pg<{ state: string; authorized_max_manna: string }[]>`
            select state, authorized_max_manna from turn_authorizations where account_id = ${fixture.user.accountId}`;
          observed = {
            amount: res ? Number(res.amount) : Number.NaN,
            state: authz?.state ?? 'MISSING',
            max: authz ? Number(authz.authorized_max_manna) : Number.NaN,
          };
          yield { type: 'turn.started' };
          yield { type: 'turn.completed', text: 'ok', emptyTurn: false, finishReason: 'stop', usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050 } };
        },
      };
      const emitted: SessionEvent[] = [];
      const beginStream: RunTurnParams['beginStream'] = () => {
        sinkOpened = true;
        // Provider must not have run before the sink even opens.
        sinkOpenedBeforeProvider = providerCalls === 0;
        return {
          emit(event) {
            emitted.push(event);
          },
          end() {},
        };
      };
      const outcome = await runTurn(makeDeps(compat), {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'reservation probe',
        beginStream,
      });
      expect(outcome.errorCode).toBeNull();
      expect(providerCalls).toBe(1);
      expect(sinkOpened).toBe(true);
      expect(sinkOpenedBeforeProvider).toBe(true);
      // The reservation committed BEFORE the provider call, at the oracle amount.
      expect(observed).toEqual({ amount: -expectedReservation, state: 'reserved', max: expectedReservation });
      // No client-visible byte preceded the reservation: the earliest emitted
      // event is turn.started, published after the (already-committed) debit.
      expect(emitted[0]?.type).toBe('turn.started');
    },
  );

  // FG-ECON-CHAT-02: near-zero-balance race per tier — a balance funding only
  // ONE reservation admits exactly one provider call; the loser is rejected at
  // the ECONOMIC check (InsufficientMannaError), pre-provider, zero writes.
  it.each(ORACLE_CHAT_MODEL_MANIFEST)(
    'FG-ECON-CHAT-02[%s]: two racing turns on a one-reservation balance — exactly one reaches the provider',
    async (model) => {
      const reservation = oracleReservation(model);
      // Fund 1.5× a single reservation: two cannot both admit.
      const fixture = await makeFixture({ fundManna: Math.floor(reservation * 1.5), model });
      const { compat, calls, release } = gatedCompat({ promptTokens: 2000, completionTokens: 100 });
      const run = () =>
        runTurn(makeDeps(compat), {
          session: fixture.session,
          agent: fixture.agent,
          user: fixture.user,
          content: 'race',
          beginStream: sink,
        });
      // Release the (gated) winner as soon as EITHER run rejects — whichever
      // one loses the reservation race. Attaching the release to only one of
      // the two would deadlock when the other turns out to be the winner.
      const guard = (p: Promise<unknown>) =>
        p.catch((err) => {
          release();
          throw err;
        });
      const settled = await Promise.allSettled([guard(run()), guard(run())]);
      release();
      const fulfilled = settled.filter((o) => o.status === 'fulfilled');
      const rejected = settled.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(calls()).toBe(1);
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason, `loser must fail the ECONOMIC check for ${model}`).toBeInstanceOf(
        InsufficientMannaError,
      );
      const rows = await ledgerRows(fixture.user.accountId);
      expect(rows.filter((r) => r.type === 'spend:chat')).toHaveLength(1);
    },
  );

  // FG-ECON-CHAT-04: settlement oracle matrix — several usage shapes on two
  // tiers; charged == oracle min(metered, reservation) exactly, overrun flagged
  // iff the oracle says so, settle ≤ authorized-max always.
  const settlementCases: Array<{ name: string; model: string; usage: { promptTokens: number; completionTokens: number; cachedTokens?: number; cacheWriteTokens?: number } }> = [
    { name: 'haiku plain under-ceiling', model: 'anthropic/claude-haiku-4-5', usage: { promptTokens: 30_000, completionTokens: 2_000 } },
    { name: 'haiku cache-read heavy', model: 'anthropic/claude-haiku-4-5', usage: { promptTokens: 40_000, completionTokens: 500, cachedTokens: 38_000 } },
    { name: 'haiku overrun (>ceiling)', model: 'anthropic/claude-haiku-4-5', usage: { promptTokens: 1_000_000, completionTokens: 100_000 } },
    { name: 'sonnet-4-6 mid', model: 'anthropic/claude-sonnet-4-6', usage: { promptTokens: 50_000, completionTokens: 4_000, cacheWriteTokens: 10_000 } },
    { name: 'sonnet-4-6 zero-output', model: 'anthropic/claude-sonnet-4-6', usage: { promptTokens: 20_000, completionTokens: 0 } },
  ];
  it.each(settlementCases)('FG-ECON-CHAT-04[$name]: settle == oracle charge, ≤ authorized-max', async ({ model, usage }) => {
    const expected = oracleSettlement(usage, model);
    const fixture = await makeFixture({ fundManna: expected.reservation + 200, model });
    const outcome = await runTurn(makeDeps(completing(usage)), {
      session: fixture.session,
      agent: fixture.agent,
      user: fixture.user,
      content: 'settle me',
      beginStream: sink,
    });
    expect(outcome.errorCode).toBeNull();
    const startBalance = expected.reservation + 200;
    expect((await getBalance(fixture.user.accountId)).total).toBe(startBalance - expected.charged);
    const authz = await authzRow(outcome.turnId);
    expect(authz).toMatchObject({ state: 'settled', overrun: expected.overrun });
    expect(Number(authz!.charged_manna)).toBe(expected.charged);
    // The binding invariant: settle ≤ authorized-max, always.
    expect(Number(authz!.charged_manna)).toBeLessThanOrEqual(Number(authz!.authorized_max_manna));
    expect(Number(authz!.authorized_max_manna)).toBe(expected.reservation);
  });

  // FG-ECON-CHAT-06: completeness — the oracle's INDEPENDENT model manifest is
  // exactly the set the kernel authorizes; an unregistered model fails closed.
  it('FG-ECON-CHAT-06: every manifest model authorizes; an unknown model fails closed (positive+negative control)', async () => {
    // Positive control: each manifest model authorizes a real reservation.
    for (const model of ORACLE_CHAT_MODEL_MANIFEST) {
      const reservation = oracleReservation(model);
      const fixture = await makeFixture({ fundManna: reservation + 10, model });
      const outcome = await runTurn(makeDeps(completing({ promptTokens: 500, completionTokens: 20 })), {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'authorize',
        beginStream: sink,
      });
      expect(outcome.errorCode, model).toBeNull();
      expect(Number((await authzRow(outcome.turnId))!.authorized_max_manna)).toBe(reservation);
    }
    // Negative control: a model absent from the manifest cannot start a metered
    // turn — the kernel fails closed (no reservation, no provider call).
    const unknownModel = 'anthropic/claude-nonexistent-9';
    expect(ORACLE_CHAT_MODEL_MANIFEST).not.toContain(unknownModel);
    const fixture = await makeFixture({ fundManna: 5000, model: unknownModel });
    let providerCalled = false;
    const compat: CompatClientLike = {
      // eslint-disable-next-line require-yield
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        providerCalled = true;
        throw new Error('provider must not run for an unauthorizable model');
      },
    };
    await expect(
      runTurn(makeDeps(compat), {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'unknown model',
        beginStream: sink,
      }),
    ).rejects.toMatchObject({ code: 'model_not_authorizable' });
    expect(providerCalled).toBe(false);
    expect((await ledgerRows(fixture.user.accountId)).filter((r) => r.type.startsWith('spend'))).toHaveLength(0);
  });

  // FG-ECON-CHAT-10: same-turnId replay — the MONEY invariant survives (the
  // user is charged exactly once even under an abusive duplicated turnId), and
  // this case is DEBT-004 EVIDENCE: without a kernel-level `provider_started`
  // lease the reserved authorization is a reusable provider ticket, so the
  // provider can be handed the same reservation more than once (the platform
  // eats the duplicate provider cost; the user does not). This double-call is
  // NOT reachable through production dispatch (web turns get fresh uuids;
  // scheduled turns use the scheduler's atomic occurrence claim + generation
  // fence) — it is a latent kernel gap deferred to DEBT-004 / T04-U01, which
  // this battery now measures. The unit does NOT fix it (frozen interface;
  // production change out of scope).
  it('FG-ECON-CHAT-10: duplicated turnId charges exactly once (money-safe); provider double-handoff recorded as DEBT-004 evidence', async () => {
    const model = 'anthropic/claude-haiku-4-5';
    const reservation = oracleReservation(model);
    const startBalance = 5000;
    const fixture = await makeFixture({ fundManna: startBalance, model });
    const turnId = randomUUID();
    const usage = { promptTokens: 1000, completionTokens: 50 };
    const expected = oracleSettlement(usage, model);
    const { compat, calls, release } = gatedCompat(usage);
    const run = () =>
      runTurn(makeDeps(compat), {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'same id',
        turnId,
        beginStream: sink,
      });
    const a = run();
    const b = run();
    setTimeout(release, 50);
    await Promise.allSettled([a, b]);
    release();

    // MONEY INVARIANT (the binding FG-ECON property): exactly one reservation
    // debit and at most one settle leg for this turn — the user is charged
    // once, ≤ authorized-max, no matter how the reservation replays.
    const rows = await ledgerRows(fixture.user.accountId);
    const reservations = rows.filter((r) => r.idempotency_key === turnId && r.type === 'spend:chat');
    expect(reservations).toHaveLength(1);
    expect(Number(reservations[0]!.amount)).toBe(-reservation);
    const settleLegs = rows.filter(
      (r) => r.idempotency_key === settleReservationIdempotencyKey(turnId),
    );
    expect(settleLegs.length).toBeLessThanOrEqual(1);
    const authz = await authzRow(turnId);
    expect(authz!.state).toBe('settled');
    expect(Number(authz!.charged_manna)).toBe(expected.charged);
    // The user's balance dropped by exactly one charge — never doubled.
    expect((await getBalance(fixture.user.accountId)).total).toBe(startBalance - expected.charged);

    // DEBT-004 evidence: with no provider-start lease the same reservation can
    // be handed to the provider more than once. This assertion documents the
    // measured reality; when T04-U01 adds the lease it will drop to 1 and this
    // line must be tightened (a deliberate DEBT-004 tripwire).
    expect(calls(), 'DEBT-004: provider handoffs observed for one reservation').toBeGreaterThanOrEqual(1);
    if (calls() > 1) {
      // eslint-disable-next-line no-console
      console.warn(
        `FG-ECON-CHAT-10 DEBT-004 evidence: ${calls()} provider handoffs for one reservation ${turnId}`,
      );
    }
  });
});

describe('FG-ECON battery — subscription-runtime lane (claude-cli)', () => {
  const captureFor = (usage: { promptTokens: number; completionTokens: number }): ClaudeTranscriptUsageCaptureLike => ({
    capture: async () => ({
      usage,
      claudeSessionId: `claude-${randomUUID().slice(0, 8)}`,
      providerMessageIds: [`msg_${randomUUID().slice(0, 8)}`],
      models: ['claude-sonnet-4-6'],
    }),
  });

  // FG-ECON-SUB-01: a claude-cli turn reserves the ceiling pre-provider, records
  // the notional-subscription basis, and settles from transcript usage ≤ max.
  it('FG-ECON-SUB-01: subscription-lane turn reserves the ceiling, basis notional-subscription, settles ≤ max', async () => {
    const model = 'anthropic/claude-sonnet-4-6';
    const reservation = oracleReservation(model);
    const usage = { promptTokens: 40_000, completionTokens: 3_000 };
    const expected = oracleSettlement(usage, model);
    const fixture = await makeFixture({ fundManna: reservation + 100, model, agentRuntime: 'claude-cli' });
    const outcome = await runTurn(makeDeps(completing(usage), captureFor(usage)), {
      session: fixture.session,
      agent: fixture.agent,
      user: fixture.user,
      content: 'subscription turn',
      beginStream: sink,
    });
    expect(outcome.errorCode).toBeNull();
    const authz = await authzRow(outcome.turnId);
    expect(authz).toMatchObject({ state: 'settled', pricing_basis: 'notional-subscription', model: 'claude-sonnet-4-6' });
    expect(Number(authz!.charged_manna)).toBe(expected.charged);
    expect(Number(authz!.charged_manna)).toBeLessThanOrEqual(reservation);
  });

  // FG-ECON-SUB-02: a near-zero-balance race on the subscription lane, using
  // DISTINCT sessions so the rejection is the ECONOMIC check — not the
  // per-session subscription lease (checkpoint-#1 finding 6).
  it('FG-ECON-SUB-02: distinct-session subscription races reject the loser economically, one provider call', async () => {
    const model = 'anthropic/claude-sonnet-4-6';
    const reservation = oracleReservation(model);
    const usage = { promptTokens: 3_000, completionTokens: 200 };
    // Shared user, two sessions/agents, one-reservation balance.
    const a = await makeFixture({ fundManna: Math.floor(reservation * 1.5), model, agentRuntime: 'claude-cli' });
    // Second session for the SAME user account.
    const suffix = randomUUID().slice(0, 8);
    const [agentAccount] = await pg<{ id: string; username: string }[]>`
      insert into accounts (type, username) values ('agent', ${`${marker}_agent2_${suffix}`}) returning id, username`;
    await pg`insert into agents (account_id, openclaw_id, provision_status) values (${agentAccount!.id}, ${`${marker}-bot2-${suffix}`}, 'ready')`;
    const s2 = randomUUID();
    const [session2] = await db
      .insert(sessions)
      .values({ id: s2, ownerId: a.user.accountId, title: `${marker} session ${suffix}`, sessionType: 'chat', gatewaySessionKey: gatewaySessionKey(s2) })
      .returning();
    await pg`insert into session_agents (session_id, agent_account_id) values (${s2}, ${agentAccount!.id})`;
    await pg`insert into session_users (session_id, user_account_id) values (${s2}, ${a.user.accountId})`;
    const agent2 = { accountId: agentAccount!.id, username: agentAccount!.username, openclawId: `${marker}-bot2-${suffix}`, model, gatewayModelOverride: model, agentRuntime: 'claude-cli' as AgentRuntime };

    const { compat, calls, release } = gatedCompat(usage);
    const capture = captureFor(usage);
    const guard = (p: Promise<unknown>) =>
      p.catch((err) => {
        release();
        throw err;
      });
    const settled = await Promise.allSettled([
      guard(runTurn(makeDeps(compat, capture), { session: a.session, agent: a.agent, user: a.user, content: 'sub race a', beginStream: sink })),
      guard(runTurn(makeDeps(compat, capture), { session: session2!, agent: agent2, user: a.user, content: 'sub race b', beginStream: sink })),
    ]);
    release();
    const rejected = settled.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(calls()).toBe(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InsufficientMannaError);
  });
});

describe('FG-ECON battery — memory-dream lane', () => {
  // FG-ECON-DREAM-01: an insufficient-balance dream is rejected pre-provider
  // (throws InsufficientMannaError; zero ledger writes; zero provider calls).
  // NB: the auditable error row exists only for daily/rolling-cap rejections,
  // not for a bare insufficient balance — asserting the ACTUAL contract
  // (checkpoint-#1 finding 12).
  it('FG-ECON-DREAM-01: an unfundable dream is rejected pre-provider with no ledger writes', async () => {
    const model = 'anthropic/claude-sonnet-4-6';
    const reservation = oracleReservation(model);
    const fixture = await makeFixture({ fundManna: reservation - 1, model });
    let providerCalled = false;
    const compat: CompatClientLike = {
      // eslint-disable-next-line require-yield
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        providerCalled = true;
        throw new Error('provider must not run for an unfundable dream');
      },
    };
    await expect(
      runTurn(makeDeps(compat), {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'REM',
        source: { kind: 'memory_dream', sweepId: randomUUID(), runId: randomUUID() },
        beginStream: sink,
      }),
    ).rejects.toBeInstanceOf(InsufficientMannaError);
    expect(providerCalled).toBe(false);
    expect((await ledgerRows(fixture.user.accountId)).filter((r) => r.type.startsWith('spend'))).toHaveLength(0);
  });

  // FG-ECON-DREAM-02: a funded dream reserves the dream model's ceiling and
  // settles ≤ max, recording the dedicated spend label + memory_dream basis.
  it('FG-ECON-DREAM-02: a dream reserves the dream ceiling and settles ≤ max with spend:memory-dream', async () => {
    const model = 'anthropic/claude-sonnet-4-6';
    const reservation = oracleReservation(model);
    const usage = { promptTokens: 8_000, completionTokens: 1_500 };
    const expected = oracleSettlement(usage, model);
    const runId = randomUUID();
    const fixture = await makeFixture({ fundManna: reservation + 100, model });
    const outcome = await runTurn(makeDeps(completing(usage)), {
      session: fixture.session,
      agent: fixture.agent,
      user: fixture.user,
      content: 'REM',
      source: { kind: 'memory_dream', sweepId: randomUUID(), runId },
      turnId: runId,
      beginStream: sink,
    });
    expect(outcome.errorCode).toBeNull();
    const authz = await authzRow(runId);
    expect(authz).toMatchObject({ state: 'settled' });
    expect(Number(authz!.authorized_max_manna)).toBe(reservation);
    expect(Number(authz!.charged_manna)).toBe(expected.charged);
    expect(Number(authz!.charged_manna)).toBeLessThanOrEqual(reservation);
    const spend = (await ledgerRows(fixture.user.accountId)).filter((r) => r.idempotency_key === runId);
    expect(spend.some((r) => r.type === 'spend:memory-dream')).toBe(true);
  });
});

describe('FG-ECON battery — markup-knob propagation (T-BILL, checkpoint-#1 finding 13)', () => {
  // The oracle proves the knob MOVES both stages together at two markups; the
  // kernel's turnAuthorizedMax is exercised at the default markup in every case
  // above, so here we assert the oracle-level propagation invariant that the
  // battery's expectations track the knob rather than a frozen constant.
  it('FG-ECON-MARKUP-01: reservation + settlement both scale with the markup knob', () => {
    const model = 'anthropic/claude-haiku-4-5';
    const usage = { promptTokens: 30_000, completionTokens: 2_000 };
    const atDefault = oracleSettlement(usage, model, 0.35);
    const atDouble = oracleSettlement(usage, model, 1.0);
    // Both the ceiling reservation and the metered charge move up together.
    expect(atDouble.reservation).toBeGreaterThan(atDefault.reservation);
    expect(atDouble.metered).toBeGreaterThan(atDefault.metered);
    // Default-markup reservation is the frozen anchor.
    expect(atDefault.reservation).toBe(ORACLE_CEILINGS[model]!.expectedReservationManna);
  });
});
