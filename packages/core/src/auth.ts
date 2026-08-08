import { isUuid } from './refs';

/**
 * Auth abstraction.
 *
 * eden3 launches with dev impersonation (no real login); Clerk arrives later
 * behind the same {@link AuthProvider} interface, so routes only ever talk to
 * `getSession()`.
 */

export interface AuthSession {
  /** `accounts.id` uuid of the signed-in (or impersonated) principal. */
  accountId: string;
  username: string;
  isAdmin: boolean;
}

/** The subset of an incoming HTTP request auth needs (Fastify-compatible). */
export interface AuthRequestLike {
  /**
   * Proxy-resolved client address when the HTTP framework supplies one.
   * Callers must configure a narrow trusted-proxy boundary; auth code never
   * derives this value from a raw forwarding header.
   */
  ip?: string;
  headers: {
    cookie?: string | string[] | undefined;
    [header: string]: string | string[] | undefined;
  };
}

export interface AuthProvider {
  /** Resolve the request's session, or `null` when not authenticated. */
  getSession(req: AuthRequestLike): Promise<AuthSession | null>;
}

// ---------------------------------------------------------------------------
// Cookie plumbing (dependency-free)
// ---------------------------------------------------------------------------

/** Name of the dev-impersonation cookie: an `accounts.id` uuid or a username. */
export const DEV_USER_COOKIE = 'eden3_dev_user';

/** Parse a `Cookie:` request header into a name → value map. */
export function parseCookieHeader(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const raw = Array.isArray(header) ? header.join('; ') : header;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value when it is not valid percent-encoding
    }
    // First occurrence wins, matching typical server behavior.
    if (!(name in out)) out[name] = value;
  }
  return out;
}

export interface DevCookieOptions {
  /** Cookie lifetime in seconds (default 30 days). */
  maxAgeSeconds?: number;
}

/**
 * Build the `Set-Cookie` header value that impersonates `idOrUsername`
 * (dev only — the value is trusted verbatim).
 */
export function buildDevSessionCookie(idOrUsername: string, opts: DevCookieOptions = {}): string {
  const maxAge = opts.maxAgeSeconds ?? 60 * 60 * 24 * 30;
  return (
    `${DEV_USER_COOKIE}=${encodeURIComponent(idOrUsername)}; ` +
    `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  );
}

/** Build the `Set-Cookie` header value that ends dev impersonation. */
export function clearDevSessionCookie(): string {
  return `${DEV_USER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// DevAuthProvider
// ---------------------------------------------------------------------------

/** What DevAuthProvider needs back from an account lookup. */
export interface DevAccountRecord {
  id: string;
  username: string;
  deleted: boolean;
}

export type DevAccountLookup = (idOrUsername: string) => Promise<DevAccountRecord | null>;

export interface DevAuthProviderOptions {
  /** Usernames granted `isAdmin` (compared case-insensitively). */
  adminUsernames?: string[];
  /**
   * Account lookup override (tests / non-db contexts). Defaults to querying
   * Postgres via the permalink resolvers: uuid → `accounts.id`, anything
   * else → citext username match.
   */
  lookupAccount?: DevAccountLookup;
}

/**
 * Development auth: whoever the `eden3_dev_user` cookie names is who you are.
 * No verification of any kind — never mount in a real deployment.
 */
export class DevAuthProvider implements AuthProvider {
  private readonly adminUsernames: Set<string>;
  private readonly lookupAccount: DevAccountLookup;

  constructor(opts: DevAuthProviderOptions = {}) {
    this.adminUsernames = new Set((opts.adminUsernames ?? []).map((u) => u.toLowerCase()));
    this.lookupAccount = opts.lookupAccount ?? defaultLookup;
  }

  async getSession(req: AuthRequestLike): Promise<AuthSession | null> {
    const cookies = parseCookieHeader(req.headers.cookie);
    const ref = cookies[DEV_USER_COOKIE]?.trim();
    if (!ref) return null;
    const account = await this.lookupAccount(ref);
    if (!account || account.deleted) return null;
    return {
      accountId: account.id,
      username: account.username,
      isAdmin: this.adminUsernames.has(account.username.toLowerCase()),
    };
  }
}

/**
 * Default lookup against Postgres. Imported lazily so that constructing a
 * DevAuthProvider with an injected lookup never touches the database client.
 */
async function defaultLookup(idOrUsername: string): Promise<DevAccountRecord | null> {
  const { resolveAccount, resolveAccountByUsername } = await import('./permalinks');
  const account = isUuid(idOrUsername)
    ? await resolveAccount(idOrUsername)
    : await resolveAccountByUsername(idOrUsername);
  if (!account) return null;
  return { id: account.id, username: account.username, deleted: account.deleted };
}
