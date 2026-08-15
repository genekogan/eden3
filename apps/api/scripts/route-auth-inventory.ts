export const ROUTE_AUTH_CLASSES = [
  'public-exact',
  'service-authenticated',
  'authenticated-user-agent',
  'owner-member',
  'admin-operator',
  'dev-only',
] as const;

export type RouteAuthClass = (typeof ROUTE_AUTH_CLASSES)[number];

export type RouteAuthManifestEntry = {
  method: string;
  path: string;
  classification: RouteAuthClass;
  guardIdentifiers: readonly string[];
};

export type CapturedRouteAuth = {
  method: string;
  path: string;
  preHandlers: readonly unknown[];
  serviceGuard: unknown | null;
  hasExactServiceMarker: boolean;
  hasLookalikeServiceMarker: boolean;
};

export type RouteAuthGuardIdentity = {
  requireAuth: unknown;
};

type PathMethods = readonly [path: string, methods: readonly string[]];

function entries(
  classification: RouteAuthClass,
  guardIdentifiers: readonly string[],
  paths: readonly PathMethods[],
): RouteAuthManifestEntry[] {
  return paths.flatMap(([path, methods]) =>
    methods.map((method) => ({
      method,
      path,
      classification,
      guardIdentifiers,
    })),
  );
}

const PUBLIC_ROUTES: readonly PathMethods[] = [
  ['/agents', ['GET', 'HEAD']],
  ['/agents/', ['HEAD']],
  ['/agents/:username', ['GET', 'HEAD']],
  ['/agents/:username/concepts', ['GET', 'HEAD']],
  ['/agents/:username/skills', ['GET', 'HEAD']],
  ['/auth/me', ['GET', 'HEAD']],
  ['/collections/:idOrExternal', ['GET', 'HEAD']],
  ['/creations/:idOrExternal', ['GET', 'HEAD']],
  ['/feed/agents', ['GET', 'HEAD']],
  ['/feed/creations', ['GET', 'HEAD']],
  ['/health', ['GET', 'HEAD']],
  ['/skills', ['GET', 'HEAD']],
  ['/studio/quote', ['POST']],
  ['/studio/tools', ['GET', 'HEAD']],
  ['/users/:username/collections', ['GET', 'HEAD']],
];

const AUTHENTICATED_ROUTES: readonly PathMethods[] = [
  ['/agents', ['POST']],
  ['/agents/import', ['POST']],
  ['/agents/:username/like', ['DELETE', 'POST']],
  ['/billing/checkout', ['POST']],
  ['/billing/subscription', ['GET', 'HEAD']],
  ['/billing/vouchers/redeem', ['POST']],
  ['/creations/:idOrExternal/like', ['DELETE', 'POST']],
  ['/creations/:idOrExternal/report', ['POST']],
  ['/manna', ['GET', 'HEAD']],
  ['/manna/', ['HEAD']],
  ['/manna/transactions', ['GET', 'HEAD']],
  ['/notifications', ['GET', 'HEAD']],
  ['/notifications/', ['HEAD']],
  ['/notifications/:id', ['DELETE']],
  ['/notifications/:id/read', ['POST']],
  ['/notifications/events', ['GET', 'HEAD']],
  ['/notifications/read-all', ['POST']],
  ['/search', ['GET', 'HEAD']],
  ['/search/', ['HEAD']],
  ['/skills/:slug/review', ['POST']],
  ['/skills/user', ['POST']],
  ['/studio/generate', ['POST']],
  ['/transcriptions', ['POST']],
  ['/transcriptions/:id', ['DELETE', 'GET', 'HEAD']],
  ['/transcriptions/:id/chunks/:chunkNumber', ['PUT']],
  ['/transcriptions/:id/finalize', ['POST']],
  ['/usage/summary', ['GET', 'HEAD']],
];

