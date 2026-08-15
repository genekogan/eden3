import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import {
  LocalMediaStore,
  normalizeMime,
  probeImageSize,
  type MediaStore,
} from '@eden3/core';
import { pg } from '@eden3/db';
import { ZipArchive } from 'archiver';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError, logSafeRequestError, sendError } from '../errors';
import {
  accountErasureRequestSchema,
  requestAccountErasure,
  type AccountErasureIntentStore,
  type AccountErasureLedgerSink,
  type AccountErasureRecoveryManifestSink,
} from '../services/account-erasure';
import {
  ALLOWED_AVATAR_MIMES,
  AVATAR_UPLOAD_BODY_LIMIT_BYTES,
  MAX_AVATAR_BYTES,
  avatarBodySchema,
  decodeAvatarData,
} from '../services/avatar-upload';

interface AccountAvatarRow {
  id: string;
  username: string;
  type: 'user' | 'agent';
  userImage: string | null;
}

const identityAvatarSchema = z.object({
  imageUrl: z.string().trim().min(1).max(4096),
});

/** Clerk copies OAuth profile photos behind this stable, first-party image host. */
export function normalizeClerkIdentityImageUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'img.clerk.com' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.hash !== '' ||
      url.pathname === '/'
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A complete, owner-scoped account export.
 *
 * The archive deliberately uses explicit safe projections instead of database
 * row objects. In particular, it never selects Clerk identifiers, gateway
 * session keys, workspace paths, channel secret material/audit rows, Stripe
 * payloads, voucher codes, or idempotency keys. Large collections are emitted
 * as NDJSON from PostgreSQL cursors so memory stays bounded by one cursor batch
 * plus stream high-water marks.
 */

export const ACCOUNT_EXPORT_VERSION = 1;
export const ACCOUNT_EXPORT_CURSOR_BATCH_SIZE = 250;

interface CursorSource<Row> {
  cursor(rows: number): AsyncIterable<Row[]>;
}

interface ExportCountRow {
  agents: string | number;
  sessions: string | number;
  messages: string | number;
  creations: string | number;
  collections: string | number;
  collection_items: string | number;
  favorite_creations: string | number;
  favorite_agents: string | number;
  manna_transactions: string | number;
}

interface SafeProfileRow {
  id: string;
  externalId: string | null;
  type: string;
  username: string;
  userImage: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface MannaSummaryRow {
  balance: string;
  subscriptionBalance: string;
  updatedAt: Date | string | null;
}

interface MessageExportRow {
  id: string;
  externalId: string | null;
  sessionId: string;
  senderId: string | null;
  role: string | null;
  content: string | null;
  name: string | null;
  attachments: unknown;
  replyToExternalId: string | null;
  createdAt: Date | string;
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function countValue(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Account export count exceeded the safe integer range');
  }
  return parsed;
}

function safeAttachments(raw: unknown): Array<Record<string, string | number>> {
  if (!Array.isArray(raw)) return [];
  const attachments: Array<Record<string, string | number>> = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item !== '') attachments.push({ url: item });
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.url !== 'string' || candidate.url === '') continue;
    attachments.push({
      url: candidate.url,
      ...(typeof candidate.mime === 'string' ? { mime: candidate.mime } : {}),
      ...(typeof candidate.creationId === 'string'
        ? { creationId: candidate.creationId }
        : {}),
      ...(typeof candidate.width === 'number' && candidate.width > 0
        ? { width: candidate.width }
        : {}),
      ...(typeof candidate.height === 'number' && candidate.height > 0
        ? { height: candidate.height }
        : {}),
    });
  }
  return attachments;
}

function messageExportJson(row: MessageExportRow): Record<string, unknown> {
  return {
    id: row.id,
    externalId: row.externalId,
    sessionId: row.sessionId,
    senderId: row.senderId,
    role: row.role,
    content: row.content,
    name: row.name,
    attachments: safeAttachments(row.attachments),
    replyToExternalId: row.replyToExternalId,
    createdAt: row.createdAt,
  };
}

