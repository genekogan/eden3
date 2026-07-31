import { resolveSession } from '@eden3/core';
import {
  accounts,
  db,
  messages,
  sessionAgents,
  sessionUsers,
  sessions,
  type Message,
  type Session,
} from '@eden3/db';
import type { AccountSummary, MessageAttachment, MessageDto, SessionDto } from '@eden3/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors';

/**
 * Session read routes.
 *
 *   GET /sessions            — the caller's sessions (owner or member), not
 *                              deleted, visible != false, last_message_at
 *                              desc (nulls last), keyset-paginated.
 *   GET /sessions/:id        — one session (uuid or legacy 24-hex permalink)
 *                              plus a page of messages ASCENDING created_at.
 *                              The page is the NEWEST slice; `nextCursor`
 *                              fetches the previous (older) slice — chat UIs
 *                              prepend older pages at the top.
 *
 * (GET /sessions/:id/events is the SSE channel — src/events-bus.ts; POST
 * /sessions/:idOrNew/messages is the chat turn — src/routes/chat.ts.)
 */

// ---------------------------------------------------------------------------
// Opaque cursors (base64url JSON, validated on decode)
// ---------------------------------------------------------------------------

const sessionListCursorSchema = z.object({
  /** last_message_at ISO of the last row, or null when paging the null tail. */
  m: z.string().datetime({ offset: true }).nullable(),
  id: z.string().uuid(),
});
export type SessionListCursor = z.infer<typeof sessionListCursorSchema>;

const messagesCursorSchema = z.object({
  /** created_at ISO of the OLDEST message the client already has. */
  t: z.string().datetime({ offset: true }),
  /** Provider sequence for equal-timestamp channel messages; null for webchat. */
  q: z.number().int().nonnegative().nullable().optional(),
  id: z.string().uuid(),
});
export type MessagesCursor = z.infer<typeof messagesCursorSchema>;

