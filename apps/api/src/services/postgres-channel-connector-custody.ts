import { randomUUID, timingSafeEqual } from 'node:crypto';

import { getEnv } from '@eden3/core';
import { pg } from '@eden3/db';
import {
  deriveCapabilityKey,
  hostedChannelSecretRef,
} from '@eden3/gateway';

import {
  assertRequestScopedSecretHandle,
  type ChannelCredentialCustodyLike,
  type ChannelSecretHandle,
} from './channel-connector-custody';
import {
  channelTokenSecretContext,
  defaultSecretVault,
  type SecretVaultLike,
} from './secret-vault';

interface CustodyRow {
  id: string;
  account_id: string;
  channel: string;
  runtime_account_id: string;
  token_ciphertext: string;
  token_iv: string;
  token_auth_tag: string;
  key_version: string;
}

export class ChannelCredentialConflictError extends Error {
  constructor() {
    super('This provider credential is already connected');
    this.name = 'ChannelCredentialConflictError';
  }
}

function capabilityKey(): Buffer {
  const raw = getEnv().CHANNEL_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('CHANNEL_TOKEN_ENCRYPTION_KEY is not configured');
  return deriveCapabilityKey(raw);
}

function handleFor(row: Pick<CustodyRow, 'id' | 'account_id' | 'channel' | 'runtime_account_id'>, capKey: Buffer): ChannelSecretHandle {
  return {
    connectionId: row.id,
    secretRefId: hostedChannelSecretRef(
      {
        connectionId: row.id,
        accountId: row.account_id,
        channel: row.channel,
        runtimeAccountId: row.runtime_account_id,
      },
      capKey,
    ).id,
  };
}