function appendJson(archive: ZipArchive, name: string, value: unknown): void {
  archive.append(`${JSON.stringify(value, null, 2)}\n`, { name });
}

/** Append one cursor-backed NDJSON entry and wait until its input is drained. */
export async function appendCursorNdjson<Row>(
  archive: ZipArchive,
  name: string,
  source: CursorSource<Row>,
  map: (row: Row) => unknown = (row) => row,
): Promise<void> {
  async function* lines(): AsyncGenerator<string> {
    for await (const batch of source.cursor(ACCOUNT_EXPORT_CURSOR_BATCH_SIZE)) {
      for (const row of batch) yield `${JSON.stringify(map(row))}\n`;
    }
  }

  const input = Readable.from(lines(), { encoding: 'utf8' });
  const closeInput = (): void => {
    if (!input.readableEnded && !input.destroyed) {
      input.destroy(new Error('Account export archive closed before the entry completed'));
    }
  };
  archive.once('close', closeInput);
  archive.append(input, { name });
  // Waiting for the input stream keeps the cursor (and its transaction) alive
  // until Archiver has consumed the entry. Backpressure propagates through the
  // archive to the HTTP response rather than accumulating all rows in memory.
  try {
    await finished(input);
  } finally {
    archive.off('close', closeInput);
  }
}

