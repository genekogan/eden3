import { describe, expect, it, vi } from 'vitest';

import type {
  ChannelCredentialCustodyLike,
  ChannelSecretHandle,
} from './channel-connector-custody';
import {
  FetchXUserClient,
  XByoConnectorService,
  type XByoCredentials,
  type XUserClientLike,
} from './x-byo-connector';

const HANDLE: ChannelSecretHandle = {
  connectionId: '20000000-0000-4000-8000-000000000002',
  secretRefId:
    'channel/20000000-0000-4000-8000-000000000002.c1.ABCDEFGHIJKLMNOPQRSTUV',
};
const CREDENTIALS: XByoCredentials = {
  apiKey: 'synthetic-api-key',
  apiSecret: 'synthetic-api-secret',
  accessToken: 'synthetic-access-token',
  accessTokenSecret: 'synthetic-access-secret',
};

function fixtures(plaintext = JSON.stringify(CREDENTIALS)): {
  custody: ChannelCredentialCustodyLike;
  client: XUserClientLike;
} {
  return {
    custody: {
      sealScoped: vi.fn(async () => HANDLE),
      withPlaintext: vi.fn(async (_handle, operation) => operation(plaintext)),
      revoke: vi.fn(async () => undefined),
    },
    client: {
      validate: vi.fn(async () => ({
        ok: true,
        value: { id: '12345', username: 'eden', name: 'Eden' },
      }) as const),
      post: vi.fn(async () => ({ ok: true, value: { id: '987654321' } }) as const),
    },
  };
}

