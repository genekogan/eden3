import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_SECRET_PROVIDER,
  ChannelSecretResolver,
  MAX_CHANNEL_SECRET_IDS,
  resolveChannelSecretFrame,
  type ChannelSecretStoreLike,
  type ResolvableChannelSecret,
} from '../src/services/channel-secret-resolver.js';
import {
  AesGcmSecretVault,
  channelTokenSecretContext,
  type SecretVaultLike,
} from '../src/services/secret-vault.js';

function record(id: string): ResolvableChannelSecret {
  return {
    id,
    accountId: randomUUID(),
    channel: 'discord',
    runtimeAccountId: 'agent-one',
    tokenCiphertext: 'ciphertext-only',
    tokenIv: 'iv',
    tokenAuthTag: 'tag',
    keyVersion: 'v1',
  };
}

describe('ChannelSecretResolver', () => {
  it('binds v2 ciphertext to connection context while retaining read-only v1 compatibility', () => {
    const key = randomBytes(32).toString('base64');
    const context = channelTokenSecretContext({
      connectionId: randomUUID(),
      accountId: randomUUID(),
      channel: 'discord',
    });
    const current = new AesGcmSecretVault({ key });
    const encrypted = current.encrypt('context-bound-token', context);
    expect(encrypted.keyVersion).toBe('v2');
    expect(current.decrypt(encrypted, context)).toBe('context-bound-token');
    expect(() => current.decrypt(encrypted, `${context}-other`)).toThrow();
    expect(() => current.decrypt(encrypted)).toThrow('context');

    const legacyWriter = new AesGcmSecretVault({ key, keyVersion: 'v1' });
    const legacy = legacyWriter.encrypt('legacy-token');
    expect(current.decrypt(legacy, context)).toBe('legacy-token');
  });

  it('returns active tokens through the exec protocol and audits every read', async () => {
    const connectionId = randomUUID();
    const secret = record(connectionId);
    const store: ChannelSecretStoreLike = {
      getActive: vi.fn(async () => secret),
      auditRuntimeRead: vi.fn(async () => {}),
    };
    const vault: SecretVaultLike = {
      encrypt: vi.fn(() => {
        throw new Error('not used');
      }),
      decrypt: vi.fn(() => 'runtime-plaintext-token'),
    };
    const resolver = new ChannelSecretResolver(store, vault);

    const result = await resolver.resolve({
      protocolVersion: 1,
      provider: CHANNEL_SECRET_PROVIDER,
      ids: [`channel/${connectionId}`],
    });

    expect(result).toEqual({
      protocolVersion: 1,
      values: { [`channel/${connectionId}`]: 'runtime-plaintext-token' },
    });
    expect(store.getActive).toHaveBeenCalledWith(connectionId);
    expect(store.auditRuntimeRead).toHaveBeenCalledWith(secret);
    expect(vault.decrypt).toHaveBeenCalledWith(
      secret,
      channelTokenSecretContext({
        connectionId: secret.id,
        accountId: secret.accountId,
        channel: secret.channel,
      }),
    );
  });

  it('fails closed for inactive/missing and corrupt secrets without leaking details', async () => {
    const missingId = randomUUID();
    const corruptId = randomUUID();
    const corrupt = record(corruptId);
    const store: ChannelSecretStoreLike = {
      getActive: vi.fn(async (id) => (id === corruptId ? corrupt : null)),
      auditRuntimeRead: vi.fn(async () => {}),
    };
    const vault: SecretVaultLike = {
      encrypt: vi.fn(() => {
        throw new Error('not used');
      }),
      decrypt: vi.fn(() => {
        throw new Error('ciphertext diagnostic must not escape');
      }),
    };
    const resolver = new ChannelSecretResolver(store, vault);

    const result = await resolver.resolve({
      protocolVersion: 1,
      provider: CHANNEL_SECRET_PROVIDER,
      ids: [`channel/${missingId}`, `channel/${corruptId}`],
    });

    expect(result.values).toEqual({});
    expect(result.errors).toEqual({
      [`channel/${missingId}`]: 'secret unavailable',
      [`channel/${corruptId}`]: 'secret unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('ciphertext diagnostic');
    expect(store.auditRuntimeRead).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { protocolVersion: 2, provider: CHANNEL_SECRET_PROVIDER, ids: ['channel/nope'] },
    { protocolVersion: 1, provider: 'other', ids: [`channel/${randomUUID()}`] },
    { protocolVersion: 1, provider: CHANNEL_SECRET_PROVIDER, ids: [] },
    {
      protocolVersion: 1,
      provider: CHANNEL_SECRET_PROVIDER,
      ids: Array.from({ length: MAX_CHANNEL_SECRET_IDS + 1 }, () => `channel/${randomUUID()}`),
    },
    { protocolVersion: 1, provider: CHANNEL_SECRET_PROVIDER, ids: ['channel/../../secret'] },
  ])('rejects malformed protocol requests %#', async (input) => {
    const resolver = new ChannelSecretResolver(
      { getActive: vi.fn(), auditRuntimeRead: vi.fn() },
      { encrypt: vi.fn(), decrypt: vi.fn() },
    );
    await expect(resolver.resolve(input)).rejects.toThrow('invalid resolver request');
  });

  it('parses a bounded JSON frame and emits JSON-only output', async () => {
    const connectionId = randomUUID();
    const resolver = {
      resolve: vi.fn(async () => ({ protocolVersion: 1 as const, values: {} })),
    };
    const output = await resolveChannelSecretFrame(
      JSON.stringify({
        protocolVersion: 1,
        provider: CHANNEL_SECRET_PROVIDER,
        ids: [`channel/${connectionId}`],
      }),
      resolver,
    );

    expect(JSON.parse(output)).toEqual({ protocolVersion: 1, values: {} });
    expect(output.endsWith('\n')).toBe(true);
  });

  it('rejects empty, oversized, and non-JSON frames generically', async () => {
    const resolver = { resolve: vi.fn() };
    await expect(resolveChannelSecretFrame('', resolver)).rejects.toThrow(
      'invalid resolver request',
    );
    await expect(resolveChannelSecretFrame('{not json', resolver)).rejects.toThrow(
      'invalid resolver request',
    );
    await expect(
      resolveChannelSecretFrame(Buffer.alloc(262_145), resolver),
    ).rejects.toThrow('invalid resolver request');
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});