const OWNER_MEMBER_ROUTES: readonly PathMethods[] = [
  ['/account', ['DELETE']],
  ['/account/avatar', ['DELETE', 'POST']],
  ['/account/avatar/identity', ['PATCH']],
  ['/account/export', ['GET', 'HEAD']],
  ['/agents/:username', ['PATCH']],
  ['/agents/:username/activity', ['GET', 'HEAD']],
  ['/agents/:username/avatar', ['DELETE', 'POST']],
  ['/agents/:username/concepts', ['POST']],
  ['/agents/:username/concepts/:slug', ['DELETE', 'PATCH']],
  ['/agents/:username/concepts/:slug/images', ['PATCH', 'POST']],
  ['/agents/:username/concepts/:slug/images/:imageId', ['DELETE']],
  ['/agents/:username/export', ['GET', 'HEAD']],
  ['/agents/:username/memory', ['GET', 'HEAD', 'PUT']],
  ['/agents/:username/memory/rebuild', ['POST']],
  ['/agents/:username/memory/search-probe', ['POST']],
  ['/agents/:username/repair', ['POST']],
  ['/agents/:username/retry-provision', ['POST']],
  ['/agents/:username/skills', ['POST']],
  ['/agents/:username/workspace', ['GET', 'HEAD']],
  ['/agents/:username/workspace/download', ['GET', 'HEAD']],
  ['/agents/:username/workspace/export', ['GET', 'HEAD']],
  ['/agents/:username/workspace/file', ['GET', 'HEAD', 'PUT']],
  ['/agents/:username/voice-assignment', ['DELETE', 'PUT']],
  ['/channels/connections', ['GET', 'HEAD', 'POST']],
  ['/channels/connections/:id', ['DELETE']],
  ['/channels/connections/:id/activate', ['POST']],
  ['/channels/connections/:id/deactivate', ['POST']],
  ['/channels/connections/:id/destinations', ['GET', 'HEAD']],
  ['/channels/connections/:id/mock-message', ['POST']],
  ['/channels/connections/:id/pairing', ['GET', 'HEAD']],
  ['/channels/connections/:id/pairing/:requestId/approve', ['POST']],
  ['/channels/connections/:id/pairing/:requestId/deny', ['POST']],
  ['/channels/connections/:id/retry', ['POST']],
  ['/channels/telegram/managed-bots/onboarding', ['POST']],
  ['/channels/telegram/managed-bots/onboarding/:intentId', ['GET', 'HEAD']],
  ['/channels/telegram/managed-bots/onboarding/:intentId/attach', ['POST']],
  ['/channels/telegram/managed-bots/onboarding/:intentId/cancel', ['POST']],
  ['/channels/x/connections', ['GET', 'HEAD', 'POST']],
  ['/channels/x/connections/:id/posts', ['POST']],
  ['/channels/x/connections/:id/revoke', ['POST']],
  ['/collections', ['POST']],
  ['/collections/:idOrExternal/creations', ['POST']],
  ['/collections/:idOrExternal/creations/:creationIdOrExternal', ['DELETE']],
  ['/creations/:idOrExternal', ['DELETE']],
  ['/sessions', ['GET', 'HEAD']],
  ['/sessions/', ['HEAD']],
  ['/sessions/:id', ['DELETE', 'GET', 'HEAD', 'PATCH']],
  ['/sessions/:id/events', ['GET', 'HEAD']],
  ['/sessions/:idOrNew/messages', ['POST']],
  ['/sessions/:sessionId/messages/:messageId/voice-note', ['POST']],
  ['/sessions/:sessionId/shares', ['GET', 'HEAD', 'POST']],
  ['/sessions/:sessionId/shares/:shareId', ['DELETE']],
  ['/tasks', ['GET', 'HEAD', 'POST']],
  ['/tasks/', ['HEAD']],
  ['/tasks/:id', ['PATCH']],
  ['/tasks/:id/runs', ['GET', 'HEAD', 'POST']],
  ['/uploads', ['POST']],
  ['/uploads/:uploadId', ['DELETE', 'GET', 'HEAD']],
  ['/uploads/:uploadId/complete', ['POST']],
  ['/uploads/:uploadId/parts/:partNumber', ['POST']],
  ['/uploads/:uploadId/parts/:partNumber/complete', ['POST']],
  ['/voices/catalog', ['GET', 'HEAD']],
  ['/voices/clones', ['GET', 'HEAD', 'POST']],
  ['/voices/clones/quote', ['POST']],
  ['/voices/clones/:id', ['DELETE', 'GET', 'HEAD']],
  ['/voices/clones/:id/revoke', ['POST']],
  ['/voices/previews', ['POST']],
  ['/voices/quotes', ['POST']],
];

const OPERATOR_ROUTES: readonly PathMethods[] = [
  ['/operator/content-reports', ['GET', 'HEAD']],
  ['/operator/content-reports/:id/resolve', ['POST']],
  ['/operator/health', ['GET', 'HEAD']],
  ['/operator/memory/sweep', ['POST']],
  ['/operator/model-runtimes', ['GET', 'HEAD', 'POST']],
  ['/operator/usage/reconcile', ['POST']],
  ['/operator/usage/summary', ['GET', 'HEAD']],
];

const DEV_ROUTES: readonly PathMethods[] = [
  ['/dev/grant', ['POST']],
  ['/dev/impersonate', ['POST']],
  ['/dev/logout', ['POST']],
  ['/dev/me', ['GET', 'HEAD']],
  ['/dev/users', ['GET', 'HEAD']],
];

