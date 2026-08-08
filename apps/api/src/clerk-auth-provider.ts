import { createHash, createPublicKey, createVerify, type KeyObject } from 'node:crypto';

import {
  credit,
  DEFAULT_CLERK_NEW_USER_SEED_MANNA,
  parseCookieHeader,
  type AuthProvider,
  type AuthRequestLike,
  type AuthSession,
} from '@eden3/core';
import { pg } from '@eden3/db';

interface ClerkJwtPayload {
  sub?: unknown;
  azp?: unknown;
  iss?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

interface ClerkJwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

interface JwksResponse {
  keys?: Jwk[];
}

export type ClerkTokenVerifier = (token: string) => Promise<ClerkJwtPayload>;

export interface ClerkAuthProviderOptions {
  adminUsernames?: string[];
  authorizedParties?: string[];
  jwtKey?: string;
  seedManna?: number;
  verifyToken?: ClerkTokenVerifier;
  now?: () => Date;
}

interface AccountRow {
  id: string;
  username: string;
  deleted: boolean;
}

const SESSION_COOKIE = '__session';
const CLOCK_SKEW_SECONDS = 5;
const JWKS_TTL_MS = 5 * 60 * 1000;
const jwksCache = new Map<string, { expiresAt: number; keys: Jwk[] }>();

function firstHeader(req: AuthRequestLike, name: string): string | null {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

export function extractClerkSessionToken(req: AuthRequestLike): string | null {
  const authorization = firstHeader(req, 'authorization');
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  return parseCookieHeader(req.headers.cookie)[SESSION_COOKIE]?.trim() || null;
}

function b64urlDecode(part: string): Buffer {
  return Buffer.from(part, 'base64url');
}

function decodeJsonPart<T>(part: string): T {
  return JSON.parse(b64urlDecode(part).toString('utf8')) as T;
}

function splitJwt(token: string): { header: ClerkJwtHeader; payload: ClerkJwtPayload; signed: string; signature: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('invalid_jwt_shape');
  }
  return {
    header: decodeJsonPart<ClerkJwtHeader>(parts[0]),
    payload: decodeJsonPart<ClerkJwtPayload>(parts[1]),
    signed: `${parts[0]}.${parts[1]}`,
    signature: b64urlDecode(parts[2]),
  };
}

async function getJwks(issuer: string, now: number): Promise<Jwk[]> {
  const cached = jwksCache.get(issuer);
  if (cached && cached.expiresAt > now) return cached.keys;

  const url = new URL('/.well-known/jwks.json', issuer);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`jwks_fetch_failed_${response.status}`);
  const body = (await response.json()) as JwksResponse;
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(issuer, { expiresAt: now + JWKS_TTL_MS, keys });
  return keys;
}

/**
 * Clerk's dashboard hands out the instance public key as a single line
 * (newlines collapsed to spaces), and env files often store it with literal
 * `\n` escapes — neither parses as PEM. Rebuild the canonical wrapped form,
 * as @clerk/backend does, before handing it to createPublicKey.
 */
export function normalizePemPublicKey(key: string): string {
  let value = key.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\\n/g, '\n');
  const body = value
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

async function publicKeyForJwt(header: ClerkJwtHeader, payload: ClerkJwtPayload, jwtKey?: string): Promise<KeyObject> {
  if (jwtKey) return createPublicKey(normalizePemPublicKey(jwtKey));

  const issuer = typeof payload.iss === 'string' ? payload.iss : null;
  const kid = typeof header.kid === 'string' ? header.kid : null;
  if (!issuer || !kid) throw new Error('missing_issuer_or_kid');
  if (!issuer.startsWith('https://')) throw new Error('invalid_issuer');

  const keys = await getJwks(issuer, Date.now());
  const jwk = keys.find((key) => key.kid === kid);
  if (!jwk) throw new Error('missing_jwk');
  return createPublicKey({ key: jwk, format: 'jwk' } as Parameters<typeof createPublicKey>[0]);
}

function verifySignature(signed: string, signature: Buffer, key: KeyObject): void {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signed);
  verifier.end();
  if (!verifier.verify(key, signature)) throw new Error('bad_signature');
}

