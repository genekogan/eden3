import { createHash, randomUUID } from 'node:crypto';

import { pg } from '@eden3/db';

import { memoryUserRelativePath } from './memory-paths';
import { channelPeerSecretContext, type SecretVaultLike } from './secret-vault';

export type ChannelMessageRole = 'user' | 'assistant';

export interface ChannelMessageEvent {
  connectionId: string;
  runtimeAccountId: string;
  gatewaySessionKey: string;
  /** Provider-native DM/channel/thread id. Falls back to peerId for legacy DMs. */
  conversationId?: string | null;
  /** Trusted provider conversation scope; group memory never resolves to a sender file. */
  conversationScope?: 'direct' | 'group';
  /** Discord guild coordinate. Null/absent for Telegram groups and DMs. */
  guildId?: string | null;
  peerId: string;
  externalMessageId: string;
  role: ChannelMessageRole;
  content: string;
  createdAt: Date;
  sourceSequence?: number | null;
}

export interface ChannelSyncConnection {
  id: string;
  accountId: string;
  agentId: string;
  channel: 'discord' | 'telegram';
  runtimeAccountId: string;
  allowedGroups: ChannelAllowedGroup[];
}

export interface ChannelAllowedGroup {
  conversationId: string;
  guildId: string | null;
  allowFrom: string[];
}

export interface EncryptedChannelPeer {
  fingerprint: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  preview: string | null;
  keyVersion: string;
}

export interface ChannelMessagePersistence {
  connection: ChannelSyncConnection;
  event: Omit<ChannelMessageEvent, 'peerId' | 'conversationId'>;
  /** Ephemeral authorization coordinates; revalidated under the connection row lock. */
  authorization: Pick<
    ChannelMessageEvent,
    'peerId' | 'conversationId' | 'conversationScope' | 'guildId'
  >;
  identity: EncryptedChannelPeer;
  conversationFingerprint: string;
  sessionExternalId: string;
  safeChannelMetadata: Record<string, unknown>;
}

export interface ChannelMemoryContext {
  linkState: 'linked' | 'pseudonymous' | 'group';
  /** Agent-workspace-relative path only; never an absolute host path. */
  relativePath: string;
}

export interface ChannelMessageSyncResult {
  sessionId: string;
  messageId: string;
  inserted: boolean;
  memoryContext: ChannelMemoryContext;
}

export interface ChannelSessionSyncStoreLike {
  getLiveConnection(connectionId: string): Promise<ChannelSyncConnection | null>;
  persistMessage(input: ChannelMessagePersistence): Promise<ChannelMessageSyncResult>;
}

interface ConnectionRow {
  id: string;
  account_id: string;
  agent_id: string | null;
  channel: string;
  runtime_account_id: string | null;
  metadata: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonicalIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((item): item is string => typeof item === 'string' && /^-?\d{3,25}$/.test(item));
  return ids.length === value.length && new Set(ids).size === ids.length ? ids : [];
}

/** Compile only the persisted activation shape; malformed config fails closed. */
export function configuredChannelGroups(channel: 'discord' | 'telegram', metadata: unknown): ChannelAllowedGroup[] {
  const config = record(record(metadata).config);
  if (channel === 'discord') {
    if (config.discordGuilds === undefined) return [];
    if (!Array.isArray(config.discordGuilds)) throw new Error('invalid channel group configuration');
    if (config.discordGuilds.length === 0) return [];
    const allowFrom = canonicalIds(config.allowFrom);
    if (allowFrom.length === 0) throw new Error('invalid channel group configuration');
    const groups: ChannelAllowedGroup[] = [];
    for (const raw of config.discordGuilds) {
      const guild = record(raw);
      if (typeof guild.guildId !== 'string' || !/^\d{3,25}$/.test(guild.guildId)) {
        throw new Error('invalid channel group configuration');
      }
      const channelIds = canonicalIds(guild.channelIds);
      if (!Array.isArray(guild.channelIds) || channelIds.length !== guild.channelIds.length) {
        throw new Error('invalid channel group configuration');
      }
      for (const conversationId of channelIds) {
        if (conversationId.startsWith('-')) throw new Error('invalid channel group configuration');
        groups.push({ conversationId, guildId: guild.guildId, allowFrom: [...allowFrom] });
      }
    }
    return groups;
  }
  if (config.telegramGroups === undefined) return [];
  if (!Array.isArray(config.telegramGroups)) throw new Error('invalid channel group configuration');
  if (config.telegramGroups.length === 0) return [];
  const allowFrom = canonicalIds(config.allowFrom);
  if (allowFrom.length === 0) throw new Error('invalid channel group configuration');
  const groups: ChannelAllowedGroup[] = [];
  for (const raw of config.telegramGroups) {
    const group = record(raw);
    if (typeof group.groupId !== 'string' || !/^-\d{3,25}$/.test(group.groupId)) {
      throw new Error('invalid channel group configuration');
    }
    groups.push({ conversationId: group.groupId, guildId: null, allowFrom: [...allowFrom] });
  }
  return groups;
}