async function streamAccountArchive(archive: ZipArchive, accountId: string): Promise<void> {
  await pg.begin('isolation level repeatable read read only', async (tx) => {
    const [profile] = await tx<SafeProfileRow[]>`
      select id,
             external_id as "externalId",
             type,
             username::text as username,
             user_image as "userImage",
             created_at as "createdAt",
             updated_at as "updatedAt"
      from accounts
      where id = ${accountId} and deleted = false
      limit 1
    `;
    if (!profile) throw new ApiError(404, 'account_not_found', 'Account not found');

    // Data portability is intentionally broader than GET /sessions: include
    // hidden/archived/deleted rows that remain in the database, but only when
    // the account owns the session or is still an explicit member.
    const accountSessionScope = tx`
      s.owner_id = ${accountId}
      or exists (
        select 1
        from session_users scoped_su
        where scoped_su.session_id = s.id
          and scoped_su.user_account_id = ${accountId}
      )
    `;

    const [rawCounts] = await tx<ExportCountRow[]>`
      select
        (select count(*)::int8
           from agents g join accounts a on a.id = g.account_id
          where a.deleted = false and (g.owner_id = ${accountId} or a.id = ${accountId})) as agents,
        (select count(*)::int8 from sessions s where ${accountSessionScope}) as sessions,
        (select count(*)::int8
           from messages m join sessions s on s.id = m.session_id
          where ${accountSessionScope}) as messages,
        (select count(*)::int8 from creations c where c.user_id = ${accountId}) as creations,
        (select count(*)::int8 from collections k where k.user_id = ${accountId}) as collections,
        (select count(*)::int8
           from collection_creations cc
           join collections k on k.id = cc.collection_id
          where k.user_id = ${accountId}) as collection_items,
        (select count(*)::int8 from creation_likes cl where cl.user_id = ${accountId}) as favorite_creations,
        (select count(*)::int8 from agent_likes al where al.user_id = ${accountId}) as favorite_agents,
        (select count(*)::int8
           from manna_transactions mt
           join manna_accounts ma on ma.id = mt.manna_account_id
          where ma.account_id = ${accountId}) as manna_transactions
    `;
    if (!rawCounts) throw new Error('Account export count query returned no row');
    const counts = {
      agents: countValue(rawCounts.agents),
      sessions: countValue(rawCounts.sessions),
      messages: countValue(rawCounts.messages),
      creations: countValue(rawCounts.creations),
      collections: countValue(rawCounts.collections),
      collectionItems: countValue(rawCounts.collection_items),
      favoriteCreations: countValue(rawCounts.favorite_creations),
      favoriteAgents: countValue(rawCounts.favorite_agents),
      mannaTransactions: countValue(rawCounts.manna_transactions),
    };

    const [snapshot] = await tx<{ exportedAt: Date | string }[]>`
      select transaction_timestamp() as "exportedAt"
    `;
    const [manna] = await tx<MannaSummaryRow[]>`
      select coalesce(ma.balance, 0)::text as balance,
             coalesce(ma.subscription_balance, 0)::text as "subscriptionBalance",
             ma.updated_at as "updatedAt"
      from accounts a
      left join manna_accounts ma on ma.account_id = a.id
      where a.id = ${accountId}
      limit 1
    `;

    const files = {
      'agents.ndjson': { format: 'ndjson', count: counts.agents },
      'sessions.ndjson': { format: 'ndjson', count: counts.sessions },
      'messages.ndjson': { format: 'ndjson', count: counts.messages },
      'creations.ndjson': { format: 'ndjson', count: counts.creations },
      'collections.ndjson': { format: 'ndjson', count: counts.collections },
      'collection-items.ndjson': { format: 'ndjson', count: counts.collectionItems },
      'favorite-creations.ndjson': { format: 'ndjson', count: counts.favoriteCreations },
      'favorite-agents.ndjson': { format: 'ndjson', count: counts.favoriteAgents },
      'manna-transactions.ndjson': { format: 'ndjson', count: counts.mannaTransactions },
    };
    appendJson(archive, 'manifest.json', {
      kind: 'eden3.account.export',
      version: ACCOUNT_EXPORT_VERSION,
      exportedAt: snapshot?.exportedAt ?? new Date(),
      accountId: profile.id,
      counts,
      files,
      scope: {
        sessions: 'owned-or-member, including hidden-and-deleted retained rows',
        creations: 'created-by-account',
        agents: 'owned-by-account',
        collections: 'owned-by-account',
        favorites: 'liked-by-account',
      },
    });
    appendJson(archive, 'profile.json', profile);
    appendJson(archive, 'manna.json', {
      balance: manna?.balance ?? '0',
      subscriptionBalance: manna?.subscriptionBalance ?? '0',
      updatedAt: manna?.updatedAt ?? null,
    });

    await appendCursorNdjson(
      archive,
      'agents.ndjson',
      tx`
        select a.id,
               a.external_id as "externalId",
               a.username::text as username,
               a.user_image as "userImage",
               g.owner_id as "ownerId",
               g.name,
               g.description,
               g.persona,
               g.is_persona_public as "isPersonaPublic",
               g.greeting,
               g.voice,
               g.model,
               g.thinking_level as "thinkingLevel",
               g.tool_groups as "toolGroups",
               g.public,
               a.created_at as "createdAt",
               a.updated_at as "updatedAt"
        from agents g
        join accounts a on a.id = g.account_id
        where a.deleted = false and (g.owner_id = ${accountId} or a.id = ${accountId})
        order by a.created_at asc, a.id asc
      `,
    );

    await appendCursorNdjson(
      archive,
      'sessions.ndjson',
      tx`
        select s.id,
               s.external_id as "externalId",
               s.owner_id as "ownerId",
               s.title,
               s.status,
               s.session_type as "sessionType",
               s.platform,
               s.visible,
               s.deleted,
               s.pinned,
               s.trigger_external_id as "triggerExternalId",
               s.parent_session_external_id as "parentSessionExternalId",
               s.is_public as "isPublic",
               coalesce(
                 (select jsonb_agg(sa.agent_account_id order by sa.agent_account_id)
                    from session_agents sa where sa.session_id = s.id),
                 '[]'::jsonb
               ) as "agentIds",
               coalesce(
                 (select jsonb_agg(su.user_account_id order by su.user_account_id)
                    from session_users su where su.session_id = s.id),
                 '[]'::jsonb
               ) as "userIds",
               s.last_message_at as "lastMessageAt",
               s.message_count as "messageCount",
               s.created_at as "createdAt",
               s.updated_at as "updatedAt"
        from sessions s
        where ${accountSessionScope}
        order by s.created_at asc, s.id asc
      `,
    );

    await appendCursorNdjson<MessageExportRow>(
      archive,
      'messages.ndjson',
      tx<MessageExportRow[]>`
        select m.id,
               m.external_id as "externalId",
               m.session_id as "sessionId",
               m.sender_id as "senderId",
               m.role,
               m.content,
               m.name,
               m.attachments,
               m.reply_to_external_id as "replyToExternalId",
               m.created_at as "createdAt"
        from messages m
        join sessions s on s.id = m.session_id
        where ${accountSessionScope}
        order by m.created_at asc, m.id asc
      `,
      messageExportJson,
    );

    await appendCursorNdjson(
      archive,
      'creations.ndjson',
      tx`
        select c.id,
               c.external_id as "externalId",
               c.user_id as "userId",
               c.agent_id as "agentId",
               c.task_external_id as "taskExternalId",
               c.tool,
               c.url,
               c.thumbnail_url as "thumbnailUrl",
               c.like_count as "likeCount",
               c.public,
               c.deleted,
               c.created_at as "createdAt",
               c.updated_at as "updatedAt"
        from creations c
        where c.user_id = ${accountId}
        order by c.created_at asc, c.id asc
      `,
    );

    await appendCursorNdjson(
      archive,
      'collections.ndjson',
      tx`
        select k.id,
               k.external_id as "externalId",
               k.name,
               k.description,
               k.cover_creation_external_id as "coverCreationExternalId",
               k.public,
               k.deleted,
               k.created_at as "createdAt",
               k.updated_at as "updatedAt"
        from collections k
        where k.user_id = ${accountId}
        order by k.created_at asc, k.id asc
      `,
    );

    await appendCursorNdjson(
      archive,
      'collection-items.ndjson',
      tx`
        select cc.collection_id as "collectionId",
               cc.creation_id as "creationId",
               c.external_id as "creationExternalId",
               cc.position
        from collection_creations cc
        join collections k on k.id = cc.collection_id
        join creations c on c.id = cc.creation_id
        where k.user_id = ${accountId}
        order by cc.collection_id asc, cc.position asc nulls last, cc.creation_id asc
      `,
    );

    await appendCursorNdjson(
      archive,
      'favorite-creations.ndjson',
      tx`
        select cl.creation_id as "creationId",
               c.external_id as "creationExternalId",
               cl.created_at as "createdAt"
        from creation_likes cl
        join creations c on c.id = cl.creation_id
        where cl.user_id = ${accountId}
        order by cl.created_at asc, cl.creation_id asc
      `,
    );

    await appendCursorNdjson(
      archive,
      'favorite-agents.ndjson',
      tx`
        select al.agent_id as "agentId",
               a.external_id as "agentExternalId",
               a.username::text as "agentUsername",
               al.created_at as "createdAt"
        from agent_likes al
        join accounts a on a.id = al.agent_id
        where al.user_id = ${accountId}
        order by al.created_at asc, al.agent_id asc
      `,
    );

    await appendCursorNdjson(
      archive,
      'manna-transactions.ndjson',
      tx`
        select mt.id,
               mt.external_id as "externalId",
               mt.amount::text as amount,
               mt.type,
               mt.task_external_id as "taskExternalId",
               mt.refunds_transaction_id as "refundsTransactionId",
               mt.created_at as "createdAt"
        from manna_transactions mt
        join manna_accounts ma on ma.id = mt.manna_account_id
        where ma.account_id = ${accountId}
        order by mt.created_at asc, mt.id asc
      `,
    );
  });

  await archive.finalize();
}

