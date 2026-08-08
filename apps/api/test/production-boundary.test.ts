import { describe, expect, it } from 'vitest';

import { assertProductionBoundary } from '../src/production-boundary';

const closedCohort = {
  AUTH_PROVIDER: 'clerk' as const,
  EDEN3_DEV_ROUTES: false,
  ACCESS_ALLOWLIST: ['gene'],
};

describe('production service boundary', () => {
  it('accepts only the closed-cohort Clerk shape in production', () => {
    expect(() =>
      assertProductionBoundary(closedCohort, { nodeEnv: 'production' }),
    ).not.toThrow();
  });

  it.each(['dev', 'hybrid'] as const)(
    'rejects the unsigned dev-cookie fallback through AUTH_PROVIDER=%s',
    (AUTH_PROVIDER) => {
      expect(() =>
        assertProductionBoundary(
          { ...closedCohort, AUTH_PROVIDER },
          { nodeEnv: 'production' },
        ),
      ).toThrow(/AUTH_PROVIDER=clerk/);
    },
  );

  it('rejects mounted dev routes and an open-door allowlist in production', () => {
    expect(() =>
      assertProductionBoundary(
        { ...closedCohort, EDEN3_DEV_ROUTES: true },
        { nodeEnv: 'production' },
      ),
    ).toThrow(/EDEN3_DEV_ROUTES=0/);
    expect(() =>
      assertProductionBoundary(
        { ...closedCohort, ACCESS_ALLOWLIST: [] },
        { nodeEnv: 'production' },
      ),
    ).toThrow(/ACCESS_ALLOWLIST/);
  });

  it('preserves explicit local development modes outside production', () => {
    expect(() =>
      assertProductionBoundary(
        { AUTH_PROVIDER: 'hybrid', EDEN3_DEV_ROUTES: true, ACCESS_ALLOWLIST: [] },
        { nodeEnv: 'development' },
      ),
    ).not.toThrow();
  });
});
