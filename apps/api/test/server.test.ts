import { getEnv, resetEnvCache } from '@eden3/core';
import { loadRootEnv } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';

loadRootEnv();

let app: FastifyInstance;

function withEnv(name: string, value: string): () => void {
  const original = process.env[name];
  process.env[name] = value;
  resetEnvCache();
  return () => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
    resetEnvCache();
  };
}

beforeAll(async () => {
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns ok with versions', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    const body = res.json() as {
      ok: boolean;
      versions: Record<string, string>;
      schema: { status: string };
    };
    expect(body.ok).toBe(true);
    expect(body.schema.status).toBe('unchecked');
    expect(body.versions.node).toBe(process.version);
    expect(body.versions.fastify).toMatch(/^5\./);
    expect(body.versions.api).toBeTruthy();
  });

  it('fails closed when production requires a stale or unavailable schema', async () => {
    const stale = await buildServer({
      health: {
        schemaReadiness: async () => ({
          status: 'missing_migrations',
          expectedMigration: '0033_session_share_links',
          expectedCount: 34,
          appliedCount: 33,
          missingCount: 1,
          unexpectedCount: 0,
        }),
      },
    });
    try {
      const response = await stale.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        ok: false,
        schema: { status: 'missing_migrations', missingCount: 1 },
      });
    } finally {
      await stale.close();
    }

    const unchecked = await buildServer();
    try {
      const response = await unchecked.inject({ method: 'GET', url: '/health?ready=1' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ ok: false, schema: { status: 'unchecked' } });
    } finally {
      await unchecked.close();
    }
  });

  it('boots degraded without a host gateway token and still runs native-cron cleanup', async () => {
    const restoreToken = withEnv('OPENCLAW_GATEWAY_TOKEN', '');
    let cleanupSweeps = 0;
    const probe = await buildServer({
      gateway: null,
      scheduler: { autoStart: true },
      provisioning: {
        cronSync: {
          async removeTrigger(triggerId) {
            return { name: `eden3:${triggerId}`, action: 'absent' as const };
          },
          async removeAllEden3Jobs() {
            cleanupSweeps += 1;
            return { removed: 0 };
          },
        },
      },
    });
    try {
      expect((await probe.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      await expect.poll(() => cleanupSweeps).toBe(1);
      expect(probe.taskScheduler).not.toBeNull();
      expect(probe.taskScheduler?.running).toBe(false);
      expect(probe.studioReservationReaper).toBeDefined();
      expect(
        (probe.studioReservationReaper as unknown as { timer: NodeJS.Timeout | null }).timer,
      ).not.toBeNull();
    } finally {
      await probe.close();
      restoreToken();
    }
  });

  it('logs structured request metadata without headers, cookies, or bearer secrets', async () => {
    const lines: string[] = [];
    const probe = await buildServer({
      logger: {
        level: 'info',
        base: undefined,
        stream: { write: (line: string) => lines.push(line) },
      },
    });
    try {
      const res = await probe.inject({
        method: 'GET',
        url: '/health?token=public-query-marker',
        headers: {
          authorization: 'Bearer should-not-appear',
          cookie: 'eden3_dev_user=also-should-not-appear',
          'x-session-id': 'test-session-123',
        },
      });
      expect(res.statusCode).toBe(200);
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const completed = records.find((record) => record.msg === 'request completed');
      expect(completed).toMatchObject({
        requestId: res.headers['x-request-id'],
        method: 'GET',
        url: '/health?token=public-query-marker',
        statusCode: 200,
        sessionId: 'test-session-123',
      });
      expect(typeof completed?.elapsedMs).toBe('number');
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain('should-not-appear');
      expect(serialized).not.toContain('authorization');
      expect(serialized).not.toContain('cookie');
    } finally {
      await probe.close();
    }
  });
});

