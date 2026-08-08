import {
  isHex24,
  isUuid,
  numericToNumber,
  resolveAccount,
  resolveAccountByUsername,
} from '@eden3/core';
import { db, mannaAccounts, pg } from '@eden3/db';
import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * User-facing usage API (auth required — everything is scoped to the
 * signed-in account). This is the *tenant* view of consumption: a user sees
 * ONLY their own balance, their own spend, and what their own agents did.
 *
 * Deliberately distinct from /operator/usage/summary, which is the admin
 * PLATFORM view (all users, provider cost_usd, gateway/egress health). This
 * route never exposes provider `cost_usd` — that is proprietary margin data.
 * Users are billed in manna (1000 manna = $1); manna is the only spend unit
 * surfaced here.
 *
 *   GET /usage/summary — {balance, spend{week,month}, recent[]} for the viewer.
 */

const summaryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * Filter spend windows + recent events to one agent (username, uuid, or
   * legacy 24-hex id). `balance` stays account-global — manna is user-level.
   */
  agent: z.string().trim().min(1).max(200).optional(),
});

/** Resolve an agent reference to an accounts.id, or null when unknown. */
async function resolveAgentRef(ref: string): Promise<string | null> {
  if (isUuid(ref)) return ref.toLowerCase();
  if (isHex24(ref)) return (await resolveAccount(ref))?.id ?? null;
  return (await resolveAccountByUsername(ref))?.id ?? null;
}

interface SpendRow {
  week_manna: string;
  week_events: number;
  month_manna: string;
  month_events: number;
}

interface RecentRow {
  id: string;
  event_type: string;
  status: string;
  agent_id: string | null;
  agent_username: string | null;
  model: string | null;
  tool: string | null;
  manna: number | null;
  latency_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

export const usageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/summary', { preHandler: app.requireAuth }, async (req) => {
    const accountId = req.account?.accountId;
    if (accountId === undefined) return null; // unreachable — requireAuth replied 401

    const { limit, agent } = summaryQuery.parse(req.query);

    let agentId: string | null = null;
    let unknownAgent = false;
    if (agent !== undefined) {
      agentId = await resolveAgentRef(agent);
      if (agentId === null) unknownAgent = true;
    }

    const [balanceRow] = await db
      .select()
      .from(mannaAccounts)
      .where(eq(mannaAccounts.accountId, accountId))
      .limit(1);

    // Spend windows: last 7 days (week) and last 30 days (month), scoped to the
    // viewer (optionally to one agent). Only the metered `manna` column is
    // summed — never cost_usd. An unknown agent ref yields empty usage (the
    // account balance is still returned — it is not agent-scoped).
    const agentFilter = agentId !== null ? pg`and agent_id = ${agentId}::uuid` : pg``;
    const [spend] = unknownAgent
      ? [undefined]
      : await pg<SpendRow[]>`
      select
        coalesce(sum(manna) filter (where created_at >= now() - interval '7 days'), 0)::bigint::text as week_manna,
        count(*) filter (where created_at >= now() - interval '7 days')::int as week_events,
        coalesce(sum(manna), 0)::bigint::text as month_manna,
        count(*)::int as month_events
      from usage_events
      where user_id = ${accountId}::uuid
        and created_at >= now() - interval '30 days'
        ${agentFilter}`;

    const recent = unknownAgent
      ? []
      : await pg<RecentRow[]>`
      select u.id,
             u.event_type,
             u.status,
             u.agent_id,
             agent_account.username::text as agent_username,
             u.model,
             u.metadata->>'tool' as tool,
             u.manna,
             u.latency_ms,
             u.error_code,
             u.error_message,
             u.created_at
      from usage_events u
      left join accounts agent_account on agent_account.id = u.agent_id
      where u.user_id = ${accountId}::uuid
        ${agentId !== null ? pg`and u.agent_id = ${agentId}::uuid` : pg``}
      order by u.created_at desc, u.id desc
      limit ${limit}`;

    const balance = balanceRow ? numericToNumber(balanceRow.balance) : 0;
    const subscriptionManna = balanceRow ? numericToNumber(balanceRow.subscriptionBalance) : 0;

    return {
      balance: {
        manna: balance,
        subscriptionManna,
        total: balance + subscriptionManna,
        updatedAt: (balanceRow?.updatedAt ?? new Date()).toISOString(),
      },
      spend: {
        week: { manna: toNumber(spend?.week_manna), events: spend?.week_events ?? 0 },
        month: { manna: toNumber(spend?.month_manna), events: spend?.month_events ?? 0 },
      },
      recent: recent.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        status: row.status,
        agentId: row.agent_id,
        agentUsername: row.agent_username,
        model: row.model,
        tool: row.tool,
        manna: row.manna,
        latencyMs: row.latency_ms,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    };
  });
};
