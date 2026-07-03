import {
  accounts,
  agents,
  collections,
  creations,
  db,
  sessions,
  type Account,
  type Agent,
  type Collection,
  type Creation,
  type Session,
} from '@eden3/db';
import { and, eq } from 'drizzle-orm';

import type { DbHandle } from './db-handle';
import { isHex24, isUuid } from './refs';

export { isHex24, isUuid };

/**
 * Permalink resolvers.
 *
 * eden1 permalinks (`/sessions/<mongo hex id>`, `/creations/<hex>`,
 * `/agents/<username>`) must keep working after the migration. Migrated rows
 * carry their Mongo ObjectId in `external_id`; eden3-native rows only have a
 * uuid `id`. Each resolver accepts either shape: 24-char hex → look up
 * `external_id`, uuid → look up `id`, anything else → `null` (no query).
 *
 * Soft-deleted rows resolve to `null` unless `includeDeleted` is set.
 */

export interface ResolveOptions {
  /** Also return soft-deleted rows (default false). */
  includeDeleted?: boolean;
  /** Database handle — pass a transaction to resolve inside it. */
  db?: DbHandle;
}

type RefKind = 'externalId' | 'id' | null;

function refKind(ref: string): RefKind {
  if (isHex24(ref)) return 'externalId';
  if (isUuid(ref)) return 'id';
  return null;
}

export async function resolveSession(ref: string, opts: ResolveOptions = {}): Promise<Session | null> {
  const kind = refKind(ref);
  if (!kind) return null;
  const dbc = opts.db ?? db;
  const where =
    kind === 'externalId' ? eq(sessions.externalId, ref.toLowerCase()) : eq(sessions.id, ref.toLowerCase());
  const [row] = await dbc.select().from(sessions).where(where).limit(1);
  if (!row) return null;
  if (row.deleted && !opts.includeDeleted) return null;
  return row;
}

export async function resolveCreation(ref: string, opts: ResolveOptions = {}): Promise<Creation | null> {
  const kind = refKind(ref);
  if (!kind) return null;
  const dbc = opts.db ?? db;
  const where =
    kind === 'externalId' ? eq(creations.externalId, ref.toLowerCase()) : eq(creations.id, ref.toLowerCase());
  const [row] = await dbc.select().from(creations).where(where).limit(1);
  if (!row) return null;
  if (row.deleted && !opts.includeDeleted) return null;
  return row;
}

export async function resolveCollection(ref: string, opts: ResolveOptions = {}): Promise<Collection | null> {
  const kind = refKind(ref);
  if (!kind) return null;
  const dbc = opts.db ?? db;
  const where =
    kind === 'externalId'
      ? eq(collections.externalId, ref.toLowerCase())
      : eq(collections.id, ref.toLowerCase());
  const [row] = await dbc.select().from(collections).where(where).limit(1);
  if (!row) return null;
  if (row.deleted && !opts.includeDeleted) return null;
  return row;
}

/** Resolve an account by uuid or legacy Mongo hex id. */
export async function resolveAccount(ref: string, opts: ResolveOptions = {}): Promise<Account | null> {
  const kind = refKind(ref);
  if (!kind) return null;
  const dbc = opts.db ?? db;
  const where =
    kind === 'externalId' ? eq(accounts.externalId, ref.toLowerCase()) : eq(accounts.id, ref.toLowerCase());
  const [row] = await dbc.select().from(accounts).where(where).limit(1);
  if (!row) return null;
  if (row.deleted && !opts.includeDeleted) return null;
  return row;
}

/**
 * Resolve an account by username. `username` is citext in Postgres, so the
 * match is case-insensitive. Optionally restrict to `type` user/agent.
 */
export async function resolveAccountByUsername(
  username: string,
  opts: ResolveOptions & { type?: 'user' | 'agent' } = {},
): Promise<Account | null> {
  if (!username) return null;
  const dbc = opts.db ?? db;
  const where = opts.type
    ? and(eq(accounts.username, username), eq(accounts.type, opts.type))
    : eq(accounts.username, username);
  const [row] = await dbc.select().from(accounts).where(where).limit(1);
  if (!row) return null;
  if (row.deleted && !opts.includeDeleted) return null;
  return row;
}

/**
 * Resolve `/agents/<username>` — the agent account plus its `agents`
 * extension row. Returns null when the account exists but is not an agent.
 */
export async function resolveAgentByUsername(
  username: string,
  opts: ResolveOptions = {},
): Promise<{ account: Account; agent: Agent } | null> {
  const account = await resolveAccountByUsername(username, { ...opts, type: 'agent' });
  if (!account) return null;
  const dbc = opts.db ?? db;
  const [agent] = await dbc.select().from(agents).where(eq(agents.accountId, account.id)).limit(1);
  if (!agent) return null;
  return { account, agent };
}