export function assertChannelConversationAuthorized(
  connection: ChannelSyncConnection,
  event: Pick<ChannelMessageEvent, 'conversationId' | 'conversationScope' | 'guildId' | 'peerId'>,
): void {
  const conversationId = event.conversationId ?? event.peerId;
  const configuredConversation = connection.allowedGroups.some(
    (group) => group.conversationId === conversationId,
  );
  if ((event.conversationScope ?? 'direct') === 'direct') {
    if (event.guildId != null || configuredConversation) {
      throw new Error('channel conversation scope is not authorized');
    }
    return;
  }
  const guildId = event.guildId ?? null;
  const allowed = connection.allowedGroups.some(
    (group) =>
      group.conversationId === conversationId &&
      group.guildId === guildId &&
      group.allowFrom.includes(event.peerId),
  );
  if (!allowed) throw new Error('channel conversation scope is not authorized');
}

/** Digest never crosses connection boundaries, even for the same provider id. */
export function channelPeerFingerprint(connectionId: string, peerId: string): string {
  return createHash('sha256')
    .update('eden3-channel-peer\0')
    .update(connectionId)
    .update('\0')
    .update(peerId)
    .digest('hex');
}

/** Digest a conversation independently from the sender speaking within it. */
export function channelConversationFingerprint(
  connectionId: string,
  conversationId: string,
): string {
  return createHash('sha256')
    .update('eden3-channel-conversation\0')
    .update(connectionId)
    .update('\0')
    .update(conversationId)
    .digest('hex');
}

export function pseudonymousChannelMemoryPath(conversationScopedPeerFingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(conversationScopedPeerFingerprint)) {
    throw new TypeError('invalid channel peer fingerprint');
  }
  return `memory/users/channel-peer-${conversationScopedPeerFingerprint}.md`;
}

export function channelGroupMemoryPath(conversationFingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(conversationFingerprint)) {
    throw new TypeError('invalid channel conversation fingerprint');
  }
  return `memory/users/channel-group-${conversationFingerprint}.md`;
}

export function resolveChannelMemoryContext(input: {
  conversationScope?: 'direct' | 'group';
  conversationFingerprint: string;
  peerFingerprint: string;
  linkedAccount: { id: string; username: string } | null;
}): ChannelMemoryContext {
  if (input.conversationScope === 'group') {
    return {
      linkState: 'group',
      relativePath: channelGroupMemoryPath(input.conversationFingerprint),
    };
  }
  return input.linkedAccount
    ? {
        linkState: 'linked',
        relativePath: memoryUserRelativePath(
          input.linkedAccount.username,
          input.linkedAccount.id,
        ),
      }
    : {
        linkState: 'pseudonymous',
        relativePath: pseudonymousChannelMemoryPath(input.peerFingerprint),
      };
}

function sessionExternalId(connectionId: string, fingerprint: string): string {
  return `channel:${connectionId}:${fingerprint}`;
}

export class PostgresChannelSessionSyncStore implements ChannelSessionSyncStoreLike {
  async getLiveConnection(connectionId: string): Promise<ChannelSyncConnection | null> {
    const rows = await pg<ConnectionRow[]>`
      select id, account_id, agent_id, channel, runtime_account_id, metadata
      from channel_connections
      where id = ${connectionId}
        and desired_state = 'active'
        and channel in ('discord', 'telegram')
      limit 1
    `;
    const row = rows[0];
    if (
      !row ||
      !row.agent_id ||
      !row.runtime_account_id ||
      (row.channel !== 'discord' && row.channel !== 'telegram')
    ) {
      return null;
    }
    return {
      id: row.id,
      accountId: row.account_id,
      agentId: row.agent_id,
      channel: row.channel,
      runtimeAccountId: row.runtime_account_id,
      allowedGroups: configuredChannelGroups(row.channel, row.metadata),
    };
  }

