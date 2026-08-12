/**
 * Pure state machine for a conversation view (/sessions/[id] and the /chat
 * handoff). No React, no IO — unit-tested in test/conversation-state.test.ts.
 *
 * Two layers compose the visible transcript:
 *   - `serverMessages` — persisted rows from GET /api/sessions/:id (ascending,
 *     deduped by id; `olderCursor` pages further back in time).
 *   - `local` — the live tail: optimistic user echoes, streaming assistant
 *     bubbles, "creating…" media shimmers, attached media, inline errors.
 *
 * Events reach the reducer from two transports that overlap on purpose
 * (the POST turn stream and the per-session events channel deliver the same
 * model), so every apply is defensive:
 *   - token/turn events from the channel are ignored when a non-remote
 *     assistant-stream item already renders that turnId (the POST stream owns it),
 *   - media.attached applies once per creation — the pipeline can re-home an
 *     asset onto a new messageId, so the bubble's identity is the creationId,
 *     not the gateway messageId,
 *   - history merges reconcile: finished local items whose rows now exist
 *     server-side are dropped instead of duplicated.
 */

import type { MessageAttachment, MessageDto, SessionEvent } from "@/lib/types";

// ---------------------------------------------------------------------------
// Local (unpersisted) transcript items
// ---------------------------------------------------------------------------

export type StreamPhase = "streaming" | "done" | "stopped" | "failed";

/** Optimistic echo of a just-sent user message. */
export interface UserEchoItem {
  kind: "user-echo";
  clientId: string;
  content: string;
  attachments: MessageAttachment[];
  at: string;
}

/** A live (or just-finished) assistant turn rendered from stream events. */
export interface AssistantStreamItem {
  kind: "assistant-stream";
  clientId: string;
  turnId: string | null;
  /** Persisted row id, set by turn.completed. */
  messageId: string | null;
  text: string;
  phase: StreamPhase;
  /** True when driven by the events channel (another tab, a trigger). */
  remote: boolean;
  at: string;
}

/** media.pending — a generation is in flight; render a shimmer bubble. */
export interface MediaPendingItem {
  kind: "media-pending";
  clientId: string;
  tool: string;
  at: string;
}

/** media.attached that doesn't (yet) belong to a fetched server row. */
export interface MediaItem {
  kind: "media";
  clientId: string;
  messageId: string;
  attachments: MessageAttachment[];
  at: string;
}

/** Inline failure row with an optional retry payload. */
export interface ErrorItem {
  kind: "error";
  clientId: string;
  code: string;
  message: string;
  /** When set, "Retry" re-sends this user content. */
  retryContent: string | null;
  at: string;
}

export type LocalItem =
  | UserEchoItem
  | AssistantStreamItem
  | MediaPendingItem
  | MediaItem
  | ErrorItem;

// ---------------------------------------------------------------------------
// State + actions
// ---------------------------------------------------------------------------

export interface ConversationState {
  /** Persisted messages, ascending (createdAt, id). */
  serverMessages: MessageDto[];
  /** Cursor for the page of OLDER messages; null = full history present. */
  olderCursor: string | null;
  historyLoaded: boolean;
  local: LocalItem[];
  /** media.attached keys already applied (`messageId:creationId`). */
  seenMedia: string[];
  /** clientId of the assistant-stream item fed by the active POST stream. */
  activeStreamId: string | null;
}

export const initialConversationState: ConversationState = {
  serverMessages: [],
  olderCursor: null,
  historyLoaded: false,
  local: [],
  seenMedia: [],
  activeStreamId: null,
};

export type HistoryPosition = "init" | "older" | "refresh";

