import { randomUUID } from 'node:crypto';

import { credit, debit, getBalance } from '@eden3/core';
import { db, pg, sessions, type Session } from '@eden3/db';
import type { GatewayTurnEvent } from '@eden3/gateway';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  isSettledPartialOutputDreamFailure,
  PostgresMemoryDreamDurability,
  recordMemoryDreamRecoveryUsage,
  renewMemoryDreamRunClaim,
  type MemoryDreamRunClaim,
} from '../src/services/memory-dreaming';
import {
  claimTurnProviderStart,
  insertTurnAuthorization,
  markTurnUsableOutput,
  reverseTurnAuthorization,
} from '../src/services/turn-authorization';
import { TurnReservationReaper } from '../src/services/turn-reservation-reaper';
import { TurnClaimLostError } from '../src/services/turns';
import { EventsBus } from '../src/events-bus';
import { HistorySync } from '../src/services/history-sync';
import { TurnRegistry } from '../src/services/turn-registry';
import { runTurn, type CompatClientLike } from '../src/services/turns';

const marker = `dreamauth_${randomUUID().slice(0, 8)}`;
const accountIds: string[] = [];

interface Fixture {
  ownerId: string;
  ownerUsername: string;
  agentId: string;
  agentUsername: string;
  openclawId: string;
  session: Session;
  claim: MemoryDreamRunClaim;
}

async function seedReservation(options: {
  durable: number;
  subscription: number;
  state?: 'reserved' | 'settled';
  errorUsageManna?: number;
  reserve?: boolean;
}): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await pg<{ id: string }[]>`
    insert into accounts (type, username)
    values ('user', ${`${marker}_owner_${suffix}`}) returning id`;
  const [agent] = await pg<{ id: string }[]>`
    insert into accounts (type, username)
    values ('agent', ${`${marker}_agent_${suffix}`}) returning id`;
  if (!owner || !agent) throw new Error('fixture accounts were not inserted');
  accountIds.push(owner.id, agent.id);
  const openclawId = `${marker}-${suffix}`;
  await pg`
    insert into agents (account_id, owner_id, openclaw_id, provision_status)
    values (${agent.id}, ${owner.id}, ${openclawId}, 'ready')`;

  const runId = randomUUID();
  const sweepId = randomUUID();
  const claimToken = randomUUID();
  await pg`
    insert into sessions (id, owner_id, title, session_type, gateway_session_key)
    values (${runId}, ${owner.id}, ${`${marker} ${suffix}`}, 'memory_dream', ${`agent:${marker}:${runId}`})`;
  await pg`insert into session_users (session_id, user_account_id) values (${runId}, ${owner.id})`;
  await pg`insert into session_agents (session_id, agent_account_id) values (${runId}, ${agent.id})`;
  await pg`
    insert into memory_dream_sweeps
      (id, sweep_key, window_start, status, claim_token, lease_expires_at)
    values
      (${sweepId}, ${`${marker}:${suffix}`}, now() - interval '1 day', 'running',
       ${randomUUID()}, now() + interval '1 hour')`;
  await pg`
    insert into memory_dream_runs
      (id, sweep_id, agent_account_id, openclaw_id, status, last_activity_at,
       claim_token, lease_expires_at, provider_status)
    values
       (${runId}, ${sweepId}, ${agent.id}, ${openclawId}, 'running', now(),
       ${claimToken}, now() + interval '1 hour', 'started')`;

  if (options.durable > 0) {
    await credit({ accountId: owner.id, amount: options.durable, type: 'credit:test' });
  }
  if (options.subscription > 0) {
    await credit({
      accountId: owner.id,
      amount: options.subscription,
      type: 'credit:subscription',
      toSubscriptionBalance: true,
    });
  }
  const amount = options.durable + options.subscription;
  if (options.reserve !== false) {
    await db.transaction(async (tx) => {
      const reserved = await debit({
        accountId: owner.id,
        amount,
        type: 'spend:memory-dream',
        idempotencyKey: runId,
        db: tx,
      });
      const row = await insertTurnAuthorization(tx, {
        turnId: runId,
        accountId: owner.id,
        agentAccountId: agent.id,
        sessionId: runId,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        pricingBasis: 'notional-subscription',
        ceilingTableVersion: 'dream-recovery-test-v1',
        authorizedMaxManna: amount,
        reservedSubscriptionManna: reserved.subscriptionDrawn ?? 0,
        reservationTxId: reserved.transaction.id,
      });
      if (!row) throw new Error('authorization was not inserted');
    });
  }
  if (options.state === 'settled') {
    await pg`
      update turn_authorizations set state = 'settled', charged_manna = ${amount}
      where turn_id = ${runId}`;
  }
  if (options.errorUsageManna !== undefined) {
    await pg`
      insert into usage_events
        (event_type, status, user_id, agent_id, session_id, turn_id,
         provider, model, pricing_basis, table_version, manna, error_code)
      values
        ('memory_dream', 'error', ${owner.id}, ${agent.id}, ${runId}, ${runId},
         'anthropic', 'claude-haiku-4-5', 'notional-subscription',
         'dream-recovery-test-v1', ${options.errorUsageManna}, 'crashed_reversal')`;
  }
  const [session] = await db.select().from(sessions).where(eq(sessions.id, runId)).limit(1);
  if (!session) throw new Error('fixture session was not inserted');
  return {
    ownerId: owner.id,
    ownerUsername: `${marker}_owner_${suffix}`,
    agentId: agent.id,
    agentUsername: `${marker}_agent_${suffix}`,
    openclawId,
    session,
    claim: {
      id: runId,
      sweepId,
      claimToken,
      lastActivityAt: new Date(),
      isRecovery: true,
    },
  };
}

