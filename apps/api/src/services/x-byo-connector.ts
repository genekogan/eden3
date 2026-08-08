import { createHmac, randomBytes } from 'node:crypto';

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

type FetchLike = typeof fetch;

function oauthEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function oauthAuthorization(
  method: 'GET' | 'POST',
  url: string,
  credentials: XByoCredentials,
  nonce: string,
  timestamp: number,
): string {
  const parameters: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };
  const normalized = Object.entries(parameters)
    .map(([key, value]) => [oauthEncode(key), oauthEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const signatureBase = [method, oauthEncode(url), oauthEncode(normalized)].join('&');
  const signingKey = `${oauthEncode(credentials.apiSecret)}&${oauthEncode(credentials.accessTokenSecret)}`;
  parameters.oauth_signature = createHmac('sha1', signingKey)
    .update(signatureBase, 'utf8')
    .digest('base64');
  return `OAuth ${Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`)
    .join(', ')}`;
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

/** Production X adapter using the four BYO-app OAuth 1.0a credentials. */
export class FetchXUserClient implements XUserClientLike {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly options: {
      timeoutMs?: number;
      nonce?: () => string;
      nowSeconds?: () => number;
    } = {},
  ) {}

  private async request(
    method: 'GET' | 'POST',
    url: string,
    credentials: XByoCredentials,
    body?: Record<string, unknown>,
  ): Promise<Response | null> {
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          authorization: oauthAuthorization(
            method,
            url,
            credentials,
            this.options.nonce?.() ?? randomBytes(16).toString('hex'),
            this.options.nowSeconds?.() ?? Math.floor(Date.now() / 1_000),
          ),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 7_500),
      });
    } catch {
      return null;
    }
  }

  async validate(credentials: XByoCredentials): Promise<XConnectorResult<XUserIdentity>> {
    const response = await this.request('GET', 'https://api.x.com/2/users/me', credentials);
    if (!response) {
      return { ok: false, code: 'provider_unavailable', message: 'X could not be reached.', retryable: true };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: 'invalid_credentials', message: 'X rejected these app credentials.', retryable: false };
    }
    if (response.status === 429) {
      return {
        ok: false,
        code: 'rate_limited',
        message: 'X rate-limited credential validation. Wait for the limit to reset.',
        retryable: true,
        ...(retryAfterSeconds(response) !== undefined
          ? { retryAfterSeconds: retryAfterSeconds(response) }
          : {}),
      };
    }
    if (!response.ok) {
      return { ok: false, code: 'provider_unavailable', message: 'X could not validate these credentials.', retryable: true };
    }
    try {
      const payload = (await response.json()) as { data?: Record<string, unknown> };
      const data = payload.data;
      if (!data || typeof data.id !== 'string' || typeof data.username !== 'string') throw new Error();
      return {
        ok: true,
        value: {
          id: data.id,
          username: data.username,
          name: typeof data.name === 'string' ? data.name : null,
        },
      };
    } catch {
      return { ok: false, code: 'provider_unavailable', message: 'X returned an incomplete account identity.', retryable: true };
    }
  }

  async post(
    credentials: XByoCredentials,
    text: string,
  ): Promise<XConnectorResult<{ id: string }>> {
    const response = await this.request('POST', 'https://api.x.com/2/tweets', credentials, { text });
    if (!response) {
      return { ok: false, code: 'provider_unavailable', message: 'X could not be reached.', retryable: true };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: 'revoked', message: 'X rejected the saved access token. Replace or revoke it.', retryable: false };
    }
    if (response.status === 429) {
      return {
        ok: false,
        code: 'rate_limited',
        message: 'X rate-limited this account. Wait for the limit to reset.',
        retryable: true,
        ...(retryAfterSeconds(response) !== undefined
          ? { retryAfterSeconds: retryAfterSeconds(response) }
          : {}),
      };
    }
    if (response.status !== 201) {
      return { ok: false, code: 'provider_unavailable', message: 'X could not publish this post.', retryable: true };
    }
    try {
      const payload = (await response.json()) as { data?: Record<string, unknown> };
      const id = payload.data?.id;
      if (typeof id !== 'string' || !/^\d{1,25}$/.test(id)) throw new Error();
      return { ok: true, value: { id } };
    } catch {
      return { ok: false, code: 'provider_unavailable', message: 'X returned an incomplete post result.', retryable: true };
    }
  }
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
    const validation = await this.client.validate(credentials);
    if (!validation.ok) return safeFailure(validation);
    if (!validIdentity(validation.value)) {
      return {
        ok: false,
        code: 'provider_unavailable',
        message: 'X returned an invalid account identity.',
        retryable: true,
      };
    }
    const returnedHandle = await this.custody.sealScoped({
      accountId: input.accountId,
      agentId: input.agentId,
      channel: 'x',
      label: input.label?.trim() || null,
      plaintext: serializeCredentials(credentials),
    });
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
    const result = await this.custody.withPlaintext(handle, async (plaintext) =>
      this.client.post(parseCredentials(plaintext), trimmed),
    );
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
    await this.custody.revoke(handle);
  }
}
