import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ChannelSessionSync,
  channelGroupMemoryPath,
  channelConversationFingerprint,
  channelPeerFingerprint,
  configuredChannelGroups,
  resolveChannelMemoryContext,
  type ChannelSessionSyncStoreLike,
  type ChannelSyncConnection,
} from '../src/services/channel-session-sync.js';
import type { SecretVaultLike } from '../src/services/secret-vault.js';

const connection: ChannelSyncConnection = {
  id: randomUUID(),
  accountId: randomUUID(),
  agentId: randomUUID(),
  runtimeAgentId: 'agent-runtime-fixture',
  channel: 'discord',
  runtimeAccountId: 'eden-connection-one',
  allowedGroups: [],
};

function vault(): SecretVaultLike {
  return {
    encrypt: vi.fn(() => ({
      tokenCiphertext: 'encrypted-peer',
      tokenIv: 'iv',
      tokenAuthTag: 'tag',
      tokenSha256: 'unused',
      tokenPreview: '7890',
      keyVersion: 'v1',
    })),
    decrypt: vi.fn(),
  };
}

describe('ChannelSessionSync', () => {
  it('wires committed channel messages to the shared session event bus', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/routes/channels.ts'), 'utf8');
    expect(source).toMatch(
      /new ChannelSessionSync\(\s*new PostgresChannelSessionSyncStore\(\),\s*vault,\s*app\.eventsBus\s*\)/,
    );
  });

  it('compiles only the canonical persisted provider group allowlist', () => {
    expect(
      configuredChannelGroups('discord', {
        config: {
          allowFrom: ['1234567890'],
          discordGuilds: [
            { guildId: '758719600895590441', channelIds: ['758719600895590444'] },
          ],
        },
      }),
    ).toEqual([
      {
        conversationId: '758719600895590444',
        guildId: '758719600895590441',
        allowFrom: ['1234567890'],
      },
    ]);
    expect(
      configuredChannelGroups('telegram', {
        config: { allowFrom: ['1234567890'], telegramGroups: [{ groupId: '-1001234567890' }] },
      }),
    ).toEqual([
      { conversationId: '-1001234567890', guildId: null, allowFrom: ['1234567890'] },
    ]);
    expect(() =>
      configuredChannelGroups('discord', {
        config: {
          allowFrom: [],
          discordGuilds: [
            { guildId: '758719600895590441', channelIds: ['758719600895590444'] },
          ],
        },
      }),
    ).toThrow('invalid channel group configuration');
  });

  it('projects safe, read-only session metadata with exact attribution', async () => {
    const publish = vi.fn();
    let persisted: Parameters<ChannelSessionSyncStoreLike['persistMessage']>[0] | undefined;
    const persistMessage: ChannelSessionSyncStoreLike['persistMessage'] = vi.fn(async (input) => {
      persisted = input;
      return {
        sessionId: randomUUID(),
        messageId: randomUUID(),
        inserted: true,
        memoryContext: {
          linkState: 'pseudonymous' as const,
          relativePath: 'memory/users/channel-peer-test.md',
        },
      };
    });
    const store: ChannelSessionSyncStoreLike = {
      getLiveConnection: vi.fn(async () => connection),
      persistMessage,
    };
    const service = new ChannelSessionSync(store, vault(), { publish });
    const createdAt = new Date('2026-07-31T05:10:03.000Z');

    const result = await service.syncMessage({
      connectionId: connection.id,
      runtimeAccountId: connection.runtimeAccountId,
      gatewaySessionKey: 'agent:one:discord:eden-connection-one:direct:peer',
      conversationId: 'discord-channel-555',
      peerId: '1234567890',
      externalMessageId: 'discord:message:42',
      role: 'assistant',
      content: 'hello from the agent',
      createdAt,
      sourceSequence: 42,
    });

    expect(result.inserted).toBe(true);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(result.sessionId, {
      type: 'session.messages.changed',
      sessionId: result.sessionId,
      messageId: result.messageId,
    });
    const input = persisted!;
    expect(input.connection).toEqual(connection);
    expect(input.event.createdAt).toEqual(createdAt);
    expect(input.identity).toMatchObject({ preview: '7890', ciphertext: 'encrypted-peer' });
    expect(input.safeChannelMetadata).toEqual({
      type: 'discord',
      connectionId: connection.id,
      runtimeAccountId: connection.runtimeAccountId,
      conversationFingerprint: channelConversationFingerprint(
        connection.id,
        'discord-channel-555',
      ),
      conversationScope: 'direct',
      readOnly: true,
    });
    expect(input.authorization).toMatchObject({
      peerId: '1234567890',
      conversationId: 'discord-channel-555',
      conversationScope: undefined,
      guildId: undefined,
    });
    expect(JSON.stringify({ event: input.event, metadata: input.safeChannelMetadata })).not.toContain(
      '1234567890',
    );
  });

  it('does not publish a duplicate channel message as new activity', async () => {
    const publish = vi.fn();
    const sessionId = randomUUID();
    const messageId = randomUUID();
    const service = new ChannelSessionSync(
      {
        getLiveConnection: vi.fn(async () => connection),
        persistMessage: vi.fn(async () => ({
          sessionId,
          messageId,
          inserted: false,
          memoryContext: {
            linkState: 'pseudonymous' as const,
            relativePath: 'memory/users/channel-peer-test.md',
          },
        })),
      },
      vault(),
      { publish },
    );

    await service.syncMessage({
      connectionId: connection.id,
      runtimeAccountId: connection.runtimeAccountId,
      gatewaySessionKey: 'agent:one:discord:eden-connection-one:direct:peer',
      peerId: '1234567890',
      externalMessageId: 'discord:message:duplicate',
      role: 'user',
      content: 'duplicate delivery',
      createdAt: new Date('2026-07-31T05:10:03.000Z'),
    });

    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects stale or cross-agent callbacks after a runtime binding is published', async () => {
    const bound: ChannelSyncConnection = {
      ...connection,
      bindingId: '33333333-3333-4333-8333-333333333333',
    };
    const persistMessage = vi.fn();
    const service = new ChannelSessionSync(
      { getLiveConnection: vi.fn(async () => bound), persistMessage },
      vault(),
    );
    const event = {
      connectionId: bound.id,
      runtimeAccountId: bound.runtimeAccountId,
      agentId: bound.runtimeAgentId,
      bindingId: bound.bindingId,
      gatewaySessionKey: 'bound-session',
      peerId: '1234567890',
      externalMessageId: 'bound-message',
      role: 'user' as const,
      content: 'must remain isolated',
      createdAt: new Date(),
    };
    for (const mutation of [
      { agentId: undefined, bindingId: undefined },
      { agentId: 'agent-runtime-other' },
      { bindingId: '44444444-4444-4444-8444-444444444444' },
    ]) {
      await expect(service.syncMessage({ ...event, ...mutation }))
        .rejects.toThrow('channel connection unavailable');
    }
    expect(persistMessage).not.toHaveBeenCalled();
  });

  it('isolates the same peer between bot connections', () => {
    expect(channelPeerFingerprint(randomUUID(), '1234567890')).not.toBe(
      channelPeerFingerprint(randomUUID(), '1234567890'),
    );
  });

  it('separates conversation identity from each sender speaking in it', () => {
    const conversation = channelConversationFingerprint(connection.id, 'group-42');
    expect(conversation).toBe(channelConversationFingerprint(connection.id, 'group-42'));
    expect(channelPeerFingerprint(connection.id, 'sender-one')).not.toBe(
      channelPeerFingerprint(connection.id, 'sender-two'),
    );
    expect(channelConversationFingerprint(connection.id, 'group-42')).not.toBe(
      channelConversationFingerprint(connection.id, 'group-43'),
    );
  });

  it('projects an allowlisted group as one conversation-scoped memory boundary', async () => {
    const groupConnection: ChannelSyncConnection = {
      ...connection,
      allowedGroups: [{ conversationId: '758719600895590444', guildId: '758719600895590441', allowFrom: ['1234567890'] }],
    };
    let persisted: Parameters<ChannelSessionSyncStoreLike['persistMessage']>[0] | undefined;
    const store: ChannelSessionSyncStoreLike = {
      getLiveConnection: vi.fn(async () => groupConnection),
      persistMessage: vi.fn(async (input) => {
        persisted = input;
        return {
          sessionId: randomUUID(),
          messageId: randomUUID(),
          inserted: true,
          memoryContext: {
            linkState: 'group' as const,
            relativePath: channelGroupMemoryPath(input.conversationFingerprint),
          },
        };
      }),
    };
    const result = await new ChannelSessionSync(store, vault()).syncMessage({
      connectionId: connection.id,
      runtimeAccountId: connection.runtimeAccountId,
      gatewaySessionKey: 'agent:one:discord:account:channel:group-42',
      conversationId: '758719600895590444',
      conversationScope: 'group',
      guildId: '758719600895590441',
      peerId: '1234567890',
      externalMessageId: 'discord:group-message:1',
      role: 'user',
      content: 'hello group',
      createdAt: new Date(),
    });
    expect(result.memoryContext).toEqual({
      linkState: 'group',
      relativePath: channelGroupMemoryPath(
        channelConversationFingerprint(connection.id, '758719600895590444'),
      ),
    });
    expect(persisted?.event.conversationScope).toBe('group');
    expect(persisted?.safeChannelMetadata).toMatchObject({ conversationScope: 'group' });
    expect(result.memoryContext.relativePath).not.toContain('1234567890');
  });

  it('fails closed on cross-guild, cross-connection, spoofed-scope, and unconfigured groups', async () => {
    const persistMessage = vi.fn();
    const allowed: ChannelSyncConnection = {
      ...connection,
      allowedGroups: [{ conversationId: '758719600895590444', guildId: '758719600895590441', allowFrom: ['1234567890'] }],
    };
    const service = new ChannelSessionSync(
      { getLiveConnection: vi.fn(async () => allowed), persistMessage },
      vault(),
    );
    const base = {
      connectionId: allowed.id,
      runtimeAccountId: allowed.runtimeAccountId,
      gatewaySessionKey: 'group-session',
      conversationId: '758719600895590444',
      conversationScope: 'group' as const,
      guildId: '758719600895590441',
      peerId: '1234567890',
      externalMessageId: 'message-1',
      role: 'user' as const,
      content: 'hello',
      createdAt: new Date(),
    };
    for (const event of [
      { ...base, guildId: '758719600895590442' },
      { ...base, conversationId: '758719600895590445' },
      { ...base, peerId: '1234567891' },
      { ...base, conversationScope: 'direct' as const },
    ]) {
      await expect(service.syncMessage(event)).rejects.toThrow('scope is not authorized');
    }
    const noGroups = new ChannelSessionSync(
      { getLiveConnection: vi.fn(async () => connection), persistMessage },
      vault(),
    );
    await expect(noGroups.syncMessage(base)).rejects.toThrow('scope is not authorized');
    const crossConnection = new ChannelSessionSync(
      { getLiveConnection: vi.fn(async () => allowed), persistMessage },
      vault(),
    );
    await expect(
      crossConnection.syncMessage({ ...base, connectionId: randomUUID() }),
    ).rejects.toThrow('connection unavailable');
    expect(persistMessage).not.toHaveBeenCalled();
  });

  it('never selects linked private memory for a group, and isolates distinct groups', () => {
    const groupOne = channelConversationFingerprint(connection.id, 'group-one');
    const groupTwo = channelConversationFingerprint(connection.id, 'group-two');
    const linkedAccount = { id: randomUUID(), username: 'private-user' };
    const firstSender = resolveChannelMemoryContext({
      conversationScope: 'group',
      conversationFingerprint: groupOne,
      peerFingerprint: channelPeerFingerprint(connection.id, 'sender-one'),
      linkedAccount,
    });
    const secondSender = resolveChannelMemoryContext({
      conversationScope: 'group',
      conversationFingerprint: groupOne,
      peerFingerprint: channelPeerFingerprint(connection.id, 'sender-two'),
      linkedAccount,
    });
    const otherGroup = resolveChannelMemoryContext({
      conversationScope: 'group',
      conversationFingerprint: groupTwo,
      peerFingerprint: channelPeerFingerprint(connection.id, 'sender-one'),
      linkedAccount,
    });
    expect(firstSender).toEqual(secondSender);
    expect(firstSender.linkState).toBe('group');
    expect(firstSender.relativePath).not.toContain('private-user');
    expect(otherGroup.relativePath).not.toBe(firstSender.relativePath);
  });

  it('rejects a runtime account mismatch before encrypting or persisting', async () => {
    const secretVault = vault();
    const store: ChannelSessionSyncStoreLike = {
      getLiveConnection: vi.fn(async () => connection),
      persistMessage: vi.fn(),
    };
    const service = new ChannelSessionSync(store, secretVault);
    await expect(
      service.syncMessage({
        connectionId: connection.id,
        runtimeAccountId: 'other-bot',
        gatewaySessionKey: 'collision',
        peerId: '1234567890',
        externalMessageId: '1',
        role: 'user',
        content: 'hello',
        createdAt: new Date(),
      }),
    ).rejects.toThrow('channel connection unavailable');
    expect(secretVault.encrypt).not.toHaveBeenCalled();
    expect(store.persistMessage).not.toHaveBeenCalled();
  });
});