export interface AccountRoutesOptions {
  /** Omitted in production until both dedicated WORM custody boundaries exist. */
  erasure?: {
    store: AccountErasureIntentStore;
    ledger: AccountErasureLedgerSink;
    recoveryManifestSink: AccountErasureRecoveryManifestSink;
  };
  /** Injectable for isolated route tests; production defaults to MEDIA_DIR. */
  mediaStore?: MediaStore;
}

export const accountRoutes: FastifyPluginAsync<AccountRoutesOptions> = async (app, options) => {
  let store = options.mediaStore;
  const getStore = (): MediaStore => (store ??= new LocalMediaStore());
  const userDto = (row: AccountAvatarRow, isAdmin: boolean) => ({
    id: row.id,
    username: row.username,
    type: row.type,
    userImage: row.userImage,
    isAdmin,
  });

  // Clerk/Google identity import is deliberately lower priority than an Eden
  // upload. Re-auth may refresh a Clerk-owned URL, but never overwrite a
  // durable /media avatar selected in Account Settings.
  app.patch('/avatar/identity', { preHandler: app.requireAuth, bodyLimit: 8_192 }, async (req, reply) => {
    const body = identityAvatarSchema.parse(req.body);
    const imageUrl = normalizeClerkIdentityImageUrl(body.imageUrl);
    if (!imageUrl) {
      return sendError(reply, 400, 'invalid_identity_avatar', 'Identity image URL is not trusted');
    }
    const accountId = req.account!.accountId;
    const row = await pg.begin(async (tx) => {
      const [current] = await tx<AccountAvatarRow[]>`
        select id,username::text as username,type,user_image as "userImage"
        from accounts where id=${accountId} and type='user' and deleted=false
        for update`;
      if (!current) throw new ApiError(404, 'account_not_found', 'Account not found');
      const currentIdentityUrl = current.userImage
        ? normalizeClerkIdentityImageUrl(current.userImage)
        : null;
      if (current.userImage !== null && currentIdentityUrl === null) return current;
      if (current.userImage === imageUrl) return current;
      const [updated] = await tx<AccountAvatarRow[]>`
        update accounts set user_image=${imageUrl},updated_at=statement_timestamp()
        where id=${accountId}
        returning id,username::text as username,type,user_image as "userImage"`;
      return updated ?? current;
    });
    return { user: userDto(row, req.account!.isAdmin ?? false) };
  });

  app.post(
    '/avatar',
    {
      preHandler: app.requireAuth,
      bodyLimit: AVATAR_UPLOAD_BODY_LIMIT_BYTES,
    },
    async (req, reply) => {
      const body = avatarBodySchema.parse(req.body);
      const mime = normalizeMime(body.mime);
      if (!ALLOWED_AVATAR_MIMES.has(mime)) {
        return sendError(reply, 400, 'unsupported_image_type', 'Only png, jpeg, or webp images are supported');
      }
      const buffer = decodeAvatarData(body.dataBase64);
      if (!buffer) {
        return sendError(reply, 400, 'invalid_image_data', 'dataBase64 is not valid base64');
      }
      if (buffer.length > MAX_AVATAR_BYTES) {
        return sendError(reply, 400, 'image_too_large', 'Images must be 8MB or smaller');
      }
      if (!probeImageSize(buffer)) {
        return sendError(reply, 400, 'invalid_image_data', 'File does not look like a valid png/jpeg/webp image');
      }

      const accountId = req.account!.accountId;
      const expectedSha256 = createHash('sha256').update(buffer).digest('hex');
      const row = await pg.begin(async (tx) => {
        const [current] = await tx<AccountAvatarRow[]>`
          select id,username::text as username,type,user_image as "userImage"
          from accounts where id=${accountId} and type='user' and deleted=false
          for update`;
        if (!current) throw new ApiError(409, 'account_erasure_active', 'Account deletion is in progress');
        const activeErasure = await tx`
          select 1 from account_erasure_jobs
          where account_id=${accountId} and state <> 'succeeded'
          limit 1`;
        if (activeErasure.length > 0) {
          throw new ApiError(409, 'account_erasure_active', 'Account deletion is in progress');
        }
        await tx`select account_erasure_lock_legacy_content(
          ${expectedSha256},${null},${null},${null},${null},
          ${null},${null},${null},${null},${null})`;
        const next = await getStore().put(buffer, { mime });
        if (next.sha256 !== expectedSha256) {
          throw new Error('avatar media store returned a mismatched content address');
        }
        await tx`
          update agent_avatar_assets set state='retired',retired_at=statement_timestamp(),
            updated_at=statement_timestamp()
          where agent_account_id=${accountId} and state='current'`;
        await tx`
          insert into agent_avatar_assets
            (owner_account_id,agent_account_id,url,local_path,sha256,mime,size_bytes)
          values (${accountId},${accountId},${next.url},${next.localPath},
            ${next.sha256},${next.mime},${next.sizeBytes})`;
        const [updated] = await tx<AccountAvatarRow[]>`
          update accounts set user_image=${next.url},updated_at=statement_timestamp()
          where id=${accountId}
          returning id,username::text as username,type,user_image as "userImage"`;
        return updated ?? { ...current, userImage: next.url };
      });
      return { user: userDto(row, req.account!.isAdmin ?? false) };
    },
  );

  app.delete('/avatar', { preHandler: app.requireAuth }, async (req) => {
    const accountId = req.account!.accountId;
    const row = await pg.begin(async (tx) => {
      const [current] = await tx<AccountAvatarRow[]>`
        select id,username::text as username,type,user_image as "userImage"
        from accounts where id=${accountId} and type='user' and deleted=false
        for update`;
      if (!current) throw new ApiError(404, 'account_not_found', 'Account not found');
      await tx`
        update agent_avatar_assets set state='retired',retired_at=statement_timestamp(),
          updated_at=statement_timestamp()
        where agent_account_id=${accountId} and state='current'`;
      const [updated] = await tx<AccountAvatarRow[]>`
        update accounts set user_image=null,updated_at=statement_timestamp()
        where id=${accountId}
        returning id,username::text as username,type,user_image as "userImage"`;
      return updated ?? { ...current, userImage: null };
    });
    return { user: userDto(row, req.account!.isAdmin ?? false) };
  });

  app.delete('/', { preHandler: app.requireAuth, bodyLimit: 1_024 }, async (req, reply) => {
    if (!options.erasure) {
      throw new ApiError(503, 'account_erasure_unavailable', 'Account erasure is not configured');
    }
    const body = accountErasureRequestSchema.parse(req.body);
    const account = req.account!;
    const result = await requestAccountErasure(
      {
        actorAccountId: account.accountId,
        actorUsername: account.username,
        actorIsAdmin: account.isAdmin,
        confirmUsername: body.confirmUsername,
      },
      options.erasure.store,
      options.erasure.ledger,
      options.erasure.recoveryManifestSink,
    );
    return reply.code(202).send(result);
  });

  app.get('/export', { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.account!.accountId;
    const [account] = await pg<{ username: string }[]>`
      select username::text as username
      from accounts
      where id = ${accountId} and deleted = false
      limit 1
    `;
    if (!account) throw new ApiError(404, 'account_not_found', 'Account not found');

    const archive = new ZipArchive({ zlib: { level: 6 } });
    let clientAborted = false;
    req.raw.once('aborted', () => {
      clientAborted = true;
      archive.destroy();
    });
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) {
        clientAborted = true;
        archive.destroy();
      }
    });
    archive.on('error', (err) => {
      if (!clientAborted) {
        logSafeRequestError(req.log, err, { accountId }, 'account export archive failed');
      }
    });

    // Let Fastify attach the archive to the HTTP response while the producer
    // runs. Any producer failure destroys the stream; after headers are sent a
    // partial download is safer than substituting an unrelated JSON envelope.
    void streamAccountArchive(archive, accountId).catch((error: unknown) => {
      if (!clientAborted) {
        logSafeRequestError(req.log, error, { accountId }, 'account export failed');
      }
      archive.destroy(error instanceof Error ? error : new Error('Account export failed'));
    });

    const filename = safeFilename(`${account.username}-eden3-account.zip`);
    return reply
      .header('content-type', 'application/zip')
      .header('cache-control', 'private, no-store')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(archive);
  });
};
