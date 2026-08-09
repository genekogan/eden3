import { parseSecretId } from '@eden3/gateway';

/**
 * Narrow hand-off into the existing encrypted channel-token vault.
 *
 * Connector services deliberately do not know how ciphertext is stored or how
 * the capability MAC is minted. Route wiring supplies the T12 implementation,
 * which must return a request-scoped `channel/<uuid>.<epoch>.<mac>` SecretRef.
 * Plaintext may exist only for the duration of `sealScoped` or `withPlaintext`.
 */
export interface ChannelCredentialCustodyLike {
  /**
   * Encrypt, persist, mint via `hostedChannelSecretRef`, and commit as one
   * atomic operation. Any validation/mint failure MUST roll back the row.
   */
  sealScoped(input: {
    accountId: string;
    agentId: string | null;
    channel: string;
    label: string | null;
    plaintext: string;
    bypassAccountQuota?: boolean;
  }): Promise<ChannelSecretHandle>;
  withPlaintext<T>(
    handle: ChannelSecretHandle,
    operation: (plaintext: string) => Promise<T>,
  ): Promise<T>;
  revoke(handle: ChannelSecretHandle): Promise<void>;
}

export interface ChannelSecretHandle {
  connectionId: string;
  secretRefId: string;
}

const CAPABILITY_SECRET_REF =
  /^channel\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.c[0-9]{1,6}\.[A-Za-z0-9_-]{22}$/i;

/** Fail closed if route wiring accidentally returns the legacy bearer id. */
export function assertRequestScopedSecretHandle(handle: ChannelSecretHandle): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(handle.connectionId)) {
    throw new Error('channel custody returned an invalid connection id');
  }
  if (!CAPABILITY_SECRET_REF.test(handle.secretRefId)) {
    throw new Error('channel custody did not return a request-scoped SecretRef');
  }
  const parsed = parseSecretId(handle.secretRefId);
  if (
    parsed.kind !== 'capability' ||
    parsed.connectionId.toLowerCase() !== handle.connectionId.toLowerCase()
  ) {
    throw new Error('channel custody returned a cross-connection SecretRef');
  }
}
