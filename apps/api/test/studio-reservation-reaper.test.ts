import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalMediaStore, credit, getBalance } from '@eden3/core';
import { pg } from '@eden3/db';
import { afterAll, describe, expect, it } from 'vitest';

import { MediaPipeline } from '../src/services/media-pipeline';
import {
  completeStudioGeneration,
  reserveStudioGeneration,
  StudioReservationReaper,
  type StudioAuthorizationQuote,
} from '../src/services/studio-reservations';

const marker = `studioreap_${randomUUID().slice(0, 8)}`;
const accountIds: string[] = [];
const mediaDir = mkdtempSync(path.join(tmpdir(), 'eden3-studio-reaper-store-'));
const sourceDir = mkdtempSync(path.join(tmpdir(), 'eden3-studio-reaper-src-'));

const quote: StudioAuthorizationQuote = {
  action: 'image',
  provider: 'fal',
  model: 'fal-ai/flux/dev',
  tableVersion: 'test-studio-reaper-v1',
  costUsd: 0.034,
  manna: 34,
};

async function makeAccount(): Promise<string> {
  const [row] = await pg<{ id: string }[]>`
    insert into accounts (type, username)
    values ('user', ${`${marker}_${randomUUID().slice(0, 8)}`})
    returning id`;
  if (!row) throw new Error('account insert failed');
  accountIds.push(row.id);
  return row.id;
}

async function fundedAccount(): Promise<string> {
  const accountId = await makeAccount();
  await credit({ accountId, amount: 100, type: 'credit:test' });
  await credit({
    accountId,
    amount: 20,
    type: 'credit:test-subscription',
    toSubscriptionBalance: true,
  });
  return accountId;
}

afterAll(async () => {
  if (accountIds.length > 0) {
    await pg`delete from media_assets where creation_id in
             (select id from creations where user_id = any(${accountIds}::uuid[]))`;
    await pg`delete from creations where user_id = any(${accountIds}::uuid[])`;
    await pg`delete from usage_events where user_id = any(${accountIds}::uuid[])`;
    await pg`delete from manna_transactions where manna_account_id in
             (select id from manna_accounts where account_id = any(${accountIds}::uuid[]))`;
    await pg`delete from manna_accounts where account_id = any(${accountIds}::uuid[])`;
    await pg`delete from accounts where id = any(${accountIds}::uuid[])`;
  }
  await pg.end({ timeout: 5 });
});

