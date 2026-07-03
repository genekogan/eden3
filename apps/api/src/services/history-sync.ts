import {
  agents,
  db,
  messages,
  sessionAgents,
  sessions,
  type Session,
} from '@eden3/db';
import { historyMessageText, type GatewayHistoryMessage, type SessionsHistoryParams, type SessionsHistoryResult } from '@eden3/gateway';
import { desc, eq, sql } from 'drizzle-orm';

/**
 * History sync — pull a session's transcript out of the gateway
 * (`sessions_history` tool) and persist any messages we do not have yet.
 *
 * This is the general inbound-sync primitive (spike.md): async media
 * completions and cron-triggered activity all post into the gateway session,
 * NOT into our HTTP stream, so after every chat turn we trail-sync the
 * session for a while to pick up whatever lands.
 *
 * ## Live payload shape (probed 2026-07-03, openclaw 2026.6.10, testbot)
 *
 * `sessions_history` messages look like:
 *
 *   { role: "user" | "assistant",
 *     content: [{type:"text", text}],
 *     timestamp: 1783083522595,                  // ms epoch, turn time
 *     __openclaw: {id:"1fc165a6",                // 8-hex per-message id
 *                  recordTimestampMs, seq},
 *     …assistant only: model, stopReason, api, provider, responseId }
 *
 * Async media completions arrive as a PAIR ~10-120s after the invoking turn:
 *
 *   1. role:"user" — "[Inter-session message] sourceSession=image_generate:
 *      <taskId> …" with `provenance:{kind:"inter_session", sourceSessionKey:
 *      "image_generate:<taskId>", sourceChannel, sourceTool}`. Internal
 *      routing banner — NOT persisted (would pollute the visible transcript;
 *      note the taskId is recoverable from provenance.sourceSessionKey).
 *   2. role:"assistant" — completion text whose body carries the media file
 *      as a line `MEDIA:/home/node/.openclaw/media/tool-image-generation/…`
 *      (container path). Persisted like any assistant message; each MEDIA/
 *      Attachment line is reported to the injected attachment callback.
 *
 * Note: the live gateway reports `truncated:true`/`contentTruncated:true`
 * even on 2-message sessions — the flags are unreliable and ignored here.
 *
 * ## Dedupe
 *
 * Primary key: the gateway message id, stored as
 * `messages.external_id = "gw:<__openclaw.id>"` (unique per session via the
 * (session_id, external_id) index). Messages we persisted OURSELVES during
 * the turn (user POST body, streamed assistant text) have no gateway id yet —
 * those are matched by (role, exact content) against recent rows and the
 * gateway id is BACKFILLED onto them, so subsequent syncs dedupe by id alone.
 */

export const GATEWAY_EXTERNAL_ID_PREFIX = 'gw:';

/**
 * First line of the continue-old-conversation primer block turns.ts prepends
 * to the first gateway message of a migrated session. Lives HERE (not in
 * turns.ts) because it is the dedupe coupling point: the row we persist holds
 * the user's verbatim text while the gateway transcript holds primer+text, so
 * a gateway user message that starts with this marker and ENDS WITH an
 * existing row's content is that row, not a new message.
 */
export const PRIMER_HEADER = '[Resumed Eden conversation — recent transcript:]';

/** Lines like `MEDIA:<path>` (live shape) or `Attachment: <path>` (spike shape). */
const ATTACHMENT_LINE_RE = /^\s*(?:MEDIA|Attachment):\s*(\S[^\r\n]*?)\s*$/gim;

export interface AttachmentSighting {
  /** eden3 `sessions.id`. */
  sessionId: string;
  /** `messages.id` of the (just-inserted) row carrying the attachment line. */
  messageId: string;
  /** Path exactly as it appears in the transcript (container path). */
  path: string;
  /** Role of the carrying message (practically always "assistant"). */
  role: string;
}

/** Injected from server.ts — the media pipeline (media agent) implements it. */
export type AttachmentCallback = (sighting: AttachmentSighting) => void;

/** Structural tools-client dependency (tests stub it; prod passes OpenClawToolsClient). */
export interface ToolsClientLike {
  sessionsHistory(params: SessionsHistoryParams): Promise<SessionsHistoryResult>;
}

// ---------------------------------------------------------------------------
// Pure planning helpers (unit-tested without a database)
// ---------------------------------------------------------------------------

interface OpenclawMeta {
  id?: unknown;
  recordTimestampMs?: unknown;
  seq?: unknown;
}

/** `__openclaw` / `provenance` are passthrough fields on the zod schema. */
function meta(message: GatewayHistoryMessage): OpenclawMeta {
  const raw = (message as Record<string, unknown>).__openclaw;
  return typeof raw === 'object' && raw !== null ? (raw as OpenclawMeta) : {};
}

