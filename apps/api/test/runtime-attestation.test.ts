import { describe, expect, it } from 'vitest';

import { runtimeAttestationFromEnvironment } from '../src/services/runtime-attestation';

describe('closed runtime attestation inputs', () => {
  const valid = {
    EDEN3_E2E_INTEGRATION_HEAD: 'b'.repeat(40),
    EDEN3_E2E_RUNTIME_NONCE: 'closed_e2e_nonce_12345',
    DATABASE_URL: 'postgres://127.0.0.1:5433/eden3_channel_client_attestation',
    NODE_ENV: 'test',
  };

  it('is absent ordinarily and exact when both closed inputs are safe', () => {
    expect(runtimeAttestationFromEnvironment({})).toBeUndefined();
    expect(runtimeAttestationFromEnvironment(valid)).toEqual({
      integrationHead: valid.EDEN3_E2E_INTEGRATION_HEAD,
      nonce: valid.EDEN3_E2E_RUNTIME_NONCE,
    });
    for (const databaseUrl of [
      'postgres://eden3@127.0.0.1:5433/eden3_runtime_e2e_gate3_attestation',
      'postgres://eden3@localhost:5433/eden3_runtime_e2e_gate3_attestation',
      'postgres://eden3@[::1]:5433/eden3_runtime_e2e_gate3_attestation',
    ]) {
      expect(runtimeAttestationFromEnvironment({
        ...valid,
        DATABASE_URL: databaseUrl,
      }), databaseUrl).toEqual({
        integrationHead: valid.EDEN3_E2E_INTEGRATION_HEAD,
        nonce: valid.EDEN3_E2E_RUNTIME_NONCE,
      });
    }
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
    for (const databaseUrl of [
      'postgres://localhost/other_noncanonical_database',
      'postgres://localhost/scratch/../eden3_channel_client_attestation',
      'postgres://localhost/scratch/%2e%2e/eden3_channel_client_attestation',
      'postgres://localhost/%65den3_channel_client_attestation',
      'postgres://localhost:5433/eden3_channel_client_attestation',
      'postgres://remote.example:5433/eden3_channel_client_attestation',
      'postgres://127.0.0.1/eden3_channel_client_attestation',
      'postgres://127.0.0.1:5432/eden3_channel_client_attestation',
      'postgres://127.0.0.1:5433/eden3_channel_client_attestation?host=remote.example',
      'postgres://127.0.0.1:5433/eden3_runtime_e2e_short',
      'postgres://127.0.0.1:5433/eden3_runtime_e2e_gate3_attestation_extra/path',
      'postgres://127.0.0.1:5433/eden3_runtime_e2e_gate3_attestation?host=remote.example',
    ]) {
      expect(() => runtimeAttestationFromEnvironment({
        ...valid,
        DATABASE_URL: databaseUrl,
      }), databaseUrl).toThrow();
    }
  });
});
