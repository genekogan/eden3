import { createHash, createPublicKey, createVerify, type KeyObject } from 'node:crypto';

import {
  credit,
  DEFAULT_CLERK_NEW_USER_SEED_MANNA,
  parseCookieHeader,
  type AuthProvider,
  type AuthRequestLike,
  type AuthSession,
} from '@eden3/core';
import { db, pg } from '@eden3/db';
import { sql } from 'drizzle-orm';

interface ClerkJwtPayload {
  sub?: unknown;
  azp?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

interface ClerkJwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

export type ClerkTokenVerifier = (token: string) => Promise<ClerkJwtPayload>;

export interface ClerkAuthProviderOptions {
  adminUsernames?: string[];
  /** Closed-cohort mode: authenticate existing Clerk links, but never provision an unknown subject. */
  allowAccountCreation?: boolean;
  authorizedParties?: string[];
  jwtKey?: string;
  seedManna?: number;
  verifyToken?: ClerkTokenVerifier;
  now?: () => Date;
  /** Deterministic crash-injection seam; production leaves this unset. */
  afterAccountCreatedBeforeSeed?: (
    account: { id: string; username: string },
  ) => void | Promise<void>;
  /** Process-local burst admission for a genuinely new subject. */
  signupAdmission?: (input: {
    clerkUserId: string;
    clientIp: string;
  }) => { allowed: boolean; retryAfterMs: number };
}

export class ClerkSignupRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('clerk_signup_rate_limited');
    this.name = 'ClerkSignupRateLimitError';
  }
}

interface AccountRow {
  id: string;
  username: string;
  deleted: boolean;
}

const SESSION_COOKIE = '__session';
const CLOCK_SKEW_SECONDS = 5;

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

function publicKeyForJwt(jwtKey: string): KeyObject {
  return createPublicKey(normalizePemPublicKey(jwtKey));
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
  // Never derive the verification trust root from the unverified token. In
  // particular, an unverified issuer claim must not select a JWKS URL: that would let an
  // attacker host both the issuer and signing key (and would add an SSRF
  // primitive). Eden3 requires the exact Clerk instance public key at boot.
  if (!opts.jwtKey) throw new Error('CLERK_JWT_KEY is required for Clerk token verification');
  const publicKey = publicKeyForJwt(opts.jwtKey);
  return async (token) => {
    const decoded = splitJwt(token);
    if (decoded.header.alg !== 'RS256') throw new Error('unsupported_alg');
    verifySignature(decoded.signed, decoded.signature, publicKey);
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

async function createClerkAccountWithSeed(
  clerkUserId: string,
  seedManna: number,
  afterAccountCreatedBeforeSeed?: ClerkAuthProviderOptions['afterAccountCreatedBeforeSeed'],
  signupAdmission?: ClerkAuthProviderOptions['signupAdmission'],
  clientIp = 'unknown',
): Promise<AccountRow> {
  return await db.transaction(async (tx) => {
    // Serialize first-session account creation and its signup grant across API
    // processes. The account row and ledger leg share this transaction, so a
    // process fault at either boundary leaves neither visible.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`clerk-signup:${clerkUserId}`}, 0))`,
    );

    const existingRows = (await tx.execute(sql`
      select id, username::text as username, deleted
      from accounts
      where clerk_user_id = ${clerkUserId} and type = 'user'
      limit 1
    `)) as unknown as AccountRow[];
    const existing = existingRows[0];
    if (existing) return existing;

    const admission = signupAdmission?.({ clerkUserId, clientIp });
    if (admission && !admission.allowed) {
      throw new ClerkSignupRateLimitError(admission.retryAfterMs);
    }

    const base = defaultClerkUsername(clerkUserId);
    for (let i = 0; i < 10; i += 1) {
      const username = i === 0 ? base : `${base}_${i + 1}`;
      const rows = (await tx.execute(sql`
        insert into accounts (type, username, clerk_user_id)
        values ('user', ${username}, ${clerkUserId})
        on conflict do nothing
        returning id, username::text as username, deleted
      `)) as unknown as AccountRow[];
      const row = rows[0];
      if (!row) {
        // A mixed-version process may have won the unique Clerk identity
        // constraint without taking this advisory lock. Re-read the identity
        // before trying a username suffix so we never misclassify that race as
        // username exhaustion.
        const racedRows = (await tx.execute(sql`
          select id, username::text as username, deleted
          from accounts
          where clerk_user_id = ${clerkUserId} and type = 'user'
          limit 1
        `)) as unknown as AccountRow[];
        const raced = racedRows[0];
        if (raced) return raced;
        continue;
      }

      await afterAccountCreatedBeforeSeed?.({ id: row.id, username: row.username });
      if (seedManna > 0) {
        await credit({
          accountId: row.id,
          amount: seedManna,
          type: 'credit:signup',
          idempotencyKey: `clerk-signup:${clerkUserId}`,
          db: tx,
        });
      }
      return row;
    }
    throw new Error('could_not_allocate_clerk_username');
  });
}

export class ClerkAuthProvider implements AuthProvider {
  private readonly adminUsernames: Set<string>;
  private readonly allowAccountCreation: boolean;
  private readonly seedManna: number;
  private readonly verifyToken: ClerkTokenVerifier;
  private readonly afterAccountCreatedBeforeSeed?: ClerkAuthProviderOptions['afterAccountCreatedBeforeSeed'];
  private readonly signupAdmission?: ClerkAuthProviderOptions['signupAdmission'];

  constructor(opts: ClerkAuthProviderOptions = {}) {
    this.adminUsernames = new Set((opts.adminUsernames ?? []).map((u) => u.toLowerCase()));
    this.allowAccountCreation = opts.allowAccountCreation ?? true;
    this.seedManna = opts.seedManna ?? DEFAULT_CLERK_NEW_USER_SEED_MANNA;
    this.afterAccountCreatedBeforeSeed = opts.afterAccountCreatedBeforeSeed;
    this.signupAdmission = opts.signupAdmission;
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
    if (!existing && !this.allowAccountCreation) return null;
    const account =
      existing ??
      (await createClerkAccountWithSeed(
        clerkUserId,
        this.seedManna,
        this.afterAccountCreatedBeforeSeed,
        this.signupAdmission,
        req.ip ?? 'unknown',
      ));
    if (account.deleted) return null;

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
