import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  authenticateServiceCallbackRequest,
  isAuthenticatedServiceCallbackRequest,
  isServiceAuthenticatedCallbackRequest,
  registerAuth,
  serviceAuthenticatedCallback,
} from '../src/auth-plugin';
import { ApiError } from '../src/errors';
import { ClerkSignupRateLimitError } from '../src/clerk-auth-provider';
import {
  FixedWindowRateLimiter,
  registerAccountRateLimiting,
  registerHttpHardening,
} from '../src/services/http-hardening';
import {
  assertNativeAgentCreationAllowed,
  type NativeAgentAdmissionTransaction,
} from '../src/services/native-agent-admission';

const quotaSqlDialect = new PgDialect();

function classifyExactNativeQuotaStatement(
  query: SQL,
  ownerAccountId: string,
): 'blocking-owner-lock' | 'owner-count' {
  const rendered = quotaSqlDialect.sqlToQuery(query);
  const normalized = rendered.sql.replace(/\s+/g, ' ').trim();
  const ownerLockKey = `native-agent-quota:${ownerAccountId}`;
  if (
    normalized === 'select pg_advisory_xact_lock( hashtextextended($1, 0) )' &&
    rendered.params.length === 1 &&
    rendered.params[0] === ownerLockKey
  ) {
    return 'blocking-owner-lock';
  }
  if (
    normalized ===
      'select count(*)::int as count from agents g join accounts a on a.id = g.account_id where g.owner_id = $1 and a.external_id is null and a.deleted = false' &&
    rendered.params.length === 1 &&
    rendered.params[0] === ownerAccountId
  ) {
    return 'owner-count';
  }
  throw new Error(
    `native-agent admission issued an unexpected or non-blocking SQL statement: ${normalized}`,
  );
}

const trustLoopback = (address: string) =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

function installErrorEnvelope(app: FastifyInstance): void {
  app.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) => {
    const apiError = error instanceof ApiError ? error : null;
    void reply.code(apiError?.statusCode ?? 500).send({
      error: {
        code: apiError?.code ?? 'internal_error',
        statusCode: apiError?.statusCode ?? 500,
      },
    });
  });
}

