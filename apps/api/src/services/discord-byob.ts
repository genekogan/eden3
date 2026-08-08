import {
  assertRequestScopedSecretHandle,
  type ChannelCredentialCustodyLike,
  type ChannelSecretHandle,
} from './channel-connector-custody';

export const DISCORD_PORTAL_URL = 'https://discord.com/developers/applications';
/** Guild permissions stay zero: the retained runtime is direct-message only. */
export const DISCORD_BOT_PERMISSIONS = 0;

export interface DiscordBotIdentity {
  id: string;
  username: string;
  displayName: string | null;
}

export type DiscordTokenValidation =
  | { ok: true; bot: DiscordBotIdentity }
  | {
      ok: false;
      code: 'invalid_token' | 'rate_limited' | 'provider_unavailable';
      message: string;
      retryable: boolean;
    };

export interface DiscordCurrentUserClientLike {
  /** Injected adapter performs exactly GET /users/@me with Bot authorization. */
  getCurrentBot(token: string): Promise<DiscordTokenValidation>;
}

export interface DiscordByobConnection {
  handle: ChannelSecretHandle;
  bot: DiscordBotIdentity;
  oauthInviteUrl: string;
}

export type DiscordConnectResult =
  | { ok: true; value: DiscordByobConnection }
  | Extract<DiscordTokenValidation, { ok: false }>;

function safeFailure(
  code: Extract<DiscordTokenValidation, { ok: false }>['code'],
): Extract<DiscordTokenValidation, { ok: false }> {
  switch (code) {
    case 'invalid_token':
      return {
        ok: false,
        code,
        message: 'Discord rejected this bot token. Copy a bot token, not a user token.',
        retryable: false,
      };
    case 'rate_limited':
      return {
        ok: false,
        code,
        message: 'Discord rate-limited validation. Wait briefly, then retry.',
        retryable: true,
      };
    default:
      return {
        ok: false,
        code: 'provider_unavailable',
        message: 'Discord could not validate this token right now.',
        retryable: true,
      };
  }
}

type FetchLike = typeof fetch;

/** HTTP adapter kept injectable so deterministic tests never call Discord. */
export class FetchDiscordCurrentUserClient implements DiscordCurrentUserClientLike {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs = 7_500,
  ) {}

  async getCurrentBot(token: string): Promise<DiscordTokenValidation> {
    try {
      const response = await this.fetchImpl('https://discord.com/api/v10/users/@me', {
        method: 'GET',
        headers: { authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          code: 'invalid_token',
          message: 'Discord rejected this bot token. Copy a bot token, not a user token.',
          retryable: false,
        };
      }
      if (response.status === 429) {
        return {
          ok: false,
          code: 'rate_limited',
          message: 'Discord rate-limited validation. Wait briefly, then retry.',
          retryable: true,
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          code: 'provider_unavailable',
          message: 'Discord could not validate this token right now.',
          retryable: true,
        };
      }
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body.id !== 'string' || typeof body.username !== 'string') {
        return {
          ok: false,
          code: 'provider_unavailable',
          message: 'Discord returned an incomplete bot identity.',
          retryable: true,
        };
      }
      return {
        ok: true,
        bot: {
          id: body.id,
          username: body.username,
          displayName: typeof body.global_name === 'string' ? body.global_name : null,
        },
      };
    } catch {
      return {
        ok: false,
        code: 'provider_unavailable',
        message: 'Discord could not validate this token right now.',
        retryable: true,
      };
    }
  }
}

export function discordOauthInviteUrl(clientId: string): string {
  if (!/^\d{3,25}$/.test(clientId)) throw new Error('invalid Discord application id');
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('permissions', String(DISCORD_BOT_PERMISSIONS));
  url.searchParams.set('scope', 'bot applications.commands');
  return url.toString();
}

/**
 * Validates before custody and returns only safe identity metadata plus a
 * minimally-permissioned OAuth invite. It never stores, logs, or returns the
 * pasted token.
 */
export class DiscordByobService {
  constructor(
    private readonly client: DiscordCurrentUserClientLike,
    private readonly custody: ChannelCredentialCustodyLike,
  ) {}

  async connect(input: {
    accountId: string;
    agentId: string | null;
    label?: string;
    token: string;
  }): Promise<DiscordConnectResult> {
    const token = input.token.trim();
    if (!token) {
      return {
        ok: false,
        code: 'invalid_token',
        message: 'Paste the bot token from the Discord developer portal.',
        retryable: false,
      };
    }
    const validation = await this.client.getCurrentBot(token);
    if (!validation.ok) return safeFailure(validation.code);
    if (!/^\d{3,25}$/.test(validation.bot.id)) {
      return {
        ok: false,
        code: 'provider_unavailable',
        message: 'Discord returned an invalid bot identity.',
        retryable: true,
      };
    }
    const returnedHandle = await this.custody.sealScoped({
      accountId: input.accountId,
      agentId: input.agentId,
      channel: 'discord',
      label: input.label?.trim() || null,
      plaintext: token,
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
        bot: {
          id: validation.bot.id,
          username: validation.bot.username,
          displayName: validation.bot.displayName,
        },
        oauthInviteUrl: discordOauthInviteUrl(validation.bot.id),
      },
    };
  }
}