function deps(compat: CompatClientLike) {
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

async function reverseWithClaim(claim: MemoryDreamRunClaim) {
  return await reverseTurnAuthorization({
    turnId: claim.id,
    refundType: 'refund:memory-dream',
    fence: (tx) => renewMemoryDreamRunClaim(claim, tx),
  });
}

afterAll(async () => {
  if (accountIds.length === 0) return;
  await pg`delete from memory_dream_runs where agent_account_id = any(${accountIds}::uuid[])`;
  await pg`delete from memory_dream_sweeps where sweep_key like ${`${marker}%`}`;
  await pg`delete from turn_authorizations where account_id = any(${accountIds}::uuid[])`;
  await pg`delete from usage_events where user_id = any(${accountIds}::uuid[])`;
  await pg`delete from session_agents where agent_account_id = any(${accountIds}::uuid[])`;
  await pg`delete from session_users where user_account_id = any(${accountIds}::uuid[])`;
  await pg`delete from messages where session_id in
           (select id from sessions where owner_id = any(${accountIds}::uuid[]))`;
  await pg`delete from sessions where owner_id = any(${accountIds}::uuid[])`;
  await pg`delete from manna_transactions where manna_account_id in
           (select id from manna_accounts where account_id = any(${accountIds}::uuid[]))`;
  await pg`delete from manna_accounts where account_id = any(${accountIds}::uuid[])`;
  await pg`delete from agents where account_id = any(${accountIds}::uuid[])`;
  await pg`delete from accounts where id = any(${accountIds}::uuid[])`;
});

describe('memory dream canonical recovery authorization (DEBT-003)', () => {
  it('fences a superseded dream generation inside reservation before any provider work', async () => {
    const fixture = await seedReservation({ durable: 61, subscription: 0, reserve: false });
    const replacement = { ...fixture.claim, claimToken: randomUUID() };
    await pg`
      update memory_dream_runs set claim_token = ${replacement.claimToken}
      where id = ${fixture.claim.id}`;
    let providerCalls = 0;
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        providerCalls += 1;
      },
    };
    await expect(
      runTurn(deps(compat), {
        session: fixture.session,
        agent: {
          accountId: fixture.agentId,
          username: fixture.agentUsername,
          openclawId: fixture.openclawId,
          model: 'anthropic/claude-haiku-4-5',
          agentRuntime: 'openclaw',
        },
        user: {
          accountId: fixture.ownerId,
          username: fixture.ownerUsername,
          isAdmin: false,
        },
        content: 'dream',
        source: { kind: 'memory_dream', sweepId: fixture.claim.sweepId, runId: fixture.claim.id },
        beginStream: () => ({ emit() {}, end() {} }),
        turnId: fixture.claim.id,
        fundingFence: (tx) => renewMemoryDreamRunClaim(fixture.claim, tx),
      }),
    ).rejects.toBeInstanceOf(TurnClaimLostError);
    expect(providerCalls).toBe(0);
    expect((await getBalance(fixture.ownerId)).total).toBe(61);
    const [authorization] = await pg<{ count: number }[]>`
      select count(*)::int as count from turn_authorizations where turn_id = ${fixture.claim.id}`;
    expect(authorization?.count).toBe(0);
  });

  it('leaves a post-provider lost claim reserved for exactly one recovery owner', async () => {
    const fixture = await seedReservation({ durable: 61, subscription: 0, reserve: false });
    const replacement = { ...fixture.claim, claimToken: randomUUID() };
    let providerCalls = 0;
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        providerCalls += 1;
        yield { type: 'turn.started' };
        await pg`
          update memory_dream_runs set claim_token = ${replacement.claimToken}
          where id = ${fixture.claim.id}`;
        yield {
          type: 'turn.completed',
          text: 'must not persist after claim loss',
          emptyTurn: false,
          finishReason: 'stop',
          usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        };
      },
    };
    const outcome = await runTurn(deps(compat), {
      session: fixture.session,
      agent: {
        accountId: fixture.agentId,
        username: fixture.agentUsername,
        openclawId: fixture.openclawId,
        model: 'anthropic/claude-haiku-4-5',
        agentRuntime: 'openclaw',
      },
      user: {
        accountId: fixture.ownerId,
        username: fixture.ownerUsername,
        isAdmin: false,
      },
      content: 'dream',
      source: { kind: 'memory_dream', sweepId: fixture.claim.sweepId, runId: fixture.claim.id },
      beginStream: () => ({ emit() {}, end() {} }),
      turnId: fixture.claim.id,
      fundingFence: (tx) => renewMemoryDreamRunClaim(fixture.claim, tx),
      beforeProvider: () => renewMemoryDreamRunClaim(fixture.claim),
      beforeTerminal: () => renewMemoryDreamRunClaim(fixture.claim),
    });
    expect(providerCalls).toBe(1);
    expect(outcome.errorCode).toBe('task_not_active');
    const [reserved] = await pg<{ state: string }[]>`
      select state from turn_authorizations where turn_id = ${fixture.claim.id}`;
    expect(reserved?.state).toBe('reserved');
    expect((await getBalance(fixture.ownerId)).total).toBe(0);
    const [usageBeforeRecovery] = await pg<{ count: number }[]>`
      select count(*)::int as count from usage_events
      where event_type = 'memory_dream' and turn_id = ${fixture.claim.id}`;
    expect(usageBeforeRecovery?.count).toBe(0);

    expect((await reverseWithClaim(replacement)).reversed).toBe(true);
    await recordMemoryDreamRecoveryUsage(replacement);
    expect((await getBalance(fixture.ownerId)).total).toBe(61);
  });

  it('persists exact settled full-reserve truth for a dream stream that errors after output', async () => {
    const fixture = await seedReservation({ durable: 61, subscription: 0, reserve: false });
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield { type: 'token', delta: 'usable REM prefix' };
        yield {
          type: 'error',
          code: 'gateway_stream_error',
          message: 'dream stream interrupted',
        };
      },
    };
    const outcome = await runTurn(deps(compat), {
      session: fixture.session,
      agent: {
        accountId: fixture.agentId,
        username: fixture.agentUsername,
        openclawId: fixture.openclawId,
        model: 'anthropic/claude-haiku-4-5',
        agentRuntime: 'openclaw',
      },
      user: {
        accountId: fixture.ownerId,
        username: fixture.ownerUsername,
        isAdmin: false,
      },
      content: 'dream prefix',
      source: { kind: 'memory_dream', sweepId: fixture.claim.sweepId, runId: fixture.claim.id },
      beginStream: () => ({ emit() {}, end() {} }),
      turnId: fixture.claim.id,
      fundingFence: (tx) => renewMemoryDreamRunClaim(fixture.claim, tx),
      beforeProvider: () => renewMemoryDreamRunClaim(fixture.claim),
      beforeTerminal: () => renewMemoryDreamRunClaim(fixture.claim),
    });
    expect(outcome.errorCode).toBe('gateway_stream_error');
    expect(outcome.assistantMessageId).toBeNull();
    expect((await getBalance(fixture.ownerId)).total).toBe(0);

    const evidence = await new PostgresMemoryDreamDurability().inspect(fixture.claim.id);
    expect(isSettledPartialOutputDreamFailure(evidence)).toBe(true);
    expect(evidence).toMatchObject({
      usage: {
        status: 'error',
        manna: 61,
        errorCode: 'gateway_stream_error',
        messageId: null,
      },
      authorization: {
        state: 'settled',
        authorizedMaxManna: 61,
        chargedManna: 61,
      },
    });
  });

  it('reaps a crash-shaped dream usable prefix into terminal charged truth', async () => {
    const fixture = await seedReservation({ durable: 61, subscription: 0 });
    expect(
      await claimTurnProviderStart(fixture.claim.id, {
        eventType: 'memory_dream',
        fence: (tx) => renewMemoryDreamRunClaim(fixture.claim, tx),
      }),
    ).toBe(true);
    expect(
      await markTurnUsableOutput(fixture.claim.id, {
        fence: (tx) => renewMemoryDreamRunClaim(fixture.claim, tx),
      }),
    ).toBe(true);
    await pg`
      update turn_authorizations set created_at = now() - interval '2 hours'
      where turn_id = ${fixture.claim.id}`;

    const result = await new TurnReservationReaper({
      accountScope: [fixture.ownerId],
    }).runOnce();
    expect(result.partialSettled).toBe(1);
    expect((await getBalance(fixture.ownerId)).total).toBe(0);
    const evidence = await new PostgresMemoryDreamDurability().inspect(fixture.claim.id);
    expect(isSettledPartialOutputDreamFailure(evidence)).toBe(true);
    expect(evidence).toMatchObject({
      providerStatus: 'started',
      usage: {
        status: 'error',
        manna: 61,
        errorCode: 'provider_process_lost_after_output',
      },
      authorization: {
        state: 'settled',
        authorizedMaxManna: 61,
        chargedManna: 61,
      },
    });
  });

  it('restores mixed subscription/durable pots once under concurrent crash retries', async () => {
    const fixture = await seedReservation({ durable: 21, subscription: 40 });
    expect(await getBalance(fixture.ownerId)).toMatchObject({
      balance: 0,
      subscriptionBalance: 0,
    });

    const outcomes = await Promise.all([
      reverseWithClaim(fixture.claim),
      reverseWithClaim(fixture.claim),
      reverseWithClaim(fixture.claim),
    ]);
    expect(outcomes.filter((row) => row.reversed)).toHaveLength(1);
    await Promise.all([
      recordMemoryDreamRecoveryUsage(fixture.claim),
      recordMemoryDreamRecoveryUsage(fixture.claim),
    ]);

    expect(await getBalance(fixture.ownerId)).toMatchObject({
      balance: 21,
      subscriptionBalance: 40,
      total: 61,
    });
    const [authorization] = await pg<{ state: string }[]>`
      select state from turn_authorizations where turn_id = ${fixture.claim.id}`;
    expect(authorization?.state).toBe('reversed');
    const [usage] = await pg<{ status: string; manna: number; pricing_basis: string }[]>`
      select status, manna, pricing_basis from usage_events
      where event_type = 'memory_dream' and turn_id = ${fixture.claim.id}`;
    expect(usage).toEqual({
      status: 'error',
      manna: 0,
      pricing_basis: 'notional-subscription',
    });
    const [refunds] = await pg<{ count: number }[]>`
      select count(*)::int as count from manna_transactions
      where refunds_transaction_id in (
        select reservation_tx_id from turn_authorizations where turn_id = ${fixture.claim.id}
      )`;
    expect(refunds?.count).toBe(1);
  });

  it('a stale claimant cannot reverse; the new generation safely resumes recovery', async () => {
    const fixture = await seedReservation({ durable: 61, subscription: 0 });
    const nextClaim = { ...fixture.claim, claimToken: randomUUID() };
    await pg`
      update memory_dream_runs set claim_token = ${nextClaim.claimToken}
      where id = ${fixture.claim.id}`;

    await expect(reverseWithClaim(fixture.claim)).rejects.toBeInstanceOf(TurnClaimLostError);
    expect((await getBalance(fixture.ownerId)).total).toBe(0);
    const [reserved] = await pg<{ state: string }[]>`
      select state from turn_authorizations where turn_id = ${fixture.claim.id}`;
    expect(reserved?.state).toBe('reserved');

    expect((await reverseWithClaim(nextClaim)).reversed).toBe(true);
    await recordMemoryDreamRecoveryUsage(nextClaim);
    expect((await getBalance(fixture.ownerId)).total).toBe(61);
  });

  it('corrects a committed error row only after the exact authorization is reversed', async () => {
    const fixture = await seedReservation({
      durable: 61,
      subscription: 0,
      errorUsageManna: 61,
    });
    await expect(recordMemoryDreamRecoveryUsage(fixture.claim)).rejects.toThrow(
      'no matching reversed authorization',
    );
    expect((await getBalance(fixture.ownerId)).total).toBe(0);

    await reverseWithClaim(fixture.claim);
    await recordMemoryDreamRecoveryUsage(fixture.claim);
    const [usage] = await pg<{ manna: number; error_code: string }[]>`
      select manna, error_code from usage_events
      where event_type = 'memory_dream' and turn_id = ${fixture.claim.id}`;
    expect(usage).toEqual({ manna: 0, error_code: 'crashed_reversal' });
  });

  it('never turns missing telemetry into a refund for an already-settled authorization', async () => {
    const fixture = await seedReservation({ durable: 61, subscription: 0, state: 'settled' });
    expect((await reverseWithClaim(fixture.claim)).reversed).toBe(false);
    await expect(recordMemoryDreamRecoveryUsage(fixture.claim)).rejects.toThrow(
      'no matching reversed authorization',
    );
    expect((await getBalance(fixture.ownerId)).total).toBe(0);
  });
});
