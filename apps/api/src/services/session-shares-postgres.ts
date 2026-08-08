import { pg } from '@eden3/db';
import {
  publicSessionAgentDto,
  publicSessionAttachmentDto,
  publicSessionShareDto,
  publicSessionSnapshotDto,
  sessionShareSummaryDto,
  type PublicSessionMessageDto,
  type PublicSessionShareDto,
  type PublicSessionSnapshotDto,
  type SessionShareSummaryDto,
} from '@eden3/shared';

import type {
  CreateSessionShareCommand,
  CreateSessionShareResult,
  RevokeSessionShareResult,
  SessionShareListResult,
  SessionShareRepository,
} from './session-shares';

type PgTransaction = Parameters<Parameters<typeof pg.begin>[1]>[0];

interface SessionRow {
  id: string;
  title: string | null;
}

interface MessageRow {
  id: string;
  role: string | null;
  name: string | null;
  content: string | null;
  attachments: unknown;
  created_at: string | Date;
}

interface ShareRow {
  id: string;
  session_id: string;
  mode: 'snapshot' | 'live';
  title: string | null;
  snapshot_payload: unknown;
  revoked_at: string | Date | null;
  created_at: string | Date;
}

class InvalidShareBoundaryError extends Error {}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function summary(row: ShareRow): SessionShareSummaryDto {
  return sessionShareSummaryDto.parse({
    id: row.id,
    sessionId: row.session_id,
    mode: row.mode,
    title: row.title,
    createdAt: iso(row.created_at),
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
  });
}