  async persistMessage(input: ChannelMessagePersistence): Promise<ChannelMessageSyncResult> {
    return pg.begin(async (tx) => {
      const connectionRows = await tx<ConnectionRow[]>`
        select id, account_id, agent_id, channel, runtime_account_id, metadata
        from channel_connections
        where id = ${input.connection.id} and desired_state = 'active'
          and channel in ('discord', 'telegram')
        for update
      `;
      const row = connectionRows[0];
      if (
        !row ||
        !row.agent_id ||
        !row.runtime_account_id ||
        (row.channel !== 'discord' && row.channel !== 'telegram') ||
        row.account_id !== input.connection.accountId ||
        row.agent_id !== input.connection.agentId ||
        row.channel !== input.connection.channel ||
        row.runtime_account_id !== input.connection.runtimeAccountId
      ) {
        throw new Error('channel connection unavailable');
      }
      const currentConnection: ChannelSyncConnection = {
        id: row.id,
        accountId: row.account_id,
        agentId: row.agent_id,
        channel: row.channel,
        runtimeAccountId: row.runtime_account_id,
        allowedGroups: configuredChannelGroups(row.channel, row.metadata),
      };
      assertChannelConversationAuthorized(currentConnection, input.authorization);

      // A SELECT ... FOR UPDATE cannot lock a row that does not exist. Lock
      // both uniqueness dimensions first so two first messages cannot race to
      // create conflicting sessions (or cross-wire a gateway key).
      for (const lockKey of [
        `channel-conversation:${input.connection.id}:${input.conversationFingerprint}`,
        `channel-gateway-session:${input.event.gatewaySessionKey}`,
      ].sort()) {
        await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      }
      const existingSessions = await tx<
        Array<{
          id: string;
          gateway_session_key: string | null;
          channel_connection_id: string | null;
          channel_peer_fingerprint: string | null;
          channel_conversation_fingerprint: string | null;
        }>
      >`
        select id, gateway_session_key, channel_connection_id,
               channel_peer_fingerprint, channel_conversation_fingerprint
        from sessions
        where gateway_session_key = ${input.event.gatewaySessionKey}
           or (
             channel_connection_id = ${input.connection.id}
             and channel_conversation_fingerprint = ${input.conversationFingerprint}
           )
        for update
      `;
      const session = existingSessions[0];
      const legacyConversationMatch =
        session?.channel_peer_fingerprint === input.identity.fingerprint &&
        session.channel_conversation_fingerprint === input.identity.fingerprint;
      if (
        existingSessions.length > 1 ||
        (session &&
          (session.gateway_session_key !== input.event.gatewaySessionKey ||
            session.channel_connection_id !== input.connection.id ||
            (session.channel_conversation_fingerprint !== input.conversationFingerprint &&
              !legacyConversationMatch)))
      ) {
        throw new Error('channel session isolation violation');
      }
      if (session && legacyConversationMatch) {
        // 0021 backfills the old peer digest so legacy sessions remain
        // discoverable. The first trusted event upgrades it to the provider
        // conversation digest without needing the historical raw peer id.
        await tx`
          update sessions
          set channel_conversation_fingerprint = ${input.conversationFingerprint},
              updated_at = now()
          where id = ${session.id}
            and channel_conversation_fingerprint = ${input.identity.fingerprint}
        `;
      }

      const identityRows = await tx<{ id: string; linked_account_id: string | null }[]>`
        insert into channel_external_identities (
          connection_id, peer_fingerprint, peer_ciphertext, peer_iv,
          peer_auth_tag, peer_preview, key_version
        ) values (
          ${input.connection.id}, ${input.identity.fingerprint}, ${input.identity.ciphertext},
          ${input.identity.iv}, ${input.identity.authTag}, ${input.identity.preview},
          ${input.identity.keyVersion}
        )
        on conflict (connection_id, peer_fingerprint) do update
          set updated_at = now()
        returning id, linked_account_id
      `;
      const identity = identityRows[0]!;
      // Group participation is intentionally pseudonymous at the Eden account
      // boundary. A peer may be linked for direct messages, but a group turn
      // must never grant that private account session membership or authorship.
      const linkedAccounts =
        input.event.conversationScope !== 'group' && identity.linked_account_id
        ? await tx<{ id: string; username: string }[]>`
            select id, username::text as username
            from accounts
            where id = ${identity.linked_account_id} and type = 'user' and deleted = false
            limit 1
          `
        : [];
      const linkedAccount = linkedAccounts[0] ?? null;
      const memoryContext = resolveChannelMemoryContext({
        conversationScope: input.event.conversationScope,
        conversationFingerprint: input.conversationFingerprint,
        peerFingerprint: input.identity.fingerprint,
        linkedAccount,
      });

      let sessionId = session?.id;
      if (!sessionId) {
        sessionId = randomUUID();
        await tx`
          insert into sessions (
            id, external_id, owner_id, title, status, session_type, platform,
            visible, channel, channel_connection_id, channel_conversation_fingerprint,
            gateway_session_key, last_message_at, message_count
          ) values (
            ${sessionId}, ${input.sessionExternalId}, ${input.connection.accountId},
            ${`${input.connection.channel === 'discord' ? 'Discord' : 'Telegram'} ${input.event.conversationScope === 'group' ? 'group' : 'conversation'}`},
            'active', 'channel', ${input.connection.channel}, true,
            ${tx.json(JSON.stringify(input.safeChannelMetadata))}, ${input.connection.id},
            ${input.conversationFingerprint}, ${input.event.gatewaySessionKey}, null, 0
          )
        `;
      }

      await tx`
        insert into session_agents (session_id, agent_account_id)
        values (${sessionId}, ${input.connection.agentId})
        on conflict do nothing
      `;
      await tx`
        insert into session_users (session_id, user_account_id)
        values (${sessionId}, ${input.connection.accountId})
        on conflict do nothing
      `;
      if (linkedAccount) {
        await tx`
          insert into session_users (session_id, user_account_id)
          values (${sessionId}, ${linkedAccount.id})
          on conflict do nothing
        `;
      }

      const senderId =
        input.event.role === 'assistant'
          ? input.connection.agentId
          : linkedAccount?.id ?? null;
      const messageRows = await tx<{ id: string }[]>`
        insert into messages (
          external_id, session_id, sender_id, role, content, eden_message_data,
          source_sequence, created_at
        ) values (
          ${input.event.externalMessageId}, ${sessionId}, ${senderId},
          ${input.event.role}, ${input.event.content},
          ${tx.json(JSON.stringify({
            channelIdentityId: identity.id,
            peerFingerprint: input.identity.fingerprint,
            peerPreview: input.identity.preview,
            memoryContext,
            readOnlyMirror: true,
          }))},
          ${input.event.sourceSequence ?? null}, ${input.event.createdAt.toISOString()}::timestamptz
        )
        on conflict (session_id, external_id) do nothing
        returning id
      `;
      const inserted = messageRows[0];
      let messageId = inserted?.id;
      if (inserted) {
        await tx`
          update sessions
          set message_count = message_count + 1,
              last_message_at = greatest(
                coalesce(last_message_at, '-infinity'::timestamptz),
                ${input.event.createdAt.toISOString()}::timestamptz
              ),
              updated_at = now()
          where id = ${sessionId}
        `;
      } else {
        const existing = await tx<{ id: string }[]>`
          select id from messages
          where session_id = ${sessionId} and external_id = ${input.event.externalMessageId}
          limit 1
        `;
        messageId = existing[0]!.id;
      }
      return {
        sessionId,
        messageId: messageId!,
        inserted: inserted !== undefined,
        memoryContext,
      };
    });
  }
}

