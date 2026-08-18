import { createSign, generateKeyPairSync } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createClerkJwtVerifier } from '../src/clerk-auth-provider';

const PARTY = 'https://app.example.test';
let trustedPublicKey = '';
let trustedPrivateKey = '';
let attackerPrivateKey = '';

function makeJwt(
  privateKey: string,
  payload: Record<string, unknown>,
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'attacker-selected' })}.${encode(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signed);
  signer.end();
  return `${signed}.${signer.sign(privateKey).toString('base64url')}`;
}

describe('Clerk JWT trust root', () => {
  beforeAll(() => {
    const trusted = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
    trustedPublicKey = trusted.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    trustedPrivateKey = trusted.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    attackerPrivateKey = attacker.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  });

  it('refuses before token handling or network access when no instance key is configured', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      expect(() => createClerkJwtVerifier()).toThrow(/CLERK_JWT_KEY/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accepts only the configured key regardless of an attacker-selected HTTPS issuer', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = {
      sub: 'user_existing',
      azp: PARTY,
      iss: 'https://attacker.invalid',
      exp: nowSeconds + 60,
    };
    const verify = createClerkJwtVerifier({
      jwtKey: trustedPublicKey,
      authorizedParties: [PARTY],
    });

    await expect(verify(makeJwt(trustedPrivateKey, payload))).resolves.toMatchObject({
      sub: 'user_existing',
    });
    await expect(verify(makeJwt(attackerPrivateKey, payload))).rejects.toThrow('bad_signature');
  });
});
