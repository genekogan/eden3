import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ApiError,
  errorEnvelope,
  safeServerErrorLog,
  sendError,
} from '../src/errors';
import { registerApiErrorHandler } from '../src/server';

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

  it('makes direct sendError calls obey the same 5xx boundary', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    app.get('/direct', async (_request, reply) =>
      sendError(reply, 502, 'provider_error', SENSITIVE));

    const response = await app.inject({ method: 'GET', url: '/direct' });

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

  it.each([
    ['ordinary Error', () => new Error(SENSITIVE), 500, 'internal_error', 'Internal server error'],
    [
      'ApiError',
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
