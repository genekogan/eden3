import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { credit, debit, gatewaySessionKey, getBalance } from '@eden3/core';
import { db, pg, sessions } from '@eden3/db';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { runTurn, type CompatClientLike, type TurnSink } from '../src/services/turns';
import { TurnReservationReaper } from '../src/services/turn-reservation-reaper';
import { EventsBus } from '../src/events-bus';
import { HistorySync } from '../src/services/history-sync';
import { TurnRegistry } from '../src/services/turn-registry';
import type { GatewayTurnEvent } from '@eden3/gateway';

import { oracleReservation, oracleSettlement } from './helpers/econ-oracle';

/**
 * T08-U03 crash→reaper battery. REAP-01 injects a GENUINE crash (SIGKILL of a
 * child process running the real turn pipeline) so the terminal transaction
 * never commits and no catch/reversal runs — the only way to leave a real
 * `reserved` orphan. REAP-04 proves the reaper never touches a settled,
 * delivered turn. Real Postgres; expectations from the independent oracle.
 */

const marker = `fgeconcrash_${randomUUID().slice(0, 8)}`;
const HAIKU = 'anthropic/claude-haiku-4-5';
const childScript = fileURLToPath(new URL('./helpers/crash-turn-child.ts', import.meta.url));
const apiCwd = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

interface Fixture {
  userId: string;
  userUsername: string;
  agentId: string;
  agentUsername: string;
  agentOpenclaw: string;
  sessionId: string;
}

async function makeFixture(fundManna: number, subscriptionManna = 0): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await pg<{ id: string; username: string }[]>`
    insert into accounts (type, username) values ('user', ${`${marker}_user_${suffix}`}) returning id, username`;
  const [agent] = await pg<{ id: string; username: string }[]>`
    insert into accounts (type, username) values ('agent', ${`${marker}_agent_${suffix}`}) returning id, username`;
  const openclaw = `${marker}-bot-${suffix}`;
  await pg`insert into agents (account_id, openclaw_id, provision_status) values (${agent!.id}, ${openclaw}, 'ready')`;
  const sessionId = randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    ownerId: user!.id,
    title: `${marker} session ${suffix}`,
    sessionType: 'chat',
    gatewaySessionKey: gatewaySessionKey(sessionId),
  });
  await pg`insert into session_agents (session_id, agent_account_id) values (${sessionId}, ${agent!.id})`;
  await pg`insert into session_users (session_id, user_account_id) values (${sessionId}, ${user!.id})`;
  if (fundManna > 0) await credit({ accountId: user!.id, amount: fundManna, type: 'credit:test' });
  if (subscriptionManna > 0) {
    await credit({ accountId: user!.id, amount: subscriptionManna, type: 'credit:subscription', toSubscriptionBalance: true });
  }
  return { userId: user!.id, userUsername: user!.username, agentId: agent!.id, agentUsername: agent!.username, agentOpenclaw: openclaw, sessionId };
}

async function authzState(turnId: string): Promise<string | null> {
  const [row] = await pg<{ state: string }[]>`select state from turn_authorizations where turn_id = ${turnId}`;
  return row?.state ?? null;
}

/** Debit a foreign account's reservation (for the isolation sentinel). */
async function debitForeign(accountId: string, turnId: string, amount: number): Promise<string> {
  const res = await debit({ accountId, amount, type: 'spend:chat', idempotencyKey: turnId });
  return res.transaction.id;
}

