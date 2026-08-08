import { mkdtempSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ROUTE_AUTH_INVENTORY,
  verifyRouteAuthInventory,
  type RouteAuthGuardIdentity,
  type RouteAuthManifestEntry,
} from '../scripts/route-auth-inventory';

type CapturedRoute = {
  method: string;
  path: string;
  preHandlers: unknown[];
  serviceGuard: unknown | null;
  hasExactServiceMarker: boolean;
  hasLookalikeServiceMarker: boolean;
};

const capture = vi.hoisted(() => ({
  routes: { dev: [] as CapturedRoute[], production: [] as CapturedRoute[] },
  profile: 'dev' as 'dev' | 'production',
  serviceMarker: null as symbol | null,
}));

vi.mock('fastify', async () => {
  const actual = await vi.importActual<typeof import('fastify')>('fastify');
  return {
    ...actual,
    default: (options?: import('fastify').FastifyServerOptions) => {
      const app = actual.default(options);
      app.addHook('onRoute', (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        const preHandlers: unknown[] = (
          Array.isArray(route.preHandler) ? route.preHandler : route.preHandler ? [route.preHandler] : []
        );
        const config = route.config ?? {};
        const functionSymbolKeys = Reflect.ownKeys(config).filter(
          (key) => typeof key === 'symbol' && typeof (config as Record<PropertyKey, unknown>)[key] === 'function',
        );
        const serviceGuard = capture.serviceMarker
          ? (config as Record<PropertyKey, unknown>)[capture.serviceMarker]
          : null;
        for (const method of methods) {
          capture.routes[capture.profile].push({
            method,
            path: route.url,
            preHandlers,
            serviceGuard: serviceGuard ?? null,
            hasExactServiceMarker:
              capture.serviceMarker !== null &&
              Reflect.ownKeys(config).includes(capture.serviceMarker),
            hasLookalikeServiceMarker: functionSymbolKeys.some(
              (key) => key !== capture.serviceMarker,
            ),
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
  const apps: Array<Awaited<ReturnType<typeof import('../src/server').buildServer>>> = [];
  let guardIdentity: RouteAuthGuardIdentity;

  beforeAll(async () => {
    const auth = await import('../src/auth-plugin');
    const probeGuard = () => undefined;
    const probeConfig = auth.serviceAuthenticatedCallback(probeGuard).config;
    const exactMarkers = Reflect.ownKeys(probeConfig).filter(
      (key): key is symbol =>
        typeof key === 'symbol' &&
        (probeConfig as Record<PropertyKey, unknown>)[key] === probeGuard,
    );
    expect(exactMarkers).toHaveLength(1);
    capture.serviceMarker = exactMarkers[0]!;
    guardIdentity = { requireAuth: auth.requireAuth };

    const { resetEnvCache } = await import('@eden3/core');
    const { buildServer } = await import('../src/server');
    const buildProfile = async (profile: 'dev' | 'production') => {
      capture.profile = profile;
      process.env.AUTH_PROVIDER = profile === 'dev' ? 'dev' : 'clerk';
      process.env.EDEN3_DEV_ROUTES = profile === 'dev' ? '1' : '0';
      resetEnvCache();
      const storageRuntime = {
        mediaResolver: {},
        uploadService: { localPartUploadsEnabled: true },
        policyEventWorker: { tick: async () => ({}) },
        multipartCleanupWorker: { tick: async () => ({}) },
      };
      const app = await buildServer({
        gateway: null,
        auth: { provider: { getSession: async () => null } },
        media: { autoStartWatcher: false },
        scheduler: { autoStart: false },
        storage: { runtime: storageRuntime as never, autoStartPolicyWorker: false },
      });
      await app.ready();
      apps.push(app);
    };
    await buildProfile('dev');
    await buildProfile('production');
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    connectSpy.mockRestore();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  it('classifies the effective prefixed route surface without a DB connection', () => {
    expect(connectSpy).not.toHaveBeenCalled();
    expect(capture.routes.dev.length).toBe(ROUTE_AUTH_INVENTORY.length);
    expect(() => verifyRouteAuthInventory(capture.routes.dev, guardIdentity)).not.toThrow();
    expect(capture.routes.dev.some((route) => route.path === '/404')).toBe(false);
  });

  it('captures production mode with no dev routes and the same non-dev graph', () => {
    const productionManifest = ROUTE_AUTH_INVENTORY.filter(
      (route) => route.classification !== 'dev-only',
    );
    expect(capture.routes.production.some((route) => route.path.startsWith('/dev/'))).toBe(false);
    expect(() =>
      verifyRouteAuthInventory(capture.routes.production, guardIdentity, productionManifest),
    ).not.toThrow();
    const keys = (routes: CapturedRoute[]) =>
      routes
        .filter((route) => !route.path.startsWith('/dev/'))
        .map((route) => `${route.method} ${route.path}`)
        .sort();
    expect(keys(capture.routes.production)).toEqual(keys(capture.routes.dev));
  });

  it('fails when a route guard is removed', () => {
    const mutated = capture.routes.dev.map((route) =>
      route.method === 'POST' && route.path === '/uploads'
        ? { ...route, preHandlers: [] }
        : route,
    );
    expect(() => verifyRouteAuthInventory(mutated, guardIdentity)).toThrow(
      /guard drift: POST \/uploads/,
    );
  });

  it('fails on an unclassified route or exact public lookalike', () => {
    expect(() =>
      verifyRouteAuthInventory(
        [
          ...capture.routes.dev,
          {
            method: 'GET',
            path: '/shares/:token/extra',
            preHandlers: [],
            serviceGuard: null,
            hasExactServiceMarker: false,
            hasLookalikeServiceMarker: false,
          },
        ],
        guardIdentity,
      ),
    ).toThrow(/unclassified effective route: GET \/shares\/:token\/extra/);
  });

  it('fails when a public capability path is broadened', () => {
    const broadened: RouteAuthManifestEntry[] = ROUTE_AUTH_INVENTORY.map((route) =>
      route.path === '/shares/:token'
        ? { ...route, path: '/shares/*' }
        : { ...route },
    );
    expect(() => verifyRouteAuthInventory(capture.routes.dev, guardIdentity, broadened)).toThrow(
      /unapproved wildcard\/lookalike route: GET \/shares\/\*/,
    );
  });

  it('fails when a service guard is swapped', () => {
    const telegramGuard = capture.routes.dev.find(
      (route) => route.path === '/channels/telegram/managed-bots/webhook',
    )!.serviceGuard;
    const mutated = capture.routes.dev.map((route) =>
      route.path === '/channels/runtime/messages'
        ? { ...route, serviceGuard: telegramGuard }
        : route,
    );
    expect(() => verifyRouteAuthInventory(mutated, guardIdentity)).toThrow(
      /service guard (?:equivalence drift|identity reused across classes)/,
    );

    const lookalike = capture.routes.dev.map((route) =>
      route.path === '/media/runtime/authorizations'
        ? { ...route, hasExactServiceMarker: false, hasLookalikeServiceMarker: true }
        : route,
    );
    expect(() => verifyRouteAuthInventory(lookalike, guardIdentity)).toThrow(
      /lookalike opaque service marker: POST \/media\/runtime\/authorizations/,
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
    expect(() => verifyRouteAuthInventory(capture.routes.dev, guardIdentity, unsupported)).toThrow(
      /unsupported method: CONNECT \/health/,
    );

    const duplicate = capture.routes.dev.find(
      (route) => route.method === 'POST' && route.path === '/uploads',
    )!;
    expect(() =>
      verifyRouteAuthInventory(
        [
          ...capture.routes.dev,
          { ...duplicate, preHandlers: [], serviceGuard: () => undefined },
        ],
        guardIdentity,
      ),
    ).toThrow(/duplicate effective route: POST \/uploads/);
  });

  it('fails class-label mutations that retain the old route guard', () => {
    const mislabeled = ROUTE_AUTH_INVENTORY.map((route) =>
      route.method === 'POST' && route.path === '/uploads'
        ? { ...route, classification: 'public-exact' as const }
        : route,
    );
    expect(() => verifyRouteAuthInventory(capture.routes.dev, guardIdentity, mislabeled)).toThrow(
      /invalid public guard contract: POST \/uploads/,
    );
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

  });
});
