import type { AuthProvider } from '@eden3/core';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerAuth } from '../src/auth-plugin';

const anonymousProvider: AuthProvider = {
  async getSession() { return null; },
};

describe('closed-alpha public share gate seam', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function setup() {
    const app = Fastify();
    apps.push(app);
    registerAuth(app, { provider: anonymousProvider, accessAllowlist: ['gene'] });
    app.get('/shares/:token', { exposeHeadRoute: false }, async () => ({ public: true }));
    app.head('/shares/:token', async (_request, reply) => reply.send());
    app.get('/sessions/:sessionId/shares', async () => ({ managed: true }));
    app.post('/sessions/:sessionId/shares', async () => ({ managed: true }));
    app.delete('/sessions/:sessionId/shares/:shareId', async () => ({ managed: true }));
    app.post('/shares/:token', async () => ({ mutated: true }));
    return app;
  }

  it.each(['GET', 'HEAD'] as const)(
    'allows anonymous %s lookup of exactly one public share token',
    async (method) => {
      const app = await setup();
      const response = await app.inject({
        method,
        url: `/shares/${'x'.repeat(32)}?source=public`,
      });
      expect(response.statusCode).toBe(200);
      if (method === 'GET') expect(response.json()).toEqual({ public: true });
    },
  );

  it.each([
    ['GET', '/sessions/session-1/shares'],
    ['POST', '/sessions/session-1/shares'],
    ['DELETE', '/sessions/session-1/shares/00000000-0000-4000-8000-000000000001'],
    ['POST', `/shares/${'x'.repeat(32)}`],
    ['GET', `/shares/${'x'.repeat(32)}/extra`],
  ] as const)('keeps %s %s behind the gate', async (method, url) => {
    const app = await setup();
    const response = await app.inject({ method, url });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('access_gated');
  });
});