export class ChannelSessionSync {
  constructor(
    private readonly store: ChannelSessionSyncStoreLike,
    private readonly vault: SecretVaultLike,
  ) {}

  async syncMessage(event: ChannelMessageEvent): Promise<ChannelMessageSyncResult> {
    const connection = await this.store.getLiveConnection(event.connectionId);
    if (
      !connection ||
      connection.id !== event.connectionId ||
      connection.runtimeAccountId !== event.runtimeAccountId
    ) {
      throw new Error('channel connection unavailable');
    }
    assertChannelConversationAuthorized(connection, event);
    const peerFingerprint = channelPeerFingerprint(connection.id, event.peerId);
    const encrypted = this.vault.encrypt(
      event.peerId,
      channelPeerSecretContext(connection.id, peerFingerprint),
    );
    const conversationFingerprint = channelConversationFingerprint(
      connection.id,
      event.conversationId ?? event.peerId,
    );
    const { peerId: _peerId, conversationId: _conversationId, guildId: _guildId, ...persistedEvent } = event;
    return this.store.persistMessage({
      connection,
      event: persistedEvent,
      authorization: {
        peerId: event.peerId,
        conversationId: event.conversationId,
        conversationScope: event.conversationScope,
        guildId: event.guildId,
      },
      identity: {
        fingerprint: peerFingerprint,
        ciphertext: encrypted.tokenCiphertext,
        iv: encrypted.tokenIv,
        authTag: encrypted.tokenAuthTag,
        preview: encrypted.tokenPreview,
        keyVersion: encrypted.keyVersion,
      },
      conversationFingerprint,
      sessionExternalId: sessionExternalId(connection.id, conversationFingerprint),
      safeChannelMetadata: {
        type: connection.channel,
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        conversationFingerprint,
        conversationScope: event.conversationScope ?? 'direct',
        ...(event.guildId ? { guildId: event.guildId } : {}),
        readOnly: true,
      },
    });
  }
}
