import { describe, expect, it, vi } from 'vitest';

import { FetchChannelProviderClient } from '../src/services/channel-provider.js';

describe('FetchChannelProviderClient', () => {
  it('validates Discord bots without exposing the token in the result', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: '123', username: 'eden_bot', global_name: 'Eden Bot' }),
        { status: 200 },
      ),
    );
    const client = new FetchChannelProviderClient(fetchImpl as typeof fetch);

    await expect(client.validate('discord', 'discord-secret')).resolves.toEqual({
      ok: true,
      bot: { id: '123', username: 'eden_bot', displayName: 'Eden Bot' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://discord.com/api/v10/users/@me',
      expect.objectContaining({ headers: { authorization: 'Bot discord-secret' } }),
    );
  });

  it('rejects malformed Telegram tokens before making a request', async () => {
    const fetchImpl = vi.fn();
    const client = new FetchChannelProviderClient(fetchImpl as typeof fetch);

    await expect(client.validate('telegram', 'not-a-token')).resolves.toEqual({
      ok: false,
      code: 'invalid_token',
      message: 'The Telegram bot token format is invalid.',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates Telegram bot identity and returns only non-secret metadata', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { id: 456, username: 'eden_bot', first_name: 'Eden', last_name: 'Three' },
        }),
        { status: 200 },
      ),
    );
    const client = new FetchChannelProviderClient(fetchImpl as typeof fetch);

    const result = await client.validate(
      'telegram',
      '123456789:abcdefghijklmnopqrstuvwxyzABCDE',
    );

    expect(result).toEqual({
      ok: true,
      bot: { id: '456', username: 'eden_bot', displayName: 'Eden Three' },
    });
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnopqrstuvwxyzABCDE');
  });

  it.each([
    [401, 'invalid_token', false],
    [429, 'provider_rate_limited', true],
    [503, 'provider_unavailable', true],
  ] as const)('maps HTTP %s to a safe validation state', async (status, code, retryable) => {
    const token = 'must-not-leak';
    const fetchImpl = vi.fn(async () => new Response(null, { status }));
    const client = new FetchChannelProviderClient(fetchImpl as typeof fetch);

    const result = await client.validate('discord', token);

    expect(result).toMatchObject({ ok: false, code, retryable });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('discovers only Discord text destinations', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/users/@me/guilds')) {
        return new Response(JSON.stringify([{ id: 'guild-1', name: 'Eden' }]), { status: 200 });
      }
      return new Response(
        JSON.stringify([
          { id: 'text-1', name: 'general', type: 0 },
          { id: 'voice-1', name: 'voice', type: 2 },
          { id: 'forum-1', name: 'ideas', type: 15 },
        ]),
        { status: 200 },
      );
    });
    const client = new FetchChannelProviderClient(fetchImpl as typeof fetch);

    await expect(client.discoverDestinations('discord', 'secret')).resolves.toEqual([
      { guildId: 'guild-1', guildName: 'Eden', channelId: 'text-1', channelName: 'general' },
      { guildId: 'guild-1', guildName: 'Eden', channelId: 'forum-1', channelName: 'ideas' },
    ]);
  });

  it('does not invent Telegram destinations before updates arrive', async () => {
    const fetchImpl = vi.fn();
    const client = new FetchChannelProviderClient(fetchImpl as typeof fetch);

    await expect(client.discoverDestinations('telegram', 'token')).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