/** Gateway message id (`__openclaw.id`), or null when absent. */
export function gatewayMessageId(message: GatewayHistoryMessage): string | null {
  const id = meta(message).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** `external_id` value for a gateway-synced row: `gw:<__openclaw.id>`. */
export function gatewayExternalId(message: GatewayHistoryMessage): string | null {
  const id = gatewayMessageId(message);
  return id === null ? null : `${GATEWAY_EXTERNAL_ID_PREFIX}${id}`;
}

/**
 * True for the internal `[Inter-session message]` routing banner the gateway
 * injects (role:user + provenance.kind === "inter_session") before an async
 * tool completion. Never persisted.
 */
export function isInterSessionBanner(message: GatewayHistoryMessage): boolean {
  if (message.role !== 'user') return false;
  const provenance = (message as Record<string, unknown>).provenance;
  return (
    typeof provenance === 'object' &&
    provenance !== null &&
    (provenance as { kind?: unknown }).kind === 'inter_session'
  );
}

/** Best-effort message time: `timestamp` → `__openclaw.recordTimestampMs` → now. */
export function historyMessageDate(message: GatewayHistoryMessage, now: () => number = Date.now): Date {
  const ts = message.timestamp ?? meta(message).recordTimestampMs;
  return new Date(typeof ts === 'number' && Number.isFinite(ts) ? ts : now());
}

/** Extract `MEDIA:`/`Attachment:` line paths from a message body. */
export function extractAttachmentPaths(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(ATTACHMENT_LINE_RE)) {
    const path = match[1]?.trim();
    if (path) out.push(path);
  }
  return out;
}

/**
 * Whitespace-insensitive comparison key for dedupe (W2 finding #5).
 *
 * The gateway streams a multi-block assistant reply as OpenAI content deltas
 * with NO block boundaries, so turns.ts persists the blocks concatenated with
 * no separator ("AB"). When the SAME reply comes back via `sessions_history`,
 * `historyMessageText` re-joins the blocks with "\n" ("A\nB"). An exact-string
 * compare would then miss the match and insert a duplicate row. Since the ONLY
 * possible difference is whitespace injected at block seams, we compare with
 * all whitespace removed — identical single-block content is unaffected.
 */
function dedupeKey(text: string): string {
  return text.replace(/\s+/g, '');
}

/** The subset of a `messages` row the dedupe plan needs. */
export interface ExistingMessageLike {
  id: string;
  externalId: string | null;
  role: string | null;
  content: string | null;
}

export interface PlannedInsert {
  externalId: string;
  role: string;
  content: string;
  createdAt: Date;
  attachmentPaths: string[];
}

export interface PlannedBackfill {
  /** Existing `messages.id` that gets the gateway external id stamped on. */
  messageId: string;
  externalId: string;
}

export interface HistorySyncPlan {
  inserts: PlannedInsert[];
  backfills: PlannedBackfill[];
  /** History entries skipped (already synced, banners, or no gateway id). */
  skipped: number;
}

/**
 * Decide, per gateway history message, whether to insert it, backfill its id
 * onto a row we already persisted (same role + exact content, oldest first),
 * or skip it. Pure — all IO happens in {@link HistorySync.syncSession}.
 */
export function planHistorySync(
  existing: ExistingMessageLike[],
  history: GatewayHistoryMessage[],
  now: () => number = Date.now,
): HistorySyncPlan {
  const knownExternalIds = new Set(
    existing.map((row) => row.externalId).filter((id): id is string => id !== null),
  );
  // Rows still eligible for a content-match backfill (no external id yet).
  // `existing` arrives NEWEST-first (syncSession loads desc(created_at) for the
  // recency window), but we consume matches OLDEST-first to align with the
  // gateway `history` array, which is processed oldest→newest. Reversing here
  // keeps the two ordered the same way, so two identical-content rows get their
  // gateway ids stamped on in chronological order instead of swapped (W2 #6).
  const backfillable = existing.filter((row) => row.externalId === null).reverse();
  const consumed = new Set<string>();

  const plan: HistorySyncPlan = { inserts: [], backfills: [], skipped: 0 };

  for (const message of history) {
    const externalId = gatewayExternalId(message);
    if (externalId === null) {
      plan.skipped += 1; // no stable id — cannot dedupe safely; leave to a later pass
      continue;
    }
    if (knownExternalIds.has(externalId)) {
      plan.skipped += 1;
      continue;
    }
    if (isInterSessionBanner(message)) {
      plan.skipped += 1;
      continue;
    }

    const content = historyMessageText(message);
    const isPrimed = message.role === 'user' && content.startsWith(PRIMER_HEADER);
    const contentKey = dedupeKey(content);
    const match = backfillable.find(
      (row) =>
        !consumed.has(row.id) &&
        row.role === message.role &&
        // Whitespace-insensitive so a multi-block streamed reply (blocks
        // concatenated, no separator) matches the gateway's "\n"-joined copy.
        (dedupeKey(row.content ?? '') === contentKey ||
          // Primed first message of a resumed session: gateway holds
          // primer+content, our row holds the verbatim content.
          (isPrimed && !!row.content && contentKey.endsWith(dedupeKey(row.content)))),
    );
    if (match) {
      consumed.add(match.id);
      plan.backfills.push({ messageId: match.id, externalId });
      continue;
    }

    plan.inserts.push({
      externalId,
      role: message.role,
      content,
      createdAt: historyMessageDate(message, now),
      attachmentPaths: extractAttachmentPaths(content),
    });
  }

  return plan;
}