/** Seed a foreign aged `reserved` authorization row bound to a real debit. */
async function seedForeignReserved(
  fixture: Fixture,
  turnId: string,
  reservationTxId: string,
  amount: number,
): Promise<void> {
  await pg`
    insert into turn_authorizations
      (turn_id, account_id, provider, model, pricing_basis, ceiling_table_version,
       authorized_max_manna, reserved_subscription_manna, reservation_tx_id, state,
       created_at, updated_at)
    values
      (${turnId}, ${fixture.userId}, 'anthropic', 'claude-haiku-4-5', 'provider-api',
       '2026-08-08.authz-v1', ${amount}, 0, ${reservationTxId}, 'reserved',
       now() - interval '2 hours', now() - interval '2 hours')`;
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

describe('FG-ECON crash → reaper (T08-U03)', () => {
  // FG-ECON-REAP-01: a GENUINE process crash between reservation and terminal
  // leaves a real `reserved` orphan (no catch/reversal runs); the reaper then
  // reverses it in full, split-exactly.
  it('FG-ECON-REAP-01: SIGKILL mid-turn leaves a reserved orphan; the reaper reverses it split-exact', async () => {
    const reservation = oracleReservation(HAIKU);
    const subShare = 20;
    const durableFund = 200;
    const fixture = await makeFixture(durableFund, subShare);
    const turnId = randomUUID();

    const child = spawn(
      path.resolve(apiCwd, 'node_modules/.bin/tsx'),
      [childScript],
      {
        cwd: apiCwd,
        env: {
          ...process.env,
          CRASH_TURN_ID: turnId,
          CRASH_USER_ID: fixture.userId,
          CRASH_USER_USERNAME: fixture.userUsername,
          CRASH_AGENT_ID: fixture.agentId,
          CRASH_AGENT_USERNAME: fixture.agentUsername,
          CRASH_AGENT_OPENCLAW: fixture.agentOpenclaw,
          CRASH_SESSION_ID: fixture.sessionId,
          CRASH_MODEL: HAIKU,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    // Wait for the child to report the reservation committed (it prints
    // RESERVED once inside the provider stub, after the durable reservation).
    const reservedSignal = await new Promise<boolean>((resolve, reject) => {
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes(`RESERVED ${turnId}`)) resolve(true);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', (c: Buffer) => process.stderr.write(`[crash-child] ${c.toString()}`));
      child.on('exit', (code) => reject(new Error(`child exited early (${code}) before reserving`)));
      setTimeout(() => reject(new Error('timed out waiting for RESERVED')), 40_000);
    });
    expect(reservedSignal).toBe(true);

    // The reservation + authorization row are committed and visible.
    expect(await authzState(turnId)).toBe('reserved');
    const afterReserve = await getBalance(fixture.userId);
    expect(afterReserve.total).toBe(durableFund + subShare - reservation);

    // GENUINE CRASH: SIGKILL — no catch, no reversal, no terminal commit.
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    // The orphan is still 'reserved' (nothing reversed it in-process) — even
    // though the client already saw a streamed token. The predeclared rule: an
    // unpersisted turn is a failed turn and refunds in full (partial-output
    // settlement is DEBT-004, undecided). No assistant message was persisted.
    expect(await authzState(turnId)).toBe('reserved');
    const [assistantCount] = await pg<{ n: string }[]>`
      select count(*)::text as n from messages where session_id = ${fixture.sessionId} and role = 'assistant'`;
    expect(Number(assistantCount!.n)).toBe(0);

    // ISOLATION SENTINEL (checkpoint-#2): a foreign aged `reserved` orphan on a
    // DIFFERENT account, outside the reaper's accountScope, must survive the
    // sweep untouched — proving accountScope really bounds the reap.
    const foreign = await makeFixture(150);
    const foreignTurn = randomUUID();
    const foreignDebit = await debitForeign(foreign.userId, foreignTurn, oracleReservation(HAIKU));
    await seedForeignReserved(foreign, foreignTurn, foreignDebit, oracleReservation(HAIKU));
    expect(await authzState(foreignTurn)).toBe('reserved');

    // Age the (marker-scoped) row past the reaper TTL and compensate it, scoped
    // to ONLY our account.
    await pg`update turn_authorizations set created_at = now() - interval '2 hours' where turn_id = ${turnId}`;
    const reaper = new TurnReservationReaper({ accountScope: [fixture.userId] });
    const result = await reaper.runOnce();
    expect(result.reaped).toBeGreaterThanOrEqual(1);
    expect(await authzState(turnId)).toBe('reaped');

    // Split-exact full restoration: both pots return to their pre-turn values.
    const restored = await getBalance(fixture.userId);
    expect(restored.subscriptionBalance).toBe(subShare);
    expect(restored.balance).toBe(durableFund);
    expect(restored.total).toBe(durableFund + subShare);

    // The foreign orphan is UNTOUCHED — the scope held.
    expect(await authzState(foreignTurn)).toBe('reserved');
    expect((await getBalance(foreign.userId)).total).toBe(150 - oracleReservation(HAIKU));

    // Idempotent: a second sweep neither double-credits nor re-touches it.
    await reaper.runOnce();
    expect((await getBalance(fixture.userId)).total).toBe(durableFund + subShare);
    expect(await authzState(turnId)).toBe('reaped');
    expect(await authzState(foreignTurn)).toBe('reserved');
  }, 60_000);

  // FG-ECON-REAP-04: the reaper never touches a settled, delivered turn — even
  // when aged past TTL. Money for delivered+settled work is never refunded.
  it('FG-ECON-REAP-04: an aged SETTLED turn is never reaped (delivered work stays charged)', async () => {
    const reservation = oracleReservation(HAIKU);
    const usage = { promptTokens: 20_000, completionTokens: 1_000 };
    const expected = oracleSettlement(usage, HAIKU);
    const fund = reservation + 200;
    const fixture = await makeFixture(fund);
    const turnId = randomUUID();
    const compat: CompatClientLike = {
      async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
        yield { type: 'turn.started' };
        yield { type: 'turn.completed', text: 'delivered', emptyTurn: false, finishReason: 'stop', usage };
      },
    };
    const sink: TurnSink = { emit() {}, end() {} };
    const [sessionRow] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, fixture.sessionId))
      .limit(1);
    const outcome = await runTurn(
      {
        compat,
        bus: new EventsBus(),
        registry: new TurnRegistry(),
        historySync: new HistorySync({ tools: { sessionsHistory: async () => ({ sessionKey: '', messages: [], truncated: false, contentTruncated: false }) } }),
      },
      {
        session: sessionRow!,
        agent: { accountId: fixture.agentId, username: fixture.agentUsername, openclawId: fixture.agentOpenclaw, model: HAIKU, gatewayModelOverride: HAIKU, agentRuntime: 'openclaw' },
        user: { accountId: fixture.userId, username: fixture.userUsername, isAdmin: false },
        content: 'deliver',
        turnId,
        beginStream: () => sink,
      },
    );
    expect(outcome.errorCode).toBeNull();
    expect(await authzState(turnId)).toBe('settled');
    const afterSettle = await getBalance(fixture.userId);
    expect(afterSettle.total).toBe(fund - expected.charged);

    // Age it and sweep — a settled row must be invisible to the reaper.
    await pg`update turn_authorizations set created_at = now() - interval '2 hours' where turn_id = ${turnId}`;
    const reaper = new TurnReservationReaper({ accountScope: [fixture.userId] });
    await reaper.runOnce();
    expect(await authzState(turnId)).toBe('settled');
    // The delivered turn's charge still stands — never refunded.
    expect((await getBalance(fixture.userId)).total).toBe(fund - expected.charged);
  });
});
