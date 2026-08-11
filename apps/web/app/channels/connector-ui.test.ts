import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import type { ChannelConnectionDto, XConnectionDto } from '@/lib/types';
import {
  DISCORD_BOT_PERMISSIONS,
  CHANNEL_STATUS_POLL_MS,
  TELEGRAM_ONBOARDING_POLL_MS,
  channelClientDeepLink,
  connectionHealthLabel,
  connectionStatusLabel,
  discordInviteUrl,
  discordDestinationSelected,
  toggleDiscordDestination,
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

  it('toggles discovered Discord channels without widening the explicit allowlist', () => {
    const first = { guildId: '111', channelId: '222' };
    const second = { guildId: '111', channelId: '333' };
    expect(toggleDiscordDestination('', first, true)).toBe('111/222');
    expect(toggleDiscordDestination('111/222', second, true)).toBe('111/222, 111/333');
    expect(discordDestinationSelected('111/222, 111/333', second)).toBe(true);
    expect(toggleDiscordDestination('111/222, 111/333', first, false)).toBe('111/333');
    expect(toggleDiscordDestination('not-canonical', first, true)).toBeNull();
  });

  it('wires audited destination discovery into the explicit Discord selection', async () => {
    const source = await readFile(new URL('./channels-client.tsx', import.meta.url), 'utf8');
    const discovery = source.slice(
      source.indexOf('const discoverDiscordDestinations'),
      source.indexOf('const activate ='),
    );
    expect(discovery).toContain('api.channels.destinations(connection.id)');
    expect(discovery).toContain('[connection.id]: result.items');
    const picker = source.slice(
      source.indexOf('Discover Discord channels'),
      source.indexOf('{pairings[connection.id]'),
    );
    expect(picker).toContain('discordDestinationSelected(draft.groups, destination)');
    expect(picker).toContain('toggleDiscordDestination(');
    expect(picker).toContain('destination.guildName');
    expect(picker).toContain('destination.channelName');
  });
  it('builds a fixed-scope Discord invite from a validated snowflake', () => {
    // VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY. Keep this least-privilege
    // value exact so onboarding cannot silently regress to an unusable or overbroad bot.
    expect(DISCORD_BOT_PERMISSIONS).toBe(68_608);
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
    const reconnecting = connection({ observedState: 'stopped', desiredState: 'active', status: 'reconnecting' });
    expect(connectionStatusLabel(reconnecting)).toBe('reconnecting');
    expect(connectionHealthLabel(reconnecting)).toContain('resume automatically');
    const paused = connection({ observedState: 'stopped', desiredState: 'inactive', status: 'paused' });
    expect(connectionStatusLabel(paused)).toBe('stopped');
    expect(connectionHealthLabel(paused)).toBe('Inactive');
    expect(connectionHealthLabel(connection({ observedState: 'stopping', desiredState: 'inactive' }))).toBe(
      'Runtime is stopping',
    );
  });

  it.each(['invalid_credentials', 'revoked', 'rate_limited', 'provider_unavailable'])(
    'gives an action for %s',
    (code) => expect(xFailureAction(code)).not.toBeNull(),
  );
});

describe('channel operation polling', () => {
  it('uses a bounded visibility-aware cadence for runtime and opened pairing state', async () => {
    expect(CHANNEL_STATUS_POLL_MS).toBe(5_000);
    const source = await readFile(new URL('./channels-client.tsx', import.meta.url), 'utf8');
    const block = source.slice(
      source.indexOf('const openedPairingConnectionKey'),
      source.indexOf('const telegramStep'),
    );
    expect(block).toContain('phase !== "ready" || busy !== null');
    expect(block).toContain('document.visibilityState !== "visible"');
    expect(block).toContain('api.channels.list()');
    expect(block).toContain('api.channels.pairing(connectionId)');
    expect(block).toContain('window.setInterval(() => void poll(), CHANNEL_STATUS_POLL_MS)');
    expect(block).toContain('document.removeEventListener("visibilitychange", onVisibilityChange)');
  });

  it('advances Telegram onboarding immediately and only while the cockpit is visible', async () => {
    expect(TELEGRAM_ONBOARDING_POLL_MS).toBe(2_000);
    const source = await readFile(new URL('./channels-client.tsx', import.meta.url), 'utf8');
    const block = source.slice(
      source.indexOf('const telegramStep'),
      source.indexOf('const selectedAgent = useMemo'),
    );
    expect(block).toContain('document.visibilityState !== "visible"');
    expect(block).toContain('void poll();');
    expect(block).toContain('window.setInterval(() => void poll(), TELEGRAM_ONBOARDING_POLL_MS)');
    expect(block).toContain('document.addEventListener("visibilitychange", onVisibilityChange)');
    expect(block).toContain('document.removeEventListener("visibilitychange", onVisibilityChange)');
  });
});