// ---------------------------------------------------------------------------
// HistorySync service
// ---------------------------------------------------------------------------

export interface SyncTarget {
  session: Pick<Session, 'id' | 'gatewaySessionKey'>;
  /** OpenClaw agent id; resolved from session_agents ⋈ agents when omitted. */
  agentOpenclawId?: string;
  /** Agent `accounts.id` (sender for inserted assistant rows); resolved when omitted. */
  agentAccountId?: string;
}

export interface SyncResult {
  inserted: number;
  backfilled: number;
  /** Attachment lines seen on inserted rows (callback invoked per line). */
  attachments: number;
  historyCount: number;
  skippedReason?: 'no_gateway_key' | 'no_provisioned_agent';
}

export interface TrailingSyncOptions {
  /** Keep syncing until this long after schedule time (default 120s). */
  windowMs?: number;
  /** Interval between sync passes (default 15s). */
  intervalMs?: number;
}

export const TRAILING_WINDOW_MS = 120_000;
export const TRAILING_INTERVAL_MS = 15_000;

/** How many recent rows are loaded for dedupe/content-matching. */
const EXISTING_ROWS_LIMIT = 300;
/** Newest-N history messages fetched per sync. */
const DEFAULT_HISTORY_LIMIT = 100;

export interface HistorySyncOptions {
  tools: ToolsClientLike;
  onAttachment?: AttachmentCallback | null;
  historyLimit?: number;
  /** Error sink for background (trailing) sync failures. */
  onError?: (err: unknown, sessionId: string) => void;
}

interface TrailingState {
  until: number;
  timer: NodeJS.Timeout;
  target: SyncTarget;
  running: boolean;
}

export class HistorySync {
  private readonly tools: ToolsClientLike;
  private readonly historyLimit: number;
  private readonly onError: (err: unknown, sessionId: string) => void;
  private onAttachment: AttachmentCallback | null;
  private readonly trailing = new Map<string, TrailingState>();

  constructor(opts: HistorySyncOptions) {
    this.tools = opts.tools;
    this.onAttachment = opts.onAttachment ?? null;
    this.historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.onError = opts.onError ?? (() => {});
  }

  /** Late wiring point for the media pipeline (server.ts / media agent). */
  setAttachmentCallback(cb: AttachmentCallback | null): void {
    this.onAttachment = cb;
  }

