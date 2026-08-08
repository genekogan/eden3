import { randomUUID } from 'node:crypto';

import { credit, debit, getBalance, settleReservation } from '@eden3/core';
import { pg } from '@eden3/db';
import { afterAll, describe, expect, it } from 'vitest';

import { TurnReservationReaper } from '../src/services/turn-reservation-reaper';

/**
 * T08-U02 compensation reaper: an aged authorization still in 'reserved' is
 * PROOF the turn never reached its atomic terminal — reverse it in full,
 * split-exactly. Terminal rows are never touched, regardless of what
 * usage-event rows do or don't exist (money truth is the state machine,
 * never telemetry — checkpoint-#1 P0 finding 3).
 */

const marker = `turnreap_${randomUUID().slice(0, 8)}`;
const createdAccountIds: string[] = [];

async function makeAccount(): Promise<string> {
  const [row] = await pg<{ id: string }[]>`
    insert into accounts (type, username)
    values ('user', ${`${marker}_${randomUUID().slice(0, 8)}`})
    returning id`;
  if (!row) throw new Error('account insert failed');
  createdAccountIds.push(row.id);
  return row.id;
}

interface SeededReservation {
  accountId: string;
  turnId: string;
  reservationTxId: string;
}

async function seedReservation(options: {
  amount: number;
  subscriptionShare?: number;
  state: 'reserved' | 'settled' | 'reversed' | 'reaped';
  ageMinutes: number;
  settleCharge?: number;
}): Promise<SeededReservation> {
  const accountId = await makeAccount();
  await credit({ accountId, amount: 200, type: 'credit:test' });
  if (options.subscriptionShare && options.subscriptionShare > 0) {
    await credit({
      accountId,
      amount: options.subscriptionShare,
      type: 'credit:subscription',
      toSubscriptionBalance: true,
    });
  }
  const turnId = randomUUID();
  const debited = await debit({
    accountId,
    amount: options.amount,
    type: 'spend:chat',
    idempotencyKey: turnId,
  });
  if (options.settleCharge !== undefined) {
    await settleReservation({
      reservationKey: turnId,
      chargeManna: options.settleCharge,
      reservedSubscriptionManna: debited.subscriptionDrawn ?? 0,
      type: 'refund:chat:settle',
    });
  }
  const createdAt = new Date(Date.now() - options.ageMinutes * 60_000);
  await pg`
    insert into turn_authorizations
      (turn_id, account_id, provider, model, pricing_basis, ceiling_table_version,
       authorized_max_manna, reserved_subscription_manna, reservation_tx_id, state,
       charged_manna, created_at, updated_at)
    values
      (${turnId}, ${accountId}, 'anthropic', 'claude-haiku-4-5', 'provider-api',
       '2026-08-08.authz-v1', ${options.amount}, ${debited.subscriptionDrawn ?? 0},
       ${debited.transaction.id}, ${options.state},
       ${options.settleCharge ?? null}, ${createdAt.toISOString()}, ${createdAt.toISOString()})`;
  return { accountId, turnId, reservationTxId: debited.transaction.id };
}

async function stateOf(turnId: string): Promise<string | null> {
  const [row] = await pg<{ state: string }[]>`
    select state from turn_authorizations where turn_id = ${turnId}`;
  return row?.state ?? null;
}

afterAll(async () => {
  if (createdAccountIds.length > 0) {
    await pg`delete from turn_authorizations where account_id = any(${createdAccountIds}::uuid[])`;
    await pg`delete from usage_events where user_id = any(${createdAccountIds}::uuid[])`;
    await pg`delete from manna_transactions where manna_account_id in
             (select id from manna_accounts where account_id = any(${createdAccountIds}::uuid[]))`;
    await pg`delete from manna_accounts where account_id = any(${createdAccountIds}::uuid[])`;
    await pg`delete from accounts where id = any(${createdAccountIds}::uuid[])`;
  }
  await pg.end({ timeout: 5 });
});

describe('turn-reservation reaper (T08-U02 compensation)', () => {
  it('reverses an aged orphaned reservation split-exactly and marks it reaped — idempotently', async () => {
    const seeded = await seedReservation({
      amount: 61,
      subscriptionShare: 40,
      state: 'reserved',
      ageMinutes: 90,
    });
    const reaper = new TurnReservationReaper({ accountScope: [seeded.accountId] });
    const first = await reaper.runOnce();
    expect(first.reaped).toBeGreaterThanOrEqual(1);
    expect(await stateOf(seeded.turnId)).toBe('reaped');
    const balance = await getBalance(seeded.accountId);
    // 200 durable + 40 subscription funded; the 61 reservation drew 40 sub +
    // 21 durable; the reap restores both pots exactly.
    expect(balance.subscriptionBalance).toBe(40);
    expect(balance.balance).toBe(200);

    const second = await reaper.runOnce();
    expect(await stateOf(seeded.turnId)).toBe('reaped');
    expect((await getBalance(seeded.accountId)).total).toBe(240);
    expect(second.scanned).toBeGreaterThanOrEqual(0);
  });

  it('never touches a fresh reserved row (TTL) or any terminal row — even without usage rows', async () => {
    const fresh = await seedReservation({ amount: 61, state: 'reserved', ageMinutes: 5 });
    // Settled long ago, NO usage row exists (e.g. telemetry insert swallowed):
    // the charge must stand — telemetry never carries money truth.
    const settled = await seedReservation({
      amount: 61,
      state: 'settled',
      ageMinutes: 240,
      settleCharge: 17,
    });
    const reversed = await seedReservation({ amount: 61, state: 'reversed', ageMinutes: 240 });

    const reaper = new TurnReservationReaper({
      accountScope: [fresh.accountId, settled.accountId, reversed.accountId],
    });
    await reaper.runOnce();

    expect(await stateOf(fresh.turnId)).toBe('reserved');
    expect(await stateOf(settled.turnId)).toBe('settled');
    expect(await stateOf(reversed.turnId)).toBe('reversed');
    // The settled turn's exact charge still stands (200 − 17).
    expect((await getBalance(settled.accountId)).total).toBe(200 - 17);
  });

  it('reaps only the outstanding remainder when a settle leg landed but the turn never went terminal', async () => {
    // Crash-shaped anomaly: the settle refund (44) committed in a partial
    // legacy interleaving but the state stayed 'reserved'. Reaping restores
    // only the outstanding 17 — never over-credits.
    const seeded = await seedReservation({
      amount: 61,
      state: 'reserved',
      ageMinutes: 120,
      settleCharge: 17,
    });
    const reaper = new TurnReservationReaper({ accountScope: [seeded.accountId] });
    await reaper.runOnce();
    expect(await stateOf(seeded.turnId)).toBe('reaped');
    expect((await getBalance(seeded.accountId)).total).toBe(200);
  });
});