describe('http hardening', () => {
  it('sets baseline security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['permissions-policy']).toContain('camera=()');
  });

  it('allows public media to render across the API and web origins', async () => {
    const mediaDir = await mkdtemp(path.join(tmpdir(), 'eden3-media-corp-'));
    const restoreMediaDir = withEnv('MEDIA_DIR', mediaDir);
    await writeFile(path.join(mediaDir, 'fixture.txt'), 'fixture', 'utf8');
    const probe = await buildServer();
    try {
      const res = await probe.inject({ method: 'GET', url: '/media/fixture.txt' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await probe.close();
      restoreMediaDir();
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  it('rejects oversized request bodies with a stable envelope', async () => {
    const restore = withEnv('API_BODY_LIMIT_BYTES', '128');
    const probe = await buildServer();
    try {
      probe.post('/__test/echo', async (req) => req.body);
      const res = await probe.inject({
        method: 'POST',
        url: '/__test/echo',
        payload: { content: 'x'.repeat(1_000) },
      });
      expect(res.statusCode).toBe(413);
      expect((res.json() as { error: { code: string } }).error.code).toBe('payload_too_large');
    } finally {
      await probe.close();
      restore();
    }
  });

  it('rate-limits the N+1 request from one client', async () => {
    const restoreMax = withEnv('API_RATE_LIMIT_MAX', '2');
    const restoreWindow = withEnv('API_RATE_LIMIT_WINDOW_MS', '60000');
    const probe = await buildServer();
    try {
      const headers = { 'x-forwarded-for': '203.0.113.10' };
      expect((await probe.inject({ method: 'GET', url: '/health', headers })).statusCode).toBe(200);
      expect((await probe.inject({ method: 'GET', url: '/health', headers })).statusCode).toBe(200);
      const limited = await probe.inject({ method: 'GET', url: '/health', headers });
      expect(limited.statusCode).toBe(429);
      expect((limited.json() as { error: { code: string } }).error.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeTruthy();
    } finally {
      await probe.close();
      restoreWindow();
      restoreMax();
    }
  });
});

describe('error envelope', () => {
  it('unknown routes 404 with the envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; statusCode: number } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.statusCode).toBe(404);
  });

  it('resource routes are live (no 501 stubs remain)', async () => {
    // agents/feed/studio-tools are public list endpoints; manna/tasks/sessions
    // are real but auth-gated (401 anonymous); /triggers moved to /tasks
    // (404); /collections and /creations only exist as detail paths now.
    for (const [url, expected] of [
      ['/agents', 200],
      ['/feed/creations', 200],
      ['/feed/agents', 200],
      ['/studio/tools', 200],
      ['/manna', 401],
      ['/tasks', 401],
      ['/sessions', 401],
      ['/triggers', 404],
      ['/collections', 404],
    ] as const) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(expected);
    }
  });
});

describe('auth plugin', () => {
  it('requireAuth rejects anonymous requests with a 401 envelope', async () => {
    // Fresh instance so we can attach a probe route before ready().
    const probe = await buildServer();
    probe.get('/__test/whoami', { preHandler: probe.requireAuth }, async (req) => ({
      account: req.account,
    }));
    const res = await probe.inject({ method: 'GET', url: '/__test/whoami' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
    await probe.close();
  });

  it('request.account is null for anonymous requests on open routes', async () => {
    const probe = await buildServer();
    probe.get('/__test/account', async (req) => ({ account: req.account }));
    const res = await probe.inject({ method: 'GET', url: '/__test/account' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { account: unknown }).account).toBeNull();
    await probe.close();
  });
});

describe('dev routes gate (AUTH_PROVIDER / EDEN3_DEV_ROUTES)', () => {
  it('does not mount /dev under clerk auth without the explicit flag (deployment shape)', async () => {
    const restoreProvider = withEnv('AUTH_PROVIDER', 'clerk');
    const restoreFlag = withEnv('EDEN3_DEV_ROUTES', '0');
    const probe = await buildServer();
    try {
      for (const [method, url] of [
        ['GET', '/dev/users'],
        ['GET', '/dev/me'],
        ['POST', '/dev/impersonate'],
        ['POST', '/dev/logout'],
      ] as const) {
        const res = await probe.inject({ method, url });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect((res.json() as { error: { code: string } }).error.code, `${method} ${url}`).toBe(
          'not_found',
        );
      }
    } finally {
      await probe.close();
      restoreFlag();
      restoreProvider();
    }
  });

  it('mounts /dev for AUTH_PROVIDER=dev without the flag', async () => {
    const restoreProvider = withEnv('AUTH_PROVIDER', 'dev');
    const restoreFlag = withEnv('EDEN3_DEV_ROUTES', '0');
    const probe = await buildServer();
    try {
      // /dev/logout touches no DB — cheap proof the prefix is live.
      const res = await probe.inject({ method: 'POST', url: '/dev/logout' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ok: boolean }).ok).toBe(true);
    } finally {
      await probe.close();
      restoreFlag();
      restoreProvider();
    }
  });

  it('mounts /dev under hybrid auth with EDEN3_DEV_ROUTES=1 (local stack shape)', async () => {
    const restoreProvider = withEnv('AUTH_PROVIDER', 'hybrid');
    const restoreFlag = withEnv('EDEN3_DEV_ROUTES', '1');
    const probe = await buildServer();
    try {
      const res = await probe.inject({ method: 'POST', url: '/dev/logout' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ok: boolean }).ok).toBe(true);
    } finally {
      await probe.close();
      restoreFlag();
      restoreProvider();
    }
  });
});

describe('cors', () => {
  it('allows the web origin with credentials', async () => {
    const origin = `http://localhost:${getEnv().WEB_PORT}`;
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin,
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});
