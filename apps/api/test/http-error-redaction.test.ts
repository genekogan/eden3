import { readFile } from 'node:fs/promises';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  errorEnvelope,
  safeServerErrorLog,
  sendError,
} from '../src/errors';
import { registerApiErrorHandler } from '../src/server';
import { recordStudioReversal } from '../src/routes/studio';

const SENSITIVE = 'SENSITIVE_5XX_SENTINEL_do_not_expose';

describe('HTTP 5xx disclosure boundary', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it.each([
    [500, 'Internal server error'],
    [501, 'Service temporarily unavailable'],
    [502, 'Upstream service unavailable'],
    [503, 'Service temporarily unavailable'],
    [504, 'Request timed out'],
    [599, 'Service temporarily unavailable'],
  ] as const)('replaces untrusted %i text with one reviewed public message', (status, expected) => {
    const envelope = errorEnvelope(status, 'specific_machine_code', SENSITIVE);

    expect(envelope).toEqual({
      error: { code: 'specific_machine_code', message: expected, statusCode: status },
    });
    expect(JSON.stringify(envelope)).not.toContain(SENSITIVE);
  });

  it('preserves actionable 4xx text and exact status/code', () => {
    expect(errorEnvelope(409, 'write_conflict', 'Reload before saving')).toEqual({
      error: {
        code: 'write_conflict',
        message: 'Reload before saving',
        statusCode: 409,
      },
    });
  });

  it('rejects an injected 5xx machine code while preserving the status', () => {
    const envelope = errorEnvelope(503, SENSITIVE, SENSITIVE);

    expect(envelope).toEqual({
      error: {
        code: 'internal_error',
        message: 'Service temporarily unavailable',
        statusCode: 503,
      },
    });
    expect(JSON.stringify(envelope)).not.toContain(SENSITIVE);
  });

  it.each([
    [502, 'provider_error', 'Upstream service unavailable'],
    [502, 'repair_failed', 'Upstream service unavailable'],
  ] as const)(
    'makes direct %s %s sendError calls obey the same 5xx boundary',
    async (status, code, message) => {
      const app = Fastify({ logger: false });
      apps.push(app);
      app.get('/direct', async (_request, reply) =>
        sendError(reply, status, code, SENSITIVE));

      const response = await app.inject({ method: 'GET', url: '/direct' });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        error: {
          code,
          message,
          statusCode: status,
        },
      });
      expect(response.body).not.toContain(SENSITIVE);
    },
  );

  it('redacts an injected ApiError code from both response and logs', async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        level: 'error',
        base: undefined,
        stream: { write: (line: string) => lines.push(line) },
      },
    });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/failure', async () => {
      throw new ApiError(503, SENSITIVE, SENSITIVE);
    });

    const response = await app.inject({ method: 'GET', url: '/failure' });

    expect(response.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'Service temporarily unavailable',
        statusCode: 503,
      },
    });
    expect(response.body).not.toContain(SENSITIVE);
    expect(lines.join('\n')).not.toContain(SENSITIVE);
  });

  it.each([
    ['ordinary Error', () => new Error(SENSITIVE), 500, 'internal_error', 'Internal server error'],
    [
      'provisioning ApiError',
      () => new ApiError(503, 'agent_provision_failed', SENSITIVE),
      503,
      'agent_provision_failed',
      'Service temporarily unavailable',
    ],
    [
      'skill-sync ApiError',
      () => new ApiError(503, 'skill_sync_failed', SENSITIVE),
      503,
      'skill_sync_failed',
      'Service temporarily unavailable',
    ],
  ] as const)(
    'redacts %s from the production handler response and captured logs',
    async (_name, makeError, status, code, message) => {
      const lines: string[] = [];
      const app = Fastify({
        logger: {
          level: 'error',
          base: undefined,
          stream: { write: (line: string) => lines.push(line) },
        },
      });
      apps.push(app);
      registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
      app.get('/failure', async () => {
        throw makeError();
      });

      const response = await app.inject({ method: 'GET', url: '/failure' });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: { code, message, statusCode: status } });
      expect(response.body).not.toContain(SENSITIVE);
      expect(lines.join('\n')).not.toContain(SENSITIVE);
      expect(lines.join('\n')).toContain('request failed');
    },
  );

  it('retains non-message exception telemetry without retaining unsafe text', () => {
    const error = Object.assign(new Error(SENSITIVE), { code: 'EUPSTREAM' });

    const context = safeServerErrorLog(error);

    expect(context).toMatchObject({ errorName: 'Error', errorCode: 'EUPSTREAM' });
    expect(JSON.stringify(context)).not.toContain(SENSITIVE);
  });

  it('rejects injected exception names and codes from safe log metadata', () => {
    const error = Object.assign(new Error('ordinary'), { name: SENSITIVE, code: SENSITIVE });

    const context = safeServerErrorLog(error);

    expect(context).toEqual({ errorName: 'Error' });
    expect(JSON.stringify(context)).not.toContain(SENSITIVE);
  });

  it('stores a stable Studio reversal reason instead of provider detail', async () => {
    const compensate = vi.fn(async () => 'refunded' as const);

    await expect(recordStudioReversal('provider_error', SENSITIVE, compensate))
      .resolves.toBe('refunded');
    expect(compensate).toHaveBeenCalledWith({
      errorCode: 'provider_error',
      errorMessage: 'Studio generation failed',
    });
    expect(JSON.stringify(compensate.mock.calls)).not.toContain(SENSITIVE);
  });

  it('clamps an explicit route reply that bypasses errorEnvelope and sendError', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/raw-provider-failure', async (_request, reply) =>
      reply.code(502).send({
        error: { code: 'provider_error', message: SENSITIVE, statusCode: 502 },
        providerDetail: SENSITIVE,
      }));

    const response = await app.inject({ method: 'GET', url: '/raw-provider-failure' });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: 'provider_error',
        message: 'Upstream service unavailable',
        statusCode: 502,
      },
    });
    expect(response.body).not.toContain(SENSITIVE);
  });

  it('does not reserialize a canonical 5xx envelope or disturb safe headers', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/canonical', async (_request, reply) => {
      reply.header('retry-after', '30');
      return reply
        .code(503)
        .send(errorEnvelope(503, 'agent_provision_failed', SENSITIVE));
    });

    const response = await app.inject({ method: 'GET', url: '/canonical' });

    expect(response.headers['retry-after']).toBe('30');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      error: {
        code: 'agent_provision_failed',
        message: 'Service temporarily unavailable',
        statusCode: 503,
      },
    });
  });

  it('preserves only the reviewed machine-readable unhealthy health schema', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/health', async (_request, reply) => reply.code(503).send({
      ok: false,
      versions: { api: '0.1.0', node: 'v24.1.0', fastify: '5.4.0' },
      database: null,
      schema: {
        status: 'missing_migrations',
        expectedMigration: '0033_session_share_links',
        expectedCount: 34,
        appliedCount: 33,
        missingCount: 1,
        unexpectedCount: 0,
      },
    }));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      schema: { status: 'missing_migrations', missingCount: 1 },
    });
    expect(response.body).not.toContain(SENSITIVE);
  });

  it('rejects free-form detail smuggled into an unhealthy health body', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/health', async (_request, reply) => reply.code(503).send({
      ok: false,
      versions: { api: '0.1.0', node: 'v24.1.0', fastify: '5.4.0' },
      database: null,
      schema: {
        status: 'database_unavailable',
        expectedMigration: SENSITIVE,
        expectedCount: 34,
        appliedCount: null,
        missingCount: null,
        unexpectedCount: null,
      },
    }));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'Service temporarily unavailable',
        statusCode: 503,
      },
    });
    expect(response.body).not.toContain(SENSITIVE);
  });

  it('keeps named provider and repair logs on the safe metadata seam', async () => {
    const [studio, agents] = await Promise.all([
      readFile(new URL('../src/routes/studio.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/routes/agents.ts', import.meta.url), 'utf8'),
    ]);

    expect(studio).not.toMatch(/tts fallback failed:.*String\(fallbackErr\)/);
    expect(studio).not.toMatch(/tool invoke failed:.*String\(err\)/);
    expect(studio).toMatch(
      /safeServerErrorLog\(fallbackErr\)[\s\S]{0,120}'studio: tts fallback failed'/,
    );
    expect(studio).toMatch(
      /safeServerErrorLog\(err\)[\s\S]{0,120}'studio: tool invocation failed'/,
    );
    expect(agents).not.toMatch(/req\.log\.error\(\{ err \}, `repair failed/);
    expect(agents).toContain('{ ...safeServerErrorLog(err), accountId: account.id }');
  });

  it('keeps an actionable ApiError 4xx message through the production handler', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/conflict', async () => {
      throw new ApiError(409, 'write_conflict', 'Reload before saving');
    });

    const response = await app.inject({ method: 'GET', url: '/conflict' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: 'write_conflict', message: 'Reload before saving', statusCode: 409 },
    });
  });
});
