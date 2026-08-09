import type { Env } from '@eden3/core';

type ProductionBoundaryEnv = Pick<
  Env,
  'ACCESS_ALLOWLIST' | 'AUTH_PROVIDER' | 'CLERK_JWT_KEY' | 'EDEN3_DEV_ROUTES'
>;

/**
 * Refuse an internet-facing API shape that can trust the unsigned local
 * impersonation cookie or silently open the closed cohort. Keep this separate
 * from the general env schema so local development retains its explicit dev
 * and hybrid modes.
 */
export function assertProductionBoundary(
  env: ProductionBoundaryEnv,
  opts: { nodeEnv?: string } = {},
): void {
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv !== 'production') return;

  if (env.AUTH_PROVIDER !== 'clerk') {
    throw new Error('Unsafe production configuration: AUTH_PROVIDER=clerk is required');
  }
  if (!env.CLERK_JWT_KEY) {
    throw new Error('Unsafe production configuration: CLERK_JWT_KEY is required');
  }
  if (env.EDEN3_DEV_ROUTES) {
    throw new Error('Unsafe production configuration: EDEN3_DEV_ROUTES=0 is required');
  }
  if (env.ACCESS_ALLOWLIST.length === 0) {
    throw new Error('Unsafe production configuration: ACCESS_ALLOWLIST must keep doors closed');
  }
}
