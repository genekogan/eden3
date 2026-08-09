import { getEnv } from '@eden3/core';
import { pg } from '@eden3/db';
import { readOpenClawConfig } from '@eden3/gateway';
import { agentModelSchema, agentRuntimeSchema } from '@eden3/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors';
import { defaultOpenclawDataDir } from '../gateway-glue';

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

const modelRuntimeBody = z
  .object({
    model: agentModelSchema,
    agentRuntime: agentRuntimeSchema,
  })
  .strict();

const contentReportsQuery = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const contentReportParams = z.object({ id: z.string().uuid() });
const contentReportResolutionBody = z
  .object({ decision: z.enum(['takedown', 'dismiss']) })
  .strict();

interface ContentReportRow {
  id: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  status: string;
  reporter_id: string;
  reporter_username: string;
  reviewer_id: string | null;
  reviewed_at: Date | string | null;
  created_at: Date | string;
  target_exists: boolean;
  target_public: boolean | null;
  target_deleted: boolean | null;
}

function contentReportDto(row: ContentReportRow) {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    status: row.status,
    reporter: { id: row.reporter_id, username: row.reporter_username },
    reviewerId: row.reviewer_id,
    reviewedAt: row.reviewed_at === null ? null : new Date(row.reviewed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    targetExists: row.target_exists,
    targetPublic: row.target_public,
    targetDeleted: row.target_deleted,
  };
}

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
  pricing_basis: 'provider-api' | 'notional-subscription';
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