function publicAttachments(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const candidate =
      typeof value === 'string'
        ? { url: value, mime: null, width: null, height: null }
        : value && typeof value === 'object'
          ? {
              url: (value as Record<string, unknown>).url,
              mime: (value as Record<string, unknown>).mime ?? null,
              width: (value as Record<string, unknown>).width ?? null,
              height: (value as Record<string, unknown>).height ?? null,
            }
          : null;
    const parsed = publicSessionAttachmentDto.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function publicRole(role: string | null): PublicSessionMessageDto['role'] | null {
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  if (role === 'eden') return 'system';
  return null;
}

async function loadSnapshot(
  tx: PgTransaction,
  sessionId: string,
  boundaryMessageId: string | null,
  capturedAt: string,
): Promise<PublicSessionSnapshotDto | null> {
  const [session] = await tx<SessionRow[]>`
    select id, title
    from sessions
    where id = ${sessionId}
      and deleted = false
      and visible is distinct from false
  `;
  if (!session) return null;

  const agentRows = await tx<
    { username: string; name: string | null; user_image: string | null }[]
  >`
    select a.username::text as username, g.name, a.user_image
    from session_agents sa
    join accounts a on a.id = sa.agent_account_id and a.deleted = false
    left join agents g on g.account_id = a.id
    where sa.session_id = ${session.id}
    order by a.username
  `;
  const messages = await tx<MessageRow[]>`
    select id, role, name, content, attachments, created_at
    from messages
    where session_id = ${session.id}
    order by created_at asc, source_sequence asc nulls last, id asc
  `;
  const boundaryIndex = boundaryMessageId
    ? messages.findIndex((message) => message.id === boundaryMessageId)
    : messages.length - 1;
  if (boundaryMessageId && boundaryIndex < 0) throw new InvalidShareBoundaryError();
  const throughBoundary = messages.slice(0, boundaryIndex + 1);
  const publicMessages = throughBoundary.flatMap((message) => {
    const role = publicRole(message.role);
    if (!role) return [];
    return [
      {
        id: message.id,
        role,
        name: message.name,
        content: message.content,
        attachments: publicAttachments(message.attachments),
        createdAt: iso(message.created_at),
      } satisfies PublicSessionMessageDto,
    ];
  });
  const agents = agentRows.flatMap((agent) => {
    const parsed = publicSessionAgentDto.safeParse({
      username: agent.username,
      name: agent.name,
      userImage: agent.user_image,
    });
    if (parsed.success) return [parsed.data];
    return [{ username: agent.username, name: agent.name, userImage: null }];
  });
  return publicSessionSnapshotDto.parse({
    sessionTitle: session.title,
    agents,
    messages: publicMessages,
    boundaryMessageId: boundaryIndex < 0 ? null : messages[boundaryIndex]!.id,
    capturedAt,
  });
}

async function authorizedSession(
  tx: PgTransaction,
  sessionRef: string,
  actorId: string,
): Promise<{ status: 'ok'; session: SessionRow } | { status: 'missing' | 'forbidden' }> {
  const [session] = await tx<SessionRow[]>`
    select id, title
    from sessions
    where (id::text = ${sessionRef} or external_id = ${sessionRef})
      and deleted = false
      and visible is distinct from false
  `;
  if (!session) return { status: 'missing' };
  const [access] = await tx<{ allowed: boolean }[]>`
    select (
      exists(select 1 from sessions where id = ${session.id} and owner_id = ${actorId})
      or exists(
        select 1 from session_users
        where session_id = ${session.id} and user_account_id = ${actorId}
      )
    ) as allowed
  `;
  return access?.allowed ? { status: 'ok', session } : { status: 'forbidden' };
}

export class PostgresSessionShareRepository implements SessionShareRepository {
  async create(command: CreateSessionShareCommand): Promise<CreateSessionShareResult> {
    try {
      return await pg.begin('isolation level repeatable read', async (tx) => {
        const access = await authorizedSession(tx, command.sessionId, command.actorId);
        if (access.status !== 'ok') return access;
        const snapshot = await loadSnapshot(
          tx,
          access.session.id,
          command.boundaryMessageId,
          command.createdAt,
        );
        if (!snapshot) return { status: 'missing' } as const;
        const [row] = await tx<ShareRow[]>`
          insert into session_share_links (
            session_id, created_by, token_hash, mode, title,
            snapshot_boundary_message_id, snapshot_payload, created_at, updated_at
          ) values (
            ${access.session.id}, ${command.actorId}, ${command.tokenHash}, ${command.mode},
            ${command.title}, ${snapshot.boundaryMessageId}, ${tx.json(snapshot)},
            ${command.createdAt}, ${command.createdAt}
          )
          returning id, session_id, mode, title, snapshot_payload,
                    revoked_at, created_at
        `;
        return { status: 'created', share: summary(row!) } as const;
      });
    } catch (error) {
      if (error instanceof InvalidShareBoundaryError) return { status: 'invalid_boundary' };
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        return { status: 'token_conflict' };
      }
      throw error;
    }
  }

  async list(sessionId: string, actorId: string): Promise<SessionShareListResult> {
    return pg.begin('isolation level repeatable read read only', async (tx) => {
      const access = await authorizedSession(tx, sessionId, actorId);
      if (access.status !== 'ok') return access;
      const rows = await tx<ShareRow[]>`
        select id, session_id, mode, title, snapshot_payload, revoked_at, created_at
        from session_share_links
        where session_id = ${access.session.id}
        order by created_at desc, id desc
        limit 100
      `;
      return { status: 'ok', items: rows.map(summary) };
    });
  }

  async revoke(
    sessionId: string,
    shareId: string,
    actorId: string,
    revokedAt: string,
  ): Promise<RevokeSessionShareResult> {
    return pg.begin(async (tx) => {
      const access = await authorizedSession(tx, sessionId, actorId);
      if (access.status !== 'ok') return access;
      const [row] = await tx<ShareRow[]>`
        update session_share_links
        set revoked_at = coalesce(revoked_at, ${revokedAt}), updated_at = now()
        where id = ${shareId} and session_id = ${access.session.id}
        returning id, session_id, mode, title, snapshot_payload, revoked_at, created_at
      `;
      return row ? { status: 'revoked', share: summary(row) } : { status: 'missing' };
    });
  }

  async resolvePublic(tokenHash: string): Promise<PublicSessionShareDto | null> {
    return pg.begin('isolation level repeatable read read only', async (tx) => {
      const [row] = await tx<ShareRow[]>`
        select id, session_id, mode, title, snapshot_payload, revoked_at, created_at
        from session_share_links
        where token_hash = ${tokenHash} and revoked_at is null
        limit 1
      `;
      if (!row) return null;
      const snapshot =
        row.mode === 'snapshot'
          ? publicSessionSnapshotDto.parse(row.snapshot_payload)
          : await loadSnapshot(tx, row.session_id, null, new Date().toISOString());
      if (!snapshot) return null;
      return publicSessionShareDto.parse({
        share: {
          id: row.id,
          mode: row.mode,
          title: row.title,
          createdAt: iso(row.created_at),
        },
        snapshot,
      });
    });
  }
}