function validateClaims(
  payload: ClerkJwtPayload,
  authorizedParties: string[],
  now: Date,
): void {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  const nbf = typeof payload.nbf === 'number' ? payload.nbf : null;
  if (exp !== null && nowSeconds > exp + CLOCK_SKEW_SECONDS) throw new Error('jwt_expired');
  if (nbf !== null && nowSeconds + CLOCK_SKEW_SECONDS < nbf) throw new Error('jwt_not_yet_valid');
  if (authorizedParties.length > 0) {
    const azp = typeof payload.azp === 'string' ? payload.azp : null;
    if (!azp || !authorizedParties.includes(azp)) throw new Error('unauthorized_party');
  }
}

export function createClerkJwtVerifier(opts: {
  authorizedParties?: string[];
  jwtKey?: string;
  now?: () => Date;
} = {}): ClerkTokenVerifier {
  return async (token) => {
    const decoded = splitJwt(token);
    if (decoded.header.alg !== 'RS256') throw new Error('unsupported_alg');
    const key = await publicKeyForJwt(decoded.header, decoded.payload, opts.jwtKey);
    verifySignature(decoded.signed, decoded.signature, key);
    validateClaims(decoded.payload, opts.authorizedParties ?? [], opts.now?.() ?? new Date());
    return decoded.payload;
  };
}

export function defaultClerkUsername(clerkUserId: string): string {
  const digest = createHash('sha256').update(clerkUserId).digest('hex').slice(0, 16);
  return `clerk_${digest}`;
}

async function findByClerkUserId(clerkUserId: string): Promise<AccountRow | null> {
  const rows = await pg<AccountRow[]>`
    select id, username::text as username, deleted
    from accounts
    where clerk_user_id = ${clerkUserId} and type = 'user'
    limit 1
  `;
  return rows[0] ?? null;
}

async function createClerkAccount(clerkUserId: string): Promise<AccountRow> {
  const base = defaultClerkUsername(clerkUserId);
  for (let i = 0; i < 10; i += 1) {
    const username = i === 0 ? base : `${base}_${i + 1}`;
    try {
      const rows = await pg<AccountRow[]>`
        insert into accounts (type, username, clerk_user_id)
        values ('user', ${username}, ${clerkUserId})
        on conflict (clerk_user_id) where clerk_user_id is not null
        do update set updated_at = accounts.updated_at
        returning id, username::text as username, deleted
      `;
      const row = rows[0];
      if (!row) throw new Error('account_insert_returned_no_row');
      return row;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') continue;
      throw err;
    }
  }
  throw new Error('could_not_allocate_clerk_username');
}

export class ClerkAuthProvider implements AuthProvider {
  private readonly adminUsernames: Set<string>;
  private readonly seedManna: number;
  private readonly verifyToken: ClerkTokenVerifier;

  constructor(opts: ClerkAuthProviderOptions = {}) {
    this.adminUsernames = new Set((opts.adminUsernames ?? []).map((u) => u.toLowerCase()));
    this.seedManna = opts.seedManna ?? DEFAULT_CLERK_NEW_USER_SEED_MANNA;
    this.verifyToken =
      opts.verifyToken ??
      createClerkJwtVerifier({
        authorizedParties: opts.authorizedParties,
        jwtKey: opts.jwtKey,
        now: opts.now,
      });
  }

  async getSession(req: AuthRequestLike): Promise<AuthSession | null> {
    const token = extractClerkSessionToken(req);
    if (!token) return null;

    let payload: ClerkJwtPayload;
    try {
      payload = await this.verifyToken(token);
    } catch {
      return null;
    }

    const clerkUserId = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!clerkUserId) return null;

    const existing = await findByClerkUserId(clerkUserId);
    if (existing?.deleted) return null;
    const account = existing ?? (await createClerkAccount(clerkUserId));
    if (account.deleted) return null;

    if (!existing && this.seedManna > 0) {
      await credit({
        accountId: account.id,
        amount: this.seedManna,
        type: 'credit:signup',
        idempotencyKey: `clerk-signup:${clerkUserId}`,
      });
    }

    return {
      accountId: account.id,
      username: account.username,
      isAdmin: this.adminUsernames.has(account.username.toLowerCase()),
    };
  }
}

export class FallbackAuthProvider implements AuthProvider {
  constructor(private readonly providers: AuthProvider[]) {}

  async getSession(req: AuthRequestLike): Promise<AuthSession | null> {
    for (const provider of this.providers) {
      const session = await provider.getSession(req);
      if (session) return session;
    }
    return null;
  }
}