export interface OperatorGatewayHealthProbeOptions {
  baseUrl: string | undefined;
  token: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function operatorGatewayModelsUrl(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '' ||
      parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' ||
      parsed.search !== '' || parsed.hash !== '') {
    return null;
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  return `${parsed.origin}/v1/models`;
}

/** Credential-bearing gateway health is restricted to the typed loopback origin. */
export async function probeOperatorGatewayModels(
  options: OperatorGatewayHealthProbeOptions,
): Promise<
  | { configured: false }
  | {
      configured: true;
      reachable: boolean;
      latencyMs?: number;
      routableModels?: number;
      error?: 'gateway_health_configuration_invalid' | 'gateway_health_unreachable';
    }
> {
  if (!options.baseUrl || !options.token) return { configured: false };
  const modelsUrl = operatorGatewayModelsUrl(options.baseUrl);
  if (!modelsUrl) {
    return {
      configured: true,
      reachable: false,
      error: 'gateway_health_configuration_invalid',
    };
  }
  const started = (options.now ?? Date.now)();
  try {
    const res = await (options.fetchImpl ?? fetch)(modelsUrl, {
      headers: { authorization: `Bearer ${options.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    const models = res.ok
      ? (((await res.json()) as { data?: unknown[] }).data?.length ?? 0)
      : 0;
    return {
      configured: true,
      reachable: res.ok,
      latencyMs: (options.now ?? Date.now)() - started,
      routableModels: models,
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      error: 'gateway_health_unreachable',
    };
  }
}

export const operatorRoutes: FastifyPluginAsync = async (app) => {
  // ---- Content report queue — closed-cohort operator minimum ------------
  app.get('/content-reports', { preHandler: app.requireAuth }, async (req) => {
    if (!req.account?.isAdmin) {
      throw new ApiError(403, 'forbidden', 'Admin access required');
    }
    const query = contentReportsQuery.parse(req.query);
    const rows = await pg<ContentReportRow[]>`
      select r.id,
             r.target_type,
             r.target_id,
             r.reason,
             r.status,
             r.reporter_id,
             reporter.username::text as reporter_username,
             r.reviewer_id,
             r.reviewed_at,
             r.created_at,
             (c.id is not null) as target_exists,
             c.public as target_public,
             c.deleted as target_deleted
      from content_reports r
      join accounts reporter on reporter.id = r.reporter_id
      left join creations c on r.target_type = 'creation' and c.id = r.target_id
      where r.status = ${query.status}
      order by r.created_at desc, r.id desc
      limit ${query.limit}
    `;
    return { reports: rows.map(contentReportDto) };
  });

  app.post('/content-reports/:id/resolve', { preHandler: app.requireAuth }, async (req) => {
    if (!req.account?.isAdmin) {
      throw new ApiError(403, 'forbidden', 'Admin access required');
    }
    const { id } = contentReportParams.parse(req.params);
    const body = contentReportResolutionBody.parse(req.body);

    const resolved = await pg.begin(async (sql) => {
      const [report] = await sql<ContentReportRow[]>`
        select r.id,
               r.target_type,
               r.target_id,
               r.reason,
               r.status,
               r.reporter_id,
               reporter.username::text as reporter_username,
               r.reviewer_id,
               r.reviewed_at,
               r.created_at,
               (c.id is not null) as target_exists,
               c.public as target_public,
               c.deleted as target_deleted
        from content_reports r
        join accounts reporter on reporter.id = r.reporter_id
        left join creations c on r.target_type = 'creation' and c.id = r.target_id
        where r.id = ${id}
        for update of r
      `;
      if (!report) throw new ApiError(404, 'report_not_found', 'Report not found');

      const expectedStatus = body.decision === 'takedown' ? 'resolved' : 'dismissed';
      if (report.status !== 'open') {
        if (report.status !== expectedStatus) {
          throw new ApiError(409, 'report_already_resolved', 'Report has already been resolved');
        }
        return report;
      }

      if (body.decision === 'takedown') {
        if (report.target_type !== 'creation') {
          throw new ApiError(409, 'unsupported_report_target', 'Report target cannot be resolved here');
        }
        const updated = await sql`
          update creations
          set deleted = true, updated_at = now()
          where id = ${report.target_id}
          returning id
        `;
        if (updated.length === 0) {
          throw new ApiError(404, 'report_target_not_found', 'Report target is unavailable');
        }
      }

      const [row] = await sql<{
        status: string;
        reviewer_id: string;
        reviewed_at: Date | string;
      }[]>`
        update content_reports
        set status = ${expectedStatus},
            reviewer_id = ${req.account!.accountId},
            reviewed_at = now()
        where id = ${report.id}
        returning status, reviewer_id, reviewed_at
      `;
      return {
        ...report,
        status: row!.status,
        reviewer_id: row!.reviewer_id,
        reviewed_at: row!.reviewed_at,
        target_deleted: body.decision === 'takedown' ? true : report.target_deleted,
      };
    });

    return { report: contentReportDto(resolved) };
  });

  // ---- GET /operator/health — one-look runtime panel (admin) --------------
  // The 80/20 of "is the appliance healthy": gateway reachability + agent
  // count, egress proxy mode, scheduler state, database label. Exec-approval
  // queues deliberately have no surface here: sandboxes run ask=off with the
  // container as the boundary (SPEC Q1), so there is no approval queue.
  app.get('/health', { preHandler: app.requireAuth }, async (req) => {
    if (!req.account?.isAdmin) {
      throw new ApiError(403, 'forbidden', 'Admin access required');
    }

    const gateway = await (async () => {
      if (!app.gatewayCompat) return { configured: false as const };
      try {
        const probe = await probeOperatorGatewayModels({
          baseUrl: getEnv().OPENCLAW_BASE_URL,
          token: getEnv().OPENCLAW_GATEWAY_TOKEN,
        });
        if (!probe.configured) return probe;
        const dataDir = defaultOpenclawDataDir();
        const config = await readOpenClawConfig(dataDir);
        const agents = config.agents as { list?: unknown[] } | undefined;
        const registered = Array.isArray(agents?.list) ? agents.list.length : 0;
        return {
          ...probe,
          registeredAgents: registered,
        };
      } catch {
        return {
          configured: true as const,
          reachable: false,
          error: 'gateway_health_unreachable' as const,
        };
      }
    })();

    const egressProxy = await (async () => {
      try {
        const res = await fetch(
          process.env.EDEN3_EGRESS_HEALTH_URL ?? 'http://127.0.0.1:18080/health',
          { signal: AbortSignal.timeout(3_000) },
        );
        if (!res.ok) return { reachable: false as const };
        const body = (await res.json()) as { mode?: string };
        return { reachable: true as const, mode: body.mode ?? 'allowlist' };
      } catch {
        // The proxy listens only on the docker networks by default — not
        // reachable from the host unless EDEN3_EGRESS_HEALTH_URL is mapped.
        return { reachable: null };
      }
    })();

    const database = (() => {
      try {
        return new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '') || null;
      } catch {
        return null;
      }
    })();

    return {
      ok: true,
      gateway,
      egressProxy,
      database,
      scheduler: app.taskScheduler
        ? { running: app.taskScheduler.running }
        : { running: false },
      memoryDreamScheduler: app.memoryDreamScheduler
        ? { running: app.memoryDreamScheduler.running }
        : { running: false },
    };
  });

  app.post('/memory/sweep', { preHandler: app.requireAuth }, async (req) => {
    if (!req.account?.isAdmin) {
      throw new ApiError(403, 'forbidden', 'Admin access required');
    }
    if (!app.memoryDreamScheduler) {
      throw new ApiError(503, 'memory_scheduler_unavailable', 'Memory scheduler requires a configured gateway');
    }
    return { sweep: await app.memoryDreamScheduler.tick({ force: true }) };
  });

  // ---- GET/POST /operator/model-runtimes — model-scoped hot toggle -------
  app.get('/model-runtimes', { preHandler: app.requireAuth }, async (req) => {
    if (!req.account?.isAdmin) {
      throw new ApiError(403, 'forbidden', 'Admin access required');
    }
    return { models: await app.gatewayGlue.modelRuntime.getCatalog() };
  });

  app.post('/model-runtimes', { preHandler: app.requireAuth }, async (req) => {
    if (!req.account?.isAdmin) {
      throw new ApiError(403, 'forbidden', 'Admin access required');
    }
    const body = modelRuntimeBody.parse(req.body);
    return app.gatewayGlue.modelRuntime.setRuntime(body.model, body.agentRuntime);
  });

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
             u.pricing_basis,
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
        pricingBasis: row.pricing_basis,
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
        and pricing_basis = 'provider-api'
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
