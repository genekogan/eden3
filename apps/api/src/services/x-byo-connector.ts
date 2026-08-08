import {
  assertRequestScopedSecretHandle,
  type ChannelCredentialCustodyLike,
  type ChannelSecretHandle,
} from './channel-connector-custody';

export const X_DEVELOPER_PORTAL_URL = 'https://developer.x.com/en/portal/dashboard';

export interface XByoCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface XUserIdentity {
  id: string;
  username: string;
  name: string | null;
}

export type XConnectorFailureCode =
  | 'invalid_credentials'
  | 'revoked'
  | 'rate_limited'
  | 'provider_unavailable';

export type XConnectorResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: XConnectorFailureCode;
      message: string;
      retryable: boolean;
      retryAfterSeconds?: number;
    };

export interface XUserClientLike {
  validate(credentials: XByoCredentials): Promise<XConnectorResult<XUserIdentity>>;
  post(credentials: XByoCredentials, text: string): Promise<XConnectorResult<{ id: string }>>;
}

export interface XByoConnection {
  handle: ChannelSecretHandle;
  user: XUserIdentity;
}

function normalizeCredentials(input: XByoCredentials): XByoCredentials | null {
  const normalized = {
    apiKey: input.apiKey.trim(),
    apiSecret: input.apiSecret.trim(),
    accessToken: input.accessToken.trim(),
    accessTokenSecret: input.accessTokenSecret.trim(),
  };
  return Object.values(normalized).every((value) => value.length > 0 && value.length <= 10_000)
    ? normalized
    : null;
}

function serializeCredentials(credentials: XByoCredentials): string {
  return JSON.stringify(credentials);
}

function parseCredentials(plaintext: string): XByoCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('vaulted X credential payload is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('vaulted X credential payload is invalid');
  }
  const record = parsed as Record<string, unknown>;
  const normalized = normalizeCredentials({
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
    apiSecret: typeof record.apiSecret === 'string' ? record.apiSecret : '',
    accessToken: typeof record.accessToken === 'string' ? record.accessToken : '',
    accessTokenSecret:
      typeof record.accessTokenSecret === 'string' ? record.accessTokenSecret : '',
  });
  if (!normalized) throw new Error('vaulted X credential payload is invalid');
  return normalized;
}

export class XByoConnectorService {
  constructor(
    private readonly client: XUserClientLike,
    private readonly custody: ChannelCredentialCustodyLike,
  ) {}

  async connect(input: {
    accountId: string;
    agentId: string | null;
    label?: string;
    credentials: XByoCredentials;
  }): Promise<XConnectorResult<XByoConnection>> {
    const credentials = normalizeCredentials(input.credentials);
    if (!credentials) {
      return {
        ok: false,
        code: 'invalid_credentials',
        message: 'Enter all four credentials from your X developer app.',
        retryable: false,
      };
    }
    const validation = await this.client.validate(credentials);
    if (!validation.ok) return validation;
    const handle = await this.custody.seal({
      accountId: input.accountId,
      agentId: input.agentId,
      channel: 'x',
      label: input.label?.trim() || null,
      plaintext: serializeCredentials(credentials),
    });
    assertRequestScopedSecretHandle(handle);
    return { ok: true, value: { handle, user: validation.value } };
  }

  async post(
    handle: ChannelSecretHandle,
    text: string,
  ): Promise<XConnectorResult<{ id: string }>> {
    const trimmed = text.trim();
    if (!trimmed || [...trimmed].length > 280) {
      throw new Error('X post must contain between 1 and 280 characters');
    }
    assertRequestScopedSecretHandle(handle);
    return this.custody.withPlaintext(handle, async (plaintext) =>
      this.client.post(parseCredentials(plaintext), trimmed),
    );
  }

  async revoke(handle: ChannelSecretHandle): Promise<void> {
    assertRequestScopedSecretHandle(handle);
    await this.custody.revoke(handle);
  }
}
