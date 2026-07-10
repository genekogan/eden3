import { DevAuthProvider } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertUserAccount,
  makeMarker,
} from './fixtures';

loadRootEnv();

const marker = makeMarker('operatorapi');
const markerSuffix = marker.slice(marker.lastIndexOf('_') + 1);
const reconcileOffsetMs = (Number.parseInt(markerSuffix, 16) % 80_000) * 1000;
const reconcilePeriodStart = new Date(Date.UTC(2001, 0, 1, 0, 0, 0) + reconcileOffsetMs);
const reconcileCompletedAt = new Date(reconcilePeriodStart.getTime() + 1_000);
const reconcileErrorAt = new Date(reconcilePeriodStart.getTime() + 2_000);
const reconcilePeriodEnd = new Date(reconcilePeriodStart.getTime() + 3_000);

let adminId = '';
let userId = '';
let agentId = '';
let viewerId = '';
let app: FastifyInstance;

beforeAll(async () => {
  adminId = await insertUserAccount(`${marker}_admin`);
  userId = await insertUserAccount(`${marker}_user`);
  viewerId = await insertUserAccount(`${marker}_viewer`);
  agentId = await insertAgentAccount(`${marker}_agent`, { openclawId: `${marker}_agent` });

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
      event_type, status, user_id, agent_id, provider, model, error_code, error_message, latency_ms, created_at
    )
    values (
      'chat_turn', 'error', ${userId}, ${agentId}, 'anthropic', 'claude-haiku-4-5',
      'gateway_error', 'boom', 20, ${reconcileErrorAt.toISOString()}::timestamptz
    )`;

  app = await buildServer({
    auth: { provider: new DevAuthProvider({ adminUsernames: [`${marker}_admin`] }) },
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
