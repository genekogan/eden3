import { pg, secretAccessAuditEvents, db } from '@eden3/db';

import {
  channelTokenSecretContext,
  defaultSecretVault,
  type SecretVaultLike,
} from './secret-vault';

export const CHANNEL_SECRET_PROTOCOL_VERSION = 1 as const;
export const CHANNEL_SECRET_PROVIDER = 'eden-channel-vault' as const;
export const MAX_CHANNEL_SECRET_IDS = 128;
export const MAX_CHANNEL_SECRET_REQUEST_BYTES = 262_144;

const SECRET_ID = /^channel\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export interface ChannelSecretRequest {
  protocolVersion: typeof CHANNEL_SECRET_PROTOCOL_VERSION;
  provider: typeof CHANNEL_SECRET_PROVIDER;
  ids: string[];
}

export interface ChannelSecretResponse {
  protocolVersion: typeof CHANNEL_SECRET_PROTOCOL_VERSION;
  values: Record<string, string>;
  errors?: Record<string, string>;
}

export interface ResolvableChannelSecret {
  id: string;
  accountId: string;
  channel: string;
  runtimeAccountId: string | null;
  tokenCiphertext: string;
  tokenIv: string;
  tokenAuthTag: string;
  keyVersion: string;
}

export interface ChannelSecretStoreLike {
  getActive(connectionId: string): Promise<ResolvableChannelSecret | null>;
  auditRuntimeRead(secret: ResolvableChannelSecret): Promise<void>;
}

interface ChannelSecretDbRow {
  id: string;
  account_id: string;
  channel: string;
  runtime_account_id: string | null;
  token_ciphertext: string;
  token_iv: string;
  token_auth_tag: string;
  key_version: string;
}

/**
 * API-side store for the private resolver. OpenClaw talks only to the resolver
 * socket and never receives DATABASE_URL or CHANNEL_TOKEN_ENCRYPTION_KEY.
 */
export class PostgresChannelSecretStore implements ChannelSecretStoreLike {
  async getActive(connectionId: string): Promise<ResolvableChannelSecret | null> {
    const rows = await pg<ChannelSecretDbRow[]>`
      select id, account_id, channel, runtime_account_id,
             token_ciphertext, token_iv, token_auth_tag, key_version
      from channel_connections
      where id = ${connectionId}
        and desired_state = 'active'
        and channel in ('discord', 'telegram')
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      channel: row.channel,
      runtimeAccountId: row.runtime_account_id,
      tokenCiphertext: row.token_ciphertext,
      tokenIv: row.token_iv,
      tokenAuthTag: row.token_auth_tag,
      keyVersion: row.key_version,
    };
  }

  async auditRuntimeRead(secret: ResolvableChannelSecret): Promise<void> {
    await db.insert(secretAccessAuditEvents).values({
      actorAccountId: null,
      ownerAccountId: secret.accountId,
      secretKind: 'channel_token',
      secretId: secret.id,
      action: 'runtime_retrieve',
      // Deliberately no token, hash, length, or provider response body.
      metadata: {
        channel: secret.channel,
        runtimeAccountId: secret.runtimeAccountId,
        actor: 'openclaw_secret_resolver',
      },
    });
  }
}

function parseRequest(input: unknown): ChannelSecretRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid resolver request');
  }
  const record = input as Record<string, unknown>;
  if (
    record.protocolVersion !== CHANNEL_SECRET_PROTOCOL_VERSION ||
    record.provider !== CHANNEL_SECRET_PROVIDER ||
    !Array.isArray(record.ids) ||
    record.ids.length < 1 ||
    record.ids.length > MAX_CHANNEL_SECRET_IDS ||
    !record.ids.every((id) => typeof id === 'string' && SECRET_ID.test(id))
  ) {
    throw new Error('invalid resolver request');
  }
  return {
    protocolVersion: CHANNEL_SECRET_PROTOCOL_VERSION,
    provider: CHANNEL_SECRET_PROVIDER,
    ids: [...new Set(record.ids as string[])],
  };
}

export class ChannelSecretResolver {
  constructor(
    private readonly store: ChannelSecretStoreLike = new PostgresChannelSecretStore(),
    private readonly vault: SecretVaultLike = defaultSecretVault(),
  ) {}

  async resolve(input: unknown): Promise<ChannelSecretResponse> {
    const request = parseRequest(input);
    const values: Record<string, string> = {};
    const errors: Record<string, string> = {};

    // A bounded, sequential loop avoids plaintext aggregation outside the
    // protocol response and makes each successful decrypt independently auditable.
    for (const id of request.ids) {
      const connectionId = SECRET_ID.exec(id)![1]!;
      try {
        const secret = await this.store.getActive(connectionId);
        if (!secret) {
          errors[id] = 'secret unavailable';
          continue;
        }
        const plaintext = this.vault.decrypt(
          secret,
          channelTokenSecretContext({
            connectionId: secret.id,
            accountId: secret.accountId,
            channel: secret.channel,
          }),
        );
        await this.store.auditRuntimeRead(secret);
        values[id] = plaintext;
      } catch {
        errors[id] = 'secret unavailable';
      }
    }

    return {
      protocolVersion: CHANNEL_SECRET_PROTOCOL_VERSION,
      values,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    };
  }
}

/** Parse and answer one bounded socket frame. No diagnostic includes input. */
export async function resolveChannelSecretFrame(
  payload: Buffer | string,
  resolver: Pick<ChannelSecretResolver, 'resolve'>,
): Promise<string> {
  const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
  if (size === 0 || size > MAX_CHANNEL_SECRET_REQUEST_BYTES) {
    throw new Error('invalid resolver request');
  }
  let input: unknown;
  try {
    input = JSON.parse(payload.toString());
  } catch {
    throw new Error('invalid resolver request');
  }
  return `${JSON.stringify(await resolver.resolve(input))}\n`;
}
