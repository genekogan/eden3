import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  ChannelSessionSync,
  channelGroupMemoryPath,
  channelConversationFingerprint,
  channelPeerFingerprint,
  resolveChannelMemoryContext,
  type ChannelSessionSyncStoreLike,
  type ChannelSyncConnection,
} from '../src/services/channel-session-sync.js';
import type { SecretVaultLike } from '../src/services/secret-vault.js';

const connection: ChannelSyncConnection = {
  id: randomUUID(),
  accountId: randomUUID(),
  agentId: randomUUID(),
  channel: 'discord',
  runtimeAccountId: 'eden-connection-one',
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
  it('projects safe, read-only session metadata with exact attribution', async () => {
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
    const service = new ChannelSessionSync(store, vault());
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
    expect(JSON.stringify(input)).not.toContain('1234567890');
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
    let persisted: Parameters<ChannelSessionSyncStoreLike['persistMessage']>[0] | undefined;
    const store: ChannelSessionSyncStoreLike = {
      getLiveConnection: vi.fn(async () => connection),
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
      conversationId: 'group-42',
      conversationScope: 'group',
      peerId: '1234567890',
      externalMessageId: 'discord:group-message:1',
      role: 'user',
      content: 'hello group',
      createdAt: new Date(),
    });
    expect(result.memoryContext).toEqual({
      linkState: 'group',
      relativePath: channelGroupMemoryPath(
        channelConversationFingerprint(connection.id, 'group-42'),
      ),
    });
    expect(persisted?.event.conversationScope).toBe('group');
    expect(persisted?.safeChannelMetadata).toMatchObject({ conversationScope: 'group' });
    expect(result.memoryContext.relativePath).not.toContain('1234567890');
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
