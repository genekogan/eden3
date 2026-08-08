import { randomUUID } from 'node:crypto';

import { DevAuthProvider } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import {
  AGENT_MODEL_OPTIONS,
  DEFAULT_AGENT_RUNTIME_BY_MODEL,
  type AgentModel,
  type AgentRuntime,
} from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertCreation,
  insertUserAccount,
  makeMarker,
} from './fixtures';

loadRootEnv();

const marker = makeMarker('operatorapi');
const markerSuffix = marker.slice(marker.lastIndexOf('_') + 1);
const reconcileOffsetMs = (Number.parseInt(markerSuffix, 16) % 80_000) * 1000;
const reconcilePeriodStart = new Date(Date.UTC(2001, 0, 1, 0, 0, 0) + reconcileOffsetMs);
const reconcileCompletedAt = new Date(reconcilePeriodStart.getTime() + 1_000);
const reconcileNotionalAt = new Date(reconcilePeriodStart.getTime() + 1_500);
const reconcileErrorAt = new Date(reconcilePeriodStart.getTime() + 2_000);
const reconcilePeriodEnd = new Date(reconcilePeriodStart.getTime() + 3_000);

let adminId = '';
let userId = '';
let agentId = '';
let viewerId = '';
let reportedCreationId = '';
let dismissedCreationId = '';
let privateCreationId = '';
let deletedCreationId = '';
let takedownReportId = '';
let dismissReportId = '';
let privateReportId = '';
let deletedReportId = '';
let unsupportedReportId = '';
let app: FastifyInstance;
const runtimeState = new Map<AgentModel, AgentRuntime>(
  AGENT_MODEL_OPTIONS.map((model) => [model, DEFAULT_AGENT_RUNTIME_BY_MODEL[model]]),
);
const fakeModelRuntime = {
  getCatalog: async () =>
    AGENT_MODEL_OPTIONS.map((model) => ({ model, agentRuntime: runtimeState.get(model)! })),
  getRuntime: async (model: string) => runtimeState.get(model as AgentModel)!,
  setRuntime: async (model: AgentModel, agentRuntime: AgentRuntime) => {
    const changed = runtimeState.get(model) !== agentRuntime;
    runtimeState.set(model, agentRuntime);
    return { changed, model, agentRuntime };
  },
};

