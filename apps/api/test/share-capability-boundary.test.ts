import { readFile } from 'node:fs/promises';

import type { AuthProvider } from '@eden3/core';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerAuth } from '../src/auth-plugin';
import { ApiError, errorEnvelope } from '../src/errors';
import { registerHttpHardening } from '../src/services/http-hardening';
import {
  isShareCapabilityRequest,
  registerShareCapabilityResponseBoundary,
  safeCapabilityErrorMessage,
  safeNotFoundMessage,
} from '../src/services/share-cache-policy';

const anonymousProvider: AuthProvider = { async getSession() { return null; } };
const TOKEN = 't'.repeat(43);
const OBJECT = '00000000-0000-4000-8000-000000000001';

function installEnvelope(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const apiError = error instanceof ApiError ? error : null;
    const status = apiError?.statusCode ?? 500;
    void reply.code(status).send(errorEnvelope(
      status,
      apiError?.code ?? 'internal_error',
      safeCapabilityErrorMessage(
        request.url,
        apiError?.message ?? (error instanceof Error ? error.message : 'Internal server error'),
      ),
    ));
  });
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(errorEnvelope(404, 'not_found', safeNotFoundMessage(request.method, request.url)));
  });
}

function expectPrivate(response: LightMyRequestResponse, token: string): void {
  expect(response.headers['cache-control']).toContain('private');
  expect(response.headers['cache-control']).toContain('no-store');
  expect(response.headers.pragma).toBe('no-cache');
  expect(response.headers.expires).toBe('0');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['x-robots-tag']).toContain('noindex');
  expect(response.body).not.toContain(token);
  expect(JSON.stringify(response.headers)).not.toContain(token);
}

describe('root share capability response boundary', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it.each(['GET', 'HEAD'] as const)('marks exact early %s rate-limit denial', async (method) => {
    const app = Fastify();
    apps.push(app);
    registerShareCapabilityResponseBoundary(app);
    installEnvelope(app);
    registerHttpHardening(app, { rateLimit: { windowMs: 60_000, max: 0 } });
    app.get('/shares/:token', { exposeHeadRoute: false }, async () => ({ ok: true }));
    app.head('/shares/:token', async (_request, reply) => reply.send());
    const response = await app.inject({ method, url: `/shares/${TOKEN}` });
    expect(response.statusCode).toBe(429);
    expectPrivate(response, TOKEN);
  });

  it('marks cohort denials without making nested capabilities public', async () => {
    const app = Fastify();
    apps.push(app);
    registerShareCapabilityResponseBoundary(app);
    installEnvelope(app);
    registerHttpHardening(app, { rateLimit: { windowMs: 60_000, max: 100 } });
    registerAuth(app, { provider: anonymousProvider, accessAllowlist: ['gene'] });

    for (const url of [
      `/shares/${TOKEN}/extra`,
      `/media/share/${TOKEN}/bad-object`,
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(403);
      expectPrivate(response, TOKEN);
    }

    const lookalike = await app.inject({ method: 'GET', url: `/sharesX/${TOKEN}` });
    expect(lookalike.statusCode).toBe(403);
    expect(lookalike.headers['cache-control']).toBeUndefined();
    expect(isShareCapabilityRequest(`/sharesX/${TOKEN}`)).toBe(false);
  });

  it.each([
    '/shares/short',
    `/shares/${'o'.repeat(201)}`,
    '/shares/not%20base64url',
    `/shares/${TOKEN}/extra`,
    `/media/share/${TOKEN}/bad-object`,
  ])('marks malformed or nested global 404 without reflecting %s', async (url) => {
    const app = Fastify();
    apps.push(app);
    registerShareCapabilityResponseBoundary(app);
    installEnvelope(app);
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(404);
    expectPrivate(response, decodeURIComponent(url.split('/')[2] ?? ''));
    expect(response.body).toContain('Share capability not found');
    expect(response.body).not.toContain(url);
  });

  it('redacts capability error text and is registered before hardening/auth', async () => {
    expect(safeCapabilityErrorMessage(`/shares/${TOKEN}`, `failure ${TOKEN}`)).toBe(
      'Share capability request failed',
    );
    const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
    const boundary = source.indexOf('registerShareCapabilityResponseBoundary(app)');
    expect(boundary).toBeGreaterThan(0);
    expect(boundary).toBeLessThan(source.indexOf("reply.header('x-request-id'"));
    expect(boundary).toBeLessThan(source.indexOf('registerHttpHardening(app'));
    expect(boundary).toBeLessThan(source.indexOf('registerAuth(app'));
  });
});
