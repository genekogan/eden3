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

function safeFailure(
  failure: Extract<XConnectorResult<unknown>, { ok: false }>,
): Extract<XConnectorResult<never>, { ok: false }> {
  const retryAfterSeconds =
    failure.code === 'rate_limited' &&
    Number.isInteger(failure.retryAfterSeconds) &&
    failure.retryAfterSeconds! > 0 &&
    failure.retryAfterSeconds! <= 86_400
      ? failure.retryAfterSeconds
      : undefined;
  switch (failure.code) {
    case 'invalid_credentials':
      return {
        ok: false,
        code: failure.code,
        message: 'X rejected these app credentials. Check all four values.',
        retryable: false,
      };
    case 'revoked':
      return {
        ok: false,
        code: failure.code,
        message: 'X reports that this access token was revoked. Generate a replacement token.',
        retryable: false,
      };
    case 'rate_limited':
      return {
        ok: false,
        code: failure.code,
        message: 'X rate-limited this request. Wait for the limit to reset.',
        retryable: true,
        ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      };
    default:
      return {
        ok: false,
        code: 'provider_unavailable',
        message: 'X could not complete this request right now.',
        retryable: true,
      };
  }
}

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

function validIdentity(identity: XUserIdentity): boolean {
  return (
    /^\d{1,25}$/.test(identity.id) &&
    /^[A-Za-z0-9_]{1,50}$/.test(identity.username) &&
    (identity.name === null || (identity.name.length > 0 && identity.name.length <= 200))
  );
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
    let validation: XConnectorResult<XUserIdentity>;
    try {
      validation = await this.client.validate(credentials);
    } catch {
      return safeFailure({
        ok: false,
        code: 'provider_unavailable',
        message: '',
        retryable: true,
      });
    }
    if (!validation.ok) return safeFailure(validation);
    if (!validIdentity(validation.value)) {
      return {
        ok: false,
        code: 'provider_unavailable',
        message: 'X returned an invalid account identity.',
        retryable: true,
      };
    }
    let returnedHandle: ChannelSecretHandle;
    try {
      returnedHandle = await this.custody.sealScoped({
        accountId: input.accountId,
        agentId: input.agentId,
        channel: 'x',
        label: input.label?.trim() || null,
        plaintext: serializeCredentials(credentials),
      });
    } catch {
      throw new Error('channel credential custody failed');
    }
    const handle = {
      connectionId: returnedHandle.connectionId,
      secretRefId: returnedHandle.secretRefId,
    };
    assertRequestScopedSecretHandle(handle);
    return {
      ok: true,
      value: {
        handle,
        user: {
          id: validation.value.id,
          username: validation.value.username,
          name: validation.value.name,
        },
      },
    };
  }

  async post(
    handle: ChannelSecretHandle,
    text: string,
  ): Promise<XConnectorResult<{ id: string }>> {
    const trimmed = text.trim();
    // X applies URL/CJK/emoji weighted length. The concrete provider adapter
    // is authoritative; this bound only rejects empty/abusive local payloads.
    if (!trimmed || [...trimmed].length > 10_000) {
      throw new Error('X post must contain text within the request-size limit');
    }
    assertRequestScopedSecretHandle(handle);
    let result: XConnectorResult<{ id: string }>;
    try {
      result = await this.custody.withPlaintext(handle, async (plaintext) =>
        this.client.post(parseCredentials(plaintext), trimmed),
      );
    } catch {
      return safeFailure({
        ok: false,
        code: 'provider_unavailable',
        message: '',
        retryable: true,
      });
    }
    if (!result.ok) return safeFailure(result);
    if (!/^\d{1,25}$/.test(result.value.id)) {
      return {
        ok: false,
        code: 'provider_unavailable',
        message: 'X returned an invalid post identity.',
        retryable: true,
      };
    }
    return { ok: true, value: { id: result.value.id } };
  }

  async revoke(handle: ChannelSecretHandle): Promise<void> {
    assertRequestScopedSecretHandle(handle);
    try {
      await this.custody.revoke(handle);
    } catch {
      throw new Error('channel credential revocation failed');
    }
  }
}
