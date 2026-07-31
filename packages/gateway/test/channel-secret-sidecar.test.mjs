import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  channelTokenSecretContext,
  decryptStoredSecret,
  parseEncryptionKey,
  resolveSecretRequest,
} from '../../../infra/channel-secret-resolver/server.mjs';

const execFileAsync = promisify(execFile);

function encrypt(token, key, row = {}, keyVersion = 'v1') {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (keyVersion === 'v2') {
    cipher.setAAD(Buffer.from(channelTokenSecretContext(row), 'utf8'));
  }
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    token_ciphertext: ciphertext.toString('base64'),
    token_iv: iv.toString('base64'),
    token_auth_tag: cipher.getAuthTag().toString('base64'),
    key_version: keyVersion,
    ...row,
  };
}

describe('channel secret resolver sidecar', () => {
  it('supports an existence-only socket healthcheck without relaxing mode 0660', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'eden3-channel-health-'));
    const socketPath = path.join(directory, 'channel-secrets.sock');
    const server = createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o660);
      await expect(execFileAsync('test', ['-S', socketPath])).resolves.toBeDefined();
      expect((await stat(socketPath)).mode & 0o777).toBe(0o660);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('decrypts the API vault AES-256-GCM record format', () => {
    const key = randomBytes(32);
    const legacy = encrypt('legacy-sidecar-runtime-token', key);
    const identity = { id: randomUUID(), account_id: randomUUID(), channel: 'discord' };
    const row = encrypt('sidecar-runtime-token', key, identity, 'v2');
    expect(decryptStoredSecret(legacy, key)).toBe('legacy-sidecar-runtime-token');
    expect(decryptStoredSecret(row, key)).toBe('sidecar-runtime-token');
    expect(() => decryptStoredSecret({ ...row, channel: 'telegram' }, key)).toThrow();
    expect(parseEncryptionKey(key.toString('base64'))).toEqual(key);
    expect(parseEncryptionKey(key.toString('hex'))).toEqual(key);
  });

  it('returns only active records and audits before releasing plaintext', async () => {
    const activeId = randomUUID();
    const missingId = randomUUID();
    const events = [];
    const active = { id: activeId, account_id: randomUUID(), channel: 'discord' };
    const result = await resolveSecretRequest(
      {
        protocolVersion: 1,
        provider: 'eden-channel-vault',
        ids: [`channel/${activeId}`, `channel/${missingId}`],
      },
      {
        loadActive: vi.fn(async () => [active]),
        decrypt: vi.fn(() => {
          events.push('decrypt');
          return 'runtime-token';
        }),
        audit: vi.fn(async () => events.push('audit')),
      },
    );
    expect(events).toEqual(['decrypt', 'audit']);
    expect(result).toEqual({
      protocolVersion: 1,
      values: { [`channel/${activeId}`]: 'runtime-token' },
      errors: { [`channel/${missingId}`]: 'secret unavailable' },
    });
  });

  it('withholds plaintext when its audit cannot be written', async () => {
    const id = randomUUID();
    const result = await resolveSecretRequest(
      { protocolVersion: 1, provider: 'eden-channel-vault', ids: [`channel/${id}`] },
      {
        loadActive: async () => [{ id }],
        decrypt: () => 'must-not-return',
        audit: async () => {
          throw new Error('database unavailable');
        },
      },
    );
    expect(result).toEqual({
      protocolVersion: 1,
      values: {},
      errors: { [`channel/${id}`]: 'secret unavailable' },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-return');
  });

  it('rejects wrong providers and path-like secret ids', async () => {
    const deps = { loadActive: vi.fn(), decrypt: vi.fn(), audit: vi.fn() };
    await expect(
      resolveSecretRequest({ protocolVersion: 1, provider: 'other', ids: ['channel/nope'] }, deps),
    ).rejects.toThrow('invalid resolver request');
    await expect(
      resolveSecretRequest(
        { protocolVersion: 1, provider: 'eden-channel-vault', ids: ['channel/../../nope'] },
        deps,
      ),
    ).rejects.toThrow('invalid resolver request');
    expect(deps.loadActive).not.toHaveBeenCalled();
  });
});
