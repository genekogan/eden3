/**
 * Chat-surface API helpers, layered over lib/api + lib/sse.
 *
 * Two things the generic client doesn't cover:
 *   - `startNewSessionStream` — POST /api/sessions/new/messages needs the raw
 *     Response so the new session id can come from EITHER the first
 *     turn.started event or the `x-session-id` response header.
 *   - `fetchSessionPage` — GET /api/sessions/:id with the optional `cursor`
 *     param for loading older messages (ascending pages, cursor at the top).
 *
 * Browser-only (same-origin through the Next rewrite, cookies flow).
 */

import { ApiError, emitMannaUpdate } from "@/lib/api";
import { streamSseBody } from "@/lib/sse";
import type {
  AccountSummary,
  MessageDto,
  SessionDetail,
  SessionDto,
  SessionEvent,
} from "@/lib/types";

async function toApiError(res: Response, path: string): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  // Accept both `{message}` and the api's `{error: {message}}` envelope.
  let detail = res.statusText;
  if (body && typeof body === "object") {
    const obj = body as { message?: unknown; error?: unknown };
    if (typeof obj.message === "string") {
      detail = obj.message;
    } else if (obj.error && typeof obj.error === "object") {
      const inner = obj.error as { message?: unknown };
      if (typeof inner.message === "string") detail = inner.message;
    }
  }
  return new ApiError(res.status, `${res.status} ${path}: ${detail}`, body);
}

/** Mirror lib/api's manna broadcast for streams built outside sseStream. */
async function* withMannaBroadcast(
  source: AsyncGenerator<SessionEvent, void, undefined>,
): AsyncGenerator<SessionEvent, void, undefined> {
  for await (const event of source) {
    if (event.type === "manna.updated") emitMannaUpdate(event.balance);
    yield event;
  }
}

export interface NewSessionStream {
  /** Session id from the `x-session-id` header (fallback to turn.started). */
  sessionIdHint: string | null;
  events: AsyncGenerator<SessionEvent, void, undefined>;
}

/**
 * POST /api/sessions/new/messages {content, agentUsername} -> SSE stream.
 * Throws ApiError on a non-2xx response (402 = insufficient manna).
 */
export async function startNewSessionStream(
  body: { content: string; agentUsername: string },
  signal?: AbortSignal,
): Promise<NewSessionStream> {
  const path = "/sessions/new/messages";
  const res = await fetch(`/api${path}`, {
    method: "POST",
    cache: "no-store",
    ...(signal ? { signal } : {}),
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res, path);
  if (!res.body) {
    throw new ApiError(res.status, `${res.status} ${path}: empty stream body`);
  }
  return {
    sessionIdHint: res.headers.get("x-session-id"),
    events: withMannaBroadcast(streamSseBody(res.body)),
  };
}

/**
 * GET /api/sessions/:id[?cursor] -> {session, messages ascending, nextCursor}.
 * Accepts uuid or legacy 24-hex permalink ids; nextCursor pages OLDER.
 */
export async function fetchSessionPage(
  id: string,
  cursor?: string,
): Promise<SessionDetail> {
  const search = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const path = `/sessions/${encodeURIComponent(id)}${search}`;
  const res = await fetch(`/api${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await toApiError(res, path);
  const data: unknown = await res.json();
  const obj =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return {
    session: (obj.session ?? data) as SessionDto,
    messages: Array.isArray(obj.messages) ? (obj.messages as MessageDto[]) : [],
    nextCursor: typeof obj.nextCursor === "string" ? obj.nextCursor : null,
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by the conversation view + sessions rail
// ---------------------------------------------------------------------------

/** Embedded agent summaries when the API joined them in (may be empty). */
export function sessionAgents(
  session: SessionDto | null | undefined,
): AccountSummary[] {
  return session?.agents ?? [];
}

/** "Session with <agents>" fallback title chain. */
export function sessionTitle(session: SessionDto | null | undefined): string {
  const title = session?.title?.trim();
  if (title) return title;
  const agents = sessionAgents(session);
  if (agents.length > 0) {
    return agents.map((agent) => agent.username).join(", ");
  }
  return "Conversation";
}

/** Best displayable error text for a thrown value. */
export function describeSendError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 402) return "Not enough manna to send this message.";
    if (error.status === 401) {
      return "Sign in first — pick a dev user from the switcher in the sidebar.";
    }
    if (error.status === 501 || error.status === 404) {
      return "The chat endpoint isn't live yet — the API is still landing.";
    }
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong sending the message.";
}

export function isInsufficientManna(error: unknown): boolean {
  return error instanceof ApiError && error.status === 402;
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
