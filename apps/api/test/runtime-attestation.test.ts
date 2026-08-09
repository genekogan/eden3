import { describe, expect, it } from 'vitest';

import { runtimeAttestationFromEnvironment } from '../src/services/runtime-attestation';

describe('closed runtime attestation inputs', () => {
  const valid = {
    EDEN3_E2E_INTEGRATION_HEAD: 'b'.repeat(40),
    EDEN3_E2E_RUNTIME_NONCE: 'closed_e2e_nonce_12345',
    DATABASE_URL: 'postgres://localhost/eden3_runtime_attestation_test',
    NODE_ENV: 'test',
  };

  it('is absent ordinarily and exact when both closed inputs are safe', () => {
    expect(runtimeAttestationFromEnvironment({})).toBeUndefined();
    expect(runtimeAttestationFromEnvironment(valid)).toEqual({
      integrationHead: valid.EDEN3_E2E_INTEGRATION_HEAD,
      nonce: valid.EDEN3_E2E_RUNTIME_NONCE,
    });
  });

  it('rejects partial, malformed, production, and canonical DB inputs', () => {
    expect(() => runtimeAttestationFromEnvironment({
      EDEN3_E2E_INTEGRATION_HEAD: valid.EDEN3_E2E_INTEGRATION_HEAD,
    })).toThrow();
    expect(() => runtimeAttestationFromEnvironment({ ...valid, NODE_ENV: 'production' })).toThrow();
    expect(() => runtimeAttestationFromEnvironment({
      ...valid,
      DATABASE_URL: 'postgres://localhost/eden3',
    })).toThrow();
  });
});
