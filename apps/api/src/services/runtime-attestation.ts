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
  let databaseName = '';
  try {
    databaseName = new URL(environment.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  } catch {
    throw new Error('closed runtime attestation requires a disposable database');
  }
  if (environment.NODE_ENV === 'production' || databaseName === 'eden3' || databaseName === 'eden3_stg' || !databaseName) {
    throw new Error('closed runtime attestation is forbidden for production or canonical databases');
  }
  return { integrationHead, nonce };
}
