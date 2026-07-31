import { randomUUID } from 'node:crypto';

import { credit, debit } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUTOMATION_HOURLY_MANNA_CAP,
  assertAutomationBudget,
  automationLedgerKey,
  automationMannaSpendLastHour,
  automationRollingCap,
} from '../src/services/automation-budget';
import { insertAgentAccount, insertUserAccount, makeMarker } from './fixtures';

loadRootEnv();

const marker = makeMarker('autobudget');
let ownerId = '';
let agentId = '';

beforeAll(async () => {
  ownerId = await insertUserAccount(`${marker}_owner`);
  agentId = await insertAgentAccount(`${marker}_bot`, {
    ownerId,
    openclawId: `${marker}-bot`,
    provisionStatus: 'ready',
  });
  await credit({ accountId: ownerId, amount: 1_000, type: 'credit:test' });
});

afterAll(async () => {
  await pg`delete from manna_transactions where manna_account_id in
           (select id from manna_accounts where account_id = ${ownerId})`;
  await pg`delete from manna_accounts where account_id = ${ownerId}`;
  await pg`delete from agents where account_id = ${agentId}`;
  await pg`delete from accounts where id in (${agentId}, ${ownerId})`;
  await pg.end({ timeout: 5 });
});

describe('rolling automation manna budget', () => {
  it('counts scoped settled ledger charges but ignores interactive/old rows', async () => {
    const now = new Date();
    const scopedDebit = async (amount: number, createdAt?: Date) => {
      const key = automationLedgerKey(agentId, randomUUID());
      await debit({
        accountId: ownerId,
        amount,
        type: 'spend:chat',
        idempotencyKey: key,
        rollingCap: automationRollingCap(agentId, now),
      });
      if (createdAt) {
        await pg`update manna_transactions set created_at = ${createdAt.toISOString()}
                 where idempotency_key = ${key}`;
      }
    };
    await scopedDebit(31);
    await scopedDebit(49);
    await debit({
      accountId: ownerId,
      amount: 100,
      type: 'spend:chat',
      idempotencyKey: `interactive:${randomUUID()}`,
    });
    // Insert without the rolling guard, then age it out: the query, not the
    // attempted debit, owns the window-boundary assertion.
    const oldKey = automationLedgerKey(agentId, randomUUID());
    await debit({
      accountId: ownerId,
      amount: 20,
      type: 'spend:chat',
      idempotencyKey: oldKey,
    });
    await pg`update manna_transactions set created_at = ${new Date(now.getTime() - 61 * 60_000).toISOString()}
             where idempotency_key = ${oldKey}`;

    expect(await automationMannaSpendLastHour(agentId, { now })).toBe(
      AUTOMATION_HOURLY_MANNA_CAP,
    );
    await expect(assertAutomationBudget(agentId, { now })).rejects.toMatchObject({
      statusCode: 429,
      code: 'automation_hourly_budget_exceeded',
    });
  });
});
