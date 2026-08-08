import path from 'node:path';

import {
  LocalMediaStore,
  type DbHandle,
  type LedgerResult,
  type MediaStore,
  type PricedAction,
} from '@eden3/core';
import {
  creations,
  db,
  mediaAssets,
  messages,
  sessions,
  type Creation,
  type MediaAsset,
  type Message,
} from '@eden3/db';
import type { SessionEvent } from '@eden3/shared';
import { eq, sql } from 'drizzle-orm';

import {
  completePendingChatMedia,
  hasPendingChatMediaAuthorization,
} from './chat-media-authorization';
import { stripAttachmentLines } from './history-sync';

/**
 * Media ingest pipeline — the single write path for generated files.
 *
 * Every file the OpenClaw gateway drops on disk (async image/video/music/tts
 * tools) enters eden3 through {@link MediaPipeline.ingestFile}, whether it was
 * correlated to a chat session (media watcher) or claimed by a direct studio
 * generation (POST /studio/generate). The pipeline:
 *
 *   1. content-addresses the file into MEDIA_DIR via @eden3/core
 *      LocalMediaStore (sha256 filename; idempotent copy),
 *   2. upserts the `media_assets` ledger row (sha256-unique),
 *   3. when correlated to a principal, creates a `creations` row
 *      (user = session owner for in-chat media, the caller for studio),
 *   4. when correlated to a session, appends an assistant `messages` row with
 *      `attachments: [{url, mime, kind, creationId, width?, height?}]` and
 *      publishes `media.attached` (+ `manna.updated` after the debit) on the
 *      per-session events bus,
 *   5. settles the exact durable chat-media authorization that the gateway's
 *      before_tool_call hook committed before provider execution. Settlement,
 *      usage attribution, creation, message, and asset correlation share one
 *      transaction; a file without that authorization is parked, never gifted.
 *
 * Deliberate policy decisions (documented, not accidental):
 * - Studio generations are debited UP FRONT by the route (before the tool is
 *   invoked, so failures can be refunded); sessionless ingests therefore never
 *   debit here.
 * - Chat media is never post-billed. A missing/consumed authorization parks
 *   the file without a session, creation, or message. The provider hook fails
 *   closed, and the stale reservation reaper refunds provider/file failures.
 * - Dedupe: one `media_assets` row per sha256. Re-observing an already-fully-
 *   ingested file in the same correlation context is a no-op (`deduped:
 *   true`). A file parked WITHOUT a session that is later correlated (e.g. by
 *   a history-sync pass) gets its creation/message created then — the asset
 *   row's null correlation columns are filled in, first writer wins.
 * - Attach mode (`messageId` option): when history-sync already persisted the
 *   gateway completion message that references the file (see
 *   services/history-sync.ts AttachmentSighting), the attachment is appended
 *   to THAT row instead of inserting a new assistant message, and the row's
 *   sender doubles as the creation's agent when the caller didn't name one.
 */

// ---------------------------------------------------------------------------
// Mime / kind / pricing helpers
// ---------------------------------------------------------------------------

/** Coarse attachment kind derived from a mime type (drives UI + claims). */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

const EXTENSION_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

/** Best-effort mime type from a file path's extension (fallback octet-stream). */
export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MIMES[ext] ?? 'application/octet-stream';
}

