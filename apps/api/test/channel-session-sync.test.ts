import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  ChannelSessionSync,
  channelConversationFingerprint,
  channelPeerFingerprint,
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
