import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const SYNTHETIC_DATABASE_URL =
  'postgresql://synthetic:synthetic@127.0.0.1:9/synthetic_access_gate';
const RUNTIME_TOKEN = 'synthetic-runtime-token';
const TELEGRAM_WEBHOOK_SECRET = 'synthetic-telegram-webhook-secret';

const RUNTIME_ROUTE_PATTERNS = [
  '/channels/runtime/messages',
  '/channels/runtime/pairing',
  '/channels/runtime/status',
  '/channels/runtime/turns/reserve',
  '/channels/runtime/turns/:turnId/settle',
  '/channels/runtime/turns/:turnId/refund',
  '/channels/runtime/turns/:turnId/delivery-failed',
  '/channels/runtime/turns/:turnId/delivered',
] as const;

const TURN_ID = '00000000-0000-4000-8000-000000000001';
const RUNTIME_REQUEST_PATHS = [
  '/channels/runtime/messages',
  '/channels/runtime/pairing',
  '/channels/runtime/status',
  '/channels/runtime/turns/reserve',
  `/channels/runtime/turns/${TURN_ID}/settle`,
  `/channels/runtime/turns/${TURN_ID}/refund`,
  `/channels/runtime/turns/${TURN_ID}/delivery-failed`,
  `/channels/runtime/turns/${TURN_ID}/delivered`,
] as const;

const NON_POST_CALLBACKS = [
  ['GET', '/channels/runtime/status'],
  ['PUT', '/channels/runtime/status'],
  ['GET', '/channels/telegram/managed-bots/webhook'],
  ['PUT', '/channels/telegram/managed-bots/webhook'],
] as const;

let registerAuth: typeof import('../src/auth-plugin').registerAuth;

beforeAll(async () => {
  // @eden3/core's public index includes DB-backed modules. Give that lazy
  // client an unreachable synthetic URL before importing the auth plugin;
  // this battery performs no query and needs no real environment or database.
  vi.stubEnv('DATABASE_URL', SYNTHETIC_DATABASE_URL);
  ({ registerAuth } = await import('../src/auth-plugin'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function unauthorized(reply: FastifyReply, code: string) {
  return reply.code(401).send({
    error: { code, message: 'Service authentication required', statusCode: 401 },
  });
}

async function buildAdmissionHarness(): Promise<FastifyInstance> {
  const app = Fastify();
  registerAuth(app, {
    provider: { async getSession() { return null; } },
    accessAllowlist: ['gene'],
  });

  const requireRuntime = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.authorization !== `Bearer ${RUNTIME_TOKEN}`) {
      return unauthorized(reply, 'runtime_unauthorized');
    }
  };

  for (const url of RUNTIME_ROUTE_PATTERNS) {
    app.post(url, { preHandler: requireRuntime }, async () => ({ ok: true }));
  }

  app.post(
    '/channels/telegram/managed-bots/webhook',
    {
      preHandler: async (request, reply) => {
        const presented = request.headers['x-telegram-bot-api-secret-token'];
        if (presented !== TELEGRAM_WEBHOOK_SECRET) {
          return unauthorized(reply, 'telegram_webhook_unauthorized');
        }
      },
    },
    async () => ({ ok: true, accepted: false }),
  );

  app.get('/channels/connections', { preHandler: app.requireAuth }, async () => ({ items: [] }));
  await app.ready();
  return app;
}

describe('closed-cohort admission for channel service callbacks', () => {
  for (const path of RUNTIME_REQUEST_PATHS) {
    it.each([
      ['missing', undefined],
      ['wrong', 'Bearer wrong-runtime-token'],
    ])(`lets ${path} reach its %s runtime credential rejection`, async (_case, authorization) => {
      const app = await buildAdmissionHarness();
      try {
        const response = await app.inject({
          method: 'POST',
          url: path,
          headers: authorization ? { authorization } : undefined,
          payload: {},
        });

        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('runtime_unauthorized');
      } finally {
        await app.close();
      }
    });
  }

  it.each([
    ['missing', undefined],
    ['wrong', 'wrong-telegram-webhook-secret'],
  ])('lets the Telegram webhook reach its %s credential rejection', async (_case, secret) => {
    const app = await buildAdmissionHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/channels/telegram/managed-bots/webhook',
        headers: secret ? { 'x-telegram-bot-api-secret-token': secret } : undefined,
        payload: {},
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('telegram_webhook_unauthorized');
    } finally {
      await app.close();
    }
  });

  it('admits an authenticated empty Telegram update without a provider or database', async () => {
    const app = await buildAdmissionHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/channels/telegram/managed-bots/webhook?source=telegram',
        headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_WEBHOOK_SECRET },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, accepted: false });
    } finally {
      await app.close();
    }
  });

  it.each(NON_POST_CALLBACKS)('keeps non-POST callback method %s %s cohort-gated', async (method, path) => {
    const app = await buildAdmissionHarness();
    try {
      const response = await app.inject({ method, url: path });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('access_gated');
    } finally {
      await app.close();
    }
  });

  it.each([
    '/channels/runtime/status/extra',
    '/channels/runtimeevil/status',
    '/channels/runtime/turns/reserve/extra',
    `/channels/runtime/turns/${TURN_ID}/settle/extra`,
    '/channels/telegram/managed-bots/webhook/extra',
    '/channels/telegram/managed-bots/webhookevil',
  ])('keeps callback lookalike %s cohort-gated', async (path) => {
    const app = await buildAdmissionHarness();
    try {
      const response = await app.inject({ method: 'POST', url: path, payload: {} });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('access_gated');
    } finally {
      await app.close();
    }
  });

  it('keeps a normal browser channel route cohort-gated', async () => {
    const app = await buildAdmissionHarness();
    try {
      const response = await app.inject({ method: 'GET', url: '/channels/connections' });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('access_gated');
    } finally {
      await app.close();
    }
  });
});