/** Map a mime type onto the coarse {@link AttachmentKind}. */
export function attachmentKindForMime(mime: string): AttachmentKind {
  const normalized = mime.toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Canonical OpenClaw media tool names → manna pricing actions. */
const TOOL_ACTIONS: Record<string, PricedAction> = {
  image_generate: 'image',
  video_generate: 'video',
  music_generate: 'music',
  tts: 'tts',
};

/**
 * Pricing action for a tool name, else a conservative fallback by attachment
 * kind: image→image, video→video, audio→tts (the CHEAPEST audio action — an
 * unattributable audio file must never be billed at music rates), file→null
 * (no charge for unknown artifacts).
 */
export function pricedActionForTool(
  tool: string | null | undefined,
  kind: AttachmentKind,
): PricedAction | null {
  if (tool && TOOL_ACTIONS[tool]) return TOOL_ACTIONS[tool];
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'tts';
  return null;
}

/**
 * Refund-safe idempotency key for the in-chat media debit: one charge per
 * (file content, session) pair no matter how many times the watcher or a
 * history-sync pass re-observes the file.
 */
export function mediaDebitIdempotencyKey(sha256: string, sessionId: string): string {
  return `media:${sha256}:${sessionId}`;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Structural slice of the api EventsBus (fakes stay trivial in tests). */
export interface SessionEventPublisher {
  publish(sessionId: string, event: SessionEvent): number;
}

export interface MediaLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const silentLogger: MediaLogger = { info() {}, warn() {}, error() {} };

export interface MediaPipelineOptions {
  /** Media store (default: LocalMediaStore over env MEDIA_DIR/MEDIA_BASE_URL). */
  store?: MediaStore;
  /** Database handle (default: the shared drizzle client). */
  db?: DbHandle;
  /** Per-session SSE bus for media.attached / manna.updated fan-out. */
  bus?: SessionEventPublisher | null;
  logger?: MediaLogger;
}

export interface IngestFileOptions {
  /** eden3 session the file belongs to (in-chat media). */
  sessionId?: string | null;
  /**
   * Existing `messages.id` to attach to (history-sync sighting flow). The
   * attachment is appended to this row's `attachments` instead of inserting
   * a new assistant message. Requires `sessionId`; ignored (with a new
   * message row created) when the row is missing or in another session.
   */
  messageId?: string | null;
  /** accounts.id of the generating agent (message sender + creations.agent). */
  agentAccountId?: string | null;
  /**
   * accounts.id the creation belongs to when there is NO session (studio
   * flow: `creations.user = current user`). Ignored when sessionId is set —
   * in-chat creations always belong to the session owner.
   */
  userId?: string | null;
  /** Tool that produced the file, e.g. "image_generate" (nullable — parked). */
  tool?: string | null;
  /** Generation args, stored verbatim on the creation row. */
  args?: Record<string, unknown> | null;
  /**
   * Optional durable finalize fence. It runs inside the same DB transaction
   * that commits the creation/message/asset correlation. Throwing rolls all
   * of those rows back. Studio uses this to make creation + billing terminal
   * truth atomic; other ingest callers pay no extra abstraction cost.
   */
  finalizeTransaction?: (
    tx: DbHandle,
    result: { asset: MediaAsset; creation: Creation | null; message: Message | null },
  ) => Promise<void>;
}

export interface IngestFileResult {
  asset: MediaAsset;
  /** Present when the file was correlated to a principal (session or user). */
  creation: Creation | null;
  /** Present when the file was correlated to a session. */
  message: Message | null;
  /** Servable URL (`<MEDIA_BASE_URL>/<sha256><ext>`). */
  url: string;
  mime: string;
  kind: AttachmentKind;
  sha256: string;
  /** Session owner that was debited (null when nothing was charged). */
  billedAccountId: string | null;
  /** Durable chat-media authorization consumed by this artifact. */
  mediaAuthorizationId: string | null;
  /** @deprecated Chat media is pre-authorized; retained for DTO compatibility. */
  debit: LedgerResult | null;
  /** @deprecated Missing authorization parks the file instead of post-billing. */
  debitError: null;
  /** True when this exact content was already ingested in this context. */
  deduped: boolean;
}

export class MediaPipeline {
  private readonly store: MediaStore;
  private readonly db: DbHandle;
  private readonly bus: SessionEventPublisher | null;
  private readonly log: MediaLogger;

  constructor(opts: MediaPipelineOptions = {}) {
    this.store = opts.store ?? new LocalMediaStore();
    this.db = opts.db ?? db;
    this.bus = opts.bus ?? null;
    this.log = opts.logger ?? silentLogger;
  }

  /**
   * Ingest a file from the gateway data dir (or anywhere on disk) into eden3.
   * See the module docblock for the full contract. Never deletes the source
   * file — the gateway owns its own directory.
   */
  async ingestFile(hostPath: string, opts: IngestFileOptions = {}): Promise<IngestFileResult> {
    const mime = mimeForPath(hostPath);
    const put = await this.store.put(hostPath, { mime });
    const kind = attachmentKindForMime(put.mime);

    // --- resolve session + pre-provider authorization ------------------
    let sessionId = opts.sessionId ?? null;
    let sessionOwnerId: string | null = null;
    if (sessionId) {
      const [session] = await this.db
        .select({ id: sessions.id, ownerId: sessions.ownerId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!session) {
        this.log.warn(
          `media-pipeline: session ${sessionId} not found for ${hostPath} — parking asset without a session`,
        );
        sessionId = null;
      } else {
        sessionOwnerId = session.ownerId;
      }
    }
    const action = pricedActionForTool(opts.tool, kind);
    if (
      sessionId &&
      (!action ||
        action === 'chatTurn' ||
        !(await hasPendingChatMediaAuthorization({ sessionId, action, db: this.db })))
    ) {
      this.log.warn(
        `media-pipeline: no pending authorization for ${action ?? 'unknown'} in session ${sessionId} — parking ${hostPath}`,
      );
      sessionId = null;
      sessionOwnerId = null;
    }
    const creationUserId = sessionId ? sessionOwnerId : (opts.userId ?? null);
    const correlated = sessionId !== null || (opts.userId ?? null) !== null;

    // --- resolve the attach-target message (history-sync sighting flow) --
    let attachTo: Message | null = null;
    let agentAccountId = opts.agentAccountId ?? null;
    if (opts.messageId && sessionId) {
      const [row] = await this.db
        .select()
        .from(messages)
        .where(eq(messages.id, opts.messageId))
        .limit(1);
      if (row && row.sessionId === sessionId) {
        attachTo = row;
        agentAccountId ??= row.senderId; // completion message sender = agent
      } else {
        this.log.warn(
          `media-pipeline: attach target ${opts.messageId} missing or in another session — inserting a new message for ${hostPath}`,
        );
      }
    }

    // --- dedupe against the sha256 ledger -------------------------------
    const [existing] = await this.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.sha256, put.sha256))
      .limit(1);

    if (existing) {
      const sameSession = (existing.sessionId ?? null) === sessionId;
      const alreadyComplete = sameSession && (existing.creationId !== null || !correlated);
      if (alreadyComplete) {
        // Late history-sync sighting: the watcher already ingested this file
        // and parked it on a standalone media message BEFORE the streamed
        // completion row was stamped. Now that we have the real completion row
        // (attachTo) and the asset lives on a DIFFERENT (orphan) message,
        // re-home the attachment onto the completion row and strip its
        // sentinel line — no new creation, no re-charge (idempotent).
        if (attachTo && existing.messageId && existing.messageId !== attachTo.id) {
          const rehomed = await this.rehomeAttachment({
            sessionId: sessionId as string,
            asset: existing,
            orphanMessageId: existing.messageId,
            completion: attachTo,
            kind,
          });
          if (this.bus && rehomed.creation) {
            try {
              this.bus.publish(sessionId as string, {
                type: 'media.attached',
                sessionId: sessionId as string,
                messageId: attachTo.id,
                url: put.url,
                mime: put.mime,
                creationId: rehomed.creation.id,
              });
            } catch (err) {
              this.log.error(
                `media-pipeline: rehome event publish failed for ${put.sha256}: ${String(err)}`,
              );
            }
          }
          return {
            asset: existing,
            creation: rehomed.creation,
            message: rehomed.completion,
            url: put.url,
            mime: put.mime,
            kind,
            sha256: put.sha256,
            billedAccountId: null,
            mediaAuthorizationId: null,
            debit: null,
            debitError: null,
            deduped: true,
          };
        }

        // Same content, same correlation context, nothing left to write.
        let creation: Creation | null = null;
        if (existing.creationId) {
          const [row] = await this.db
            .select()
            .from(creations)
            .where(eq(creations.id, existing.creationId))
            .limit(1);
          creation = row ?? null;
        }
        const result = {
          asset: existing,
          creation,
          message: null,
          url: put.url,
          mime: put.mime,
          kind,
          sha256: put.sha256,
          billedAccountId: null,
          mediaAuthorizationId: null,
          debit: null,
          debitError: null,
          deduped: true,
        };
        if (opts.finalizeTransaction) {
          await this.db.transaction(async (tx) => {
            await opts.finalizeTransaction?.(tx, {
              asset: existing,
              creation,
              message: null,
            });
          });
        }
        return result;
      }
    }

    // --- rows (creation + message + asset) in one transaction -----------
    const attachment = {
      url: put.url,
      mime: put.mime,
      kind,
      ...(put.width !== undefined ? { width: put.width } : {}),
      ...(put.height !== undefined ? { height: put.height } : {}),
    };

    const txResult = await this.db.transaction(async (tx) => {
      // CLAIM THE SHA256 SLOT FIRST. `media_assets.sha256` is UNIQUE, so this
      // upsert serializes concurrent ingests of the SAME new file: the loser
      // blocks on the row lock, then its ON CONFLICT DO UPDATE returns the
      // WINNER's row (already carrying a creationId/session). We read that back
      // to decide whether a creation/message still needs writing — this is what
      // makes a concurrent double-ingest yield exactly ONE creation (W2 #7).
      // sessionId/messageId/creationId are seeded null here and set below once
      // known; coalesce preserves an existing (winner's) value.
      const [claimed] = await tx
        .insert(mediaAssets)
        .values({
          sourcePath: hostPath,
          localPath: put.localPath,
          url: put.url,
          sha256: put.sha256,
          mime: put.mime,
          width: put.width ?? null,
          height: put.height ?? null,
          sizeBytes: put.sizeBytes,
          sessionId,
          messageId: null,
          creationId: null,
        })
        .onConflictDoUpdate({
          target: mediaAssets.sha256,
          // Touch source_path only (no-op-safe) so the conflicting row is
          // locked + returned; correlation columns are filled in explicitly
          // below, first-writer-wins.
          set: { sourcePath: sql`coalesce(${mediaAssets.sourcePath}, excluded.source_path)` },
        })
        .returning();
      if (!claimed) throw new Error('media-pipeline: media_assets upsert returned no row');

      // A concurrent/earlier call for THIS sha in THIS session already created
      // the creation — reuse it, write nothing new (idempotent short-circuit).
      const claimedSameSession = (claimed.sessionId ?? null) === sessionId;
      if (claimed.creationId !== null && claimedSameSession) {
        const [existingCreation] = await tx
          .select()
          .from(creations)
          .where(eq(creations.id, claimed.creationId))
          .limit(1);
        const result = {
          asset: claimed,
          creation: existingCreation ?? null,
          message: null,
          raced: true as const,
        };
        await opts.finalizeTransaction?.(tx, result);
        return result;
      }

      let creationRow: Creation | null = null;
      if (correlated) {
        const [inserted] = await tx
          .insert(creations)
          .values({
            userId: creationUserId,
            agentId: agentAccountId,
            tool: opts.tool ?? null,
            args: opts.args ?? null,
            filename: path.basename(hostPath),
            url: put.url,
            mediaAttributes: {
              mime: put.mime,
              sizeBytes: put.sizeBytes,
              sha256: put.sha256,
              ...(put.width !== undefined ? { width: put.width } : {}),
              ...(put.height !== undefined ? { height: put.height } : {}),
            },
            // Eden semantics: generated media lands in the internal Explore
            // feed immediately. There is no separate publish step.
            public: true,
          })
          .returning();
        if (!inserted) throw new Error('media-pipeline: creations insert returned no row');
        creationRow = inserted;
      }

      let messageRow: Message | null = null;
      if (sessionId) {
        const fullAttachment = { ...attachment, creationId: creationRow?.id ?? null };
        if (attachTo) {
          // Append to the existing (history-synced) completion message and
          // strip its `MEDIA:`/`Attachment:` sentinel line (the raw container
          // path is a gateway artifact, not user text). The row was already
          // counted when it was inserted.
          const cleaned = stripAttachmentLines(attachTo.content ?? '') || null;
          const [updated] = await tx
            .update(messages)
            .set({
              content: cleaned,
              attachments: sql`coalesce(${messages.attachments}, '[]'::jsonb) || ${JSON.stringify([fullAttachment])}::jsonb`,
            })
            .where(eq(messages.id, attachTo.id))
            .returning();
          if (!updated) throw new Error('media-pipeline: attachment update returned no row');
          messageRow = updated;
        } else {
          const [inserted] = await tx
            .insert(messages)
            .values({
              sessionId,
              senderId: agentAccountId,
              role: 'assistant',
              content: null,
              attachments: [fullAttachment],
            })
            .returning();
          if (!inserted) throw new Error('media-pipeline: messages insert returned no row');
          messageRow = inserted;

          await tx
            .update(sessions)
            .set({
              lastMessageAt: new Date(),
              messageCount: sql`${sessions.messageCount} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(sessions.id, sessionId));
        }
      }

      // Fill the correlation columns onto the claimed asset row (first writer
      // wins via coalesce — a racing late-correlation cannot clobber them).
      const [assetRow] = await tx
        .update(mediaAssets)
        .set({
          sessionId: sql`coalesce(${mediaAssets.sessionId}, ${sessionId})`,
          messageId: sql`coalesce(${mediaAssets.messageId}, ${messageRow?.id ?? null})`,
          creationId: sql`coalesce(${mediaAssets.creationId}, ${creationRow?.id ?? null})`,
        })
        .where(eq(mediaAssets.sha256, put.sha256))
        .returning();
      if (!assetRow) throw new Error('media-pipeline: media_assets update returned no row');

      const mediaAuthorization =
        sessionId && action && action !== 'chatTurn'
          ? await completePendingChatMedia(tx, {
              sessionId,
              action,
              messageId: messageRow?.id ?? null,
              creationId: creationRow?.id ?? null,
              observedTool: opts.tool ?? null,
            })
          : null;
      if (sessionId && !mediaAuthorization) {
        throw new Error(
          `media-pipeline: pending ${action ?? 'unknown'} authorization disappeared for session ${sessionId}`,
        );
      }

      const result = {
        asset: assetRow,
        creation: creationRow,
        message: messageRow,
        mediaAuthorization,
        raced: false as const,
      };
      await opts.finalizeTransaction?.(tx, result);
      return result;
    });
    const { asset, creation, message } = txResult;

    const mediaAuthorization = 'mediaAuthorization' in txResult ? txResult.mediaAuthorization : null;
    const billedAccountId = mediaAuthorization?.accountId ?? null;

    // --- SSE fan-out ------------------------------------------------------
    if (this.bus && sessionId && message && creation) {
      try {
        this.bus.publish(sessionId, {
          type: 'media.attached',
          sessionId,
          messageId: message.id,
          url: put.url,
          mime: put.mime,
          creationId: creation.id,
        });
        if (mediaAuthorization && billedAccountId) {
          this.bus.publish(sessionId, {
            type: 'manna.updated',
            accountId: billedAccountId,
            balance: mediaAuthorization.balance,
          });
        }
      } catch (err) {
        this.log.error(`media-pipeline: event publish failed for ${put.sha256}: ${String(err)}`);
      }
    }

    return {
      asset,
      creation,
      message,
      url: put.url,
      mime: put.mime,
      kind,
      sha256: put.sha256,
      billedAccountId,
      mediaAuthorizationId: mediaAuthorization?.authorizationId ?? null,
      debit: null,
      debitError: null,
      // A concurrent double-ingest that lost the sha256 race wrote no new
      // creation/message — report it as deduped, like a plain re-ingest.
      deduped: txResult.raced,
    };
  }

  /**
   * Move an already-ingested attachment from the standalone media message the
   * watcher created onto the real (history-synced) completion row, strip the
   * sentinel line from the completion's content, and delete the now-empty
   * orphan. One transaction; no creation/ledger changes — the asset was
   * already fully ingested and charged.
   */
  private async rehomeAttachment(params: {
    sessionId: string;
    asset: MediaAsset;
    orphanMessageId: string;
    completion: Message;
    kind: AttachmentKind;
  }): Promise<{ completion: Message; creation: Creation | null }> {
    const { sessionId, asset, orphanMessageId, completion, kind } = params;
    const fullAttachment = {
      url: asset.url,
      mime: asset.mime,
      kind,
      ...(asset.width != null ? { width: asset.width } : {}),
      ...(asset.height != null ? { height: asset.height } : {}),
      creationId: asset.creationId ?? null,
    };
    const cleanedContent = stripAttachmentLines(completion.content ?? '') || null;

    return this.db.transaction(async (tx) => {
      const [orphan] = await tx
        .select()
        .from(messages)
        .where(eq(messages.id, orphanMessageId))
        .limit(1);

      // Append onto the completion row and drop its sentinel line. Guard the
      // append against a re-run: skip if this url is already attached there.
      const alreadyThere = ((completion.attachments as Array<{ url?: string }> | null) ?? []).some(
        (a) => a?.url === asset.url,
      );
      const [updated] = await tx
        .update(messages)
        .set({
          content: cleanedContent,
          ...(alreadyThere
            ? {}
            : {
                attachments: sql`coalesce(${messages.attachments}, '[]'::jsonb) || ${JSON.stringify([fullAttachment])}::jsonb`,
              }),
        })
        .where(eq(messages.id, completion.id))
        .returning();

      // Detach from the orphan; delete it (and decrement the session count) if
      // it was the bare media message we created — never touch a message that
      // carries other content or attachments.
      if (orphan) {
        const orphanAttachments = (orphan.attachments as Array<Record<string, unknown>> | null) ?? [];
        const remaining = orphanAttachments.filter(
          (a) => (a as { url?: string })?.url !== asset.url,
        );
        const orphanEmptyText = !(orphan.content ?? '').trim();
        if (remaining.length === 0 && orphanEmptyText) {
          await tx.delete(messages).where(eq(messages.id, orphan.id));
          await tx
            .update(sessions)
            .set({ messageCount: sql`greatest(${sessions.messageCount} - 1, 0)` })
            .where(eq(sessions.id, sessionId));
        } else if (remaining.length !== orphanAttachments.length) {
          await tx
            .update(messages)
            .set({ attachments: remaining.length > 0 ? remaining : null })
            .where(eq(messages.id, orphan.id));
        }
      }

      await tx
        .update(mediaAssets)
        .set({ messageId: completion.id })
        .where(eq(mediaAssets.id, asset.id));

      let creation: Creation | null = null;
      if (asset.creationId) {
        const [row] = await tx
          .select()
          .from(creations)
          .where(eq(creations.id, asset.creationId))
          .limit(1);
        creation = row ?? null;
      }
      return { completion: updated ?? completion, creation };
    });
  }
}
