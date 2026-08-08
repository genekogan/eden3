import { randomUUID } from 'node:crypto';

import type { AuthSession } from '@eden3/core';
import { credit, gatewaySessionKey, getBalance } from '@eden3/core';
import { pg, type Session } from '@eden3/db';
import type { GatewayTurnEvent } from '@eden3/gateway';
import type { SessionEvent } from '@eden3/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EventsBus } from '../src/events-bus';
import { HistorySync } from '../src/services/history-sync';
import { TurnRegistry } from '../src/services/turn-registry';
import { runTurn, type CompatClientLike, type TurnSink } from '../src/services/turns';

/**
 * runTurn refund-guard regression (W2 finding #3, turns.ts side): a throw
 * ANYWHERE after the successful debit but before the SSE stream (primer load,
 * user-message persist, registry register, beginStream) must refund the debit
 * and re-throw — the ledger nets to zero and the route still gets its error.
 *
 * We force the persist to fail by handing runTurn a session whose id has NO
 * row in `sessions`: persistMessage inserts into `messages` with that
 * session_id, tripping the FK. Real Postgres + real manna ledger.
 */

const marker = `turnsrefund_${randomUUID().slice(0, 8)}`;

let userId = '';

/** A compat client that must never be reached (the throw precedes streaming). */
const unusedCompat: CompatClientLike = {
  // eslint-disable-next-line require-yield
  async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
    throw new Error('compat.chatTurn must not run — the turn failed before streaming');
  },
};

function makeDeps() {
  return {
    compat: unusedCompat,
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

function userSession(): AuthSession {
  return { accountId: userId, username: `${marker}_user`, isAdmin: false };
}

beforeAll(async () => {
  const rows = await pg<{ id: string }[]>`
    insert into accounts (type, username) values ('user', ${`${marker}_user`}) returning id`;
  userId = rows[0]!.id;
  // Cover the haiku worst-case reservation (61 manna, T08-U02); this test
  // exercises the pre-stream refund guard, not balance rejection.
  await credit({ accountId: userId, amount: 100, type: 'credit:test' });
});

afterAll(async () => {
  await pg`delete from turn_authorizations where account_id = ${userId}
           or account_id in (select id from accounts where username like ${`${marker}%`})`;
  await pg`delete from manna_transactions where manna_account_id in
           (select id from manna_accounts where account_id = ${userId})`;
  await pg`delete from manna_accounts where account_id = ${userId}`;
  await pg`delete from accounts where username like ${`${marker}%`}`;
  await pg.end({ timeout: 5 });
});

describe('runTurn refund-guard (pre-stream failure)', () => {
  it('refunds the debit when the user-message persist throws (net-zero ledger)', async () => {
    const before = await getBalance(userId);

    // session.id points at NO sessions row → persistMessage FK-fails.
    const orphanSessionId = randomUUID();
    const session = {
      id: orphanSessionId,
      gatewaySessionKey: gatewaySessionKey(orphanSessionId),
      externalId: null,
      gatewayPrimedAt: null,
    } as unknown as Session;

    let streamOpened = false;
    await expect(
      runTurn(makeDeps(), {
        session,
        agent: {
          accountId: userId,
          username: 'agent',
          openclawId: 'testbot',
          model: 'anthropic/claude-haiku-4-5',
          agentRuntime: 'openclaw',
        },
        user: userSession(),
        content: 'hello',
        beginStream: (): TurnSink => {
          streamOpened = true;
          return { emit() {}, end() {} };
        },
      }),
    ).rejects.toThrow();

    // The stream was never opened (failure preceded beginStream).
    expect(streamOpened).toBe(false);

    // Ledger nets to zero: a spend:chat debit AND a refund:chat both landed.
    const after = await getBalance(userId);
    expect(after.total).toBe(before.total);

    const txs = await pg<{ type: string; amount: string }[]>`
      select type, amount from manna_transactions
      where manna_account_id in (select id from manna_accounts where account_id = ${userId})
      order by created_at asc`;
    const spend = txs.find((t) => t.type === 'spend:chat');
    const refundTx = txs.find((t) => t.type === 'refund:chat');
    expect(spend, 'a chat debit should have been recorded').toBeDefined();
    expect(refundTx, 'a chat refund should have been recorded').toBeDefined();
    expect(Number(spend!.amount)).toBe(-61);
    expect(Number(refundTx!.amount)).toBe(61);
    // State-machine truth, not just aggregate balance (checkpoint-#2): the
    // authorization ended 'reversed' and the refund is linked to the debit.
    const [authz] = await pg<{ state: string }[]>`
      select ta.state from turn_authorizations ta
      join manna_transactions mt on mt.id = ta.reservation_tx_id
      where mt.idempotency_key is not null and ta.account_id = ${userId}`;
    expect(authz).toMatchObject({ state: 'reversed' });
  });
});
