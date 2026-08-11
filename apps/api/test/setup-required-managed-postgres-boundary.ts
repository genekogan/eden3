import { generateKeyPairSync } from 'node:crypto';

import { assertApiManagedPostgresBoundary } from './fixtures/api-managed-postgres-boundary';

assertApiManagedPostgresBoundary(process.env);

// Provider rehearsals must be hermetic. These values are deterministic test
// inputs, never live channel or gateway credentials.
process.env.CHANNEL_TOKEN_ENCRYPTION_KEY ??= '1'.repeat(64);
process.env.OPENCLAW_GATEWAY_TOKEN ??= 'managed-rehearsal-synthetic-gateway-token';
process.env.CLERK_JWT_KEY ??= generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();