function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function fromBase64Url(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

export function encodeCursor(cursor: SessionListCursor | MessagesCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

function decodeCursor<T>(schema: z.ZodType<T>, encoded: string): T {
  let json: unknown;
  try {
    json = JSON.parse(fromBase64Url(encoded));
  } catch {
    throw new ApiError(400, 'bad_cursor', 'Malformed pagination cursor');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(400, 'bad_cursor', 'Malformed pagination cursor');
  return parsed.data;
}

export const decodeSessionListCursor = (encoded: string): SessionListCursor =>
  decodeCursor(sessionListCursorSchema, encoded);
export const decodeMessagesCursor = (encoded: string): MessagesCursor =>
  decodeCursor(messagesCursorSchema, encoded);

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

const isoOrNull = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toAccountSummary(row: {
  id: string;
  type: string;
  username: string;
  userImage: string | null;
}): AccountSummary {
  return {
    id: row.id,
    type: row.type === 'agent' ? 'agent' : 'user',
    username: row.username,
    userImage: row.userImage,
  };
}

export function toSessionDto(
  row: Session,
  members: { agentIds: string[]; userIds: string[]; agents?: AccountSummary[] },
): SessionDto {
  return {
    id: row.id,
    externalId: row.externalId,
    ownerId: row.ownerId,
    title: row.title,
    status: row.status,
    sessionType: row.sessionType,
    platform: row.platform,
    channelConnectionId: row.channelConnectionId,
    readOnly: row.channelConnectionId !== null || row.sessionType === 'channel',
    agentIds: members.agentIds,
    userIds: members.userIds,
    ...(members.agents ? { agents: members.agents } : {}),
    lastMessageAt: isoOrNull(row.lastMessageAt),
    messageCount: row.messageCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Normalize the `attachments` jsonb column. Migrated eden1 rows store an
 * array of URL STRINGS (verified against live data); eden3-native rows store
 * `MessageAttachment`-shaped objects. Anything else is dropped.
 */
export function toAttachments(raw: unknown): MessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageAttachment[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.length > 0) out.push({ url: item });
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      if (typeof record.url === 'string' && record.url.length > 0) {
        out.push({
          url: record.url,
          ...(typeof record.mime === 'string' ? { mime: record.mime } : {}),
          ...(typeof record.creationId === 'string' ? { creationId: record.creationId } : {}),
          ...(typeof record.width === 'number' && record.width > 0 ? { width: record.width } : {}),
          ...(typeof record.height === 'number' && record.height > 0 ? { height: record.height } : {}),
        });
      }
    }
  }
  return out;
}

export function toMessageDto(row: Message, sender?: AccountSummary): MessageDto {
  return {
    id: row.id,
    externalId: row.externalId,
    sessionId: row.sessionId,
    senderId: row.senderId,
    role: row.role,
    content: row.content,
    attachments: toAttachments(row.attachments),
    toolCalls: Array.isArray(row.toolCalls)
      ? (row.toolCalls as Array<Record<string, unknown>>)
      : null,
    reactions:
      row.reactions && typeof row.reactions === 'object' && !Array.isArray(row.reactions)
        ? (row.reactions as Record<string, unknown>)
        : null,
    replyToExternalId: row.replyToExternalId,
    ...(sender ? { sender } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Membership helpers
// ---------------------------------------------------------------------------

export interface SessionMembers {
  agentIds: string[];
  userIds: string[];
  agents: AccountSummary[];
}

/** Batch-load memberships (+ agent account summaries) for a page of sessions. */
async function loadMembers(sessionIds: string[]): Promise<Map<string, SessionMembers>> {
  const map = new Map<string, SessionMembers>();
  for (const id of sessionIds) map.set(id, { agentIds: [], userIds: [], agents: [] });
  if (sessionIds.length === 0) return map;

  const agentRows = await db
    .select({
      sessionId: sessionAgents.sessionId,
      id: accounts.id,
      type: accounts.type,
      username: accounts.username,
      userImage: accounts.userImage,
    })
    .from(sessionAgents)
    .innerJoin(accounts, eq(accounts.id, sessionAgents.agentAccountId))
    .where(inArray(sessionAgents.sessionId, sessionIds));
  for (const row of agentRows) {
    const entry = map.get(row.sessionId);
    if (!entry) continue;
    entry.agentIds.push(row.id);
    entry.agents.push(toAccountSummary(row));
  }

  const userRows = await db
    .select({ sessionId: sessionUsers.sessionId, userAccountId: sessionUsers.userAccountId })
    .from(sessionUsers)
    .where(inArray(sessionUsers.sessionId, sessionIds));
  for (const row of userRows) {
    map.get(row.sessionId)?.userIds.push(row.userAccountId);
  }

  return map;
}

/** owner, member (session_users), or admin — everyone else is denied. */
export async function canAccessSession(
  session: Session,
  account: { accountId: string; isAdmin: boolean },
): Promise<boolean> {
  if (account.isAdmin) return true;
  if (session.ownerId === account.accountId) return true;
  const [member] = await db
    .select({ userAccountId: sessionUsers.userAccountId })
    .from(sessionUsers)
    .where(
      and(
        eq(sessionUsers.sessionId, session.id),
        eq(sessionUsers.userAccountId, account.accountId),
      ),
    )
    .limit(1);
  return member !== undefined;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const detailQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const sessionsRoutes: FastifyPluginAsync = async (app) => {
  // GET /sessions — the caller's sessions, newest activity first.
  app.get('/', { preHandler: app.requireAuth }, async (req) => {
    const { cursor: rawCursor, limit } = listQuerySchema.parse(req.query);
    const me = req.account!.accountId;
    const cursor = rawCursor ? decodeSessionListCursor(rawCursor) : null;

    const conditions = [
      eq(sessions.deleted, false),
      sql`${sessions.visible} is distinct from false`,
      sql`(${sessions.ownerId} = ${me} or exists (
        select 1 from ${sessionUsers}
        where ${sessionUsers.sessionId} = ${sessions.id}
          and ${sessionUsers.userAccountId} = ${me}
      ))`,
    ];
    if (cursor) {
      // Keyset over (last_message_at desc nulls last, id desc).
      conditions.push(
        cursor.m === null
          ? sql`(${sessions.lastMessageAt} is null and ${sessions.id} < ${cursor.id})`
          : sql`(${sessions.lastMessageAt} < ${cursor.m}::timestamptz
              or (${sessions.lastMessageAt} = ${cursor.m}::timestamptz and ${sessions.id} < ${cursor.id})
              or ${sessions.lastMessageAt} is null)`,
      );
    }

    const rows = await db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(sql`${sessions.lastMessageAt} desc nulls last`, desc(sessions.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const members = await loadMembers(page.map((row) => row.id));
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor({ m: isoOrNull(last.lastMessageAt), id: last.id })
        : null;

    return {
      sessions: page.map((row) =>
        toSessionDto(row, members.get(row.id) ?? { agentIds: [], userIds: [], agents: [] }),
      ),
      nextCursor,
    };
  });

  // GET /sessions/:id — session + newest messages (ascending within the page).
  app.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireAuth },
    async (req) => {
      const { cursor: rawCursor, limit } = detailQuerySchema.parse(req.query);
      const session = await resolveSession(req.params.id);
      if (!session) throw new ApiError(404, 'not_found', 'Session not found');
      if (!(await canAccessSession(session, req.account!))) {
        throw new ApiError(403, 'forbidden', 'You do not have access to this session');
      }
      const cursor = rawCursor ? decodeMessagesCursor(rawCursor) : null;

      // Fetch newest-first, then reverse. Channel providers can deliver events
      // out of order or with equal timestamps, so source_sequence precedes the
      // UUID fallback whenever it is available.
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, session.id),
            cursor
              ? sql`(
                  ${messages.createdAt} < ${cursor.t}::timestamptz
                  or (
                    ${messages.createdAt} = ${cursor.t}::timestamptz
                    and (
                      coalesce(${messages.sourceSequence}, -1) < ${cursor.q ?? -1}
                      or (
                        coalesce(${messages.sourceSequence}, -1) = ${cursor.q ?? -1}
                        and ${messages.id} < ${cursor.id}::uuid
                      )
                    )
                  )
                )`
              : undefined,
          ),
        )
        .orderBy(
          desc(messages.createdAt),
          sql`coalesce(${messages.sourceSequence}, -1) desc`,
          desc(messages.id),
        )
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).reverse();
      const oldest = page[0];
      const nextCursor =
        hasMore && oldest
          ? encodeCursor({
              t: oldest.createdAt.toISOString(),
              q: oldest.sourceSequence,
              id: oldest.id,
            })
          : null;

      // Embedded summaries: senders of this page + the session's agents.
      const senderIds = [
        ...new Set(page.map((m) => m.senderId).filter((id): id is string => id !== null)),
      ];
      const senderRows = senderIds.length
        ? await db
            .select({
              id: accounts.id,
              type: accounts.type,
              username: accounts.username,
              userImage: accounts.userImage,
            })
            .from(accounts)
            .where(inArray(accounts.id, senderIds))
        : [];
      const senders = new Map(senderRows.map((row) => [row.id, toAccountSummary(row)]));
      const members = await loadMembers([session.id]);

      return {
        session: toSessionDto(
          session,
          members.get(session.id) ?? { agentIds: [], userIds: [], agents: [] },
        ),
        messages: page.map((row) =>
          toMessageDto(row, row.senderId ? senders.get(row.senderId) : undefined),
        ),
        nextCursor,
      };
    },
  );
};