export type ConversationAction =
  | {
      type: "history/merge";
      messages: MessageDto[];
      /** Only applied for init/older loads (refresh must not rewind it). */
      olderCursor?: string | null;
      position: HistoryPosition;
    }
  | { type: "send"; clientId: string; content: string; attachments?: MessageAttachment[]; at: string }
  | {
      /** Adopt an in-flight new-session stream handed off from /chat. */
      type: "adopt";
      clientId: string;
      content: string;
      text: string;
      turnId: string | null;
      at: string;
    }
  | {
      /** Event consumed from the active POST turn stream. */
      type: "stream/event";
      clientId: string;
      event: SessionEvent;
      retryContent: string | null;
      at: string;
    }
  | { type: "stream/aborted"; clientId: string }
  | {
      /** The POST was rejected before any event (402, endpoint missing…) —
       *  remove the optimistic echo + stream bubble; the composer shows the
       *  notice instead. */
      type: "send/rejected";
      clientId: string;
    }
  | {
      type: "stream/failed";
      clientId: string;
      code: string;
      message: string;
      retryContent: string | null;
      at: string;
    }
  | {
      /** Replace transient shimmers with durable authorization truth. */
      type: "pending/reconcile";
      pending: Array<{ tool: string; createdAt: string }>;
    }
  | { type: "stream/finished"; clientId: string }
  | {
      /** Event from the long-lived per-session channel. */
      type: "channel/event";
      event: SessionEvent;
      at: string;
    }
  | { type: "error/dismiss"; clientId: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function echoClientId(streamClientId: string): string {
  return `${streamClientId}:echo`;
}

/**
 * Strip gateway media-sentinel lines (`MEDIA:<container path>` and the spike
 * `Attachment: <path>` shape) from displayed message text. The media pipeline
 * normally parks these and swaps in a real attachment, but when correlation
 * lands the attachment on a different row (late history-sync) the raw
 * container path — meaningless outside the gateway — must never reach users.
 * Mirrors ATTACHMENT_LINE_RE in apps/api/src/services/history-sync.ts.
 */
export function stripMediaSentinelLines(text: string): string {
  return text
    .replace(/^\s*(?:MEDIA|Attachment):\s*\/\S[^\r\n]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function messageOrder(a: MessageDto, b: MessageDto): number {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Union by id, ascending. Incoming rows win over stale copies. */
function mergeMessages(existing: MessageDto[], incoming: MessageDto[]): MessageDto[] {
  const byId = new Map<string, MessageDto>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(messageOrder);
}

/** True when a non-remote (POST-stream-owned) item renders this turn. */
function hasLocalTurn(state: ConversationState, turnId: string): boolean {
  return state.local.some(
    (item) =>
      item.kind === "assistant-stream" && !item.remote && item.turnId === turnId,
  );
}

function updateStream(
  state: ConversationState,
  match: (item: AssistantStreamItem) => boolean,
  update: (item: AssistantStreamItem) => AssistantStreamItem,
): ConversationState {
  let touched = false;
  const local = state.local.map((item) => {
    if (!touched && item.kind === "assistant-stream" && match(item)) {
      touched = true;
      return update(item);
    }
    return item;
  });
  return touched ? { ...state, local } : state;
}

/** A failed/stopped bubble with no text is dead weight — drop it (the echo
 *  and the inline error row tell the story). */
function pruneEmptyStream(state: ConversationState): ConversationState {
  const local = state.local.filter(
    (item) =>
      !(
        item.kind === "assistant-stream" &&
        item.text.length === 0 &&
        (item.phase === "failed" || item.phase === "stopped")
      ),
  );
  return local.length === state.local.length ? state : { ...state, local };
}

const ECHO_MATCH_WINDOW_MS = 10 * 60_000;

/**
 * Drop local items that the server now owns:
 *  - finished assistant-stream items whose messageId exists server-side,
 *  - media items whose message row was fetched (attachments live on the row),
 *  - user echoes matching a recent server user message with equal content.
 */
function reconcile(state: ConversationState): ConversationState {
  if (state.local.length === 0) return state;
  const ids = new Set(state.serverMessages.map((message) => message.id));
  // Creations already present on ANY fetched row. A live media item must retire
  // once its creation is persisted even if it landed on a different message id
  // than the one media.attached first referenced (the pipeline can re-home an
  // attachment off a transient row, deleting the original) — otherwise the
  // live item lingers as a phantom second copy of the same image until refresh.
  const persistedCreationIds = new Set(
    state.serverMessages.flatMap((message) =>
      (message.attachments ?? [])
        .map((a) => a.creationId)
        .filter((id): id is string => typeof id === "string"),
    ),
  );

  const local = state.local.filter((item) => {
    if (item.kind === "assistant-stream") {
      if (
        item.phase !== "streaming" &&
        item.messageId !== null &&
        ids.has(item.messageId)
      ) {
        return false;
      }
      // A stopped/failed turn has no messageId (no turn.completed), but the
      // server may still have persisted the partial reply — dedupe when a
      // recent assistant row textually covers what we streamed.
      if (
        (item.phase === "stopped" || item.phase === "failed") &&
        item.text.length > 0
      ) {
        const itemAt = Date.parse(item.at);
        const covered = state.serverMessages.some(
          (message) =>
            message.role !== "user" &&
            (message.content ?? "").startsWith(item.text) &&
            Math.abs(Date.parse(message.createdAt) - itemAt) <
              ECHO_MATCH_WINDOW_MS,
        );
        if (covered) return false;
      }
      return true;
    }
    if (item.kind === "media") {
      if (ids.has(item.messageId)) return false;
      // Retire once the creation shows up on any persisted row.
      if (
        item.attachments.some(
          (a) => a.creationId && persistedCreationIds.has(a.creationId),
        )
      ) {
        return false;
      }
      return true;
    }
    if (item.kind === "user-echo") {
      const echoAt = Date.parse(item.at);
      return !state.serverMessages.some(
        (message) =>
          message.role === "user" &&
          (message.content ?? "") === item.content &&
          Math.abs(Date.parse(message.createdAt) - echoAt) < ECHO_MATCH_WINDOW_MS,
      );
    }
    return true;
  });

  return local.length === state.local.length ? state : { ...state, local };
}

let mediaKeySeq = 0;

/** Apply media.attached exactly once, retiring one shimmer if present. */
function applyMediaAttached(
  state: ConversationState,
  event: Extract<SessionEvent, { type: "media.attached" }>,
  at: string,
): ConversationState {
  const key = `${event.messageId}:${event.creationId}`;
  if (state.seenMedia.includes(key)) return state;

  // A media bubble's identity is the stable `creationId`, not the mutable
  // gateway `messageId`. The pipeline can fire a SECOND media.attached for the
  // same creation after re-homing the asset off a transient message onto the
  // real completion row (apps/api/src/services/media-pipeline.ts:298-315) —
  // same creationId, new messageId. The `${messageId}:${creationId}` key lets
  // both through, so guard on the creation itself: if it's already on screen
  // (a live media bubble or a fetched row), record the key and bail instead of
  // rendering the image twice.
  const creationOnScreen =
    state.local.some(
      (item) =>
        item.kind === "media" &&
        item.attachments.some((a) => a.creationId === event.creationId),
    ) ||
    state.serverMessages.some((message) =>
      message.attachments.some((a) => a.creationId === event.creationId),
    );

  let next: ConversationState = {
    ...state,
    seenMedia: [...state.seenMedia, key],
  };

  if (creationOnScreen) return next;

  // Retire the oldest shimmer — pending/attached carry no correlation id.
  const shimmerIndex = next.local.findIndex(
    (item) => item.kind === "media-pending",
  );
  if (shimmerIndex !== -1) {
    next = {
      ...next,
      local: [
        ...next.local.slice(0, shimmerIndex),
        ...next.local.slice(shimmerIndex + 1),
      ],
    };
  }

  const attachment: MessageAttachment = {
    url: event.url,
    mime: event.mime,
    creationId: event.creationId,
    ...(event.width !== undefined ? { width: event.width } : {}),
    ...(event.height !== undefined ? { height: event.height } : {}),
  };

  // Prefer merging into the fetched server row — by message id, or by an
  // already-attached creation (a re-home moves the asset onto a new message id
  // while the original row may still carry the same creation).
  const rowIndex = next.serverMessages.findIndex(
    (message) =>
      message.id === event.messageId ||
      message.attachments.some((a) => a.creationId === event.creationId),
  );
  if (rowIndex !== -1) {
    const row = next.serverMessages[rowIndex];
    if (!row) return next;
    if (
      row.attachments.some(
        (existing) =>
          existing.url === event.url ||
          existing.creationId === event.creationId,
      )
    ) {
      return next;
    }
    const serverMessages = [...next.serverMessages];
    serverMessages[rowIndex] = {
      ...row,
      attachments: [...row.attachments, attachment],
    };
    return { ...next, serverMessages };
  }

  // Otherwise merge into (or create) a local media item, matched on the stable
  // creation id (any attachment carrying it) OR the gateway message id, so a
  // re-homed event updates the existing bubble instead of spawning a new one.
  const localIndex = next.local.findIndex(
    (item) =>
      item.kind === "media" &&
      (item.messageId === event.messageId ||
        item.attachments.some((a) => a.creationId === event.creationId)),
  );
  if (localIndex !== -1) {
    const item = next.local[localIndex];
    if (!item || item.kind !== "media") return next;
    if (
      item.attachments.some(
        (existing) =>
          existing.url === event.url ||
          existing.creationId === event.creationId,
      )
    ) {
      return next;
    }
    const local = [...next.local];
    local[localIndex] = {
      ...item,
      attachments: [...item.attachments, attachment],
    };
    return { ...next, local };
  }

  mediaKeySeq += 1;
  const mediaItem: MediaItem = {
    kind: "media",
    clientId: `media:${event.creationId}:${mediaKeySeq}`,
    messageId: event.messageId,
    attachments: [attachment],
    at,
  };
  return { ...next, local: [...next.local, mediaItem] };
}

let shimmerSeq = 0;

function appendShimmer(
  state: ConversationState,
  tool: string,
  at: string,
): ConversationState {
  const alreadyPending = state.local.some(
    (item) =>
      item.kind === "media-pending" &&
      (item.tool === tool || item.tool === "unknown" || tool === "unknown"),
  );
  if (alreadyPending) return state;
  shimmerSeq += 1;
  const item: MediaPendingItem = {
    kind: "media-pending",
    clientId: `pending:${shimmerSeq}`,
    tool,
    at,
  };
  return { ...state, local: [...state.local, item] };
}

function applyMediaFailed(
  state: ConversationState,
  event: Extract<SessionEvent, { type: "media.failed" }>,
  at: string,
): ConversationState {
  let retired = false;
  const local = state.local.filter((item) => {
    if (
      !retired &&
      item.kind === "media-pending" &&
      (item.tool === event.tool || item.tool === "unknown")
    ) {
      retired = true;
      return false;
    }
    return true;
  });
  return appendError(
    local.length === state.local.length ? state : { ...state, local },
    {
      clientId: `error:media:${event.sessionId}:${event.tool}:${event.code}`,
      code: event.code,
      message: event.message,
      retryContent: null,
      at,
    },
  );
}

function appendError(
  state: ConversationState,
  error: Omit<ErrorItem, "kind">,
): ConversationState {
  const exists = state.local.some(
    (item) => item.kind === "error" && item.clientId === error.clientId,
  );
  if (exists) return state;
  return { ...state, local: [...state.local, { kind: "error", ...error }] };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case "pending/reconcile": {
      let next: ConversationState = {
        ...state,
        local: state.local.filter((item) => item.kind !== "media-pending"),
      };
      for (const pending of action.pending) {
        next = appendShimmer(next, pending.tool, pending.createdAt);
      }
      return next;
    }

    case "history/merge": {
      const serverMessages =
        action.position === "init"
          ? mergeMessages([], action.messages)
          : mergeMessages(state.serverMessages, action.messages);
      const olderCursor =
        action.position === "refresh"
          ? state.olderCursor
          : (action.olderCursor ?? null);
      return reconcile({
        ...state,
        serverMessages,
        olderCursor,
        historyLoaded: true,
      });
    }

    case "send":
    case "adopt": {
      const echo: UserEchoItem = {
        kind: "user-echo",
        clientId: echoClientId(action.clientId),
        content: action.content,
        attachments: action.type === "send" ? (action.attachments ?? []) : [],
        at: action.at,
      };
      const stream: AssistantStreamItem = {
        kind: "assistant-stream",
        clientId: action.clientId,
        turnId: action.type === "adopt" ? action.turnId : null,
        messageId: null,
        text: action.type === "adopt" ? action.text : "",
        phase: "streaming",
        remote: false,
        at: action.at,
      };
      return {
        ...state,
        local: [...state.local, echo, stream],
        activeStreamId: action.clientId,
      };
    }

    case "stream/event": {
      const { event } = action;
      switch (event.type) {
        case "turn.started": {
          const claimed = updateStream(
            state,
            (item) => item.clientId === action.clientId,
            (item) => ({ ...item, turnId: event.turnId }),
          );
          // The channel may have delivered this turn.started first and
          // spawned a remote bubble — absorb it (the POST stream replays
          // every token itself, so the copy would double-render).
          const local = claimed.local.filter(
            (item) =>
              !(
                item.kind === "assistant-stream" &&
                item.remote &&
                item.turnId === event.turnId
              ),
          );
          return local.length === claimed.local.length
            ? claimed
            : { ...claimed, local };
        }
        case "token":
          return updateStream(
            state,
            (item) => item.clientId === action.clientId,
            (item) => ({ ...item, text: item.text + event.delta }),
          );
        case "turn.completed":
          return updateStream(
            state,
            (item) => item.clientId === action.clientId,
            (item) => ({ ...item, phase: "done", messageId: event.messageId }),
          );
        case "media.pending":
          return appendShimmer(state, event.tool, action.at);
        case "media.attached":
          return applyMediaAttached(state, event, action.at);
        case "media.failed":
          return applyMediaFailed(state, event, action.at);
        case "manna.updated":
          return state; // broadcast handled globally (sidebar badge)
        case "error": {
          const failed = pruneEmptyStream(
            updateStream(
              state,
              (item) => item.clientId === action.clientId,
              (item) => ({ ...item, phase: "failed" }),
            ),
          );
          return appendError(failed, {
            clientId: `error:${action.clientId}:${event.code}`,
            code: event.code,
            message: event.message,
            retryContent: action.retryContent,
            at: action.at,
          });
        }
        default:
          return state;
      }
    }

    case "stream/aborted":
      return pruneEmptyStream(
        updateStream(
          state,
          (item) =>
            item.clientId === action.clientId && item.phase === "streaming",
          (item) => ({ ...item, phase: "stopped" }),
        ),
      );

    case "send/rejected": {
      const echoId = echoClientId(action.clientId);
      return {
        ...state,
        local: state.local.filter(
          (item) => item.clientId !== action.clientId && item.clientId !== echoId,
        ),
        activeStreamId:
          state.activeStreamId === action.clientId ? null : state.activeStreamId,
      };
    }

    case "stream/failed": {
      const failed = pruneEmptyStream(
        updateStream(
          state,
          (item) =>
            item.clientId === action.clientId && item.phase === "streaming",
          (item) => ({ ...item, phase: "failed" }),
        ),
      );
      return appendError(failed, {
        clientId: `error:${action.clientId}:${action.code}`,
        code: action.code,
        message: action.message,
        retryContent: action.retryContent,
        at: action.at,
      });
    }

    case "stream/finished": {
      const finished = updateStream(
        state,
        (item) => item.clientId === action.clientId && item.phase === "streaming",
        (item) => ({ ...item, phase: "done" }),
      );
      return finished.activeStreamId === action.clientId
        ? { ...finished, activeStreamId: null }
        : finished;
    }

    case "channel/event": {
      const { event } = action;
      switch (event.type) {
        case "turn.started": {
          if (hasLocalTurn(state, event.turnId)) return state;
          const exists = state.local.some(
            (item) =>
              item.kind === "assistant-stream" && item.turnId === event.turnId,
          );
          if (exists) return state;
          const item: AssistantStreamItem = {
            kind: "assistant-stream",
            clientId: `remote:${event.turnId}`,
            turnId: event.turnId,
            messageId: null,
            text: "",
            phase: "streaming",
            remote: true,
            at: action.at,
          };
          return { ...state, local: [...state.local, item] };
        }
        case "token": {
          if (hasLocalTurn(state, event.turnId)) return state;
          const updated = updateStream(
            state,
            (item) => item.remote && item.turnId === event.turnId,
            (item) => ({ ...item, text: item.text + event.delta }),
          );
          if (updated !== state) return updated;
          // Joined mid-turn — start a remote bubble from here.
          const item: AssistantStreamItem = {
            kind: "assistant-stream",
            clientId: `remote:${event.turnId}`,
            turnId: event.turnId,
            messageId: null,
            text: event.delta,
            phase: "streaming",
            remote: true,
            at: action.at,
          };
          return { ...state, local: [...state.local, item] };
        }
        case "turn.completed": {
          if (hasLocalTurn(state, event.turnId)) return state;
          return updateStream(
            state,
            (item) => item.remote && item.turnId === event.turnId,
            (item) => ({ ...item, phase: "done", messageId: event.messageId }),
          );
        }
        case "media.pending":
          // The runtime authorization callback is the earliest authoritative
          // signal and arrives on this channel even while our POST turn is
          // live. appendShimmer dedupes the terminal stream fallback.
          return appendShimmer(state, event.tool, action.at);
        case "media.attached":
          return applyMediaAttached(state, event, action.at);
        case "media.failed":
          return applyMediaFailed(state, event, action.at);
        case "manna.updated":
          return state;
        case "error": {
          if (event.turnId && hasLocalTurn(state, event.turnId)) return state;
          const turnId = event.turnId;
          const failed = turnId
            ? pruneEmptyStream(
                updateStream(
                  state,
                  (item) => item.remote && item.turnId === turnId,
                  (item) => ({ ...item, phase: "failed" }),
                ),
              )
            : state;
          return appendError(failed, {
            clientId: `error:channel:${event.turnId ?? "session"}:${event.code}`,
            code: event.code,
            message: event.message,
            retryContent: null,
            at: action.at,
          });
        }
        default:
          return state;
      }
    }

    case "error/dismiss":
      return {
        ...state,
        local: state.local.filter(
          (item) => !(item.kind === "error" && item.clientId === action.clientId),
        ),
      };

    default:
      return state;
  }
}
