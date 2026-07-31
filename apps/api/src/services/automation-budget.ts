import { scopedLedgerIdempotencyKey, scopedNetSpendSince } from '@eden3/core';

import { ApiError } from '../errors';

/**
 * Rolling agent-automation budget. This is intentionally separate from the
 * owner's daily manna ceiling: the daily cap protects the account while this
 * smaller window prevents a self-scheduled agent from running away quickly.
 */
export const AUTOMATION_HOURLY_MANNA_CAP = 80;
export const AUTOMATION_HOURLY_BUDGET_ERROR = 'automation_hourly_budget_exceeded';
export const AUTOMATION_BUDGET_SCOPE = 'automation';
export const AUTOMATION_BUDGET_WINDOW_MS = 60 * 60 * 1000;

export type AutomationSourceKind = 'scheduled_task' | 'heartbeat';

export function automationLedgerKey(
  agentId: string,
  turnId: string,
  suffix?: 'settle',
): string {
  return scopedLedgerIdempotencyKey(
    AUTOMATION_BUDGET_SCOPE,
    agentId,
    suffix ? `${turnId}:${suffix}` : turnId,
  );
}

export function automationRollingCap(agentId: string, now?: Date): {
  scope: string;
  scopeId: string;
  limit: number;
  windowMs: number;
  now?: Date;
} {
  return {
    scope: AUTOMATION_BUDGET_SCOPE,
    scopeId: agentId,
    limit: AUTOMATION_HOURLY_MANNA_CAP,
    windowMs: AUTOMATION_BUDGET_WINDOW_MS,
    ...(now ? { now } : {}),
  };
}

/**
 * Sum transactionally-attributed cron/heartbeat ledger spend in the rolling
 * hour. Linked refunds reduce their original debit at the original timestamp,
 * so window edges cannot undercount newer work.
 */
export async function automationMannaSpendLastHour(
  agentId: string,
  options: { now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - AUTOMATION_BUDGET_WINDOW_MS);
  return await scopedNetSpendSince(AUTOMATION_BUDGET_SCOPE, agentId, since);
}

/** Refuse a new autonomous turn once its agent has spent the rolling cap. */
export async function assertAutomationBudget(
  agentId: string,
  options: { now?: Date } = {},
): Promise<{ spent: number; cap: number }> {
  const spent = await automationMannaSpendLastHour(agentId, options);
  if (spent >= AUTOMATION_HOURLY_MANNA_CAP) {
    throw new ApiError(
      429,
      AUTOMATION_HOURLY_BUDGET_ERROR,
      `Agent automation hourly manna cap reached: ${spent} spent in the last hour, cap is ${AUTOMATION_HOURLY_MANNA_CAP}`,
    );
  }
  return { spent, cap: AUTOMATION_HOURLY_MANNA_CAP };
}
