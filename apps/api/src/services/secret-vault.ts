import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { getEnv } from '@eden3/core';
import type { ChannelConnection } from '@eden3/db';

export interface EncryptedSecret {
  tokenCiphertext: string;
  tokenIv: string;
  tokenAuthTag: string;
  tokenSha256: string;
  tokenPreview: string | null;
  keyVersion: string;
}

export interface SecretVaultLike {
  encrypt(plaintext: string): EncryptedSecret;
  decrypt(record: Pick<ChannelConnection, 'tokenCiphertext' | 'tokenIv' | 'tokenAuthTag' | 'keyVersion'>): string;
}

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const hex = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, 'hex') : null;
  const key = hex ?? Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('CHANNEL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return key;
}

function preview(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 4) return null;
  return trimmed.slice(-4);
}

export class AesGcmSecretVault implements SecretVaultLike {
  private readonly key: Buffer;
  private readonly keyVersion: string;

  constructor(opts: { key: string; keyVersion?: string }) {
    this.key = parseKey(opts.key);
    this.keyVersion = opts.keyVersion ?? 'v1';
  }

  encrypt(plaintext: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      tokenCiphertext: ciphertext.toString('base64'),
      tokenIv: iv.toString('base64'),
      tokenAuthTag: authTag.toString('base64'),
      tokenSha256: createHash('sha256').update(plaintext).digest('hex'),
      tokenPreview: preview(plaintext),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(record: Pick<ChannelConnection, 'tokenCiphertext' | 'tokenIv' | 'tokenAuthTag' | 'keyVersion'>): string {
    if (record.keyVersion !== this.keyVersion) {
      throw new Error(`Unsupported secret key version ${record.keyVersion}`);
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(record.tokenIv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(record.tokenAuthTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.tokenCiphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

export function defaultSecretVault(): SecretVaultLike {
  const key = getEnv().CHANNEL_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error('CHANNEL_TOKEN_ENCRYPTION_KEY is not configured');
  return new AesGcmSecretVault({ key });
}