const CHANNEL_RUNTIME_SERVICE_ROUTES: readonly PathMethods[] = [
  ['/channels/runtime/messages', ['POST']],
  ['/channels/runtime/pairing', ['POST']],
  ['/channels/runtime/status', ['POST']],
  ['/channels/runtime/turns/:turnId/delivered', ['POST']],
  ['/channels/runtime/turns/:turnId/delivery-failed', ['POST']],
  ['/channels/runtime/turns/:turnId/refund', ['POST']],
  ['/channels/runtime/turns/:turnId/settle', ['POST']],
  ['/channels/runtime/turns/reserve', ['POST']],
];

const VOICE_RUNTIME_SERVICE_ROUTES: readonly PathMethods[] = [
  ['/channels/runtime/turns/:turnId/voice-note', ['POST']],
];

const MEDIA_RUNTIME_SERVICE_ROUTES: readonly PathMethods[] = [
  ['/media/runtime/authorizations', ['POST']],
  ['/media/runtime/authorizations/:authorizationId/fail', ['POST']],
];

const TELEGRAM_SERVICE_ROUTES: readonly PathMethods[] = [
  ['/channels/telegram/managed-bots/webhook', ['POST']],
];

const UUID_MEDIA_ROUTE =
  '/media/:objectId(^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$)';
const SHARE_MEDIA_ROUTE =
  '/media/share/:token/:objectId(^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$)';

export const ROUTE_AUTH_INVENTORY: readonly RouteAuthManifestEntry[] = [
  ...entries('public-exact', ['root:cohort-exact-policy'], PUBLIC_ROUTES),
  ...entries('public-exact', ['cors:preflight'], [['*', ['OPTIONS']]]),
  ...entries(
    'public-exact',
    ['handler:stripe-signature'],
    [['/billing/webhook', ['POST']]],
  ),
  ...entries(
    'public-exact',
    ['handler:lifecycle-media-authorization'],
    [[UUID_MEDIA_ROUTE, ['GET', 'HEAD']]],
  ),
  ...entries(
    'public-exact',
    ['handler:opaque-share-token', 'response:private-capability'],
    [
      ['/shares/:token', ['GET', 'HEAD']],
      [SHARE_MEDIA_ROUTE, ['GET', 'HEAD']],
    ],
  ),
  ...entries(
    'public-exact',
    ['static:legacy-media-root'],
    [['/media/*', ['GET', 'HEAD']]],
  ),
  ...entries(
    'public-exact',
    ['header:upload-capability'],
    [['/uploads/:uploadId/parts/:partNumber', ['PUT']]],
  ),
  ...entries(
    'authenticated-user-agent',
    ['route:requireAuth'],
    AUTHENTICATED_ROUTES,
  ),
  ...entries('owner-member', ['route:requireAuth', 'handler:resource-authority'], OWNER_MEMBER_ROUTES),
  ...entries('admin-operator', ['route:requireAuth', 'handler:admin'], OPERATOR_ROUTES),
  ...entries('dev-only', ['server:dev-mount-condition'], DEV_ROUTES),
  ...entries(
    'service-authenticated',
    ['root-service:channels-runtime'],
    CHANNEL_RUNTIME_SERVICE_ROUTES,
  ),
  ...entries(
    'service-authenticated',
    ['root-service:media-runtime'],
    MEDIA_RUNTIME_SERVICE_ROUTES,
  ),
  ...entries(
    'service-authenticated',
    ['root-service:voice-runtime'],
    VOICE_RUNTIME_SERVICE_ROUTES,
  ),
  ...entries(
    'service-authenticated',
    ['root-service:requireTelegramManager'],
    TELEGRAM_SERVICE_ROUTES,
  ),
];

function key(route: Pick<RouteAuthManifestEntry, 'method' | 'path'>): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

const SUPPORTED_METHODS = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
]);
const APPROVED_WILDCARD_KEYS = new Set(['OPTIONS *', 'GET /media/*', 'HEAD /media/*']);

