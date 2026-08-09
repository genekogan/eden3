import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { createClerkJwtVerifier } from '../src/clerk-auth-provider';
import { assertProductionBoundary } from '../src/production-boundary';

const closedCohort = {
  AUTH_PROVIDER: 'clerk' as const,
  CLERK_JWT_KEY: 'configured-clerk-instance-public-key',
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

  it('requires a configured Clerk verification trust root before production work', () => {
    expect(() =>
      assertProductionBoundary(
        { ...closedCohort, CLERK_JWT_KEY: undefined },
        { nodeEnv: 'production' },
      ),
    ).toThrow(/CLERK_JWT_KEY/);
    expect(() => createClerkJwtVerifier()).toThrow(/CLERK_JWT_KEY/);

    const source = readFileSync(new URL('../src/clerk-auth-provider.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("new URL('/.well-known/jwks.json'");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain('payload.iss');

    const envTemplate = readFileSync(
      new URL('../../../.env.example', import.meta.url),
      'utf8',
    );
    expect(envTemplate).toContain('CLERK_JWT_KEY is mandatory for clerk and');
    expect(envTemplate).not.toMatch(/(?:fallback|otherwise).*JWKS/i);
  });

  it('preserves explicit local development modes outside production', () => {
    expect(() =>
      assertProductionBoundary(
        {
          AUTH_PROVIDER: 'hybrid',
          CLERK_JWT_KEY: undefined,
          EDEN3_DEV_ROUTES: true,
          ACCESS_ALLOWLIST: [],
        },
        { nodeEnv: 'development' },
      ),
    ).not.toThrow();
  });
});
