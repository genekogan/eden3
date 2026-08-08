import { getEnv } from '@eden3/core';
import { pg, secretAccessAuditEvents, db } from '@eden3/db';
import {
  CAPABILITY_EPOCH_DEFAULT,
  deriveCapabilityKey,
  parseSecretId,
  verifySecretId,
  type VerifyReason,
} from '@eden3/gateway';

import {
  channelTokenSecretContext,
  defaultSecretVault,
  type SecretVaultLike,
} from './secret-vault';

export const CHANNEL_SECRET_PROTOCOL_VERSION = 1 as const;
export const CHANNEL_SECRET_PROVIDER = 'eden-channel-vault' as const;
export const MAX_CHANNEL_SECRET_IDS = 128;
export const MAX_CHANNEL_SECRET_REQUEST_BYTES = 262_144;

/**
 * NOTE: this is the reference/consistency implementation. The DEPLOYED resolver
 * is the `infra/channel-secret-resolver` sidecar (server.mjs). Capability
 * primitives here are imported from `@eden3/gateway` (single crypto source);
 * the sidecar mirrors them and the agreement test asserts they never drift.
 */

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
  capabilityEpoch: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenAuthTag: string;
  keyVersion: string;
}

export type ChannelSecretAuditRecord =
  | { decision: 'granted'; reason: VerifyReason; connectionId: string; secret: ResolvableChannelSecret }
  | { decision: 'denied'; deniedCount: number; deniedReasons: Record<string, number> };

export interface ChannelSecretStoreLike {
  getActive(connectionId: string): Promise<ResolvableChannelSecret | null>;
  audit(record: ChannelSecretAuditRecord): Promise<void>;
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
        and channel in ('discord', 'telegram', 'x')
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      channel: row.channel,
      runtimeAccountId: row.runtime_account_id,
      // Constant epoch in T12-U01 (rotation column is T12-U02); never from
      // mutable metadata (a wholesale rewrite could resurrect old capabilities).
      capabilityEpoch: CAPABILITY_EPOCH_DEFAULT,
      tokenCiphertext: row.token_ciphertext,
      tokenIv: row.token_iv,
      tokenAuthTag: row.token_auth_tag,
      keyVersion: row.key_version,
    };
  }

  async audit(record: ChannelSecretAuditRecord): Promise<void> {
    if (record.decision === 'granted') {
      await db.insert(secretAccessAuditEvents).values({
        actorAccountId: null,
        ownerAccountId: record.secret.accountId,
        secretKind: 'channel_token',
        secretId: record.connectionId,
        action: 'runtime_retrieve',
        // Deliberately no token, hash, length, key, or capability secret.
        metadata: {
          decision: 'granted',
          reason: record.reason,
          channel: record.secret.channel,
          runtimeAccountId: record.secret.runtimeAccountId,
          actor: 'openclaw_secret_resolver',
        },
      });
      return;
    }
    // Aggregated denial (one row per request) — bounds enumeration write
    // amplification and leaks no per-id existence oracle into the audit stream.
    await db.insert(secretAccessAuditEvents).values({
      actorAccountId: null,
      ownerAccountId: null,
      secretKind: 'channel_token',
      secretId: '00000000-0000-0000-0000-000000000000',
      action: 'runtime_retrieve_denied',
      metadata: {
        decision: 'denied',
        reason: 'request_denied',
        deniedCount: record.deniedCount,
        deniedReasons: record.deniedReasons,
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
    !record.ids.every((id) => typeof id === 'string' && parseSecretId(id).kind !== 'malformed')
  ) {
    throw new Error('invalid resolver request');
  }
  return {
    protocolVersion: CHANNEL_SECRET_PROTOCOL_VERSION,
    provider: CHANNEL_SECRET_PROVIDER,
    ids: [...new Set(record.ids as string[])],
  };
}

function defaultCapabilityKey(): Buffer {
  const key = getEnv().CHANNEL_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error('CHANNEL_TOKEN_ENCRYPTION_KEY is not configured');
  return deriveCapabilityKey(key);
}

export class ChannelSecretResolver {
  private readonly capKey: Buffer;
  private readonly allowLegacyUnscoped: boolean;

  constructor(
    private readonly store: ChannelSecretStoreLike = new PostgresChannelSecretStore(),
    private readonly vault: SecretVaultLike = defaultSecretVault(),
    opts: { capKey?: Buffer; allowLegacyUnscoped?: boolean } = {},
  ) {
    this.capKey = opts.capKey ?? defaultCapabilityKey();
    this.allowLegacyUnscoped =
      opts.allowLegacyUnscoped ?? process.env.CHANNEL_SECRET_ALLOW_LEGACY_UNSCOPED === '1';
  }

  async resolve(input: unknown): Promise<ChannelSecretResponse> {
    const request = parseRequest(input);
    const values: Record<string, string> = {};
    const errors: Record<string, string> = {};
    const deniedReasons: Record<string, number> = {};
    let deniedCount = 0;
    const deny = (id: string, reason: string) => {
      errors[id] = 'secret unavailable';
      deniedReasons[reason] = (deniedReasons[reason] ?? 0) + 1;
      deniedCount += 1;
    };

    // A bounded, sequential loop avoids plaintext aggregation outside the
    // protocol response. Grants audit per connection; denials aggregate.
    for (const id of request.ids) {
      const parsed = parseSecretId(id);
      if (parsed.kind === 'malformed') continue; // unreachable after parseRequest
      const secret = await this.store.getActive(parsed.connectionId);
      if (!secret) {
        deny(id, 'connection_inactive');
        continue;
      }
      const verdict = verifySecretId({
        id,
        capKey: this.capKey,
        row: {
          connectionId: secret.id,
          accountId: secret.accountId,
          channel: secret.channel,
          runtimeAccountId: secret.runtimeAccountId,
          epoch: secret.capabilityEpoch,
        },
        allowLegacyUnscoped: this.allowLegacyUnscoped,
      });
      if (!verdict.ok) {
        deny(id, verdict.reason);
        continue;
      }
      try {
        const plaintext = this.vault.decrypt(
          secret,
          channelTokenSecretContext({
            connectionId: secret.id,
            accountId: secret.accountId,
            channel: secret.channel,
          }),
        );
        await this.store.audit({
          decision: 'granted',
          reason: verdict.reason,
          connectionId: secret.id,
          secret,
        });
        values[id] = plaintext;
      } catch {
        deny(id, 'decrypt_or_audit_failed');
      }
    }

    if (deniedCount > 0) {
      try {
        await this.store.audit({ decision: 'denied', deniedCount, deniedReasons });
      } catch {
        /* aggregate denial audit is best-effort; ids are denied regardless */
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