describe('FG-SIGNUP-ABUSE proxy-safe network admission', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('does not let a direct untrusted peer rotate buckets with forged forwarding headers', async () => {
    const app = Fastify({ trustProxy: trustLoopback });
    apps.push(app);
    installErrorEnvelope(app);
    registerHttpHardening(app, { rateLimit: { windowMs: 60_000, max: 2 } });
    app.get('/probe', async () => ({ ok: true }));
    await app.ready();

    const request = (forged: string) =>
      app.inject({
        method: 'GET',
        url: '/probe',
        remoteAddress: '198.51.100.9',
        headers: { 'x-forwarded-for': forged },
      });

    expect((await request('203.0.113.1')).statusCode).toBe(200);
    expect((await request('203.0.113.2')).statusCode).toBe(200);
    const rejected = await request('203.0.113.3');
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('uses the Caddy-observed first untrusted hop and isolates real clients', async () => {
    const app = Fastify({ trustProxy: trustLoopback });
    apps.push(app);
    installErrorEnvelope(app);
    registerHttpHardening(app, { rateLimit: { windowMs: 60_000, max: 1 } });
    app.get('/probe', async () => ({ ok: true }));
    await app.ready();

    const from = (client: string, attackerPrefix: string) =>
      app.inject({
        method: 'GET',
        url: '/probe',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': `${attackerPrefix}, ${client}` },
      });
    expect((await from('198.51.100.1', '10.0.0.1')).statusCode).toBe(200);
    expect((await from('198.51.100.2', '10.0.0.1')).statusCode).toBe(200);
    expect((await from('198.51.100.1', '10.0.0.99')).statusCode).toBe(429);
  });

  it('fails closed at bounded attacker-controlled bucket cardinality', () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({
      windowMs: 60_000,
      max: 1,
      maxBuckets: 2,
      now: () => now,
    });
    expect(limiter.hit('one').allowed).toBe(true);
    expect(limiter.hit('two').allowed).toBe(true);
    expect(limiter.hit('three')).toMatchObject({ allowed: false, remaining: 0 });
    now += 60_000;
    expect(limiter.hit('three')).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('rejects an exhausted IP before auth lookup or a route side effect', async () => {
    const app = Fastify({ trustProxy: trustLoopback });
    apps.push(app);
    installErrorEnvelope(app);
    registerHttpHardening(app, { rateLimit: { windowMs: 60_000, max: 1 } });
    let authLookups = 0;
    let sideEffects = 0;
    registerAuth(app, {
      accessAllowlist: [],
      provider: {
        async getSession() {
          authLookups += 1;
          return null;
        },
      },
    });
    app.post('/expensive', async () => {
      sideEffects += 1;
      return { ok: true };
    });
    await app.ready();

    const request = () =>
      app.inject({ method: 'POST', url: '/expensive', remoteAddress: '198.51.100.8' });
    expect((await request()).statusCode).toBe(200);
    expect((await request()).statusCode).toBe(429);
    expect(authLookups).toBe(1);
    expect(sideEffects).toBe(1);
  });
});

describe('FG-SIGNUP-ABUSE tenant and callback admission', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('limits immutable account ids independently across IP changes and tenants', async () => {
    const app = Fastify({ trustProxy: trustLoopback });
    apps.push(app);
    installErrorEnvelope(app);
    registerAuth(app, {
      accessAllowlist: [],
      provider: {
        async getSession(req) {
          const accountId = req.headers['x-test-account'];
          if (typeof accountId !== 'string') return null;
          return { accountId, username: accountId, isAdmin: false };
        },
      },
    });
    registerAccountRateLimiting(app, { rateLimit: { windowMs: 60_000, max: 1 } });
    let sideEffects = 0;
    app.post('/expensive', async () => {
      sideEffects += 1;
      return { ok: true };
    });
    await app.ready();

    const request = (accountId: string, clientIp: string) =>
      app.inject({
        method: 'POST',
        url: '/expensive',
        remoteAddress: '127.0.0.1',
        headers: { 'x-test-account': accountId, 'x-forwarded-for': clientIp },
      });
    expect((await request('account-a', '198.51.100.1')).statusCode).toBe(200);
    expect((await request('account-a', '198.51.100.2')).statusCode).toBe(429);
    expect((await request('account-b', '198.51.100.1')).statusCode).toBe(200);
    expect(sideEffects).toBe(2);
  });

  it('fails a denied new-subject admission with a bounded 429 before the route', async () => {
    const app = Fastify({ trustProxy: trustLoopback });
    apps.push(app);
    installErrorEnvelope(app);
    registerAuth(app, {
      accessAllowlist: [],
      provider: {
        async getSession() {
          throw new ClerkSignupRateLimitError(12_500);
        },
      },
    });
    let handled = 0;
    app.post('/signup-target', async () => {
      handled += 1;
      return { ok: true };
    });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/signup-target' });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('13');
    expect(response.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(handled).toBe(0);
  });

  it('bypasses both windows only for the opaque root-guarded callback', async () => {
    const app = Fastify({ trustProxy: trustLoopback });
    apps.push(app);
    installErrorEnvelope(app);
    registerHttpHardening(app, {
      rateLimit: { windowMs: 60_000, max: 0 },
      serviceCallbackAdmission: async (request, reply) =>
        isServiceAuthenticatedCallbackRequest(request)
          ? authenticateServiceCallbackRequest(request, reply)
          : false,
    });
    let browserAuthLookups = 0;
    registerAuth(app, {
      accessAllowlist: ['gene'],
      provider: {
        async getSession() {
          browserAuthLookups += 1;
          return { accountId: 'account-a', username: 'gene', isAdmin: false };
        },
      },
    });
    registerAccountRateLimiting(app, {
      rateLimit: { windowMs: 60_000, max: 0 },
      bypass: isAuthenticatedServiceCallbackRequest,
    });
    let guarded = 0;
    let handled = 0;
    const guard = async (request: FastifyRequest, reply: FastifyReply) => {
      guarded += 1;
      if (request.headers.authorization !== 'Bearer synthetic-runtime') {
        await reply.code(401).send({ error: { code: 'runtime_unauthorized' } });
      }
    };
    app.post('/runtime', serviceAuthenticatedCallback(guard), async () => {
      handled += 1;
      return { ok: true };
    });
    app.post('/ordinary', async () => {
      handled += 1;
      return { ok: true };
    });
    await app.ready();

    const rejected = await app.inject({ method: 'POST', url: '/runtime' });
    expect(rejected.statusCode).toBe(401);
    expect(handled).toBe(0);
    const admitted = await app.inject({
      method: 'POST',
      url: '/runtime',
      headers: { authorization: 'Bearer synthetic-runtime' },
    });
    expect(admitted.statusCode).toBe(200);
    expect(guarded).toBe(2);
    expect(browserAuthLookups).toBe(0);
    expect(handled).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/ordinary' })).statusCode).toBe(429);
    expect(handled).toBe(1);
  });
});

describe('FG-SIGNUP-ABUSE durable native-agent quota contract', () => {
  it('serializes concurrent same-owner admission and rejects every loser before creation', async () => {
    let durableCount = 0;
    let lockTail = Promise.resolve();

    class FakeTransaction implements NativeAgentAdmissionTransaction {
      private calls = 0;
      private unlock: (() => void) | null = null;

      async execute(query: SQL): Promise<unknown> {
        this.calls += 1;
        const statement = classifyExactNativeQuotaStatement(query, 'owner-a');

        if (statement === 'blocking-owner-lock') {
          expect(this.calls).toBe(1);
          const prior = lockTail;
          lockTail = new Promise<void>((resolve) => {
            this.unlock = resolve;
          });
          await prior;
          return [];
        }
        if (statement === 'owner-count') {
          expect(this.calls).toBe(2);
          return [{ count: durableCount }];
        }
        throw new Error('unreachable native-agent admission statement');
      }

      release(): void {
        this.unlock?.();
        this.unlock = null;
      }
    }

    const viewer = { accountId: 'owner-a', username: 'owner-a', isAdmin: false };
    const attempts = Array.from({ length: 8 }, async () => {
      const tx = new FakeTransaction();
      try {
        await assertNativeAgentCreationAllowed(tx, viewer, 2);
        durableCount += 1;
        return 'created';
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'agent_quota_exceeded') throw error;
        expect(error).toMatchObject({ statusCode: 429 });
        return 'rejected';
      } finally {
        tx.release();
      }
    });

    const results = await Promise.all(attempts);
    expect(results.filter((result) => result === 'created')).toHaveLength(2);
    expect(results.filter((result) => result === 'rejected')).toHaveLength(6);
    expect(durableCount).toBe(2);
  });

  it('rejects try-lock and no-op mutations in the concurrency harness', () => {
    expect(() =>
      classifyExactNativeQuotaStatement(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${'native-agent-quota:owner-a'}, 0))`,
        'owner-a',
      ),
    ).toThrow(/unexpected or non-blocking SQL statement/);
    expect(() => classifyExactNativeQuotaStatement(sql`select 1`, 'owner-a')).toThrow(
      /unexpected or non-blocking SQL statement/,
    );
  });

  it('does not make one owner consume another owner quota', async () => {
    const transaction = (count: number): NativeAgentAdmissionTransaction => ({
      execute: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          return calls === 1 ? [] : [{ count }];
        };
      })(),
    });
    await expect(
      assertNativeAgentCreationAllowed(
        transaction(1),
        { accountId: 'owner-b', username: 'owner-b', isAdmin: false },
        2,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertNativeAgentCreationAllowed(
        transaction(2),
        { accountId: 'owner-a', username: 'owner-a', isAdmin: false },
        2,
      ),
    ).rejects.toMatchObject({ code: 'agent_quota_exceeded' });
  });
});
