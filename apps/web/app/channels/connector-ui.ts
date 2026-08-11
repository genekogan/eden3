import type { ChannelConnectionDto, XConnectionDto } from '@/lib/types';

export const DISCORD_DEVELOPER_PORTAL = 'https://discord.com/developers/applications';
export const X_DEVELOPER_PORTAL = 'https://developer.x.com/en/portal/dashboard';
// Discord VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY. This is the
// smallest guild permission set needed for Eden's allowlisted receive/reply
// journey; channel overwrites can still narrow it further.
export const DISCORD_BOT_PERMISSIONS = 68_608;
export const CHANNEL_STATUS_POLL_MS = 5_000;

export function parseDiscordGroupCoordinates(
  value: string,
): Array<{ guildId: string; channelIds: string[] }> | null {
  const pairs = [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
  if (pairs.length > 100) return null;
  const grouped = new Map<string, string[]>();
  for (const pair of pairs) {
    const match = /^(\d{3,25})\/(\d{3,25})$/.exec(pair);
    if (!match) return null;
    const channels = grouped.get(match[1]!) ?? [];
    if (!channels.includes(match[2]!)) channels.push(match[2]!);
    grouped.set(match[1]!, channels);
  }
  return [...grouped].map(([guildId, channelIds]) => ({ guildId, channelIds }));
}

export function parseTelegramGroupCoordinates(value: string): Array<{ groupId: string }> | null {
  const ids = [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
  return ids.length <= 100 && ids.every((id) => /^-\d{3,25}$/.test(id))
    ? ids.map((groupId) => ({ groupId }))
    : null;
}

export type TelegramManagedStep =
  | 'bind_owner'
  | 'choose_bot'
  | 'attach'
  | 'complete'
  | 'terminal';

export function telegramManagedStep(state: string): TelegramManagedStep {
  switch (state) {
    case 'awaiting_bot':
      return 'choose_bot';
    case 'stored':
      return 'attach';
    case 'attached':
      return 'complete';
    case 'cancelled':
    case 'expired':
    case 'failed':
      return 'terminal';
    default:
      return 'bind_owner';
  }
}

/** Reject unexpected schemes/hosts before rendering provider-owned links. */
export function trustedTelegramUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 't.me' || url.hostname === 'telegram.me')
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function discordInviteUrl(clientId: string): string | null {
  if (!/^\d{3,25}$/.test(clientId)) return null;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('permissions', String(DISCORD_BOT_PERMISSIONS));
  url.searchParams.set('scope', 'bot applications.commands');
  return url.toString();
}

export function channelClientDeepLink(connection: ChannelConnectionDto): string | null {
  if (connection.channel === 'telegram' && connection.bot?.username) {
    return `https://t.me/${encodeURIComponent(connection.bot.username.replace(/^@/, ''))}`;
  }
  if (connection.channel === 'discord' && connection.bot?.id && /^\d{3,25}$/.test(connection.bot.id)) {
    return `https://discord.com/users/${connection.bot.id}`;
  }
  return null;
}

export function xClientDeepLink(connection: XConnectionDto): string | null {
  const username = connection.user?.username.replace(/^@/, '');
  return username ? `https://x.com/${encodeURIComponent(username)}` : null;
}

export function connectionHealthLabel(
  connection: Pick<ChannelConnectionDto, 'observedState' | 'lastError' | 'desiredState' | 'status'>,
): string {
  if (connection.lastError) return `Needs attention: ${connection.lastError.message}`;
  if (
    connection.desiredState === 'active'
    && (connection.status === 'reconnecting' || connection.observedState === 'stopped')
  ) {
    return 'Reconnecting — messages will resume automatically';
  }
  switch (connection.observedState) {
    case 'live':
      return 'Healthy — receiving messages';
    case 'verified':
      return 'Verified — ready to activate';
    case 'validating':
      return 'Checking provider credentials';
    case 'starting':
      return 'Runtime is starting';
    case 'stopping':
      return 'Runtime is stopping';
    case 'stopped':
      return 'Inactive';
    case 'error':
      return 'Needs attention';
    default:
      return 'Status not reported yet';
  }
}

export function connectionStatusLabel(
  connection: Pick<ChannelConnectionDto, 'observedState' | 'desiredState' | 'status'>,
): string {
  return connection.desiredState === 'active'
    && (connection.status === 'reconnecting' || connection.observedState === 'stopped')
    ? 'reconnecting'
    : connection.observedState;
}

export function xFailureAction(code: string | null): string | null {
  switch (code) {
    case 'invalid_credentials':
      return 'Check all four values against the Keys and tokens tab, then try again.';
    case 'revoked':
      return 'Generate a new access token in X, then replace the revoked credentials.';
    case 'rate_limited':
      return 'Wait for the provider limit to reset before retrying.';
    case 'provider_unavailable':
      return 'X could not be reached. Your saved connection is unchanged; retry shortly.';
    default:
      return null;
  }
}
