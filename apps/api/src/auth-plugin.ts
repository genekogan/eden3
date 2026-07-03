import { DevAuthProvider, type AuthProvider, type AuthSession } from '@eden3/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved auth session, or null when the request is anonymous. */
    account: AuthSession | null;
  }
  interface FastifyInstance {
    authProvider: AuthProvider;
    requireAuth: typeof requireAuth;
  }
}

export interface AuthPluginOptions {
  /** Override the auth provider (tests / future Clerk). Defaults to DevAuthProvider. */
  provider?: AuthProvider;
}

/** preHandler: reject anonymous requests with a 401 envelope. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.account) {
    await sendError(reply, 401, 'unauthorized', 'Authentication required (dev: POST /dev/impersonate)');
  }
}

export function registerAuth(app: FastifyInstance, opts: AuthPluginOptions = {}): void {
  const provider = opts.provider ?? new DevAuthProvider();

  app.decorateRequest('account', null);
  app.decorate('authProvider', provider);
  app.decorate('requireAuth', requireAuth);

  // DevAuthProvider short-circuits (no DB query) when the cookie is absent,
  // so anonymous traffic pays nothing here.
  app.addHook('onRequest', async (req) => {
    req.account = await provider.getSession(req);
  });
}
