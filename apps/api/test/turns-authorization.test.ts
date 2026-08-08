import { randomUUID } from 'node:crypto';

import type { AuthSession } from '@eden3/core';
import {
  InsufficientMannaError,
  credit,
  debit,
  gatewaySessionKey,
  getBalance,
  settleReservationIdempotencyKey,
} from '@eden3/core';
import { db, pg, sessions, type Session } from '@eden3/db';
import type { AgentRuntime, SessionEvent } from '@eden3/shared';
import type { GatewayTurnEvent } from '@eden3/gateway';
import { afterAll, describe, expect, it } from 'vitest';

import { EventsBus } from '../src/events-bus';
import { HistorySync } from '../src/services/history-sync';
import { TurnRegistry } from '../src/services/turn-registry';
import { runTurn, type CompatClientLike, type TurnSink } from '../src/services/turns';

/**
 * T08-U02 economic-authorization kernel — the core FG-ECON adversarial cases
 * (MVP gap 42, MVP-ACCEPTANCE S3-A). Real Postgres, stubbed compat. The full
 * per-route battery is T08-U03.
 *
 * Frozen oracle values (independent literals, NOT recomputed from the
 * implementation's table — a silent ceiling regression must fail here):
 *   haiku-4-5 authorized-max = 61 manna ($0.045 × 1.35 markup × 1000/USD).
 */
const HAIKU_AUTHORIZED_MAX = 61;

const marker = `turnauthz_${randomUUID().slice(0, 8)}`;

interface Fixture {
  user: AuthSession;
  agent: {
    accountId: string;
    username: string;
    openclawId: string;
    model: string;
    agentRuntime: AgentRuntime;
  };
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

async function makeFixture(fundManna: number): Promise<Fixture> {
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
  if (fundManna > 0) {
    await credit({ accountId: user.id, amount: fundManna, type: 'credit:test' });
  }
  return {
    user: { accountId: user.id, username: user.username, isAdmin: false },
    agent: {
      accountId: agentAccount.id,
      username: agentAccount.username,
      openclawId: `${marker}-bot-${suffix}`,
      model: 'anthropic/claude-haiku-4-5',
      agentRuntime: 'openclaw',
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
    {
      state: string;
      authorized_max_manna: string;
      reserved_subscription_manna: string;
      charged_manna: string | null;
      overrun: boolean;
    }[]
  >`
    select state, authorized_max_manna, reserved_subscription_manna, charged_manna, overrun
    from turn_authorizations where turn_id = ${turnId}`;
  return row ?? null;
}

afterAll(async () => {
  await pg`delete from turn_authorizations where account_id in
           (select id from accounts where username::text like ${`${marker}%`})`;
  await pg`delete from usage_events where user_id in
           (select id from accounts where username::text like ${`${marker}%`})`;
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
});

describe('economic authorization kernel (T08-U02, FG-ECON core)', () => {
  it('A1: a near-zero-balance user is rejected before any provider call, with zero ledger writes', async () => {
    const fixture = await makeFixture(HAIKU_AUTHORIZED_MAX - 1);
    let streamOpened = false;
    const compat: CompatClientLike = {
      // eslint-disable-next-line require-yield
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        throw new Error('provider must never run for an unfunded authorization');
      },
    };
    await expect(
      runTurn(makeDeps(compat), {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'expensive request on a dust balance',
        beginStream: () => {
          streamOpened = true;
          return sink();
        },
      }),
    ).rejects.toBeInstanceOf(InsufficientMannaError);
    expect(streamOpened).toBe(false);
    const rows = await ledgerRows(fixture.user.accountId);
    expect(rows.filter((row) => row.type?.startsWith('spend'))).toHaveLength(0);
    expect(rows.filter((row) => row.type?.startsWith('refund'))).toHaveLength(0);
    expect((await getBalance(fixture.user.accountId)).total).toBe(HAIKU_AUTHORIZED_MAX - 1);
  });

  it('A2: the worst-case reservation is durably committed before the provider call', async () => {
    const fixture = await makeFixture(200);
    // The compat stub verifies durability through a SEPARATE client (`pg` is
    // postgres.js, a different pool than the drizzle client running the
    // reservation transaction): the reservation and authorization row must be
    // COMMITTED — visible to another backend — not merely pending.
    const independentPg = pg;
    let observedAtProvider: { amount: number; state: string; authorizedMax: number } | null = null;
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        const [reservation] = await independentPg<{ amount: string }[]>`
          select amount from manna_transactions
          where manna_account_id in
            (select id from manna_accounts where account_id = ${fixture.user.accountId})
            and type = 'spend:chat'`;
        const [authz] = await independentPg<
          { state: string; authorized_max_manna: string }[]
        >`select state, authorized_max_manna from turn_authorizations
          where account_id = ${fixture.user.accountId}`;
        observedAtProvider = {
          amount: reservation ? Number(reservation.amount) : Number.NaN,
          state: authz?.state ?? 'MISSING',
          authorizedMax: authz ? Number(authz.authorized_max_manna) : Number.NaN,
        };
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'ok',
          emptyTurn: false,
          finishReason: 'stop',
          usage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
        };
      },
    };
    try {
      const outcome = await runTurn(makeDeps(compat), {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'prove durability',
        beginStream: sink,
      });
      expect(outcome.errorCode).toBeNull();
      expect(observedAtProvider).toEqual({
        amount: -HAIKU_AUTHORIZED_MAX,
        state: 'reserved',
        authorizedMax: HAIKU_AUTHORIZED_MAX,
      });
    } finally {
      // shared client — closed in afterAll
    }
  });

