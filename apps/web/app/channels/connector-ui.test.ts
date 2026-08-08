import { describe, expect, it } from 'vitest';

import type { ChannelConnectionDto, XConnectionDto } from '@/lib/types';
import {
  DISCORD_BOT_PERMISSIONS,
  channelClientDeepLink,
  connectionHealthLabel,
  discordInviteUrl,
  parseDiscordGroupCoordinates,
  parseTelegramGroupCoordinates,
  telegramManagedStep,
  trustedTelegramUrl,
  xClientDeepLink,
  xFailureAction,
} from './connector-ui';

function connection(overrides: Partial<ChannelConnectionDto> = {}): ChannelConnectionDto {
  return {
    id: 'connection-1',
    accountId: 'account-1',
    agentId: 'agent-1',
    channel: 'discord',
    label: null,
    runtimeAccountId: 'runtime-1',
    status: 'connected',
    desiredState: 'active',
    observedState: 'live',
    lastError: null,
    lastValidatedAt: '2026-08-08T00:00:00.000Z',
    retryCount: 0,
    nextRetryAt: null,
    activatedAt: '2026-08-08T00:00:00.000Z',
    bot: { id: '123456789', username: 'eden_bot', displayName: 'Eden' },
    config: {
      dmPolicy: 'pairing',
      allowFrom: [],
      deliveryScope: 'direct_messages_only',
      discordGuilds: [],
      telegramGroups: [],
    },
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('connector links', () => {
  it('parses only canonical allowlisted provider group coordinates', () => {
    expect(parseDiscordGroupCoordinates('111/222, 111/333, 444/555')).toEqual([
      { guildId: '111', channelIds: ['222', '333'] },
      { guildId: '444', channelIds: ['555'] },
    ]);
    expect(parseDiscordGroupCoordinates('111')).toBeNull();
    expect(parseTelegramGroupCoordinates('-100123, -100456')).toEqual([
      { groupId: '-100123' },
      { groupId: '-100456' },
    ]);
    expect(parseTelegramGroupCoordinates('100123')).toBeNull();
  });
  it('builds a fixed-scope Discord invite from a validated snowflake', () => {
    const url = new URL(discordInviteUrl('123456789')!);
    expect(url.searchParams.get('client_id')).toBe('123456789');
    expect(url.searchParams.get('permissions')).toBe(String(DISCORD_BOT_PERMISSIONS));
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    expect(discordInviteUrl('not-an-id')).toBeNull();
  });

  it('uses provider-owned HTTPS deep links', () => {
    expect(channelClientDeepLink(connection())).toBe('https://discord.com/users/123456789');
    expect(
      channelClientDeepLink(
        connection({ channel: 'telegram', bot: { id: '4', username: '@eden bot', displayName: null } }),
      ),
    ).toBe('https://t.me/eden%20bot');
    expect(
      xClientDeepLink({ user: { id: '1', username: '@eden', name: null } } as XConnectionDto),
    ).toBe('https://x.com/eden');
  });

  it('accepts only provider-owned Telegram onboarding links', () => {
    expect(trustedTelegramUrl('https://t.me/eden_managed_bot?start=abc')).toBe(
      'https://t.me/eden_managed_bot?start=abc',
    );
    expect(trustedTelegramUrl('javascript:alert(1)')).toBeNull();
    expect(trustedTelegramUrl('https://example.com/not-telegram')).toBeNull();
  });
});

describe('Telegram Managed Bots state', () => {
  it('maps the frozen onboarding milestones to UI steps', () => {
    expect(telegramManagedStep('pending_owner')).toBe('bind_owner');
    expect(telegramManagedStep('awaiting_bot')).toBe('choose_bot');
    expect(telegramManagedStep('stored')).toBe('attach');
    expect(telegramManagedStep('attached')).toBe('complete');
    expect(telegramManagedStep('cancelled')).toBe('terminal');
    expect(telegramManagedStep('expired')).toBe('terminal');
    expect(telegramManagedStep('failed')).toBe('terminal');
  });
});

describe('connector health copy', () => {
  it('prioritizes the actionable provider error', () => {
    expect(
      connectionHealthLabel(
        connection({ lastError: { code: 'invalid_token', message: 'Replace this token.' } }),
      ),
    ).toBe('Needs attention: Replace this token.');
    expect(connectionHealthLabel(connection({ observedState: 'verified' }))).toContain('activate');
  });

  it.each(['invalid_credentials', 'revoked', 'rate_limited', 'provider_unavailable'])(
    'gives an action for %s',
    (code) => expect(xFailureAction(code)).not.toBeNull(),
  );
});