describe('XByoConnectorService', () => {
  it('validates before channel-token-class custody and returns no raw key', async () => {
    const { custody, client } = fixtures();
    const order: string[] = [];
    vi.mocked(client.validate).mockImplementation(async () => {
      order.push('validate');
      return { ok: true, value: { id: '12345', username: 'eden', name: null } };
    });
    vi.mocked(custody.sealScoped).mockImplementation(async () => {
      order.push('seal');
      return HANDLE;
    });
    const service = new XByoConnectorService(client, custody);

    const result = await service.connect({
      accountId: 'account-1',
      agentId: 'agent-1',
      credentials: CREDENTIALS,
    });

    expect(order).toEqual(['validate', 'seal']);
    expect(custody.sealScoped).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'x', plaintext: JSON.stringify(CREDENTIALS) }),
    );
    for (const secret of Object.values(CREDENTIALS)) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it.each([
    ['invalid_credentials', false],
    ['revoked', false],
    ['rate_limited', true],
    ['provider_unavailable', true],
  ] as const)('preserves actionable %s validation state', async (code, retryable) => {
    const { custody, client } = fixtures();
    vi.mocked(client.validate).mockResolvedValue({
      ok: false,
      code,
      message: `Action required for ${code}`,
      retryable,
      ...(code === 'rate_limited' ? { retryAfterSeconds: 30 } : {}),
    });
    const result = await new XByoConnectorService(client, custody).connect({
      accountId: 'account-1',
      agentId: null,
      credentials: CREDENTIALS,
    });
    expect(result).toMatchObject({ ok: false, code, retryable });
    expect(custody.sealScoped).not.toHaveBeenCalled();
  });

  it('resolves the vaulted payload only inside the posting callback', async () => {
    const { custody, client } = fixtures();
    const result = await new XByoConnectorService(client, custody).post(HANDLE, ' hello ');
    expect(custody.withPlaintext).toHaveBeenCalledWith(HANDLE, expect.any(Function));
    expect(client.post).toHaveBeenCalledWith(CREDENTIALS, 'hello');
    expect(result).toEqual({ ok: true, value: { id: '987654321' } });
  });

  it('rejects empty posts before touching custody', async () => {
    const { custody, client } = fixtures();
    await expect(
      new XByoConnectorService(client, custody).post(HANDLE, '   '),
    ).rejects.toThrow('request-size limit');
    expect(custody.withPlaintext).not.toHaveBeenCalled();
  });

  it('revokes through custody without retrieving plaintext', async () => {
    const { custody, client } = fixtures();
    await new XByoConnectorService(client, custody).revoke(HANDLE);
    expect(custody.revoke).toHaveBeenCalledWith(HANDLE);
    expect(custody.withPlaintext).not.toHaveBeenCalled();
  });

  it('rejects malformed provider identity before custody', async () => {
    const { custody, client } = fixtures();
    vi.mocked(client.validate).mockResolvedValue({
      ok: true,
      value: { id: 'not-an-id', username: 'bad username', name: null },
    });
    const result = await new XByoConnectorService(client, custody).connect({
      accountId: 'account-1',
      agentId: null,
      credentials: CREDENTIALS,
    });
    expect(result).toMatchObject({ ok: false, code: 'provider_unavailable' });
    expect(custody.sealScoped).not.toHaveBeenCalled();
  });

  it('allowlists provider and custody results so extra secret fields cannot escape', async () => {
    const { custody, client } = fixtures();
    vi.mocked(custody.sealScoped).mockResolvedValue({
      ...HANDLE,
      plaintext: 'synthetic-api-secret',
    } as never);
    vi.mocked(client.validate).mockResolvedValue({
      ok: true,
      value: {
        id: '12345',
        username: 'eden',
        name: null,
        apiSecret: 'synthetic-api-secret',
      },
    } as never);
    const result = await new XByoConnectorService(client, custody).connect({
      accountId: 'account-1',
      agentId: null,
      credentials: CREDENTIALS,
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-api-secret');
  });

  it('maps provider failures to service-owned messages', async () => {
    const { custody, client } = fixtures();
    vi.mocked(client.validate).mockResolvedValue({
      ok: false,
      code: 'invalid_credentials',
      message: 'synthetic-api-secret',
      retryable: true,
      credentials: CREDENTIALS,
    } as never);
    const result = await new XByoConnectorService(client, custody).connect({
      accountId: 'account-1',
      agentId: null,
      credentials: CREDENTIALS,
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-api-secret');
  });

  it('maps rejected provider and custody promises to service-owned errors', async () => {
    const providerFailure = fixtures();
    vi.mocked(providerFailure.client.validate).mockRejectedValue(
      new Error('synthetic-api-secret'),
    );
    const validation = await new XByoConnectorService(
      providerFailure.client,
      providerFailure.custody,
    ).connect({ accountId: 'account-1', agentId: null, credentials: CREDENTIALS });
    expect(validation).toMatchObject({ ok: false, code: 'provider_unavailable' });
    expect(JSON.stringify(validation)).not.toContain('synthetic-api-secret');

    const custodyFailure = fixtures();
    vi.mocked(custodyFailure.custody.sealScoped).mockRejectedValue(
      new Error('synthetic-api-secret'),
    );
    await expect(
      new XByoConnectorService(custodyFailure.client, custodyFailure.custody).connect({
        accountId: 'account-1',
        agentId: null,
        credentials: CREDENTIALS,
      }),
    ).rejects.toThrow('channel credential custody failed');
  });

  it('maps rejected posting promises to a service-owned safe failure', async () => {
    const { custody, client } = fixtures();
    vi.mocked(client.post).mockRejectedValue(new Error('synthetic-api-secret'));
    const result = await new XByoConnectorService(client, custody).post(HANDLE, 'hello');
    expect(result).toMatchObject({ ok: false, code: 'provider_unavailable' });
    expect(JSON.stringify(result)).not.toContain('synthetic-api-secret');
  });
});

describe('FetchXUserClient', () => {
  const clientWith = (fetchImpl: typeof fetch) =>
    new FetchXUserClient(fetchImpl, {
      nonce: () => 'fixed-nonce',
      nowSeconds: () => 1_700_000_000,
    });

  it('validates the authenticated X user with an OAuth 1.0a signed GET', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      new Response(
        JSON.stringify({ data: { id: '2244994945', username: 'XDevelopers', name: 'X Dev' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await clientWith(fetchImpl as typeof fetch).validate(CREDENTIALS);
    expect(result).toEqual({
      ok: true,
      value: { id: '2244994945', username: 'XDevelopers', name: 'X Dev' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.x.com/2/users/me',
      expect.objectContaining({ method: 'GET' }),
    );
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.authorization).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(headers.authorization).toContain('oauth_nonce="fixed-nonce"');
    expect(headers.authorization).not.toContain(CREDENTIALS.apiSecret);
    expect(headers.authorization).not.toContain(CREDENTIALS.accessTokenSecret);
  });

  it('publishes text through the signed POST /2/tweets contract', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      new Response(JSON.stringify({ data: { id: '1900000000000000000', text: 'hello' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(clientWith(fetchImpl as typeof fetch).post(CREDENTIALS, 'hello')).resolves.toEqual({
      ok: true,
      value: { id: '1900000000000000000' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.x.com/2/tweets',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'hello' }) }),
    );
  });

  it('returns actionable revoked and rate-limit outcomes without response-body leakage', async () => {
    const revoked = vi.fn(async () => new Response('provider detail must not escape', { status: 401 }));
    await expect(clientWith(revoked as typeof fetch).post(CREDENTIALS, 'hello')).resolves.toMatchObject({
      ok: false,
      code: 'revoked',
      retryable: false,
    });

    const limited = vi.fn(async () =>
      new Response('provider detail must not escape', { status: 429, headers: { 'retry-after': '17' } }),
    );
    await expect(clientWith(limited as typeof fetch).validate(CREDENTIALS)).resolves.toMatchObject({
      ok: false,
      code: 'rate_limited',
      retryable: true,
      retryAfterSeconds: 17,
    });
  });
});
