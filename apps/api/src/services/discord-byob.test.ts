import { describe, expect, it, vi } from 'vitest';

import type {
  ChannelCredentialCustodyLike,
  ChannelSecretHandle,
} from './channel-connector-custody';
import { assertRequestScopedSecretHandle } from './channel-connector-custody';
import {
  DISCORD_BOT_PERMISSIONS,
  DiscordByobService,
  FetchDiscordCurrentUserClient,
  discordOauthInviteUrl,
} from './discord-byob';

const HANDLE: ChannelSecretHandle = {
  connectionId: '10000000-0000-4000-8000-000000000001',
  secretRefId:
    'channel/10000000-0000-4000-8000-000000000001.c1.ABCDEFGHIJKLMNOPQRSTUV',
};

function custody(): ChannelCredentialCustodyLike {
  return {
    sealScoped: vi.fn(async () => HANDLE),
    withPlaintext: vi.fn(),
    revoke: vi.fn(),
  };
}

describe('discordOauthInviteUrl', () => {
  it('uses the validated bot id and the fixed minimal permission set', () => {
    const url = new URL(discordOauthInviteUrl('123456789'));
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('123456789');
    expect(url.searchParams.get('permissions')).toBe(String(DISCORD_BOT_PERMISSIONS));
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    expect([...url.searchParams.keys()].sort()).toEqual([
      'client_id',
      'permissions',
      'scope',
    ]);
  });

  it('rejects non-snowflake application ids', () => {
    expect(() => discordOauthInviteUrl('123&permissions=8')).toThrow(
      'invalid Discord application id',
    );
  });
});

describe('assertRequestScopedSecretHandle', () => {
  it('parses and compares the exact connection UUID', () => {
    expect(() =>
      assertRequestScopedSecretHandle({
        connectionId: `${HANDLE.connectionId}.c1`,
        secretRefId: HANDLE.secretRefId,
      }),
    ).toThrow('invalid connection id');
    expect(() =>
      assertRequestScopedSecretHandle({
        connectionId: '30000000-0000-4000-8000-000000000003',
        secretRefId: HANDLE.secretRefId,
      }),
    ).toThrow('cross-connection');
  });
});

describe('FetchDiscordCurrentUserClient', () => {
  it('uses exactly GET /users/@me with Bot authorization', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ id: '123456789', username: 'edenbot', global_name: 'Eden' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await new FetchDiscordCurrentUserClient(fetchImpl).getCurrentBot(
      'synthetic-token',
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://discord.com/api/v10/users/@me');
    expect(init).toMatchObject({
      method: 'GET',
      headers: { authorization: 'Bot synthetic-token' },
      redirect: 'error',
    });
    expect(result).toMatchObject({ ok: true, bot: { username: 'edenbot' } });
  });

  it.each([
    [401, 'invalid_token', false],
    [429, 'rate_limited', true],
    [503, 'provider_unavailable', true],
  ] as const)('maps HTTP %s to %s', async (status, code, retryable) => {
    const result = await new FetchDiscordCurrentUserClient(
      vi.fn(async () => new Response(null, { status })),
    ).getCurrentBot('synthetic-token');
    expect(result).toMatchObject({ ok: false, code, retryable });
  });
});

