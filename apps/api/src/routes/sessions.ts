import {
  isHex24,
  isUuid,
  resolveAccount,
  resolveAccountByUsername,
  resolveSession,
} from '@eden3/core';
import {
  accounts,
  db,
  messages,
  sessionAgents,
  sessionUsers,
  sessions,
  usageEvents,
  type Message,
  type Session,
} from '@eden3/db';
import type { AccountSummary, MessageAttachment, MessageDto, SessionDto } from '@eden3/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors';
import { CHAT_MEDIA_EVENT_TYPE } from '../services/chat-media-authorization';

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
  /** pinned state of the last row (new cursors always include it). */
  p: z.boolean().optional(),
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

/** Keep a session read available even when the local gateway is unhealthy. */
export async function waitForBestEffortHistoryRefresh(
  refresh: Promise<unknown>,
  timeoutMs = 2_500,
): Promise<'completed' | 'failed' | 'timed_out'> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), timeoutMs);
    timer.unref?.();
  });
  const settled = refresh.then(
    () => 'completed' as const,
    () => 'failed' as const,
  );
  const outcome = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return outcome;
}

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
    pinned: row.pinned === true,
    archivedAt: isoOrNull(row.archivedAt),
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
  /** Filter to sessions this agent participates in (username, uuid, or legacy 24-hex id). */
  agent: z.string().trim().min(1).max(200).optional(),
  /** Active is the normal rail; archived is the reversible archive view. */
  archived: z.enum(['active', 'archived']).default('active'),
});

const updateSessionBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.pinned !== undefined || value.archived !== undefined,
    'At least one conversation change is required',
  );

/** Resolve an agent reference to an accounts.id, or null when unknown. */
async function resolveAgentRef(ref: string): Promise<string | null> {
  if (isUuid(ref)) return ref.toLowerCase();
  if (isHex24(ref)) return (await resolveAccount(ref))?.id ?? null;
  return (await resolveAccountByUsername(ref))?.id ?? null;
}

const detailQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const sessionsRoutes: FastifyPluginAsync = async (app) => {
  // GET /sessions — the caller's sessions, newest activity first.
  app.get('/', { preHandler: app.requireAuth }, async (req) => {
    const { cursor: rawCursor, limit, agent, archived } = listQuerySchema.parse(req.query);
    const me = req.account!.accountId;
    const cursor = rawCursor ? decodeSessionListCursor(rawCursor) : null;

    let agentId: string | null = null;
    if (agent !== undefined) {
      agentId = await resolveAgentRef(agent);
      if (agentId === null) return { sessions: [], nextCursor: null };
    }

    const conditions = [
      eq(sessions.deleted, false),
      sql`${sessions.visible} is distinct from false`,
      archived === 'archived'
        ? sql`${sessions.archivedAt} is not null`
        : sql`${sessions.archivedAt} is null`,
      sql`(${sessions.ownerId} = ${me} or exists (
        select 1 from ${sessionUsers}
        where ${sessionUsers.sessionId} = ${sessions.id}
          and ${sessionUsers.userAccountId} = ${me}
      ))`,
    ];
    if (agentId !== null) {
      conditions.push(
        sql`exists (
          select 1 from ${sessionAgents}
          where ${sessionAgents.sessionId} = ${sessions.id}
            and ${sessionAgents.agentAccountId} = ${agentId}
        )`,
      );
    }
    if (cursor) {
      // Keyset over (pinned desc, last_message_at desc nulls last, id desc).
      const activityTail =
        cursor.m === null
          ? sql`(${sessions.lastMessageAt} is null and ${sessions.id} < ${cursor.id})`
          : sql`(${sessions.lastMessageAt} < ${cursor.m}::timestamptz
              or (${sessions.lastMessageAt} = ${cursor.m}::timestamptz and ${sessions.id} < ${cursor.id})
              or ${sessions.lastMessageAt} is null)`;
      conditions.push(
        cursor.p
          ? sql`((coalesce(${sessions.pinned}, false) = true and ${activityTail})
              or coalesce(${sessions.pinned}, false) = false)`
          : sql`(coalesce(${sessions.pinned}, false) = false and ${activityTail})`,
      );
    }

    const rows = await db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(
        sql`coalesce(${sessions.pinned}, false) desc`,
        sql`${sessions.lastMessageAt} desc nulls last`,
        desc(sessions.id),
      )
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const members = await loadMembers(page.map((row) => row.id));
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor({ p: last.pinned === true, m: isoOrNull(last.lastMessageAt), id: last.id })
        : null;

    return {
      sessions: page.map((row) =>
        toSessionDto(row, members.get(row.id) ?? { agentIds: [], userIds: [], agents: [] }),
      ),
      nextCursor,
    };
  });

  // PATCH /sessions/:id — rename, pin, and reversibly archive one owned chat.
  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireAuth },
    async (req) => {
      const body = updateSessionBodySchema.parse(req.body);
      const session = await resolveSession(req.params.id);
      if (!session) throw new ApiError(404, 'not_found', 'Session not found');
      const account = req.account!;
      if (!account.isAdmin && session.ownerId !== account.accountId) {
        throw new ApiError(403, 'forbidden', 'Only the conversation owner can manage it');
      }

      const changes: Partial<typeof sessions.$inferInsert> = { updatedAt: new Date() };
      if (body.title !== undefined) changes.title = body.title;
      if (body.pinned !== undefined) changes.pinned = body.pinned;
      if (body.archived !== undefined) changes.archivedAt = body.archived ? new Date() : null;

      const [updated] = await db
        .update(sessions)
        .set(changes)
        .where(and(eq(sessions.id, session.id), eq(sessions.deleted, false)))
        .returning();
      if (!updated) throw new ApiError(404, 'not_found', 'Session not found');
      const members = await loadMembers([updated.id]);
      return {
        session: toSessionDto(
          updated,
          members.get(updated.id) ?? { agentIds: [], userIds: [], agents: [] },
        ),
      };
    },
  );

  // DELETE /sessions/:id — the existing data model uses recoverable soft deletion.
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const session = await resolveSession(req.params.id);
      if (!session) throw new ApiError(404, 'not_found', 'Session not found');
      const account = req.account!;
      if (!account.isAdmin && session.ownerId !== account.accountId) {
        throw new ApiError(403, 'forbidden', 'Only the conversation owner can delete it');
      }
      await db
        .update(sessions)
        .set({ deleted: true, pinned: false, updatedAt: new Date() })
        .where(and(eq(sessions.id, session.id), eq(sessions.deleted, false)));
      return reply.code(204).send();
    },
  );

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

      // Trailing-sync timers are intentionally in-memory. A restart or a
      // provider completion at the edge of that window must still heal when
      // the user reloads the conversation. Refresh only the newest page,
      // after authorization, and keep this read available if the local
      // gateway is slow/down.
      if (!cursor && app.historySync && session.gatewaySessionKey) {
        const refresh = app.historySync.syncSession({
          session: { id: session.id, gatewaySessionKey: session.gatewaySessionKey },
        });
        const outcome = await waitForBestEffortHistoryRefresh(refresh);
        if (outcome === 'failed') {
          req.log.warn({ sessionId: session.id }, 'session history refresh failed');
        } else if (outcome === 'timed_out') {
          req.log.warn({ sessionId: session.id }, 'session history refresh timed out');
        }
      }

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
      const pendingRows = !cursor
        ? await db
            .select({ metadata: usageEvents.metadata, createdAt: usageEvents.createdAt })
            .from(usageEvents)
            .where(
              and(
                eq(usageEvents.eventType, CHAT_MEDIA_EVENT_TYPE),
                eq(usageEvents.sessionId, session.id),
                inArray(usageEvents.status, ['pending', 'provider_admitted']),
              ),
            )
            .orderBy(usageEvents.createdAt)
            .limit(8)
        : [];
      const pendingMedia = pendingRows.flatMap((row) => {
        const metadata = row.metadata;
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
        const tool = (metadata as { tool?: unknown }).tool;
        if (
          tool !== 'image_generate' &&
          tool !== 'video_generate' &&
          tool !== 'music_generate'
        ) return [];
        return [{ tool, createdAt: row.createdAt.toISOString() }];
      });

      return {
        session: toSessionDto(
          session,
          members.get(session.id) ?? { agentIds: [], userIds: [], agents: [] },
        ),
        messages: page.map((row) =>
          toMessageDto(row, row.senderId ? senders.get(row.senderId) : undefined),
        ),
        nextCursor,
        pendingMedia,
      };
    },
  );
};
