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
  deriveCapabilityKey,
  deriveRequesterKey,
  parseEncryptionKey,
  requesterProof,
  resolveSecretRequest,
} from '../../../infra/channel-secret-resolver/server.mjs';
import { mintCapabilityId } from '../src/channel-secret-capability';

const execFileAsync = promisify(execFile);
const AGREEMENT_KEY = randomBytes(32);
const AGREEMENT_CAP_KEY = deriveCapabilityKey(AGREEMENT_KEY);
const AGREEMENT_REQUESTER_KEY = deriveRequesterKey(AGREEMENT_KEY);

function activeRow(row) {
  return {
    ...row,
    agent_openclaw_id: row.runtime_account_id,
    agent_owner_id: row.account_id,
    agent_deleted: false,
    owner_deleted: false,
  };
}

function request(ids, rows, challenge = randomBytes(32).toString('base64url')) {
  const processInstanceId = randomUUID();
  const requesters = ids.map((id) => {
    const connectionId = id.split('/')[1].split('.')[0];
    const row = rows.find((candidate) => candidate.id === connectionId);
    const channel = row?.channel ?? 'discord';
    const runtimeAccountId = row?.runtime_account_id ?? 'missing-account';
    return {
      id,
      configPath: `channels.${channel}.accounts.${runtimeAccountId}.${channel === 'discord' ? 'token' : 'botToken'}`,
      connectionId,
      channel,
      runtimeAccountId,
      agentId: row?.agent_openclaw_id ?? runtimeAccountId,
      credentialField: channel === 'discord' ? 'token' : 'botToken',
    };
  });
  return {
    input: {
      protocolVersion: 2,
      provider: 'eden-channel-vault',
      ids,
      requesters,
      challenge,
      processInstanceId,
      proof: requesterProof(AGREEMENT_REQUESTER_KEY, {
        challenge,
        processInstanceId,
        requesters,
      }),
    },
    challenge,
  };
}

/** Mint a capability id for a synthetic row (matches loadActive output shape). */
function capId(row, epoch = 'c1') {
  return mintCapabilityId(AGREEMENT_CAP_KEY, {
    connectionId: row.id,
    accountId: row.account_id,
    channel: row.channel,
    runtimeAccountId: row.runtime_account_id,
    epoch,
  });
}

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

  it('returns only active records and audits (GRANT) before releasing plaintext', async () => {
    const active = activeRow({ id: randomUUID(), account_id: randomUUID(), channel: 'discord', runtime_account_id: 'eden-one' });
    const missingId = randomUUID();
    const events = [];
    const activeCap = capId(active);
    const missingCap = capId({ id: missingId, account_id: randomUUID(), channel: 'discord', runtime_account_id: 'eden-x' });
    const signed = request([activeCap, missingCap], [active]);
    const result = await resolveSecretRequest(
      signed.input,
      {
        capKey: AGREEMENT_CAP_KEY,
        requesterKey: AGREEMENT_REQUESTER_KEY,
        challenge: signed.challenge,
        loadActive: vi.fn(async () => [active]),
        decrypt: vi.fn(() => {
          events.push('decrypt');
          return 'runtime-token';
        }),
        audit: vi.fn(async (r) => events.push(r.decision)),
      },
    );
    expect(events).toEqual(['decrypt', 'granted', 'denied']); // grant decrypts+audits; missing → deny audit
    expect(result).toEqual({
      protocolVersion: 2,
      values: { [activeCap]: 'runtime-token' },
      errors: { [missingCap]: 'secret unavailable' },
    });
  });

  it('withholds plaintext when its audit cannot be written', async () => {
    const row = activeRow({ id: randomUUID(), account_id: randomUUID(), channel: 'discord', runtime_account_id: 'eden-one' });
    const id = capId(row);
    const signed = request([id], [row]);
    const result = await resolveSecretRequest(
      signed.input,
      {
        capKey: AGREEMENT_CAP_KEY,
        requesterKey: AGREEMENT_REQUESTER_KEY,
        challenge: signed.challenge,
        loadActive: async () => [row],
        decrypt: () => 'must-not-return',
        audit: async (r) => {
          if (r.decision === 'granted') throw new Error('database unavailable');
        },
      },
    );
    expect(result).toEqual({
      protocolVersion: 2,
      values: {},
      errors: { [id]: 'secret unavailable' },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-return');
  });

  it('rejects a captured authenticated request against a fresh socket challenge before DB work', async () => {
    const row = activeRow({
      id: randomUUID(),
      account_id: randomUUID(),
      channel: 'discord',
      runtime_account_id: 'eden-one',
    });
    const id = capId(row);
    const oldChallenge = randomBytes(32).toString('base64url');
    const signed = request([id], [row], oldChallenge);
    const loadActive = vi.fn();
    await expect(
      resolveSecretRequest(signed.input, {
        capKey: AGREEMENT_CAP_KEY,
        requesterKey: AGREEMENT_REQUESTER_KEY,
        challenge: randomBytes(32).toString('base64url'),
        loadActive,
        decrypt: vi.fn(),
        audit: vi.fn(),
      }),
    ).rejects.toThrow('invalid resolver request');
    expect(loadActive).not.toHaveBeenCalled();
  });

  it('rejects wrong providers and path-like secret ids', async () => {
    const deps = {
      capKey: AGREEMENT_CAP_KEY,
      requesterKey: AGREEMENT_REQUESTER_KEY,
      challenge: randomBytes(32).toString('base64url'),
      loadActive: vi.fn(),
      decrypt: vi.fn(),
      audit: vi.fn(),
    };
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
