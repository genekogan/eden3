import { DevAuthProvider, getEnv, type AuthProvider, type AuthSession } from '@eden3/core';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';

import { ClerkAuthProvider, FallbackAuthProvider } from './clerk-auth-provider';
import { sendError } from './errors';

/**
 * Auth wiring.
 *
 * An instance-level onRequest hook resolves the session via the configured
 * {@link AuthProvider} (DevAuthProvider by default — the `eden3_dev_user`
 * cookie set by `POST /dev/impersonate`) and exposes it as `request.account`
 * (null when anonymous). Routes that require a signed-in principal attach
 * {@link requireAuth} as a preHandler (`app.requireAuth` is the same
 * function, decorated for convenience).
 *
 * Registered as a plain function on the ROOT instance (not via
 * `app.register`) so the decorators and hook escape plugin encapsulation
 * without needing fastify-plugin.
 */

const SERVICE_CALLBACK_GUARD: unique symbol = Symbol('eden.service-callback-guard');

declare module 'fastify' {
  interface FastifyContextConfig {
    [SERVICE_CALLBACK_GUARD]?: preHandlerHookHandler;
  }
  interface FastifyRequest {
    /** Resolved auth session, or null when the request is anonymous. */
    account: AuthSession | null;
  }
  interface FastifyInstance {
    authProvider: AuthProvider;
    requireAuth: typeof requireAuth;
    /** Lowercased closed-alpha allowlist; empty set = gate off. */
    accessAllowlist: ReadonlySet<string>;
  }
}

export interface AuthPluginOptions {
  /** Override the auth provider (tests / future Clerk). Defaults to DevAuthProvider. */
  provider?: AuthProvider;
  /** Override the closed-alpha allowlist (tests). Defaults to env.ACCESS_ALLOWLIST. */
  accessAllowlist?: string[];
  /** Test/future composition seam; production uses the Clerk/dev factory. */
  providerFactory?: (opts: { allowAccountCreation: boolean }) => AuthProvider;
}

/** Bind an exact POST service callback to the guard that authenticates it. */
export function serviceAuthenticatedCallback(guard: preHandlerHookHandler) {
  return {
    config: { [SERVICE_CALLBACK_GUARD]: guard },
    preHandler: guard,
  } as const;
}

/**
 * Paths a gated (or anonymous) visitor may still reach when the closed-alpha
 * gate is on: enough to sign in, learn they are gated, and let
 * signature-authenticated services through. Everything else 403s.
 */
const GATE_EXEMPT_EXACT = new Set(['/health', '/billing/webhook']);
const GATE_EXEMPT_PREFIXES = ['/auth/', '/dev/'] as const;
const PUBLIC_SHARE_PATH = /^\/shares\/[^/]+$/;
const PUBLIC_SHARE_MEDIA_PATH =
  /^\/media\/share\/[^/]+\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const UUID_PATH_PART =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const SERVICE_AUTH_POST_EXACT = new Set([
  '/channels/telegram/managed-bots/webhook',
  '/channels/runtime/messages',
  '/channels/runtime/pairing',
  '/channels/runtime/status',
  '/channels/runtime/turns/reserve',
]);
const SERVICE_AUTH_POST_TURN = new RegExp(
  `^/channels/runtime/turns/${UUID_PATH_PART}/(?:settle|refund|delivery-failed|delivered)$`,
);

function isGateExempt(method: string, url: string, serviceCallback: boolean): boolean {
  const path = url.split('?', 1)[0]!;
  return (
    GATE_EXEMPT_EXACT.has(path) ||
    (method === 'POST' && serviceCallback) ||
    (method === 'POST' &&
      (SERVICE_AUTH_POST_EXACT.has(path) || SERVICE_AUTH_POST_TURN.test(path))) ||
    ((method === 'GET' || method === 'HEAD') &&
      (PUBLIC_SHARE_PATH.test(path) || PUBLIC_SHARE_MEDIA_PATH.test(path))) ||
    GATE_EXEMPT_PREFIXES.some((prefix) =>
      path === prefix.slice(0, -1) || path.startsWith(prefix),
    )
  );
}

/** True when the closed-alpha gate blocks this session (never for exempt paths). */
export function isAccessGated(
  allowlist: ReadonlySet<string>,
  session: AuthSession | null,
): boolean {
  if (allowlist.size === 0) return false;
  return session === null || !allowlist.has(session.username.toLowerCase());
}

function defaultAuthProvider(opts: { allowAccountCreation: boolean }): AuthProvider {
  const env = getEnv();
  const dev = new DevAuthProvider({ adminUsernames: env.ADMIN_USERNAMES });
  if (env.AUTH_PROVIDER === 'dev') return dev;

  const clerk = new ClerkAuthProvider({
    adminUsernames: env.ADMIN_USERNAMES,
    allowAccountCreation: opts.allowAccountCreation,
    authorizedParties: env.CLERK_AUTHORIZED_PARTIES,
    jwtKey: env.CLERK_JWT_KEY,
    seedManna: env.CLERK_NEW_USER_SEED_MANNA,
  });
  return env.AUTH_PROVIDER === 'hybrid' ? new FallbackAuthProvider([clerk, dev]) : clerk;
}

/** preHandler: reject anonymous requests with a 401 envelope. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.account) {
    await sendError(reply, 401, 'unauthorized', 'Authentication required');
  }
}

export function registerAuth(app: FastifyInstance, opts: AuthPluginOptions = {}): void {
  const allowlist = new Set(
    (opts.accessAllowlist ?? getEnv().ACCESS_ALLOWLIST).map((u) => u.toLowerCase()),
  );
  const provider =
    opts.provider ??
    (opts.providerFactory ?? defaultAuthProvider)({ allowAccountCreation: allowlist.size === 0 });

  app.decorateRequest('account', null);
  app.decorate('authProvider', provider);
  app.decorate('requireAuth', requireAuth);
  app.decorate('accessAllowlist', allowlist);

  app.addHook('onRoute', (route) => {
    const guard = route.config?.[SERVICE_CALLBACK_GUARD];
    if (!guard) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const handlers = Array.isArray(route.preHandler)
      ? route.preHandler
      : route.preHandler
        ? [route.preHandler]
        : [];
    if (methods.length !== 1 || methods[0] !== 'POST' || !handlers.includes(guard)) {
      throw new Error(
        'serviceAuthenticatedCallback requires one exact POST route with its bound pre-handler',
      );
    }
  });

  // DevAuthProvider short-circuits (no DB query) when the cookie is absent,
  // so anonymous traffic pays nothing here.
  app.addHook('onRequest', async (req) => {
    req.account = await provider.getSession(req);
  });

  if (allowlist.size > 0) {
    app.addHook('onRequest', async (req, reply) => {
      if (
        isGateExempt(
          req.method,
          req.url,
          typeof req.routeOptions.config[SERVICE_CALLBACK_GUARD] === 'function',
        )
      ) return;
      if (isAccessGated(allowlist, req.account)) {
        await sendError(reply, 403, 'access_gated', 'This Eden is in closed alpha');
      }
    });
  }
}
