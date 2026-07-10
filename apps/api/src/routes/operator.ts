import { pg } from '@eden3/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors';

const summaryQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  userId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
});

const invoiceRow = z.object({
  provider: z.string().trim().min(1),
  costUsd: z.coerce.number().finite().nonnegative(),
  label: z.string().trim().min(1).optional(),
});

const reconcileBody = z
  .object({
    periodStart: z.string().trim().min(1),
    periodEnd: z.string().trim().min(1),
    toleranceUsd: z.coerce.number().finite().nonnegative().default(1),
    tolerancePct: z.coerce.number().finite().nonnegative().max(1).default(0.03),
    invoices: z.array(invoiceRow).min(1),
  })
  .superRefine((body, ctx) => {
    const start = Date.parse(body.periodStart);
    const end = Date.parse(body.periodEnd);
    if (Number.isNaN(start)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodStart'], message: 'Invalid date' });
    }
    if (Number.isNaN(end)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: 'Invalid date' });
    }
    if (!Number.isNaN(start) && !Number.isNaN(end) && end <= start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodEnd'],
        message: 'periodEnd must be after periodStart',
      });
    }
  });

interface TotalRow {
  event_count: number;
  total_cost_usd: string;
  total_manna: string;
  avg_latency_ms: string | null;
  error_count: number;
}

interface BreakdownRow {
  id: string | null;
  username: string | null;
  event_count: number;
  total_cost_usd: string;
  total_manna: string;
}

interface StatusRow {
  status: string;
  event_count: number;
  total_cost_usd: string;
  total_manna: string;
}

interface RecentRow {
  id: string;
  event_type: string;
  status: string;
  user_id: string | null;
  user_username: string | null;
  agent_id: string | null;
  agent_username: string | null;
  session_id: string | null;
  message_id: string | null;
  turn_id: string | null;
  provider: string | null;
  model: string | null;
  cost_usd: string | null;
  manna: number | null;
  latency_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
}