describe('Studio durable reservation and crash reaper (DEBT-010)', () => {
  it('atomically refuses a debit when the durable authorization row cannot be inserted', async () => {
    const accountId = await fundedAccount();
    const turnId = randomUUID();
    const reservationKey = `studio:${turnId}:reserve`;
    await pg`
      insert into usage_events (event_type, status, user_id, turn_id)
      values ('studio_generation', 'error', ${accountId}, ${turnId})`;

    await expect(
      reserveStudioGeneration({
        turnId,
        accountId,
        tool: 'image_generate',
        quote,
        reservationKey,
        dailyCap: 10_000,
      }),
    ).rejects.toThrow('durable authorization refused');

    expect(await getBalance(accountId)).toMatchObject({ balance: 100, subscriptionBalance: 20 });
    const [ledger] = await pg<{ count: string }[]>`
      select count(*) from manna_transactions where idempotency_key = ${reservationKey}`;
    expect(Number(ledger?.count ?? -1)).toBe(0);
  });

  it('reverses a crash after debit split-exactly once across concurrent/restarted reapers', async () => {
    const accountId = await fundedAccount();
    const turnId = randomUUID();
    const reservationKey = `studio:${turnId}:reserve`;
    await reserveStudioGeneration({
      turnId,
      accountId,
      tool: 'image_generate',
      quote,
      reservationKey,
      dailyCap: 10_000,
    });
    expect(await getBalance(accountId)).toMatchObject({ balance: 86, subscriptionBalance: 0 });
    await pg`update usage_events set created_at = now() - interval '2 hours'
             where event_type = 'studio_generation' and turn_id = ${turnId}`;

    const a = new StudioReservationReaper({ accountScope: [accountId] });
    const b = new StudioReservationReaper({ accountScope: [accountId] });
    const outcomes = await Promise.all([a.runOnce(), b.runOnce()]);
    expect(outcomes.reduce((sum, outcome) => sum + outcome.reaped, 0)).toBe(1);
    expect(await getBalance(accountId)).toMatchObject({ balance: 100, subscriptionBalance: 20 });

    const [usage] = await pg<{ status: string; manna: number; errorCode: string }[]>`
      select status, manna, error_code as "errorCode" from usage_events
      where event_type = 'studio_generation' and turn_id = ${turnId}`;
    expect(usage).toEqual({ status: 'error', manna: 0, errorCode: 'studio_reservation_reaped' });
    const [refunds] = await pg<{ count: string }[]>`
      select count(*) from manna_transactions
      where refunds_transaction_id = (
        select id from manna_transactions where idempotency_key = ${reservationKey}
      )`;
    expect(Number(refunds?.count ?? -1)).toBe(1);

    const restarted = new StudioReservationReaper({ accountScope: [accountId] });
    expect((await restarted.runOnce()).reaped).toBe(0);
    expect((await getBalance(accountId)).total).toBe(120);
  });

  it('rolls creation and completed state back together, then reaps the surviving pending debit', async () => {
    const accountId = await fundedAccount();
    const turnId = randomUUID();
    const reservation = await reserveStudioGeneration({
      turnId,
      accountId,
      tool: 'image_generate',
      quote,
      reservationKey: `studio:${turnId}:reserve`,
      dailyCap: 10_000,
    });
    const source = path.join(sourceDir, `${turnId}.png`);
    writeFileSync(source, Buffer.from(`fake-png-${turnId}`));
    const pipeline = new MediaPipeline({
      store: new LocalMediaStore({ mediaDir, baseUrl: 'http://media.test/media' }),
    });

    await expect(
      pipeline.ingestFile(source, {
        userId: accountId,
        tool: 'image_generate',
        args: { prompt: 'must not commit' },
        finalizeTransaction: async (tx, result) => {
          if (!result.creation) throw new Error('missing creation');
          await completeStudioGeneration(tx, {
            reservation,
            creationId: result.creation.id,
            latencyMs: 1,
          });
          throw new Error('simulated process failure before transaction commit');
        },
      }),
    ).rejects.toThrow('simulated process failure');

    const [creationCount] = await pg<{ count: string }[]>`
      select count(*) from creations where user_id = ${accountId}`;
    expect(Number(creationCount?.count ?? -1)).toBe(0);
    const [usageBefore] = await pg<{ status: string }[]>`
      select status from usage_events
      where event_type = 'studio_generation' and turn_id = ${turnId}`;
    expect(usageBefore?.status).toBe('pending');

    const reaper = new StudioReservationReaper({
      ttlMs: 0,
      now: () => new Date(Date.now() + 1),
      accountScope: [accountId],
    });
    expect((await reaper.runOnce()).reaped).toBe(1);
    expect((await getBalance(accountId)).total).toBe(120);
  });

  it('never refunds a creation whose completed state committed in the same transaction', async () => {
    const accountId = await fundedAccount();
    const turnId = randomUUID();
    const reservation = await reserveStudioGeneration({
      turnId,
      accountId,
      tool: 'image_generate',
      quote,
      reservationKey: `studio:${turnId}:reserve`,
      dailyCap: 10_000,
    });
    const source = path.join(sourceDir, `${turnId}.png`);
    writeFileSync(source, Buffer.from(`successful-png-${turnId}`));
    const pipeline = new MediaPipeline({
      store: new LocalMediaStore({ mediaDir, baseUrl: 'http://media.test/media' }),
    });
    const result = await pipeline.ingestFile(source, {
      userId: accountId,
      tool: 'image_generate',
      args: { prompt: 'committed' },
      finalizeTransaction: async (tx, ingested) => {
        if (!ingested.creation) throw new Error('missing creation');
        await completeStudioGeneration(tx, {
          reservation,
          creationId: ingested.creation.id,
          latencyMs: 1,
        });
      },
    });
    expect(result.creation?.id).toBeTruthy();

    const reaper = new StudioReservationReaper({
      ttlMs: 0,
      now: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
      accountScope: [accountId],
    });
    expect((await reaper.runOnce()).reaped).toBe(0);
    expect(await getBalance(accountId)).toMatchObject({ balance: 86, subscriptionBalance: 0 });
    const [usage] = await pg<{ status: string; creationId: string }[]>`
      select status, metadata->>'creationId' as "creationId" from usage_events
      where event_type = 'studio_generation' and turn_id = ${turnId}`;
    expect(usage).toEqual({ status: 'completed', creationId: result.creation!.id });
  });
});
