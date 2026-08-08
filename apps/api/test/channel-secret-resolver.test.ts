import { randomBytes, randomUUID } from 'node:crypto';

import { deriveCapabilityKey, mintCapabilityId } from '@eden3/gateway';
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

const VAULT_KEY = randomBytes(32);
const CAP_KEY = deriveCapabilityKey(VAULT_KEY);

function record(overrides: Partial<ResolvableChannelSecret> = {}): ResolvableChannelSecret {
  return {
    id: randomUUID(),
    accountId: randomUUID(),
    channel: 'discord',
    runtimeAccountId: 'eden-agent-one',
    capabilityEpoch: 'c1',
    tokenCiphertext: 'ciphertext-only',
    tokenIv: 'iv',
    tokenAuthTag: 'tag',
    keyVersion: 'v1',
    ...overrides,
  };
}

function capIdFor(secret: ResolvableChannelSecret): string {
  return mintCapabilityId(CAP_KEY, {
    connectionId: secret.id,
    accountId: secret.accountId,
    channel: secret.channel,
    runtimeAccountId: secret.runtimeAccountId!,
    epoch: secret.capabilityEpoch,
  });
}

describe('ChannelSecretResolver (capability-bound)', () => {
  it('resolves a legitimate capability and audits a per-connection GRANT', async () => {
    const secret = record();
    const store: ChannelSecretStoreLike = {
      getActive: vi.fn(async () => secret),
      audit: vi.fn(async () => {}),
    };
    const vault: SecretVaultLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(() => 'runtime-plaintext-token'),
    };
    const resolver = new ChannelSecretResolver(store, vault, { capKey: CAP_KEY });
    const id = capIdFor(secret);

    const result = await resolver.resolve({
      protocolVersion: 1,
      provider: CHANNEL_SECRET_PROVIDER,
      ids: [id],
    });

    expect(result).toEqual({ protocolVersion: 1, values: { [id]: 'runtime-plaintext-token' } });
    expect(store.getActive).toHaveBeenCalledWith(secret.id);
    expect(store.audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'granted', connectionId: secret.id }),
    );
  });

  it('DENIES a forged capability and a cross-agent connectionId swap; aggregates the denial audit', async () => {
    const a = record({ runtimeAccountId: 'eden-A' });
    const b = record({ runtimeAccountId: 'eden-B' });
    const store: ChannelSecretStoreLike = {
      getActive: vi.fn(async (id) => (id === a.id ? a : id === b.id ? b : null)),
      audit: vi.fn(async () => {}),
    };
    const vault: SecretVaultLike = { encrypt: vi.fn(), decrypt: vi.fn(() => 'must-not-return') };
    const resolver = new ChannelSecretResolver(store, vault, { capKey: CAP_KEY });

    const forged = mintCapabilityId(deriveCapabilityKey(randomBytes(32)), {
      connectionId: a.id,
      accountId: a.accountId,
      channel: a.channel,
      runtimeAccountId: a.runtimeAccountId!,
      epoch: 'c1',
    });
    const crossAgent = capIdFor(a).replace(a.id, b.id);

    const result = await resolver.resolve({
      protocolVersion: 1,
      provider: CHANNEL_SECRET_PROVIDER,
      ids: [forged, crossAgent],
    });

    expect(result.values).toEqual({});
    expect(Object.keys(result.errors!)).toHaveLength(2);
    expect(vault.decrypt).not.toHaveBeenCalled();
    // A single aggregated denial event, never a per-id existence oracle.
    expect(store.audit).toHaveBeenCalledTimes(1);
    expect(store.audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'denied', deniedCount: 2 }),
    );
  });

  it('fails closed for a missing/inactive connection and a corrupt decrypt, leaking no diagnostic', async () => {
    const missing = record();
    const corrupt = record();
    const store: ChannelSecretStoreLike = {
      getActive: vi.fn(async (id) => (id === corrupt.id ? corrupt : null)),
      audit: vi.fn(async () => {}),
    };
    const vault: SecretVaultLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(() => {
        throw new Error('ciphertext diagnostic must not escape');
      }),
    };
    const resolver = new ChannelSecretResolver(store, vault, { capKey: CAP_KEY });
    const missingId = capIdFor(missing);
    const corruptId = capIdFor(corrupt);

    const result = await resolver.resolve({
      protocolVersion: 1,
      provider: CHANNEL_SECRET_PROVIDER,
      ids: [missingId, corruptId],
    });

    expect(result.values).toEqual({});
    expect(result.errors).toEqual({
      [missingId]: 'secret unavailable',
      [corruptId]: 'secret unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('ciphertext diagnostic');
    // Only the aggregated denial is audited (no per-id existence oracle).
    expect(store.audit).toHaveBeenCalledTimes(1);
    expect(store.audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'denied', deniedCount: 2 }),
    );
  });

  it('the vault binds v2 ciphertext to context: wrong or missing context throws', () => {
    const key = randomBytes(32).toString('base64');
    const context = channelTokenSecretContext({
      connectionId: randomUUID(),
      accountId: randomUUID(),
      channel: 'discord',
    });
    const vault = new AesGcmSecretVault({ key });
    const encrypted = vault.encrypt('bound-token', context);
    expect(() => vault.decrypt(encrypted, `${context}-tampered`)).toThrow();
    expect(() => vault.decrypt(encrypted)).toThrow('context');
  });

  it('fails a bare legacy id closed by default; the break-glass flag admits it', async () => {
    const secret = record();
    const store: ChannelSecretStoreLike = {
      getActive: vi.fn(async () => secret),
      audit: vi.fn(async () => {}),
    };
    const vault: SecretVaultLike = { encrypt: vi.fn(), decrypt: vi.fn(() => 'legacy-plaintext') };
    const bare = `channel/${secret.id}`;

    const strict = new ChannelSecretResolver(store, vault, { capKey: CAP_KEY });
    expect(
      await strict.resolve({ protocolVersion: 1, provider: CHANNEL_SECRET_PROVIDER, ids: [bare] }),
    ).toEqual({ protocolVersion: 1, values: {}, errors: { [bare]: 'secret unavailable' } });

    const breakGlass = new ChannelSecretResolver(store, vault, {
      capKey: CAP_KEY,
      allowLegacyUnscoped: true,
    });
    expect(
      await breakGlass.resolve({
        protocolVersion: 1,
        provider: CHANNEL_SECRET_PROVIDER,
        ids: [bare],
      }),
    ).toEqual({ protocolVersion: 1, values: { [bare]: 'legacy-plaintext' } });
  });

  it('withholds plaintext when the GRANT audit cannot be written', async () => {
    const secret = record();
    const store: ChannelSecretStoreLike = {
      getActive: vi.fn(async () => secret),
      audit: vi.fn(async (r) => {
        if (r.decision === 'granted') throw new Error('database unavailable');
      }),
    };
    const vault: SecretVaultLike = { encrypt: vi.fn(), decrypt: vi.fn(() => 'must-not-return') };
    const resolver = new ChannelSecretResolver(store, vault, { capKey: CAP_KEY });
    const id = capIdFor(secret);
    const result = await resolver.resolve({
      protocolVersion: 1,
      provider: CHANNEL_SECRET_PROVIDER,
      ids: [id],
    });
    expect(result.values).toEqual({});
    expect(result.errors).toEqual({ [id]: 'secret unavailable' });
    expect(JSON.stringify(result)).not.toContain('must-not-return');
  });

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
    const legacyWriter = new AesGcmSecretVault({ key, keyVersion: 'v1' });
    const legacy = legacyWriter.encrypt('legacy-token');
    expect(current.decrypt(legacy, context)).toBe('legacy-token');
  });

  it.each([
    null,
    {},
    { protocolVersion: 2, provider: CHANNEL_SECRET_PROVIDER, ids: [`channel/${randomUUID()}`] },
    { protocolVersion: 1, provider: 'other', ids: [`channel/${randomUUID()}`] },
    { protocolVersion: 1, provider: CHANNEL_SECRET_PROVIDER, ids: [] },
    {
      protocolVersion: 1,
      provider: CHANNEL_SECRET_PROVIDER,
      ids: Array.from({ length: MAX_CHANNEL_SECRET_IDS + 1 }, () => `channel/${randomUUID()}`),
    },
    { protocolVersion: 1, provider: CHANNEL_SECRET_PROVIDER, ids: ['channel/../../secret'] },
    { protocolVersion: 1, provider: CHANNEL_SECRET_PROVIDER, ids: ['channel/*'] },
  ])('rejects malformed protocol requests %#', async (input) => {
    const resolver = new ChannelSecretResolver(
      { getActive: vi.fn(), audit: vi.fn() },
      { encrypt: vi.fn(), decrypt: vi.fn() },
      { capKey: CAP_KEY },
    );
    await expect(resolver.resolve(input)).rejects.toThrow('invalid resolver request');
  });

  it('parses a bounded JSON frame and emits JSON-only output', async () => {
    const resolver = {
      resolve: vi.fn(async () => ({ protocolVersion: 1 as const, values: {} })),
    };
    const output = await resolveChannelSecretFrame(
      JSON.stringify({
        protocolVersion: 1,
        provider: CHANNEL_SECRET_PROVIDER,
        ids: [`channel/${randomUUID()}`],
      }),
      resolver,
    );
    expect(JSON.parse(output)).toEqual({ protocolVersion: 1, values: {} });
    expect(output.endsWith('\n')).toBe(true);
  });

  it('rejects empty, oversized, and non-JSON frames generically', async () => {
    const resolver = { resolve: vi.fn() };
    await expect(resolveChannelSecretFrame('', resolver)).rejects.toThrow('invalid resolver request');
    await expect(resolveChannelSecretFrame('{not json', resolver)).rejects.toThrow(
      'invalid resolver request',
    );
    await expect(resolveChannelSecretFrame(Buffer.alloc(262_145), resolver)).rejects.toThrow(
      'invalid resolver request',
    );
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});
