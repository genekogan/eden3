import { createSign, generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { pg } from '@eden3/db';

import {
  ClerkAuthProvider,
  createClerkJwtVerifier,
  defaultClerkUsername,
  extractClerkSessionToken,
  normalizePemPublicKey,
} from '../src/clerk-auth-provider';

const marker = `user_eden3_clerk_auth_${Date.now()}`;

async function cleanup(): Promise<void> {
  await pg`
    delete from manna_transactions
    where manna_account_id in (
      select ma.id
      from manna_accounts ma
      join accounts a on a.id = ma.account_id
      where a.clerk_user_id like ${`${marker}%`} or a.username::text like ${`${marker}%`}
    )
  `;
  await pg`
    delete from manna_accounts
    where account_id in (
      select id from accounts
      where clerk_user_id like ${`${marker}%`} or username::text like ${`${marker}%`}
    )
  `;
  await pg`
    delete from accounts
    where clerk_user_id like ${`${marker}%`} or username::text like ${`${marker}%`}
  `;
}

describe('extractClerkSessionToken', () => {
  it('accepts bearer tokens and Clerk __session cookies', () => {
    expect(extractClerkSessionToken({ headers: { authorization: 'Bearer abc.def.ghi' } })).toBe(
      'abc.def.ghi',
    );
    expect(extractClerkSessionToken({ headers: { cookie: '__session=from-cookie; other=x' } })).toBe(
      'from-cookie',
    );
  });
});

describe('createClerkJwtVerifier jwtKey formats', () => {
  function makeJwt(privatePem: string, payload: Record<string, unknown>): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const signed = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signed);
    signer.end();
    return `${signed}.${signer.sign(privatePem).toString('base64url')}`;
  }

  it('accepts a dashboard-style single-line PEM with spaces instead of newlines', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const flattened = publicPem.replace(/\n/g, ' ').trim();
    expect(() => normalizePemPublicKey(flattened)).not.toThrow();

    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = makeJwt(privatePem, { sub: 'user_x', exp, azp: 'http://localhost:4300' });
    const verify = createClerkJwtVerifier({
      jwtKey: flattened,
      authorizedParties: ['http://localhost:4300'],
    });
    await expect(verify(token)).resolves.toMatchObject({ sub: 'user_x' });
  });

  it('accepts a PEM with literal \\n escapes', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const escaped = publicPem.replace(/\n/g, '\\n');

    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = makeJwt(privatePem, { sub: 'user_y', exp });
    const verify = createClerkJwtVerifier({ jwtKey: escaped });
    await expect(verify(token)).resolves.toMatchObject({ sub: 'user_y' });
  });

  it('still rejects tokens signed by a different key', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const otherPrivatePem = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = makeJwt(otherPrivatePem, { sub: 'user_z', exp });
    const verify = createClerkJwtVerifier({ jwtKey: publicPem.replace(/\n/g, ' ') });
    await expect(verify(token)).rejects.toThrow('bad_signature');
  });
});

describe('ClerkAuthProvider', () => {
  afterEach(async () => {
    await cleanup();
  });

  it('resolves an existing migrated account by Clerk subject', async () => {
    const clerkUserId = `${marker}_existing`;
    const username = `${marker}_gene`;
    const accountRows = await pg<{ id: string }[]>`
      insert into accounts (type, username, clerk_user_id, external_id)
      values ('user', ${username}, ${clerkUserId}, ${`${marker}_external`})
      returning id
    `;

    const provider = new ClerkAuthProvider({
      adminUsernames: [username],
      verifyToken: async () => ({ sub: clerkUserId }),
    });
    const session = await provider.getSession({ headers: { authorization: 'Bearer valid' } });

    expect(session).toEqual({
      accountId: accountRows[0]!.id,
      username,
      isAdmin: true,
    });

    const count = await pg<{ n: string }[]>`
      select count(*)::int8 as n from accounts where clerk_user_id = ${clerkUserId}
    `;
    expect(Number(count[0]!.n)).toBe(1);
  });

  it('provisions a new non-PII account and credits signup manna once', async () => {
    const clerkUserId = `${marker}_new`;
    const provider = new ClerkAuthProvider({
      seedManna: 77,
      verifyToken: async () => ({ sub: clerkUserId }),
    });

    const first = await provider.getSession({ headers: { cookie: '__session=valid' } });
    const second = await provider.getSession({ headers: { cookie: '__session=valid' } });

    expect(first?.accountId).toBeTruthy();
    expect(second?.accountId).toBe(first?.accountId);
    expect(first?.username).toBe(defaultClerkUsername(clerkUserId));

    const ledger = await pg<{ balance: string; tx_count: string }[]>`
      select ma.balance, count(mt.id)::int8 as tx_count
      from accounts a
      join manna_accounts ma on ma.account_id = a.id
      left join manna_transactions mt on mt.manna_account_id = ma.id and mt.type = 'credit:signup'
      where a.clerk_user_id = ${clerkUserId}
      group by ma.balance
    `;
    expect(ledger[0]).toEqual({ balance: '77.0000', tx_count: '1' });
  });

  it('returns null for missing or rejected tokens without provisioning', async () => {
    const provider = new ClerkAuthProvider({
      verifyToken: async () => {
        throw new Error('bad token');
      },
    });

    await expect(provider.getSession({ headers: {} })).resolves.toBeNull();
    await expect(provider.getSession({ headers: { authorization: 'Bearer invalid' } })).resolves.toBeNull();

    const count = await pg<{ n: string }[]>`
      select count(*)::int8 as n from accounts where clerk_user_id like ${`${marker}%`}
    `;
    expect(Number(count[0]!.n)).toBe(0);
  });
});