interface ReconcileComputedRow {
  provider: string;
  event_count: number;
  total_cost_usd: string;
  total_manna: string;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function signedDeltaPct(deltaUsd: number, invoiceCostUsd: number, computedCostUsd: number): number | null {
  const basis = Math.max(Math.abs(invoiceCostUsd), Math.abs(computedCostUsd));
  if (basis === 0) return null;
  return roundUsd(deltaUsd / basis);
}

export const operatorRoutes: FastifyPluginAsync = async (app) => {
  app.get('/usage/summary', { preHandler: app.requireAuth }, async (req) => {
    if (!req.account?.isAdmin) {
      throw new ApiError(403, 'forbidden', 'Admin access required');
    }

    const query = summaryQuery.parse(req.query);
    const userFilter = query.userId ?? null;
    const agentFilter = query.agentId ?? null;
    const [totals] = await pg<TotalRow[]>`
      select count(*)::int as event_count,
             coalesce(sum(cost_usd), 0)::text as total_cost_usd,
             coalesce(sum(manna), 0)::bigint::text as total_manna,
             avg(latency_ms)::text as avg_latency_ms,
             count(*) filter (where status = 'error')::int as error_count
      from usage_events
      where created_at >= now() - (${query.days}::int * interval '1 day')
        and (${userFilter}::uuid is null or user_id = ${userFilter}::uuid)
        and (${agentFilter}::uuid is null or agent_id = ${agentFilter}::uuid)`;

    const byUser = await pg<BreakdownRow[]>`
      select u.user_id as id,
             a.username::text as username,
             count(*)::int as event_count,
             coalesce(sum(u.cost_usd), 0)::text as total_cost_usd,
             coalesce(sum(u.manna), 0)::bigint::text as total_manna
      from usage_events u
      left join accounts a on a.id = u.user_id
      where u.created_at >= now() - (${query.days}::int * interval '1 day')
        and (${userFilter}::uuid is null or u.user_id = ${userFilter}::uuid)
        and (${agentFilter}::uuid is null or u.agent_id = ${agentFilter}::uuid)
      group by u.user_id, a.username
      order by coalesce(sum(u.cost_usd), 0) desc, count(*) desc
      limit ${query.limit}`;

    const byAgent = await pg<BreakdownRow[]>`
      select u.agent_id as id,
             a.username::text as username,
             count(*)::int as event_count,
             coalesce(sum(u.cost_usd), 0)::text as total_cost_usd,
             coalesce(sum(u.manna), 0)::bigint::text as total_manna
      from usage_events u
      left join accounts a on a.id = u.agent_id
      where u.created_at >= now() - (${query.days}::int * interval '1 day')
        and (${userFilter}::uuid is null or u.user_id = ${userFilter}::uuid)
        and (${agentFilter}::uuid is null or u.agent_id = ${agentFilter}::uuid)
      group by u.agent_id, a.username
      order by coalesce(sum(u.cost_usd), 0) desc, count(*) desc
      limit ${query.limit}`;

    const byStatus = await pg<StatusRow[]>`
      select status,
             count(*)::int as event_count,
             coalesce(sum(cost_usd), 0)::text as total_cost_usd,
             coalesce(sum(manna), 0)::bigint::text as total_manna
      from usage_events
      where created_at >= now() - (${query.days}::int * interval '1 day')
        and (${userFilter}::uuid is null or user_id = ${userFilter}::uuid)
        and (${agentFilter}::uuid is null or agent_id = ${agentFilter}::uuid)
      group by status
      order by count(*) desc`;

    const recent = await pg<RecentRow[]>`
      select u.id,
             u.event_type,
             u.status,
             u.user_id,
             user_account.username::text as user_username,
             u.agent_id,
             agent_account.username::text as agent_username,
             u.session_id,
             u.message_id,
             u.turn_id,
             u.provider,
             u.model,
             u.cost_usd::text as cost_usd,
             u.manna,
             u.latency_ms,
             u.error_code,
             u.error_message,
             u.created_at
      from usage_events u
      left join accounts user_account on user_account.id = u.user_id
      left join accounts agent_account on agent_account.id = u.agent_id
      where u.created_at >= now() - (${query.days}::int * interval '1 day')
        and (${userFilter}::uuid is null or u.user_id = ${userFilter}::uuid)
        and (${agentFilter}::uuid is null or u.agent_id = ${agentFilter}::uuid)
      order by u.created_at desc, u.id desc
      limit ${query.limit}`;

    return {
      window: { days: query.days, userId: userFilter, agentId: agentFilter },
      totals: {
        events: totals?.event_count ?? 0,
        costUsd: toNumber(totals?.total_cost_usd),
        manna: toNumber(totals?.total_manna),
        avgLatencyMs: totals?.avg_latency_ms === null ? null : toNumber(totals?.avg_latency_ms),
        errors: totals?.error_count ?? 0,
      },
      byUser: byUser.map((row) => ({
        userId: row.id,
        username: row.username,
        events: row.event_count,
        costUsd: toNumber(row.total_cost_usd),
        manna: toNumber(row.total_manna),
      })),
      byAgent: byAgent.map((row) => ({
        agentId: row.id,
        username: row.username,
        events: row.event_count,
        costUsd: toNumber(row.total_cost_usd),
        manna: toNumber(row.total_manna),
      })),
      byStatus: byStatus.map((row) => ({
        status: row.status,
        events: row.event_count,
        costUsd: toNumber(row.total_cost_usd),
        manna: toNumber(row.total_manna),
      })),
      recent: recent.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        status: row.status,
        userId: row.user_id,
        userUsername: row.user_username,
        agentId: row.agent_id,
        agentUsername: row.agent_username,
        sessionId: row.session_id,
        messageId: row.message_id,
        turnId: row.turn_id,
        provider: row.provider,
        model: row.model,
        costUsd: toNumber(row.cost_usd),
        manna: toNumber(row.manna),
        latencyMs: row.latency_ms,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    };
  });

  app.post('/usage/reconcile', { preHandler: app.requireAuth }, async (req) => {
    if (!req.account?.isAdmin) {
      throw new ApiError(403, 'forbidden', 'Admin access required');
    }

    const body = reconcileBody.parse(req.body);
    const periodStart = new Date(body.periodStart);
    const periodEnd = new Date(body.periodEnd);

    const computed = await pg<ReconcileComputedRow[]>`
      select coalesce(provider, 'unknown') as provider,
             count(*)::int as event_count,
             coalesce(sum(cost_usd), 0)::text as total_cost_usd,
             coalesce(sum(manna), 0)::bigint::text as total_manna
      from usage_events
      where created_at >= ${periodStart.toISOString()}::timestamptz
        and created_at < ${periodEnd.toISOString()}::timestamptz
      group by coalesce(provider, 'unknown')`;

    const invoiceByProvider = new Map<string, { provider: string; costUsd: number; labels: string[] }>();
    for (const invoice of body.invoices) {
      const provider = invoice.provider.toLowerCase();
      const current = invoiceByProvider.get(provider) ?? { provider, costUsd: 0, labels: [] };
      current.costUsd = roundUsd(current.costUsd + invoice.costUsd);
      if (invoice.label) current.labels.push(invoice.label);
      invoiceByProvider.set(provider, current);
    }

    const computedByProvider = new Map(
      computed.map((row) => [
        row.provider.toLowerCase(),
        {
          provider: row.provider.toLowerCase(),
          events: row.event_count,
          costUsd: toNumber(row.total_cost_usd),
          manna: toNumber(row.total_manna),
        },
      ]),
    );

    const providerIds = [...new Set([...invoiceByProvider.keys(), ...computedByProvider.keys()])].sort();
    const providers = providerIds.map((provider) => {
      const invoice = invoiceByProvider.get(provider);
      const usage = computedByProvider.get(provider);
      const invoiceCostUsd = invoice?.costUsd ?? 0;
      const computedCostUsd = usage?.costUsd ?? 0;
      const deltaUsd = roundUsd(computedCostUsd - invoiceCostUsd);
      const toleranceUsd = roundUsd(Math.max(body.toleranceUsd, invoiceCostUsd * body.tolerancePct));
      const withinTolerance = Math.abs(deltaUsd) <= toleranceUsd;
      return {
        provider,
        invoiceCostUsd,
        computedCostUsd,
        deltaUsd,
        deltaPct: signedDeltaPct(deltaUsd, invoiceCostUsd, computedCostUsd),
        toleranceUsd,
        withinTolerance,
        events: usage?.events ?? 0,
        manna: usage?.manna ?? 0,
        labels: invoice?.labels ?? [],
      };
    });

    const totalInvoiceCostUsd = roundUsd([...invoiceByProvider.values()].reduce((sum, row) => sum + row.costUsd, 0));
    const totalComputedCostUsd = roundUsd([...computedByProvider.values()].reduce((sum, row) => sum + row.costUsd, 0));
    const totalDeltaUsd = roundUsd(totalComputedCostUsd - totalInvoiceCostUsd);
    const totalToleranceUsd = roundUsd(Math.max(body.toleranceUsd, totalInvoiceCostUsd * body.tolerancePct));
    const totalWithinTolerance = Math.abs(totalDeltaUsd) <= totalToleranceUsd;
    const providerAlerts = providers
      .filter((provider) => !provider.withinTolerance)
      .map((provider) => ({
        provider: provider.provider,
        deltaUsd: provider.deltaUsd,
        toleranceUsd: provider.toleranceUsd,
      }));
    const alerts = [
      ...(!totalWithinTolerance
        ? [{ provider: 'total', deltaUsd: totalDeltaUsd, toleranceUsd: totalToleranceUsd }]
        : []),
      ...providerAlerts,
    ];

    return {
      period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
      tolerance: { usd: body.toleranceUsd, pct: body.tolerancePct },
      status: alerts.length === 0 ? 'pass' : 'fail',
      total: {
        invoiceCostUsd: totalInvoiceCostUsd,
        computedCostUsd: totalComputedCostUsd,
        deltaUsd: totalDeltaUsd,
        deltaPct: signedDeltaPct(totalDeltaUsd, totalInvoiceCostUsd, totalComputedCostUsd),
        toleranceUsd: totalToleranceUsd,
        withinTolerance: totalWithinTolerance,
      },
      providers,
      alerts,
    };
  });
};