beforeAll(async () => {
  adminId = await insertUserAccount(`${marker}_admin`);
  userId = await insertUserAccount(`${marker}_user`);
  viewerId = await insertUserAccount(`${marker}_viewer`);
  agentId = await insertAgentAccount(`${marker}_agent`, { openclawId: `${marker}_agent` });
  reportedCreationId = await insertCreation({ userId, agentId, public: true });
  dismissedCreationId = await insertCreation({ userId, agentId, public: true });
  privateCreationId = await insertCreation({ userId, agentId, public: false });
  deletedCreationId = await insertCreation({ userId, agentId, public: true, deleted: true });
  takedownReportId = (
    await pg<{ id: string }[]>`
      insert into content_reports (reporter_id, target_type, target_id, reason)
      values (${viewerId}, 'creation', ${reportedCreationId}, 'operator test takedown')
      returning id
    `
  )[0]!.id;
  dismissReportId = (
    await pg<{ id: string }[]>`
      insert into content_reports (reporter_id, target_type, target_id, reason)
      values (${viewerId}, 'creation', ${dismissedCreationId}, 'operator test dismiss')
      returning id
    `
  )[0]!.id;
  privateReportId = (
    await pg<{ id: string }[]>`
      insert into content_reports (reporter_id, target_type, target_id, reason)
      values (${viewerId}, 'creation', ${privateCreationId}, 'private target')
      returning id
    `
  )[0]!.id;
  deletedReportId = (
    await pg<{ id: string }[]>`
      insert into content_reports (reporter_id, target_type, target_id, reason)
      values (${viewerId}, 'creation', ${deletedCreationId}, 'deleted target')
      returning id
    `
  )[0]!.id;
  unsupportedReportId = (
    await pg<{ id: string }[]>`
      insert into content_reports (reporter_id, target_type, target_id, reason)
      values (${viewerId}, 'agent', ${agentId}, 'unsupported target')
      returning id
    `
  )[0]!.id;

  await pg`
    insert into usage_events (
      event_type, status, user_id, agent_id, provider, model, table_version,
      prompt_tokens, completion_tokens, total_tokens, cost_usd, manna, latency_ms, metadata, created_at
    )
    values (
      'chat_turn', 'completed', ${userId}, ${agentId}, 'anthropic', 'claude-haiku-4-5',
      'test-table', 100, 20, 120, 1.50000000, 2025, 42, ${JSON.stringify({ source: 'test' })}::jsonb,
      now() - interval '2 minutes'
    )`;
  await pg`
    insert into usage_events (
      event_type, status, user_id, agent_id, provider, model, error_code, error_message, latency_ms, created_at
    )
    values (
      'chat_turn', 'error', ${userId}, ${agentId}, 'anthropic', 'claude-haiku-4-5',
      'gateway_error', 'boom', 20, now() - interval '1 minute'
    )`;
  await pg`
    insert into usage_events (
      event_type, status, user_id, agent_id, provider, model, table_version,
      prompt_tokens, completion_tokens, total_tokens, cost_usd, manna, latency_ms, metadata, created_at
    )
    values (
      'chat_turn', 'completed', ${userId}, ${agentId}, 'anthropic', 'claude-haiku-4-5',
      'test-table', 100, 20, 120, 1.50000000, 2025, 42, ${JSON.stringify({ source: 'reconcile-test' })}::jsonb,
      ${reconcileCompletedAt.toISOString()}::timestamptz
    )`;
  await pg`
    insert into usage_events (
      event_type, status, user_id, agent_id, provider, model, pricing_basis, table_version,
      prompt_tokens, completion_tokens, total_tokens, cost_usd, manna, latency_ms, metadata, created_at
    )
    values (
      'chat_turn', 'completed', ${userId}, ${agentId}, 'anthropic', 'claude-sonnet-4-6',
      'notional-subscription', 'test-table', 100, 20, 120, 9.00000000, 12150, 42,
      ${JSON.stringify({ source: 'reconcile-notional-test' })}::jsonb,
      ${reconcileNotionalAt.toISOString()}::timestamptz
    )`;
  await pg`
    insert into usage_events (
      event_type, status, user_id, agent_id, provider, model, error_code, error_message, latency_ms, created_at
    )
    values (
      'chat_turn', 'error', ${userId}, ${agentId}, 'anthropic', 'claude-haiku-4-5',
      'gateway_error', 'boom', 20, ${reconcileErrorAt.toISOString()}::timestamptz
    )`;

  app = await buildServer({
    auth: { provider: new DevAuthProvider({ adminUsernames: [`${marker}_admin`] }) },
    provisioning: { modelRuntime: fakeModelRuntime },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('GET /operator/health', () => {
  it('401s anonymous and 403s non-admins', async () => {
    expect((await app.inject({ method: 'GET', url: '/operator/health' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/operator/health',
          headers: { cookie: devCookie(viewerId) },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('reports gateway/egress/scheduler/database health for admins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/operator/health',
      headers: { cookie: devCookie(adminId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      gateway: { configured: boolean } & Record<string, unknown>;
      egressProxy: unknown;
      scheduler: { running: boolean };
      database: string | null;
    };
    expect(body.ok).toBe(true);
    // Gateway may or may not be wired depending on env — assert the shape,
    // not a specific configured state.
    expect(body.gateway).toHaveProperty('configured');
    expect(typeof body.gateway.configured).toBe('boolean');
    expect(body).toHaveProperty('egressProxy');
    expect(body).toHaveProperty('scheduler');
    expect(typeof body.scheduler.running).toBe('boolean');
  });
});

describe('/operator/model-runtimes', () => {
  it('requires admin access for reads and writes', async () => {
    expect((await app.inject({ method: 'GET', url: '/operator/model-runtimes' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/model-runtimes',
          headers: { cookie: devCookie(viewerId) },
          payload: { model: 'anthropic/claude-sonnet-4-6', agentRuntime: 'openclaw' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('lists effective runtimes and hot-toggles both directions', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/operator/model-runtimes',
      headers: { cookie: devCookie(adminId) },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      models: expect.arrayContaining([
        { model: 'anthropic/claude-sonnet-4-6', agentRuntime: 'claude-cli' },
      ]),
    });

    for (const agentRuntime of ['openclaw', 'claude-cli'] as const) {
      const updated = await app.inject({
        method: 'POST',
        url: '/operator/model-runtimes',
        headers: { cookie: devCookie(adminId) },
        payload: { model: 'anthropic/claude-sonnet-4-6', agentRuntime },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        model: 'anthropic/claude-sonnet-4-6',
        agentRuntime,
      });
    }
  });
});

describe('/operator/content-reports', () => {
  it('allows only admins to list or resolve reports', async () => {
    expect((await app.inject({ method: 'GET', url: '/operator/content-reports' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/operator/content-reports',
          headers: { cookie: devCookie(viewerId) },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/operator/content-reports/${takedownReportId}/resolve`,
          headers: { cookie: devCookie(viewerId) },
          payload: { decision: 'takedown' },
        })
      ).statusCode,
    ).toBe(403);

    const [unchanged] = await pg<{ status: string; deleted: boolean }[]>`
      select r.status, c.deleted
      from content_reports r
      join creations c on c.id = r.target_id
      where r.id = ${takedownReportId}
    `;
    expect(unchanged).toEqual({ status: 'open', deleted: false });
  });

  it('lists open creation reports with the minimum safe operator context', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/operator/content-reports?status=open',
      headers: { cookie: devCookie(adminId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reports: Array<{
        id: string;
        targetId: string;
        reason: string | null;
        reporter: { id: string; username: string };
        targetType: string;
        targetExists: boolean;
        targetPublic: boolean | null;
        targetDeleted: boolean | null;
      }>;
    };
    expect(body.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: takedownReportId,
          targetId: reportedCreationId,
          reason: 'operator test takedown',
          reporter: { id: viewerId, username: `${marker}_viewer` },
          targetType: 'creation',
          targetExists: true,
          targetPublic: true,
          targetDeleted: false,
        }),
      ]),
    );
    expect(res.payload).not.toContain(`${marker}_user@`);
  });

  it('marks unsupported, private, and deleted queue targets as ineligible DTOs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/operator/content-reports?status=open',
      headers: { cookie: devCookie(adminId) },
    });
    expect(res.statusCode).toBe(200);
    const reports = (res.json() as {
      reports: Array<{
        id: string;
        targetType: string;
        targetExists: boolean;
        targetPublic: boolean | null;
        targetDeleted: boolean | null;
      }>;
    }).reports;
    const byId = new Map(reports.map((report) => [report.id, report]));

    expect(byId.get(unsupportedReportId)).toMatchObject({
      targetType: 'agent',
      targetExists: false,
      targetPublic: null,
      targetDeleted: null,
    });
    expect(byId.get(privateReportId)).toMatchObject({
      targetType: 'creation',
      targetExists: true,
      targetPublic: false,
      targetDeleted: false,
    });
    expect(byId.get(deletedReportId)).toMatchObject({
      targetType: 'creation',
      targetExists: true,
      targetPublic: true,
      targetDeleted: true,
    });
  });

  it('atomically resolves a report and removes public reachability without deleting owner data', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operator/content-reports/${takedownReportId}/resolve`,
      headers: { cookie: devCookie(adminId) },
      payload: { decision: 'takedown' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      report: {
        id: takedownReportId,
        status: 'resolved',
        reviewerId: adminId,
        targetExists: true,
        targetDeleted: true,
      },
    });
    expect(
      (await app.inject({ method: 'GET', url: `/creations/${reportedCreationId}` })).statusCode,
    ).toBe(404);

    const [retained] = await pg<{
      creation_id: string;
      deleted: boolean;
      status: string;
      reviewer_id: string | null;
      reviewed: boolean;
    }[]>`
      select c.id as creation_id,
             c.deleted,
             r.status,
             r.reviewer_id,
             (r.reviewed_at is not null) as reviewed
      from content_reports r
      join creations c on c.id = r.target_id
      where r.id = ${takedownReportId}
    `;
    expect(retained).toMatchObject({
      creation_id: reportedCreationId,
      deleted: true,
      status: 'resolved',
      reviewer_id: adminId,
      reviewed: true,
    });

    const repeated = await app.inject({
      method: 'POST',
      url: `/operator/content-reports/${takedownReportId}/resolve`,
      headers: { cookie: devCookie(adminId) },
      payload: { decision: 'takedown' },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ report: { status: 'resolved' } });
  });

  it('dismisses without taking down and returns generic unknown-report errors', async () => {
    const dismissed = await app.inject({
      method: 'POST',
      url: `/operator/content-reports/${dismissReportId}/resolve`,
      headers: { cookie: devCookie(adminId) },
      payload: { decision: 'dismiss' },
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toMatchObject({ report: { status: 'dismissed' } });
    expect(
      (await app.inject({ method: 'GET', url: `/creations/${dismissedCreationId}` })).statusCode,
    ).toBe(200);

    const missing = await app.inject({
      method: 'POST',
      url: `/operator/content-reports/${randomUUID()}/resolve`,
      headers: { cookie: devCookie(adminId) },
      payload: { decision: 'takedown' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'report_not_found' } });
  });
});

describe('GET /operator/usage/summary', () => {
  it('401s anonymous requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/operator/usage/summary' });
    expect(res.statusCode).toBe(401);
  });

  it('403s non-admin users', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/operator/usage/summary',
      headers: { cookie: devCookie(viewerId) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('aggregates usage for admins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operator/usage/summary?days=7&userId=${userId}`,
      headers: { cookie: devCookie(adminId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      window: { days: number; userId: string | null };
      totals: { events: number; costUsd: number; manna: number; errors: number; avgLatencyMs: number };
      byUser: Array<{ userId: string | null; username: string | null; events: number; costUsd: number }>;
      byAgent: Array<{ agentId: string | null; username: string | null; events: number; manna: number }>;
      byStatus: Array<{ status: string; events: number }>;
      recent: Array<{
        eventType: string;
        status: string;
        userId: string | null;
        userUsername: string | null;
        agentId: string | null;
        agentUsername: string | null;
        provider: string | null;
        model: string | null;
        costUsd: number;
        manna: number;
        latencyMs: number | null;
        errorCode: string | null;
        createdAt: string;
      }>;
    };

    expect(body.window.days).toBe(7);
    expect(body.window.userId).toBe(userId);
    expect(body.totals).toMatchObject({
      events: 2,
      costUsd: 1.5,
      manna: 2025,
      errors: 1,
    });
    expect(body.totals.avgLatencyMs).toBe(31);
    expect(body.byUser[0]).toMatchObject({ userId, username: `${marker}_user`, events: 2, costUsd: 1.5 });
    expect(body.byAgent[0]).toMatchObject({ agentId, username: `${marker}_agent`, events: 2, manna: 2025 });
    expect(Object.fromEntries(body.byStatus.map((row) => [row.status, row.events]))).toMatchObject({
      completed: 1,
      error: 1,
    });
    expect(body.recent).toHaveLength(2);
    expect(body.recent[0]).toMatchObject({
      eventType: 'chat_turn',
      status: 'error',
      userId,
      userUsername: `${marker}_user`,
      agentId,
      agentUsername: `${marker}_agent`,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      costUsd: 0,
      manna: 0,
      latencyMs: 20,
      errorCode: 'gateway_error',
    });
    expect(Date.parse(body.recent[0]!.createdAt)).toBeGreaterThan(0);
    expect(body.recent[1]).toMatchObject({
      eventType: 'chat_turn',
      status: 'completed',
      costUsd: 1.5,
      manna: 2025,
      latencyMs: 42,
      errorCode: null,
    });
  });
});

describe('GET /usage/summary (viewer-scoped, no cost_usd leak)', () => {
  it('401s anonymous requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/usage/summary' });
    expect(res.statusCode).toBe(401);
  });

  it('lets a NON-admin see their OWN balance, spend, and activity', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/usage/summary',
      headers: { cookie: devCookie(userId) },
    });
    // The tenant view is NOT admin-gated: the owner of the data can read it.
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      balance: { manna: number; subscriptionManna: number; total: number; updatedAt: string };
      spend: {
        week: { manna: number; events: number };
        month: { manna: number; events: number };
      };
      recent: Array<{
        eventType: string;
        status: string;
        agentUsername: string | null;
        tool: string | null;
        manna: number | null;
      }>;
    };

    expect(typeof body.balance.total).toBe('number');
    // Spend is windowed: two in-window events (one completed 2025 manna + one
    // error); the two 2001-dated reconcile fixtures fall outside the 30-day sum.
    expect(body.spend.week).toMatchObject({ manna: 2025, events: 2 });
    expect(body.spend.month).toMatchObject({ manna: 2025, events: 2 });
    // Recent activity is latest-N (not windowed) — the two fresh rows lead.
    expect(body.recent.length).toBeGreaterThanOrEqual(2);
    expect(body.recent[0]).toMatchObject({ status: 'error', eventType: 'chat_turn' });
    expect(body.recent[1]).toMatchObject({
      status: 'completed',
      eventType: 'chat_turn',
      agentUsername: `${marker}_agent`,
      manna: 2025,
    });
    // Friendly-mapping field is present (null for chat turns).
    expect(body.recent[1]).toHaveProperty('tool');
  });

  it('never exposes provider cost_usd', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/usage/summary',
      headers: { cookie: devCookie(userId) },
    });
    expect(res.statusCode).toBe(200);
    // No provider-cost field in any shape (row, spend, or balance).
    expect(res.payload).not.toMatch(/cost/i);
    const body = res.json() as { recent: Array<Record<string, unknown>> };
    for (const row of body.recent) {
      expect(row).not.toHaveProperty('costUsd');
      expect(row).not.toHaveProperty('cost_usd');
    }
  });

  it('scopes to the viewer — a user cannot see another user\'s usage', async () => {
    // viewerId is a different account with no usage_events of its own.
    const res = await app.inject({
      method: 'GET',
      url: '/usage/summary',
      headers: { cookie: devCookie(viewerId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      spend: { week: { manna: number; events: number }; month: { events: number } };
      recent: unknown[];
    };
    // None of userId's spend or activity bleeds into viewerId's view.
    expect(body.spend.week).toMatchObject({ manna: 0, events: 0 });
    expect(body.spend.month.events).toBe(0);
    expect(body.recent).toHaveLength(0);
  });
});

describe('POST /operator/usage/reconcile', () => {
  function reconciliationWindow() {
    return {
      periodStart: reconcilePeriodStart.toISOString(),
      periodEnd: reconcilePeriodEnd.toISOString(),
    };
  }

  it('compares computed usage cost to invoice totals within tolerance', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/operator/usage/reconcile',
      headers: { cookie: devCookie(adminId) },
      payload: {
        ...reconciliationWindow(),
        toleranceUsd: 0.05,
        tolerancePct: 0.01,
        invoices: [{ provider: 'anthropic', costUsd: 1.51, label: 'anthropic-july-test' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      total: {
        invoiceCostUsd: number;
        computedCostUsd: number;
        deltaUsd: number;
        withinTolerance: boolean;
      };
      providers: Array<{
        provider: string;
        invoiceCostUsd: number;
        computedCostUsd: number;
        deltaUsd: number;
        withinTolerance: boolean;
        events: number;
        labels: string[];
      }>;
      alerts: Array<{ provider: string; deltaUsd: number; toleranceUsd: number }>;
    };

    expect(body.status).toBe('pass');
    expect(body.total).toMatchObject({
      invoiceCostUsd: 1.51,
      computedCostUsd: 1.5,
      deltaUsd: -0.01,
      withinTolerance: true,
    });
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({
      provider: 'anthropic',
      invoiceCostUsd: 1.51,
      computedCostUsd: 1.5,
      deltaUsd: -0.01,
      withinTolerance: true,
      events: 2,
      labels: ['anthropic-july-test'],
    });
    expect(body.alerts).toEqual([]);
  });

  it('excludes subscription-notional rows from provider invoice reconciliation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/operator/usage/reconcile',
      headers: { cookie: devCookie(adminId) },
      payload: {
        ...reconciliationWindow(),
        toleranceUsd: 0,
        tolerancePct: 0,
        invoices: [{ provider: 'anthropic', costUsd: 1.5 }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'pass',
      total: { computedCostUsd: 1.5, withinTolerance: true },
      providers: [{ provider: 'anthropic', computedCostUsd: 1.5, events: 2 }],
    });
  });

  it('returns drift alerts when invoice and computed costs exceed tolerance', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/operator/usage/reconcile',
      headers: { cookie: devCookie(adminId) },
      payload: {
        ...reconciliationWindow(),
        toleranceUsd: 0.01,
        tolerancePct: 0,
        invoices: [{ provider: 'anthropic', costUsd: 2.0 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      total: { deltaUsd: number; toleranceUsd: number; withinTolerance: boolean };
      alerts: Array<{ provider: string; deltaUsd: number; toleranceUsd: number }>;
    };

    expect(body.status).toBe('fail');
    expect(body.total).toMatchObject({
      deltaUsd: -0.5,
      toleranceUsd: 0.01,
      withinTolerance: false,
    });
    expect(body.alerts).toEqual([
      { provider: 'total', deltaUsd: -0.5, toleranceUsd: 0.01 },
      { provider: 'anthropic', deltaUsd: -0.5, toleranceUsd: 0.01 },
    ]);
  });

  it('rejects non-admin reconciliation requests before exposing usage totals', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/operator/usage/reconcile',
      headers: { cookie: devCookie(viewerId) },
      payload: {
        ...reconciliationWindow(),
        invoices: [{ provider: 'anthropic', costUsd: 1.5 }],
      },
    });
    expect(res.statusCode).toBe(403);
  });
});
