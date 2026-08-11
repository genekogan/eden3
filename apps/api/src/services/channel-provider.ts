export type SupportedChannelProvider = 'discord' | 'telegram';

export interface ChannelBotIdentity {
  id: string;
  username: string;
  displayName: string | null;
}

export type ChannelTokenValidation =
  | { ok: true; bot: ChannelBotIdentity }
  | {
      ok: false;
      code: 'invalid_token' | 'provider_rate_limited' | 'provider_unavailable';
      message: string;
      retryable: boolean;
    };

export interface ChannelDestination {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
}

export interface ChannelProviderClientLike {
  validate(channel: SupportedChannelProvider, token: string): Promise<ChannelTokenValidation>;
  discoverDestinations(
    channel: SupportedChannelProvider,
    token: string,
  ): Promise<ChannelDestination[]>;
}

type FetchLike = typeof fetch;

interface DiscordUserResponse {
  id?: unknown;
  username?: unknown;
  global_name?: unknown;
}

interface TelegramMeResponse {
  ok?: unknown;
  result?: {
    id?: unknown;
    username?: unknown;
    first_name?: unknown;
    last_name?: unknown;
  };
}

const TELEGRAM_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,200}$/;
const DISCORD_TEXT_CHANNEL_TYPES = new Set([0, 5, 15, 16]);

type ChannelTokenFailure = Extract<ChannelTokenValidation, { ok: false }>;

function providerFailure(status: number): ChannelTokenFailure {
  if (status === 401 || status === 403 || status === 404) {
    return {
      ok: false,
      code: 'invalid_token',
      message: 'The provider rejected this bot token.',
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      code: 'provider_rate_limited',
      message: 'The provider rate-limited token validation. Retry shortly.',
      retryable: true,
    };
  }
  return {
    ok: false,
    code: 'provider_unavailable',
    message: 'The provider could not validate this token right now.',
    retryable: true,
  };
}

function unavailable(): ChannelTokenFailure {
  return {
    ok: false,
    code: 'provider_unavailable',
    message: 'The provider could not validate this token right now.',
    retryable: true,
  };
}

/**
 * Minimal Discord/Telegram credential client.
 *
 * Tokens are used only in the outbound request and are never interpolated
 * into errors. Telegram requires its token in the Bot API path; a strict token
 * grammar prevents URL/path injection before constructing that URL.
 */
export class FetchChannelProviderClient implements ChannelProviderClientLike {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 7_500,
  ) {}

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  async validate(
    channel: SupportedChannelProvider,
    token: string,
  ): Promise<ChannelTokenValidation> {
    try {
      if (channel === 'discord') {
        const response = await this.fetchImpl('https://discord.com/api/v10/users/@me', {
          headers: { authorization: `Bot ${token}` },
          signal: this.signal(),
          redirect: 'error',
        });
        if (!response.ok) return providerFailure(response.status);
        const body = (await response.json()) as DiscordUserResponse;
        if (typeof body.id !== 'string' || typeof body.username !== 'string') return unavailable();
        return {
          ok: true,
          bot: {
            id: body.id,
            username: body.username,
            displayName: typeof body.global_name === 'string' ? body.global_name : null,
          },
        };
      }

      if (!TELEGRAM_TOKEN.test(token)) {
        return {
          ok: false,
          code: 'invalid_token',
          message: 'The Telegram bot token format is invalid.',
          retryable: false,
        };
      }
      const response = await this.fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
        signal: this.signal(),
        redirect: 'error',
      });
      if (!response.ok) return providerFailure(response.status);
      const body = (await response.json()) as TelegramMeResponse;
      const result = body.result;
      if (
        body.ok !== true ||
        !result ||
        (typeof result.id !== 'string' && typeof result.id !== 'number') ||
        typeof result.username !== 'string'
      ) {
        return unavailable();
      }
      const displayName = [result.first_name, result.last_name]
        .filter((part): part is string => typeof part === 'string' && part !== '')
        .join(' ');
      return {
        ok: true,
        bot: {
          id: String(result.id),
          username: result.username,
          displayName: displayName || null,
        },
      };
    } catch {
      return unavailable();
    }
  }

  async discoverDestinations(
    channel: SupportedChannelProvider,
    token: string,
  ): Promise<ChannelDestination[]> {
    // Telegram chats become visible only after updates arrive; there is no
    // credential-scoped equivalent of Discord's guild/channel directory.
    if (channel === 'telegram') return [];

    const guildResponse = await this.fetchImpl('https://discord.com/api/v10/users/@me/guilds', {
      headers: { authorization: `Bot ${token}` },
      signal: this.signal(),
      redirect: 'error',
    });
    if (!guildResponse.ok) throw new Error(providerFailure(guildResponse.status).code);
    const guilds = (await guildResponse.json()) as unknown;
    if (!Array.isArray(guilds)) throw new Error('provider_unavailable');

    const destinations: ChannelDestination[] = [];
    // Sequential calls intentionally bound request concurrency and provider
    // pressure. UI discovery is an operator action, not a hot request path.
    for (const guild of guilds.slice(0, 100)) {
      if (!guild || typeof guild !== 'object') continue;
      const record = guild as Record<string, unknown>;
      if (typeof record.id !== 'string' || typeof record.name !== 'string') continue;
      const response = await this.fetchImpl(
        `https://discord.com/api/v10/guilds/${record.id}/channels`,
        {
          headers: { authorization: `Bot ${token}` },
          signal: this.signal(),
          redirect: 'error',
        },
      );
      if (!response.ok) continue;
      const channels = (await response.json()) as unknown;
      if (!Array.isArray(channels)) continue;
      for (const candidate of channels) {
        if (!candidate || typeof candidate !== 'object') continue;
        const item = candidate as Record<string, unknown>;
        if (
          typeof item.id !== 'string' ||
          typeof item.name !== 'string' ||
          typeof item.type !== 'number' ||
          !DISCORD_TEXT_CHANNEL_TYPES.has(item.type)
        ) {
          continue;
        }
        destinations.push({
          guildId: record.id,
          guildName: record.name,
          channelId: item.id,
          channelName: item.name,
        });
        if (destinations.length >= 500) return destinations;
      }
    }
    return destinations;
  }
}