  /**
   * One sync pass: fetch the gateway transcript, dedupe against recent rows,
   * insert what is missing (bumping session counters), backfill gateway ids
   * onto rows we streamed ourselves, and report attachment lines.
   */
  async syncSession(target: SyncTarget): Promise<SyncResult> {
    const { session } = target;
    const none: SyncResult = { inserted: 0, backfilled: 0, attachments: 0, historyCount: 0 };
    const sessionKey = session.gatewaySessionKey;
    if (!sessionKey) return { ...none, skippedReason: 'no_gateway_key' };

    let { agentOpenclawId, agentAccountId } = target;
    if (!agentOpenclawId) {
      const agent = await resolveSessionAgent(session.id);
      if (!agent) return { ...none, skippedReason: 'no_provisioned_agent' };
      agentOpenclawId = agent.openclawId;
      agentAccountId ??= agent.accountId;
    }

    const history = await this.tools.sessionsHistory({
      sessionKey,
      agentId: agentOpenclawId,
      limit: this.historyLimit,
    });
    if (history.messages.length === 0) return none;

    const existing = await db
      .select({
        id: messages.id,
        externalId: messages.externalId,
        role: messages.role,
        content: messages.content,
      })
      .from(messages)
      .where(eq(messages.sessionId, session.id))
      .orderBy(desc(messages.createdAt))
      .limit(EXISTING_ROWS_LIMIT);

    const plan = planHistorySync(existing, history.messages);
    const sightings: AttachmentSighting[] = [];
    let inserted = 0;

    await db.transaction(async (tx) => {
      for (const backfill of plan.backfills) {
        await tx
          .update(messages)
          .set({ externalId: backfill.externalId })
          .where(eq(messages.id, backfill.messageId));
      }

      let latest: Date | null = null;
      for (const item of plan.inserts) {
        const [row] = await tx
          .insert(messages)
          .values({
            sessionId: session.id,
            externalId: item.externalId,
            senderId: item.role === 'assistant' ? (agentAccountId ?? null) : null,
            role: item.role,
            content: item.content,
            createdAt: item.createdAt,
          })
          // Concurrent trailing syncs may race on (session_id, external_id).
          .onConflictDoNothing({ target: [messages.sessionId, messages.externalId] })
          .returning({ id: messages.id });
        if (!row) continue; // lost the race — the other pass owns this message
        inserted += 1;
        if (latest === null || item.createdAt > latest) latest = item.createdAt;
        for (const path of item.attachmentPaths) {
          sightings.push({ sessionId: session.id, messageId: row.id, path, role: item.role });
        }
      }

      if (inserted > 0) {
        await tx
          .update(sessions)
          .set({
            messageCount: sql`${sessions.messageCount} + ${inserted}`,
            lastMessageAt: sql`greatest(coalesce(${sessions.lastMessageAt}, 'epoch'::timestamptz), ${(latest ?? new Date()).toISOString()}::timestamptz)`,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, session.id));
      }
    });

    // Report attachments only after the rows are committed.
    const callback = this.onAttachment;
    if (callback) {
      for (const sighting of sightings) {
        try {
          callback(sighting);
        } catch (err) {
          this.onError(err, session.id);
        }
      }
    }

    return {
      inserted,
      backfilled: plan.backfills.length,
      attachments: sightings.length,
      historyCount: history.messages.length,
    };
  }

  /**
   * Fire-and-forget trailing sync: run a pass now, then every `intervalMs`
   * until `windowMs` has elapsed (async media lands 10-120s after the turn).
   * Re-scheduling an already-trailing session just extends its window.
   */
  scheduleTrailingSync(target: SyncTarget, opts: TrailingSyncOptions = {}): void {
    const windowMs = opts.windowMs ?? TRAILING_WINDOW_MS;
    const intervalMs = opts.intervalMs ?? TRAILING_INTERVAL_MS;
    const sessionId = target.session.id;
    const until = Date.now() + windowMs;

    const existing = this.trailing.get(sessionId);
    if (existing) {
      existing.until = Math.max(existing.until, until);
      existing.target = target;
      return;
    }

    const state: TrailingState = {
      until,
      target,
      running: false,
      timer: setInterval(() => void this.trailingTick(sessionId), intervalMs),
    };
    state.timer.unref();
    this.trailing.set(sessionId, state);
    void this.trailingTick(sessionId, /* initial */ true);
  }

  private async trailingTick(sessionId: string, initial = false): Promise<void> {
    const state = this.trailing.get(sessionId);
    if (!state) return;
    if (!initial && Date.now() > state.until) {
      clearInterval(state.timer);
      this.trailing.delete(sessionId);
      return;
    }
    if (state.running) return; // previous pass still in flight
    state.running = true;
    try {
      await this.syncSession(state.target);
    } catch (err) {
      this.onError(err, sessionId);
    } finally {
      state.running = false;
    }
  }

  /** Number of sessions currently trail-syncing (tests/ops). */
  get trailingCount(): number {
    return this.trailing.size;
  }

  /** Cancel all trailing timers (server shutdown). */
  stop(): void {
    for (const state of this.trailing.values()) clearInterval(state.timer);
    this.trailing.clear();
  }
}

/** First provisioned agent of a session (session_agents ⋈ agents). */
async function resolveSessionAgent(
  sessionId: string,
): Promise<{ accountId: string; openclawId: string } | null> {
  const rows = await db
    .select({ accountId: agents.accountId, openclawId: agents.openclawId })
    .from(sessionAgents)
    .innerJoin(agents, eq(agents.accountId, sessionAgents.agentAccountId))
    .where(eq(sessionAgents.sessionId, sessionId))
    .orderBy(agents.accountId)
    .limit(8);
  const provisioned = rows.find((row) => row.openclawId !== null);
  return provisioned ? { accountId: provisioned.accountId, openclawId: provisioned.openclawId! } : null;
}
