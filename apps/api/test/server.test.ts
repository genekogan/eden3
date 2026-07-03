import { getEnv } from '@eden3/core';
import { loadRootEnv } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';

loadRootEnv();

let app: FastifyInstance;

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
    const body = res.json() as { ok: boolean; versions: Record<string, string> };
    expect(body.ok).toBe(true);
    expect(body.versions.node).toBe(process.version);
    expect(body.versions.fastify).toMatch(/^5\./);
    expect(body.versions.api).toBeTruthy();
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
