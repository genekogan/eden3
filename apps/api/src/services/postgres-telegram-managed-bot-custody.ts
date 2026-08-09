import { randomUUID, timingSafeEqual } from 'node:crypto';

import { getEnv } from '@eden3/core';
import { pg } from '@eden3/db';
import {
  capabilityEpochId,
  deriveCapabilityKey,
  hostedChannelSecretRef,
  parseSecretId,
} from '@eden3/gateway';

import type {
  TelegramManagedBotCustodyInput,
  TelegramManagedBotCustodyLike,
  TelegramManagedBotCustodyResult,
} from './telegram-managed-bots';
import { lockAndAssertChannelConnectionQuota } from './channel-connection-quota';
import {
  channelTokenSecretContext,
  defaultSecretVault,
  type SecretVaultLike,
} from './secret-vault';

function capabilityKey(): Buffer {
  const raw = getEnv().CHANNEL_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('CHANNEL_TOKEN_ENCRYPTION_KEY is not configured');
  return deriveCapabilityKey(raw);
}

/**
 * One-shot managed-bot custody adapter. The Telegram connection, audit row,
 * and onboarding-intent terminal binding commit together, so a crash cannot
 * strand an unclaimable token between `exchanging` and `stored`.
 */
export class PostgresTelegramManagedBotCustody implements TelegramManagedBotCustodyLike {
  constructor(
    private readonly intent: { id: string; accountId: string },
    private readonly vault: SecretVaultLike = defaultSecretVault(),
    private readonly capKey: Buffer = capabilityKey(),
    private readonly mintSecretRef: typeof hostedChannelSecretRef = hostedChannelSecretRef,
  ) {}

  async storeManagedBotToken(
    input: TelegramManagedBotCustodyInput,
  ): Promise<TelegramManagedBotCustodyResult> {
    if (input.ownerAccountId !== this.intent.accountId || input.channel !== 'telegram') {
      throw new Error('managed-bot custody scope mismatch');
    }
    const connectionId = randomUUID();
    const runtimeAccountId = `eden-${connectionId}`;
    const encrypted = this.vault.encrypt(
      input.plaintextToken,
      channelTokenSecretContext({
        connectionId,
        accountId: input.ownerAccountId,
        channel: 'telegram',
      }),
    );
    return pg.begin(async (tx) => {
      await lockAndAssertChannelConnectionQuota(tx, {
        accountId: input.ownerAccountId,
        limit: getEnv().MAX_CHANNEL_CONNECTIONS_PER_USER,
        bypassAccountQuota: false,
      });
      for (const lockKey of [
        `channel-credential-token:telegram:${encrypted.tokenSha256}`,
        `channel-credential-bot:telegram:${input.bot.id}`,
      ].sort()) {
        await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      }
      const conflict = await tx<{ id: string }[]>`
        select id from channel_connections
        where channel = 'telegram'
          and (
            token_sha256 = ${encrypted.tokenSha256}
            or metadata -> 'bot' ->> 'id' = ${input.bot.id}
          )
        limit 1
      `;
      if (conflict[0]) throw new Error('managed bot is already connected');

      const inserted = await tx<{ capability_epoch: number }[]>`
        insert into channel_connections (
          id, account_id, agent_id, channel, label, runtime_account_id,
          desired_state, observed_state, status, token_ciphertext, token_iv,
          token_auth_tag, token_sha256, key_version,
          last_validated_at, metadata
        ) values (
          ${connectionId}, ${input.ownerAccountId}, ${input.agentId ?? null}, 'telegram',
          ${input.label?.trim() || input.bot.displayName}, ${runtimeAccountId},
          'inactive', 'verified', 'connected', ${encrypted.tokenCiphertext},
          ${encrypted.tokenIv}, ${encrypted.tokenAuthTag}, ${encrypted.tokenSha256},
          ${encrypted.keyVersion}, now(),
          ${tx.json(JSON.stringify({
            bot: {
              id: input.bot.id,
              username: input.bot.username,
              displayName: input.bot.displayName,
            },
            managed: true,
            config: { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [], telegramGroups: [] },
          }))}
        )
        returning capability_epoch
      `;
      const capabilityEpoch = capabilityEpochId(inserted[0]?.capability_epoch ?? Number.NaN);
      const transitioned = await tx<{ id: string }[]>`
        update channel_onboarding_intents
        set state = 'stored', connection_id = ${connectionId},
            last_error_code = null, updated_at = now()
        where id = ${this.intent.id} and account_id = ${this.intent.accountId}
          and channel = 'telegram' and state = 'exchanging' and expires_at > now()
        returning id
      `;
      if (!transitioned[0]) throw new Error('managed-bot onboarding intent changed');
      await tx`
        insert into secret_access_audit_events (
          actor_account_id, owner_account_id, secret_kind, secret_id, action, metadata
        ) values (
          ${input.ownerAccountId}, ${input.ownerAccountId}, 'channel_token',
          ${connectionId}, 'store',
          ${tx.json(JSON.stringify({
            channel: 'telegram',
            runtimeAccountId,
            managed: true,
            botId: input.bot.id,
          }))}
        )
      `;
      const secretRef = this.mintSecretRef(
        {
          connectionId,
          accountId: input.ownerAccountId,
          channel: 'telegram',
          runtimeAccountId,
          epoch: capabilityEpoch,
        },
        this.capKey,
      );
      const canonicalSecretRef = hostedChannelSecretRef(
        {
          connectionId,
          accountId: input.ownerAccountId,
          channel: 'telegram',
          runtimeAccountId,
          epoch: capabilityEpoch,
        },
        this.capKey,
      );
      const parsed = parseSecretId(secretRef.id);
      const presented = Buffer.from(secretRef.id, 'utf8');
      const expected = Buffer.from(canonicalSecretRef.id, 'utf8');
      if (
        secretRef.source !== 'exec' ||
        secretRef.provider !== 'eden-channel-vault' ||
        parsed.kind !== 'capability' ||
        parsed.connectionId.toLowerCase() !== connectionId.toLowerCase() ||
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected)
      ) {
        throw new Error('managed-bot custody minted an invalid secret scope');
      }
      return {
        connectionId,
        runtimeAccountId,
        secretRef,
        state: 'stored_inactive' as const,
      };
    });
  }
}
