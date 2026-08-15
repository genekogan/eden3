import { DevAuthProvider, getEnv, type AuthProvider, type AuthSession } from '@eden3/core';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import {
  ClerkAuthProvider,
  ClerkSignupRateLimitError,
  FallbackAuthProvider,
} from './clerk-auth-provider';
import { sendError } from './errors';
import { FixedWindowRateLimiter } from './services/http-hardening';

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
const authenticatedServiceCallbacks = new WeakSet<FastifyRequest>();
type ServiceCallbackGuard = (
  request: FastifyRequest,
  reply: FastifyReply,
) => void | Promise<unknown>;

declare module 'fastify' {
  interface FastifyContextConfig {
    [SERVICE_CALLBACK_GUARD]?: ServiceCallbackGuard;
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

/** Bind an exact POST service callback to the root hook that authenticates it. */
export function serviceAuthenticatedCallback(guard: ServiceCallbackGuard) {
  return {
    config: { [SERVICE_CALLBACK_GUARD]: guard },
  } as const;
}

/** Read-only check for the opaque route/guard binding; callers cannot mint it. */
export function isServiceAuthenticatedCallbackRequest(request: FastifyRequest): boolean {
  return typeof request.routeOptions.config[SERVICE_CALLBACK_GUARD] === 'function';
}

/**
 * Execute the opaque route-bound credential guard exactly once. The network
 * limiter calls this at the root before granting a service-only bypass;
 * registerAuth calls it as a fallback when no limiter is installed.
 */
export async function authenticateServiceCallbackRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const guard = request.routeOptions.config[SERVICE_CALLBACK_GUARD];
  if (!guard) return false;
  if (!authenticatedServiceCallbacks.has(request)) {
    await guard(request, reply);
    if (!reply.sent) authenticatedServiceCallbacks.add(request);
  }
  return authenticatedServiceCallbacks.has(request);
}

export function isAuthenticatedServiceCallbackRequest(request: FastifyRequest): boolean {
  return authenticatedServiceCallbacks.has(request);
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
const UUID_PATH = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const PRIVATE_RUNTIME_VOICE_PATH =
  new RegExp(`^/media/runtime/voice/${UUID_PATH}/${UUID_PATH}/${UUID_PATH}/[0-9]{10}/[0-9a-f]{64}\\.ogg$`);
function isGateExempt(method: string, url: string, serviceCallback: boolean): boolean {
  const path = url.split('?', 1)[0]!;
  return (
    GATE_EXEMPT_EXACT.has(path) ||
    (method === 'POST' && serviceCallback) ||
    ((method === 'GET' || method === 'HEAD') &&
      (PUBLIC_SHARE_PATH.test(path) || PUBLIC_SHARE_MEDIA_PATH.test(path) ||
        (method === 'GET' && PRIVATE_RUNTIME_VOICE_PATH.test(path)))) ||
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

  const signupLimiter = new FixedWindowRateLimiter({
    windowMs: env.CLERK_SIGNUP_RATE_LIMIT_WINDOW_MS,
    max: env.CLERK_SIGNUP_RATE_LIMIT_MAX,
  });

  const clerk = new ClerkAuthProvider({
    adminUsernames: env.ADMIN_USERNAMES,
    allowAccountCreation: opts.allowAccountCreation,
    authorizedParties: env.CLERK_AUTHORIZED_PARTIES,
    jwtKey: env.CLERK_JWT_KEY,
    seedManna: env.CLERK_NEW_USER_SEED_MANNA,
    signupAdmission: ({ clientIp }) => signupLimiter.hit(`signup-ip:${clientIp}`),
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
    if (
      methods.length !== 1 ||
      methods[0] !== 'POST' ||
      route.url.includes('*') ||
      route.url.includes('?')
    ) {
      throw new Error(
        'serviceAuthenticatedCallback requires one exact non-wildcard POST route',
      );
    }
  });

  // DevAuthProvider short-circuits (no DB query) when the cookie is absent,
  // so anonymous traffic pays nothing here.
  app.addHook('onRequest', async (req, reply) => {
    if (reply.sent || isAuthenticatedServiceCallbackRequest(req)) return;
    try {
      req.account = await provider.getSession(req);
    } catch (err) {
      if (err instanceof ClerkSignupRateLimitError) {
        reply.header('retry-after', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
        await sendError(reply, 429, 'rate_limited', 'Too many new accounts; retry later');
        return;
      }
      throw err;
    }
  });

  // Execute the opaque route-bound credential guard at the root, before any
  // plugin/route lifecycle hook can parse, validate, or mutate service data.
  app.addHook('onRequest', async (req, reply) => {
    if (!reply.sent) await authenticateServiceCallbackRequest(req, reply);
  });

  if (allowlist.size > 0) {
    app.addHook('onRequest', async (req, reply) => {
      if (reply.sent) return;
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