function sameSecretRef(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Postgres implementation of channel-token-class custody for outbound
 * connectors. X is active for resolver access but is never projected into
 * OpenClaw's Discord/Telegram account config.
 */
export class PostgresChannelCredentialCustody implements ChannelCredentialCustodyLike {
  private readonly capKey: Buffer;

  constructor(
    private readonly vault: SecretVaultLike = defaultSecretVault(),
    capKey?: Buffer,
  ) {
    this.capKey = capKey ?? capabilityKey();
  }

  async sealScoped(input: {
    accountId: string;
    agentId: string | null;
    channel: string;
    label: string | null;
    plaintext: string;
  }): Promise<ChannelSecretHandle> {
    if (input.channel !== 'x') throw new Error('unsupported outbound connector custody channel');
    const id = randomUUID();
    const runtimeAccountId = `eden-x-${id}`;
    const encrypted = this.vault.encrypt(
      input.plaintext,
      channelTokenSecretContext({ connectionId: id, accountId: input.accountId, channel: 'x' }),
    );
    return pg.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`channel-credential-token:x:${encrypted.tokenSha256}`}, 0))`;
      const conflict = await tx<{ id: string }[]>`
        select id from channel_connections
        where channel = 'x' and token_sha256 = ${encrypted.tokenSha256}
        limit 1
      `;
      if (conflict[0]) throw new ChannelCredentialConflictError();
      const inserted = await tx<CustodyRow[]>`
        insert into channel_connections (
          id, account_id, agent_id, channel, label, runtime_account_id,
          desired_state, observed_state, status, token_ciphertext, token_iv,
          token_auth_tag, token_sha256, token_preview, key_version,
          last_validated_at, metadata
        ) values (
          ${id}, ${input.accountId}, ${input.agentId}, 'x', ${input.label}, ${runtimeAccountId},
          'active', 'live', 'active', ${encrypted.tokenCiphertext}, ${encrypted.tokenIv},
          ${encrypted.tokenAuthTag}, ${encrypted.tokenSha256}, null, ${encrypted.keyVersion},
          now(), ${tx.json('{}')}
        )
        returning id, account_id, channel, runtime_account_id,
                  token_ciphertext, token_iv, token_auth_tag, key_version
      `;
      const row = inserted[0];
      if (!row) throw new Error('channel credential custody write failed');
      await tx`
        insert into secret_access_audit_events (
          actor_account_id, owner_account_id, secret_kind, secret_id, action, metadata
        ) values (
          ${row.account_id}, ${row.account_id}, 'channel_token', ${row.id}, 'store',
          ${tx.json(JSON.stringify({ channel: row.channel, runtimeAccountId: row.runtime_account_id }))}
        )
      `;
      const handle = handleFor(row, this.capKey);
      // Validation is intentionally inside the transaction: a bad capability
      // mint cannot publish an orphaned encrypted credential row.
      assertRequestScopedSecretHandle(handle);
      return handle;
    });
  }

  async withPlaintext<T>(
    handle: ChannelSecretHandle,
    operation: (plaintext: string) => Promise<T>,
  ): Promise<T> {
    assertRequestScopedSecretHandle(handle);
    return (await pg.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`channel-connector-use:${handle.connectionId}`}, 0))`;
      const rows = await tx<CustodyRow[]>`
        select id, account_id, channel, runtime_account_id,
               token_ciphertext, token_iv, token_auth_tag, key_version
        from channel_connections
        where id = ${handle.connectionId} and channel = 'x' and desired_state = 'active'
        limit 1
      `;
      const row = rows[0];
      if (!row || !sameSecretRef(handleFor(row, this.capKey).secretRefId, handle.secretRefId)) {
        throw new Error('channel credential unavailable');
      }
      await tx`
        insert into secret_access_audit_events (
          actor_account_id, owner_account_id, secret_kind, secret_id, action, metadata
        ) values (
          ${row.account_id}, ${row.account_id}, 'channel_token', ${row.id},
          'connector_retrieve',
          ${tx.json(JSON.stringify({ channel: row.channel, runtimeAccountId: row.runtime_account_id }))}
        )
      `;
      const plaintext = this.vault.decrypt(
        {
          tokenCiphertext: row.token_ciphertext,
          tokenIv: row.token_iv,
          tokenAuthTag: row.token_auth_tag,
          keyVersion: row.key_version,
        },
        channelTokenSecretContext({
          connectionId: row.id,
          accountId: row.account_id,
          channel: row.channel,
        }),
      );
      return operation(plaintext);
    })) as T;
  }

  async revoke(handle: ChannelSecretHandle): Promise<void> {
    assertRequestScopedSecretHandle(handle);
    await pg.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`channel-connector-use:${handle.connectionId}`}, 0))`;
      const candidates = await tx<CustodyRow[]>`
        select id, account_id, channel, runtime_account_id,
               token_ciphertext, token_iv, token_auth_tag, key_version
        from channel_connections
        where id = ${handle.connectionId} and channel = 'x'
        for update
      `;
      const candidate = candidates[0];
      if (
        !candidate ||
        !sameSecretRef(handleFor(candidate, this.capKey).secretRefId, handle.secretRefId)
      ) {
        throw new Error('channel credential unavailable');
      }
      await tx`
        update channel_connections
        set desired_state = 'inactive', observed_state = 'stopped', status = 'revoked',
            updated_at = now()
        where id = ${candidate.id} and channel = 'x'
      `;
      await tx`
        insert into secret_access_audit_events (
          actor_account_id, owner_account_id, secret_kind, secret_id, action, metadata
        ) values (
          ${candidate.account_id}, ${candidate.account_id}, 'channel_token', ${candidate.id},
          'revoke',
          ${tx.json(JSON.stringify({ channel: candidate.channel, runtimeAccountId: candidate.runtime_account_id }))}
        )
      `;
    });
  }
}

export function xChannelSecretHandle(
  row: Pick<CustodyRow, 'id' | 'account_id' | 'channel' | 'runtime_account_id'>,
  capKey = capabilityKey(),
): ChannelSecretHandle {
  if (row.channel !== 'x') throw new Error('not an X connector row');
  return handleFor(row, capKey);
}