export function verifyRouteAuthInventory(
  captured: readonly CapturedRouteAuth[],
  guardIdentity: RouteAuthGuardIdentity,
  manifest: readonly RouteAuthManifestEntry[] = ROUTE_AUTH_INVENTORY,
): void {
  const failures: string[] = [];
  const manifestByKey = new Map<string, RouteAuthManifestEntry>();
  for (const entry of manifest) {
    const routeKey = key(entry);
    if (manifestByKey.has(routeKey)) failures.push(`duplicate manifest route: ${routeKey}`);
    manifestByKey.set(routeKey, entry);
    if (!SUPPORTED_METHODS.has(entry.method)) failures.push(`unsupported method: ${routeKey}`);
    if (
      (entry.path.includes('*') || entry.path.includes('?')) &&
      !APPROVED_WILDCARD_KEYS.has(routeKey)
    ) {
      failures.push(`unapproved wildcard/lookalike route: ${routeKey}`);
    }
    if (entry.classification === 'service-authenticated') {
      const serviceGuards = entry.guardIdentifiers.filter((guard) =>
        guard.startsWith('root-service:'),
      );
      if (entry.method !== 'POST' || serviceGuards.length !== 1) {
        failures.push(`invalid service callback contract: ${routeKey}`);
      }
    }
    const guards = [...entry.guardIdentifiers].sort().join('|');
    if (
      entry.classification === 'authenticated-user-agent' &&
      guards !== 'route:requireAuth'
    ) {
      failures.push(`invalid authenticated guard contract: ${routeKey}`);
    }
    if (
      entry.classification === 'owner-member' &&
      guards !== 'handler:resource-authority|route:requireAuth'
    ) {
      failures.push(`invalid owner/member guard contract: ${routeKey}`);
    }
    if (
      entry.classification === 'admin-operator' &&
      guards !== 'handler:admin|route:requireAuth'
    ) {
      failures.push(`invalid admin guard contract: ${routeKey}`);
    }
    if (
      entry.classification === 'dev-only' &&
      (guards !== 'server:dev-mount-condition' || !entry.path.startsWith('/dev/'))
    ) {
      failures.push(`invalid dev-only guard contract: ${routeKey}`);
    }
    if (
      entry.classification === 'public-exact' &&
      entry.guardIdentifiers.some(
        (guard) => guard.startsWith('route:') || guard.startsWith('root-service:'),
      )
    ) {
      failures.push(`invalid public guard contract: ${routeKey}`);
    }
  }

  const capturedByKey = new Map<string, CapturedRouteAuth>();
  const serviceGuardByIdentifier = new Map<string, unknown>();
  const identifierByServiceGuard = new Map<unknown, string>();
  for (const route of captured) {
    const routeKey = key(route);
    const prior = capturedByKey.get(routeKey);
    if (prior) {
      failures.push(`duplicate effective route: ${routeKey}`);
      continue;
    }
    capturedByKey.set(routeKey, route);
    const expected = manifestByKey.get(routeKey);
    if (!expected) {
      failures.push(`unclassified effective route: ${routeKey}`);
      continue;
    }
    if (route.hasLookalikeServiceMarker) {
      failures.push(`lookalike opaque service marker: ${routeKey}`);
    }

    const requiresRouteAuth = [
      'authenticated-user-agent',
      'owner-member',
      'admin-operator',
    ].includes(expected.classification);
    const hasExactRouteAuth =
      route.preHandlers.length === 1 && route.preHandlers[0] === guardIdentity.requireAuth;
    if (requiresRouteAuth !== hasExactRouteAuth) {
      failures.push(`guard drift: ${routeKey} exact requireAuth mismatch`);
    }

    if (expected.classification === 'service-authenticated') {
      const identifier = expected.guardIdentifiers.find((guard) =>
        guard.startsWith('root-service:'),
      )!;
      if (
        route.preHandlers.length !== 0 ||
        !route.hasExactServiceMarker ||
        typeof route.serviceGuard !== 'function'
      ) {
        failures.push(`guard drift: ${routeKey} exact opaque service marker mismatch`);
      } else {
        const boundGuard = serviceGuardByIdentifier.get(identifier);
        if (boundGuard !== undefined && boundGuard !== route.serviceGuard) {
          failures.push(`service guard equivalence drift: ${routeKey}`);
        } else {
          serviceGuardByIdentifier.set(identifier, route.serviceGuard);
        }
        const boundIdentifier = identifierByServiceGuard.get(route.serviceGuard);
        if (boundIdentifier !== undefined && boundIdentifier !== identifier) {
          failures.push(`service guard identity reused across classes: ${routeKey}`);
        } else {
          identifierByServiceGuard.set(route.serviceGuard, identifier);
        }
      }
    } else if (
      route.hasExactServiceMarker ||
      route.serviceGuard !== null ||
      (!requiresRouteAuth && route.preHandlers.length !== 0)
    ) {
      failures.push(`guard drift: ${routeKey} unexpected route/service guard`);
    }
  }
  for (const routeKey of manifestByKey.keys()) {
    if (!capturedByKey.has(routeKey)) failures.push(`manifest route is not effective: ${routeKey}`);
  }

  if (failures.length > 0) {
    throw new Error(`route auth inventory verification failed:\n- ${failures.join('\n- ')}`);
  }
}
