import { describe, expect, it, vi } from 'vitest';

import type {
  ChannelCredentialCustodyLike,
  ChannelSecretHandle,
} from './channel-connector-custody';
import {
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
});
