import { describe, expect, it } from 'vitest';

import type { ChannelConnectionDto, XConnectionDto } from '@/lib/types';
import {
  DISCORD_BOT_PERMISSIONS,
  channelClientDeepLink,
  connectionHealthLabel,
  discordInviteUrl,
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
    },
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('connector links', () => {
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
