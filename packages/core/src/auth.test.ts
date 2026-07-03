import { describe, expect, it } from 'vitest';

import {
  DEV_USER_COOKIE,
  DevAuthProvider,
  buildDevSessionCookie,
  clearDevSessionCookie,
  parseCookieHeader,
  type DevAccountRecord,
} from './auth';

describe('parseCookieHeader', () => {
  it('parses a simple header into a map', () => {
    expect(parseCookieHeader('a=1; b=two')).toEqual({ a: '1', b: 'two' });
  });

  it('returns {} for missing headers', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  it('joins array headers', () => {
    expect(parseCookieHeader(['a=1', 'b=2'])).toEqual({ a: '1', b: '2' });
  });

  it('decodes percent-encoding and strips quotes', () => {
    expect(parseCookieHeader('name=gene%20kogan; q="quoted"')).toEqual({
      name: 'gene kogan',
      q: 'quoted',
    });
  });

  it('keeps the first occurrence of a duplicated name', () => {
    expect(parseCookieHeader('a=first; a=second')).toEqual({ a: 'first' });
  });

  it('skips malformed parts and keeps raw value on bad encoding', () => {
    expect(parseCookieHeader('noequals; a=1; =empty; b=%E0%A4%A')).toEqual({
      a: '1',
      b: '%E0%A4%A',
    });
  });
});

describe('dev session cookies', () => {
  it('buildDevSessionCookie encodes the value and sets attributes', () => {
    const cookie = buildDevSessionCookie('gene kogan');
    expect(cookie).toContain(`${DEV_USER_COOKIE}=gene%20kogan`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toMatch(/Max-Age=\d+/);
  });

  it('round-trips through parseCookieHeader', () => {
    const setCookie = buildDevSessionCookie('gene kogan');
    const pair = setCookie.split(';')[0]!;
    expect(parseCookieHeader(pair)[DEV_USER_COOKIE]).toBe('gene kogan');
  });

  it('clearDevSessionCookie expires the cookie', () => {
    expect(clearDevSessionCookie()).toContain('Max-Age=0');
    expect(clearDevSessionCookie()).toContain(`${DEV_USER_COOKIE}=;`);
  });
});

describe('DevAuthProvider', () => {
  const records: Record<string, DevAccountRecord> = {
    '0d4ff44a-2e6c-4b19-a021-63f2fe1c5a11': {
      id: '0d4ff44a-2e6c-4b19-a021-63f2fe1c5a11',
      username: 'gene',
      deleted: false,
    },
    verdelis: {
      id: '95c9f1a2-6a52-4a3c-8c8f-0a35a9a1a001',
      username: 'Verdelis',
      deleted: false,
    },
    ghost: { id: 'b6a4b70e-1a6a-4a4b-9a1a-3a9a9a9a9a9a', username: 'ghost', deleted: true },
  };
  const seenRefs: string[] = [];
  const provider = new DevAuthProvider({
    adminUsernames: ['GENE'],
    lookupAccount: async (ref) => {
      seenRefs.push(ref);
      return records[ref] ?? null;
    },
  });

  const reqWithCookie = (value: string) => ({
    headers: { cookie: `${DEV_USER_COOKIE}=${encodeURIComponent(value)}` },
  });

  it('returns null when the cookie is absent', async () => {
    expect(await provider.getSession({ headers: {} })).toBeNull();
    expect(await provider.getSession({ headers: { cookie: 'other=1' } })).toBeNull();
  });

  it('resolves a session and flags admins case-insensitively', async () => {
    const session = await provider.getSession(reqWithCookie('0d4ff44a-2e6c-4b19-a021-63f2fe1c5a11'));
    expect(session).toEqual({
      accountId: '0d4ff44a-2e6c-4b19-a021-63f2fe1c5a11',
      username: 'gene',
      isAdmin: true,
    });
  });

  it('resolves usernames through the lookup verbatim', async () => {
    const session = await provider.getSession(reqWithCookie('verdelis'));
    expect(session).toEqual({
      accountId: '95c9f1a2-6a52-4a3c-8c8f-0a35a9a1a001',
      username: 'Verdelis',
      isAdmin: false,
    });
    expect(seenRefs).toContain('verdelis');
  });

  it('returns null for unknown or deleted accounts', async () => {
    expect(await provider.getSession(reqWithCookie('nobody'))).toBeNull();
    expect(await provider.getSession(reqWithCookie('ghost'))).toBeNull();
  });

  it('ignores a whitespace-only cookie value', async () => {
    expect(
      await provider.getSession({ headers: { cookie: `${DEV_USER_COOKIE}=%20%20` } }),
    ).toBeNull();
  });
});
