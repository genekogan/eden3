import { randomUUID } from 'node:crypto';

import { DEV_USER_COOKIE } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';

loadRootEnv();

/**
 * Integration tests against live Postgres (localhost:5433). The accounts
 * table may be empty (ETL runs separately), so a uniquely-named fixture
 * account is inserted for the duration and hard-deleted afterwards.
 */

const marker = `apitest_${randomUUID().slice(0, 8)}`;
let fixtureId = '';
let app: FastifyInstance;

interface DevUser {
  id: string;
  externalId: string | null;
  type: string;
  username: string;
  userImage: string | null;
}

beforeAll(async () => {
  const rows = await pg<{ id: string }[]>`
    insert into accounts (type, username)
    values ('user', ${marker})
    returning id
  `;
  fixtureId = rows[0]!.id;

  app = await buildServer();
  // Probe route exercising the full cookie -> DevAuthProvider -> requireAuth path.
  app.get('/__test/whoami', { preHandler: app.requireAuth }, async (req) => ({
    account: req.account,
  }));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pg`delete from accounts where username = ${marker}`;
  await pg.end({ timeout: 5 });
});

describe('GET /dev/users (live postgres)', () => {
  it('finds accounts by case-insensitive username fragment', async () => {
    // Uppercased interior fragment: proves ILIKE + substring matching.
    const fragment = marker.slice(3, 12).toUpperCase();
    const res = await app.inject({ method: 'GET', url: `/dev/users?q=${fragment}` });
    expect(res.statusCode).toBe(200);
    const { users } = res.json() as { users: DevUser[] };
    expect(users.length).toBeGreaterThanOrEqual(1);
    expect(users.length).toBeLessThanOrEqual(20);
    const hit = users.find((u) => u.id === fixtureId);
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({ username: marker, type: 'user', userImage: null });
  });

  it('returns at most 20 rows with an empty query', async () => {
    const res = await app.inject({ method: 'GET', url: '/dev/users' });
    expect(res.statusCode).toBe(200);
    const { users } = res.json() as { users: DevUser[] };
    expect(users.length).toBeLessThanOrEqual(20);
  });

  it('treats LIKE metacharacters literally (no wildcard injection)', async () => {
    const res = await app.inject({ method: 'GET', url: `/dev/users?q=${encodeURIComponent('%_%')}` });
    expect(res.statusCode).toBe(200);
    const { users } = res.json() as { users: DevUser[] };
    expect(users.find((u) => u.id === fixtureId)).toBeUndefined();
  });
});

describe('POST /dev/impersonate (live postgres)', () => {
  it('sets the dev cookie for an existing account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dev/impersonate',
      payload: { accountId: fixtureId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; account: DevUser };
    expect(body.ok).toBe(true);
    expect(body.account.id).toBe(fixtureId);
    expect(body.account.username).toBe(marker);

    const setCookie = res.headers['set-cookie'];
    const cookieValue = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    expect(cookieValue).toContain(`${DEV_USER_COOKIE}=${fixtureId}`);
    expect(cookieValue).toContain('HttpOnly');
  });

  it('404s for an unknown account id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dev/impersonate',
      payload: { accountId: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('account_not_found');
  });

  it('400s on a malformed body (envelope)', async () => {
    const res = await app.inject({ method: 'POST', url: '/dev/impersonate', payload: {} });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('bad_request');
  });
});

describe('dev cookie -> request.account roundtrip', () => {
  it('authenticates a requireAuth route with the impersonation cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/__test/whoami',
      headers: { cookie: `${DEV_USER_COOKIE}=${fixtureId}` },
    });
    expect(res.statusCode).toBe(200);
    const { account } = res.json() as {
      account: { accountId: string; username: string; isAdmin: boolean };
    };
    expect(account.accountId).toBe(fixtureId);
    expect(account.username).toBe(marker);
    expect(account.isAdmin).toBe(false);
  });

  it('still 401s with a cookie naming a nonexistent account', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/__test/whoami',
      headers: { cookie: `${DEV_USER_COOKIE}=${randomUUID()}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
