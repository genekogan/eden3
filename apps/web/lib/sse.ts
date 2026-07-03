/**
 * SSE plumbing for the @eden3/shared event model. Two transports share it:
 *
 *  1. POST-and-stream — `POST /api/sessions/(new|:id)/messages` answers with
 *     an SSE body; `streamSseBody` parses the ReadableStream into typed
 *     events (used by lib/api.ts `sseStream`).
 *  2. Long-lived channel — `GET /api/sessions/:id/events` via EventSource
 *     (`subscribeSessionEvents`, used by lib/api.ts `subscribeSession`).
 *
 * Wire contract: every frame is `data: {"type":"token",...}` — the
 * discriminator lives INSIDE the JSON payload (no `event:` field), so the
 * browser delivers everything through `onmessage` and frames decode with the
 * shared zod union. Malformed/unknown frames are dropped (optionally
 * reported) so a newer api can't crash an older client.
 */

import { extractSseData, tryParseSessionEvent } from "@eden3/shared";
import type { SessionEvent } from "@eden3/shared";

// ---------------------------------------------------------------------------
// Incremental frame splitting (fetch/ReadableStream transport)
// ---------------------------------------------------------------------------

export interface SseFrameSplitter {
  /** Feed a decoded text chunk; returns any frames it completed. */
  push(chunk: string): string[];
  /** Drain the tail after EOF (a final frame may lack its blank line). */
  flush(): string | null;
}

/**
 * Stateful splitter that turns an arbitrary chunking of an SSE byte stream
 * into whole frames. Handles \n, \r\n and \r line endings, including a CRLF
 * split across two chunks.
 */
export function createSseFrameSplitter(): SseFrameSplitter {
  let buffer = "";

  const push = (chunk: string): string[] => {
    buffer += chunk;
    // Hold back a trailing lone CR — it may be the first half of a CRLF.
    let held = "";
    if (buffer.endsWith("\r")) {
      held = "\r";
      buffer = buffer.slice(0, -1);
    }
    // Normalizing is idempotent, so the remainder can be re-scanned next push.
    const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = normalized.split("\n\n");
    buffer = (parts.pop() ?? "") + held;
    return parts.filter((frame) => frame.trim() !== "");
  };

  const flush = (): string | null => {
    const tail = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    buffer = "";
    return tail.trim() === "" ? null : tail;
  };

  return { push, flush };
}

export interface StreamSseOptions {
  /** A data frame arrived that failed schema decode (logged/ignored). */
  onUnknownFrame?: (frame: string) => void;
}

/** Decode one whole frame; null for comments/heartbeats/unknown events. */
function frameToEvent(
  frame: string,
  options: StreamSseOptions,
): SessionEvent | null {
  const payload = extractSseData(frame);
  if (payload === null) return null; // comment / heartbeat frame
  const event = tryParseSessionEvent(payload);
  if (!event) options.onUnknownFrame?.(frame);
  return event;
}

/**
 * Parse an SSE response body (e.g. `res.body` from a fetch POST) into typed
 * SessionEvents. Cancels the underlying reader when the consumer exits early
 * (break/return/throw), which aborts the HTTP stream.
 */
export async function* streamSseBody(
  body: ReadableStream<Uint8Array>,
  options: StreamSseOptions = {},
): AsyncGenerator<SessionEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const splitter = createSseFrameSplitter();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of splitter.push(decoder.decode(value, { stream: true }))) {
        const event = frameToEvent(frame, options);
        if (event) yield event;
      }
    }
    // Flush any buffered multi-byte sequence, then the final frame.
    const frames = splitter.push(decoder.decode());
    const tail = splitter.flush();
    if (tail !== null) frames.push(tail);
    for (const frame of frames) {
      const event = frameToEvent(frame, options);
      if (event) yield event;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// EventSource transport (long-lived per-session channel)
// ---------------------------------------------------------------------------

export interface SessionEventStreamOptions {
  /** Override the stream URL (default: /api/sessions/:id/events). */
  url?: string;
  onOpen?: () => void;
  /**
   * Connection-level failures (api down, proxy drop). EventSource auto-
   * reconnects; close via the returned unsubscribe to stop it.
   */
  onConnectionError?: (event: Event) => void;
  /** A data frame arrived that failed schema decode (logged/ignored). */
  onUnknownFrame?: (raw: string) => void;
}

export function sessionEventsUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/events`;
}

/**
 * Subscribe to a session's live events. Browser-only (EventSource); call it
 * from client components. Returns an unsubscribe function.
 */
export function subscribeSessionEvents(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
  options: SessionEventStreamOptions = {},
): () => void {
  if (typeof EventSource === "undefined") {
    throw new Error(
      "subscribeSessionEvents requires EventSource — call it from a client component",
    );
  }

  const source = new EventSource(options.url ?? sessionEventsUrl(sessionId));

  source.onmessage = (ev: MessageEvent<string>) => {
    const event = decodeSessionEventData(ev.data);
    if (event) {
      onEvent(event);
    } else if (options.onUnknownFrame) {
      options.onUnknownFrame(ev.data);
    }
  };

  if (options.onOpen) source.onopen = options.onOpen;
  if (options.onConnectionError) source.onerror = options.onConnectionError;

  return () => source.close();
}

/**
 * Decode one already-de-framed SSE payload (browser `MessageEvent#data`)
 * into a typed SessionEvent via the @eden3/shared zod union, or null if it
 * is not a known event. Exported for tests and non-EventSource consumers.
 */
export function decodeSessionEventData(raw: unknown): SessionEvent | null {
  if (typeof raw !== "string") return null;
  return tryParseSessionEvent(raw);
}