describe('DiscordByobService', () => {
  it('validates before sealing and returns no token material', async () => {
    const order: string[] = [];
    const vault = custody();
    vi.mocked(vault.sealScoped).mockImplementation(async () => {
      order.push('seal');
      return HANDLE;
    });
    const service = new DiscordByobService(
      {
        getCurrentBot: vi.fn(async () => {
          order.push('validate');
          return {
            ok: true,
            bot: { id: '123456789', username: 'edenbot', displayName: 'Eden bot' },
          } as const;
        }),
      },
      vault,
    );

    const result = await service.connect({
      accountId: 'account-1',
      agentId: 'agent-1',
      token: '  synthetic.discord.token  ',
    });

    expect(order).toEqual(['validate', 'seal']);
    expect(vault.sealScoped).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'discord', plaintext: 'synthetic.discord.token' }),
    );
    expect(JSON.stringify(result)).not.toContain('synthetic.discord.token');
    expect(result).toMatchObject({
      ok: true,
      value: { handle: HANDLE, bot: { username: 'edenbot' } },
    });
  });

  it('does not persist a rejected token', async () => {
    const vault = custody();
    const service = new DiscordByobService(
      {
        getCurrentBot: vi.fn(async () => ({
          ok: false,
          code: 'invalid_token',
          message: 'Discord rejected this bot token.',
          retryable: false,
        }) as const),
      },
      vault,
    );
    await expect(
      service.connect({ accountId: 'account-1', agentId: null, token: 'synthetic-invalid' }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_token' });
    expect(vault.sealScoped).not.toHaveBeenCalled();
  });

  it('allowlists adapter failures so an echoed token cannot escape', async () => {
    const vault = custody();
    const service = new DiscordByobService(
      {
        getCurrentBot: vi.fn(async () => ({
          ok: false,
          code: 'invalid_token',
          message: 'synthetic-secret-token',
          retryable: true,
          token: 'synthetic-secret-token',
        }) as never),
      },
      vault,
    );
    const result = await service.connect({
      accountId: 'account-1',
      agentId: null,
      token: 'synthetic-secret-token',
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-token');
  });

  it('maps rejected provider promises to service-owned safe failures', async () => {
    const service = new DiscordByobService(
      {
        getCurrentBot: vi.fn(async () => {
          throw new Error('synthetic-secret-token');
        }),
      },
      custody(),
    );
    const result = await service.connect({
      accountId: 'account-1',
      agentId: null,
      token: 'synthetic-secret-token',
    });
    expect(result).toMatchObject({ ok: false, code: 'provider_unavailable' });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-token');
  });

  it('replaces rejected custody messages with a service-owned error', async () => {
    const vault = custody();
    vi.mocked(vault.sealScoped).mockRejectedValue(new Error('synthetic-secret-token'));
    const service = new DiscordByobService(
      {
        getCurrentBot: vi.fn(async () => ({
          ok: true,
          bot: { id: '123456789', username: 'edenbot', displayName: null },
        }) as const),
      },
      vault,
    );
    await expect(
      service.connect({ accountId: 'account-1', agentId: null, token: 'synthetic-secret-token' }),
    ).rejects.toThrow('channel credential custody failed');
  });

  it('fails closed when custody returns a legacy unscoped reference', async () => {
    const vault = custody();
    vi.mocked(vault.sealScoped).mockResolvedValue({
      connectionId: HANDLE.connectionId,
      secretRefId: `channel/${HANDLE.connectionId}`,
    });
    const service = new DiscordByobService(
      {
        getCurrentBot: vi.fn(async () => ({
          ok: true,
          bot: { id: '123456789', username: 'edenbot', displayName: null },
        }) as const),
      },
      vault,
    );
    await expect(
      service.connect({ accountId: 'account-1', agentId: null, token: 'synthetic' }),
    ).rejects.toThrow('request-scoped SecretRef');
  });

  it('rejects an invalid provider identity before custody', async () => {
    const vault = custody();
    const service = new DiscordByobService(
      {
        getCurrentBot: vi.fn(async () => ({
          ok: true,
          bot: { id: 'not-a-snowflake', username: 'edenbot', displayName: null },
        }) as const),
      },
      vault,
    );
    await expect(
      service.connect({ accountId: 'account-1', agentId: null, token: 'synthetic' }),
    ).resolves.toMatchObject({ ok: false, code: 'provider_unavailable' });
    expect(vault.sealScoped).not.toHaveBeenCalled();
  });

  it('copies only allowlisted handle and bot fields', async () => {
    const vault = custody();
    vi.mocked(vault.sealScoped).mockResolvedValue({
      ...HANDLE,
      plaintext: 'synthetic-secret-token',
    } as never);
    const result = await new DiscordByobService(
      {
        getCurrentBot: vi.fn(async () => ({
          ok: true,
          bot: {
            id: '123456789',
            username: 'edenbot',
            displayName: null,
            token: 'synthetic-secret-token',
          },
        }) as never),
      },
      vault,
    ).connect({ accountId: 'account-1', agentId: null, token: 'synthetic-secret-token' });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-token');
  });
});
