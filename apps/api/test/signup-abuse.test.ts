import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerHttpHardening } from '../src/services/http-hardening';

describe('FG-SIGNUP-ABUSE proxy-safe network admission', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('does not let a direct untrusted peer rotate buckets with forged forwarding headers', async () => {
    const app = Fastify({
      trustProxy: (address) =>
        address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1',
    });
    apps.push(app);
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
});
