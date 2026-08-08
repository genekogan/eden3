import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ROUTE_AUTH_INVENTORY,
  verifyRouteAuthInventory,
  type RouteAuthManifestEntry,
} from '../scripts/route-auth-inventory';

type CapturedRoute = {
  method: string;
  path: string;
  preHandlers: string[];
  serviceGuard: string | null;
};

const capture = vi.hoisted(() => ({ routes: [] as CapturedRoute[] }));

vi.mock('fastify', async () => {
  const actual = await vi.importActual<typeof import('fastify')>('fastify');
  return {
    ...actual,
    default: (options?: import('fastify').FastifyServerOptions) => {
      const app = actual.default(options);
      app.addHook('onRoute', (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        const preHandlers = (
          Array.isArray(route.preHandler) ? route.preHandler : route.preHandler ? [route.preHandler] : []
        ).map((handler) => handler.name || 'anonymous');
        const serviceGuardKey = Reflect.ownKeys(route.config ?? {}).find(
          (key) => typeof key === 'symbol' && key.description === 'eden.service-callback-guard',
        );
        const serviceGuard = serviceGuardKey
          ? (route.config as Record<PropertyKey, unknown>)[serviceGuardKey]
          : null;
        for (const method of methods) {
          capture.routes.push({
            method,
            path: route.url,
            preHandlers,
            serviceGuard:
              typeof serviceGuard === 'function' ? serviceGuard.name || 'anonymous' : null,
          });
        }
      });
      return app;
    },
  };
});

vi.mock('../src/services/agent-skills', () => ({
  ensureBuiltinSkills: vi.fn(async () => undefined),
}));

vi.mock('../src/services/default-assistant', () => ({
  ensureEveAssistant: vi.fn(async () => undefined),
}));

const mediaDir = mkdtempSync(join(tmpdir(), 'eden-route-inventory-'));
process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/route_inventory';
process.env.MEDIA_DIR = mediaDir;
process.env.AUTH_PROVIDER = 'dev';
process.env.EDEN3_DEV_ROUTES = '1';
process.env.CHANNEL_TOKEN_ENCRYPTION_KEY = '11'.repeat(32);
const connectSpy = vi.spyOn(Socket.prototype, 'connect');

describe('effective route auth inventory capture', () => {
  let app: Awaited<ReturnType<typeof import('../src/server').buildServer>>;

  beforeAll(async () => {
    const { buildServer } = await import('../src/server');
    const storageRuntime = {
      mediaResolver: {},
      uploadService: { localPartUploadsEnabled: true },
      policyEventWorker: { tick: async () => ({}) },
      multipartCleanupWorker: { tick: async () => ({}) },
    };
    app = await buildServer({
      gateway: null,
      auth: { provider: { getSession: async () => null } },
      media: { autoStartWatcher: false },
      scheduler: { autoStart: false },
      storage: { runtime: storageRuntime as never, autoStartPolicyWorker: false },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    connectSpy.mockRestore();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  it('classifies the effective prefixed route surface without a DB connection', () => {
    expect(connectSpy).not.toHaveBeenCalled();
    expect(capture.routes.length).toBe(ROUTE_AUTH_INVENTORY.length);
    expect(() => verifyRouteAuthInventory(capture.routes)).not.toThrow();
    expect(capture.routes.some((route) => route.path === '/404')).toBe(false);
  });

  it('fails when a route guard is removed', () => {
    const mutated = capture.routes.map((route) =>
      route.method === 'POST' && route.path === '/uploads'
        ? { ...route, preHandlers: [] }
        : route,
    );
    expect(() => verifyRouteAuthInventory(mutated)).toThrow(/guard drift: POST \/uploads/);
  });

  it('fails on an unclassified route or exact public lookalike', () => {
    expect(() =>
      verifyRouteAuthInventory([
        ...capture.routes,
        { method: 'GET', path: '/shares/:token/extra', preHandlers: [], serviceGuard: null },
      ]),
    ).toThrow(/unclassified effective route: GET \/shares\/:token\/extra/);
  });

  it('fails when a public capability path is broadened', () => {
    const broadened: RouteAuthManifestEntry[] = ROUTE_AUTH_INVENTORY.map((route) =>
      route.path === '/shares/:token'
        ? { ...route, path: '/shares/*' }
        : { ...route },
    );
    expect(() => verifyRouteAuthInventory(capture.routes, broadened)).toThrow(
      /unapproved wildcard\/lookalike route: GET \/shares\/\*/,
    );
  });

  it('fails when a service guard is swapped', () => {
    const mutated = capture.routes.map((route) =>
      route.path === '/channels/runtime/messages'
        ? { ...route, serviceGuard: 'requireTelegramManager' }
        : route,
    );
    expect(() => verifyRouteAuthInventory(mutated)).toThrow(
      /guard drift: POST \/channels\/runtime\/messages/,
    );
  });

  it('fails on unsupported methods and duplicate guard registrations', () => {
    const unsupported: RouteAuthManifestEntry[] = [
      ...ROUTE_AUTH_INVENTORY,
      {
        method: 'CONNECT',
        path: '/health',
        classification: 'public-exact',
        guardIdentifiers: ['root:cohort-exact-policy'],
      },
    ];
    expect(() => verifyRouteAuthInventory(capture.routes, unsupported)).toThrow(
      /unsupported method: CONNECT \/health/,
    );

    const duplicate = capture.routes.find(
      (route) => route.method === 'POST' && route.path === '/uploads',
    )!;
    expect(() =>
      verifyRouteAuthInventory([
        ...capture.routes,
        { ...duplicate, preHandlers: [], serviceGuard: 'otherGuard' },
      ]),
    ).toThrow(/duplicate effective route: POST \/uploads/);
  });

  it('pins exact service POSTs, capability methods, and production-off dev mounting', () => {
    expect(
      ROUTE_AUTH_INVENTORY.every(
        (route) =>
          Object.keys(route).sort().join(',') ===
          'classification,guardIdentifiers,method,path',
      ),
    ).toBe(true);
    const serviceRoutes = ROUTE_AUTH_INVENTORY.filter(
      (route) => route.classification === 'service-authenticated',
    );
    expect(serviceRoutes.length).toBeGreaterThan(0);
    expect(serviceRoutes.every((route) => route.method === 'POST')).toBe(true);
    expect(serviceRoutes.every((route) => !route.path.includes('*'))).toBe(true);

    expect(
      ROUTE_AUTH_INVENTORY.find(
        (route) =>
          route.method === 'PUT' && route.path === '/uploads/:uploadId/parts/:partNumber',
      )?.guardIdentifiers,
    ).toEqual(['header:upload-capability']);
    expect(
      ROUTE_AUTH_INVENTORY.filter((route) => route.path.startsWith('/dev/')).every(
        (route) => route.classification === 'dev-only',
      ),
    ).toBe(true);

    const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(serverSource).toContain("if (env.AUTH_PROVIDER === 'dev' || env.EDEN3_DEV_ROUTES)");
    expect(serverSource).toContain("app.register(devRoutes, { prefix: '/dev' })");
  });
});
