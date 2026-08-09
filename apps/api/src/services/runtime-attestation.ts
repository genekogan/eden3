import {
  databaseNameFromUrl,
  hasLiteralPostgresEndpoint,
} from '@eden3/core/database-url';

export interface RuntimeAttestation {
  integrationHead: string;
  nonce: string;
}

/** Closed-harness attestation; never enabled by one input or a canonical DB. */
export function runtimeAttestationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeAttestation | undefined {
  const integrationHead = environment.EDEN3_E2E_INTEGRATION_HEAD;
  const nonce = environment.EDEN3_E2E_RUNTIME_NONCE;
  if (integrationHead === undefined && nonce === undefined) return undefined;
  if (!integrationHead || !nonce || !/^[0-9a-f]{40}$/.test(integrationHead) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error('closed runtime attestation inputs are invalid or incomplete');
  }
  const databaseName = databaseNameFromUrl(environment.DATABASE_URL ?? '');
  if (
    environment.NODE_ENV === 'production' ||
    databaseName === null ||
    !/^eden3_channel_client_[a-z0-9_]{8,48}$/.test(databaseName) ||
    !hasLiteralPostgresEndpoint(environment.DATABASE_URL ?? '', '127.0.0.1', 5433)
  ) {
    throw new Error('closed runtime attestation is forbidden for production or canonical databases');
  }
  return { integrationHead, nonce };
}