  it('A3: settle ≤ authorized-max — actual charged exactly, unused refunded on the linked settle leg', async () => {
    const fixture = await makeFixture(200);
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'answer',
          emptyTurn: false,
          finishReason: 'stop',
          // 30k in + 2k out on haiku = $0.04 → 54 manna actual.
          usage: { promptTokens: 30_000, completionTokens: 2_000, totalTokens: 32_000 },
        };
      },
    };
    const outcome = await runTurn(makeDeps(compat), {
      session: fixture.session,
      agent: fixture.agent,
      user: fixture.user,
      content: 'meter me',
      beginStream: sink,
    });
    expect(outcome.errorCode).toBeNull();
    expect((await getBalance(fixture.user.accountId)).total).toBe(200 - 54);

    const rows = await ledgerRows(fixture.user.accountId);
    const reservation = rows.find((row) => row.idempotency_key === outcome.turnId);
    const settleLeg = rows.find(
      (row) => row.idempotency_key === settleReservationIdempotencyKey(outcome.turnId),
    );
    expect(Number(reservation!.amount)).toBe(-HAIKU_AUTHORIZED_MAX);
    expect(Number(settleLeg!.amount)).toBe(HAIKU_AUTHORIZED_MAX - 54);

    const authz = await authzRow(outcome.turnId);
    expect(authz).toMatchObject({ state: 'settled', overrun: false });
    expect(Number(authz!.charged_manna)).toBe(54);

    const [message] = await pg<{ eden_message_data: { settlement?: Record<string, unknown> } }[]>`
      select eden_message_data from messages where id = ${outcome.assistantMessageId}`;
    expect(message!.eden_message_data.settlement).toMatchObject({
      status: 'settled',
      authorizedMaxManna: HAIKU_AUTHORIZED_MAX,
      meteredManna: 54,
      chargedManna: 54,
      refundedManna: HAIKU_AUTHORIZED_MAX - 54,
      overrun: false,
    });
  });

  it('A4: a metered actual above the ceiling settles AT the ceiling (never above), loudly flagged', async () => {
    const fixture = await makeFixture(200);
    const sideErrors: string[] = [];
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'runaway output',
          emptyTurn: false,
          finishReason: 'stop',
          // 1M in + 100k out on haiku = $1.50 → 2025 manna metered ≫ 61 max.
          usage: { promptTokens: 1_000_000, completionTokens: 100_000, totalTokens: 1_100_000 },
        };
      },
    };
    const outcome = await runTurn(
      { ...makeDeps(compat), onError: (_err, context) => sideErrors.push(context) },
      {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'overrun the ceiling',
        beginStream: sink,
      },
    );
    expect(outcome.errorCode).toBeNull();
    // The invariant under overrun: the user pays EXACTLY the authorized max —
    // no more (settle ≤ authorized-max) and no less (no refund of the clamp).
    expect((await getBalance(fixture.user.accountId)).total).toBe(200 - HAIKU_AUTHORIZED_MAX);
    expect(sideErrors).toContain('authorized-max overrun');
    const authz = await authzRow(outcome.turnId);
    expect(authz).toMatchObject({ state: 'settled', overrun: true });
    expect(Number(authz!.charged_manna)).toBe(HAIKU_AUTHORIZED_MAX);
    const [usage] = await pg<{ manna: number; metadata: { settlement?: { meteredManna?: number; overrun?: boolean } } }[]>`
      select manna, metadata from usage_events where turn_id = ${outcome.turnId}`;
    expect(usage!.manna).toBe(HAIKU_AUTHORIZED_MAX);
    // Full metered actual stays recorded for reconciliation.
    expect(usage!.metadata.settlement).toMatchObject({ meteredManna: 2025, overrun: true });
  });

  it('A5: two concurrent turns racing a balance that funds only one — exactly one reaches the provider', async () => {
    const fixture = await makeFixture(Math.floor(HAIKU_AUTHORIZED_MAX * 1.5)); // 91 < 2×61
    let providerCalls = 0;
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        providerCalls += 1;
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'winner output',
          emptyTurn: false,
          finishReason: 'stop',
          usage: { promptTokens: 5_000, completionTokens: 500, totalTokens: 5_500 },
        };
      },
    };
    const run = () =>
      runTurn(makeDeps(compat), {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'race the balance',
        beginStream: sink,
      });
    const outcomes = await Promise.allSettled([run(), run()]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(providerCalls).toBe(1);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InsufficientMannaError);
    // The loser wrote nothing; the winner settled its small actual.
    const rows = await ledgerRows(fixture.user.accountId);
    expect(rows.filter((row) => row.type === 'spend:chat')).toHaveLength(1);
  });

  it('A6: a provider error fully reverses the worst-case reservation (net-zero, state reversed)', async () => {
    const fixture = await makeFixture(200);
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield { type: 'error', code: 'gateway_upstream_error', message: 'provider exploded' };
      },
    };
    const events: SessionEvent[] = [];
    const outcome = await runTurn(makeDeps(compat), {
      session: fixture.session,
      agent: fixture.agent,
      user: fixture.user,
      content: 'fail please',
      beginStream: () => ({
        emit(event) {
          events.push(event);
        },
        end() {},
      }),
    });
    expect(outcome.errorCode).toBe('gateway_upstream_error');
    expect((await getBalance(fixture.user.accountId)).total).toBe(200);
    const authz = await authzRow(outcome.turnId);
    expect(authz).toMatchObject({ state: 'reversed' });
    const [usage] = await pg<{ manna: number | null; status: string }[]>`
      select manna, status from usage_events where turn_id = ${outcome.turnId}`;
    expect(usage).toMatchObject({ status: 'error', manna: 0 });
    // The user watched their balance restore live.
    expect(events.some((event) => event.type === 'manna.updated' && event.balance === 200)).toBe(
      true,
    );
  });

  it('A7: after a settled turn the daily-cap headroom reflects the charge, not the reservation', async () => {
    const fixture = await makeFixture(500);
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'cheap',
          emptyTurn: false,
          finishReason: 'stop',
          usage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
        };
      },
    };
    const outcome = await runTurn(makeDeps(compat), {
      session: fixture.session,
      agent: fixture.agent,
      user: fixture.user,
      content: 'cheap turn',
      beginStream: sink,
    });
    expect(outcome.errorCode).toBeNull();
    // 1k in + 100 out = $0.0015 → 3 manna. Net spend counts 3, not 61.
    const [net] = await pg<{ spend: string }[]>`
      select coalesce(sum(greatest(
        -original.amount - coalesce(linked.amount, 0), 0)), 0)::numeric::text as spend
      from manna_transactions original
      join manna_accounts ma on ma.id = original.manna_account_id
      left join lateral (
        select coalesce(sum(r.amount), 0) as amount from manna_transactions r
        where r.refunds_transaction_id = original.id and r.type like 'refund%' and r.amount > 0
      ) linked on true
      where ma.account_id = ${fixture.user.accountId}
        and original.type like 'spend%' and original.amount < 0`;
    expect(Number(net!.spend)).toBe(3);
  });

  it('A9: provider-api usable output with no usage settles at the full reserve, loudly (RP-2)', async () => {
    const fixture = await makeFixture(200);
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield {
          type: 'turn.completed',
          text: 'output with vanished usage',
          emptyTurn: false,
          finishReason: 'stop',
          // No usage block at all.
        };
      },
    };
    const outcome = await runTurn(makeDeps(compat), {
      session: fixture.session,
      agent: fixture.agent,
      user: fixture.user,
      content: 'lose my usage',
      beginStream: sink,
    });
    expect(outcome.errorCode).toBeNull();
    expect((await getBalance(fixture.user.accountId)).total).toBe(200 - HAIKU_AUTHORIZED_MAX);
    const [usage] = await pg<{ status: string; manna: number | null; metadata: { settlement?: { status?: string; reason?: string } } }[]>`
      select status, manna, metadata from usage_events where turn_id = ${outcome.turnId}`;
    expect(usage).toMatchObject({ status: 'missing_usage', manna: HAIKU_AUTHORIZED_MAX });
    expect(usage!.metadata.settlement).toMatchObject({ status: 'unmetered', reason: 'missing_usage' });
    const authz = await authzRow(outcome.turnId);
    expect(authz).toMatchObject({ state: 'settled' });
  });

  it('F10: a foreign debit under the turn key can never masquerade as the authorization', async () => {
    const fixture = await makeFixture(200);
    const turnId = randomUUID();
    // A pre-existing (legacy-shaped) 1-manna debit under the same key.
    await debit({
      accountId: fixture.user.accountId,
      amount: 1,
      type: 'spend:chat',
      idempotencyKey: turnId,
    });
    let providerCalled = false;
    const compat: CompatClientLike = {
      // eslint-disable-next-line require-yield
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        providerCalled = true;
        throw new Error('provider must not run on a masqueraded reservation');
      },
    };
    await expect(
      runTurn(makeDeps(compat), {
        session: fixture.session,
        agent: fixture.agent,
        user: fixture.user,
        content: 'replay attack',
        turnId,
        beginStream: sink,
      }),
    ).rejects.toMatchObject({ code: 'turn_reservation_conflict' });
    expect(providerCalled).toBe(false);
    // The foreign debit is untouched (it belongs to another lifecycle).
    expect((await getBalance(fixture.user.accountId)).total).toBe(199);
  });
});
