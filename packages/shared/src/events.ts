/**
 * @eden3/shared — internal SSE event model.
 *
 * Events flow api -> web over the per-session channel
 * (`GET /sessions/:id/events`). Every event is one SSE frame:
 *
 *     data: {"type":"token","turnId":"…","delta":"…"}\n\n
 *
 * The discriminator lives INSIDE the JSON payload (no `event:` field), so
 * browser `EventSource` consumers handle everything in `onmessage`.
 *
 * Lifecycle of a chat turn:
 *   turn.started -> token* -> turn.completed
 *                -> media.pending -> media.attached   (async, may land later)
 *                -> manna.updated                     (after debits/refunds)
 *   error may replace/interrupt any of the above.
 */
import { z } from 'zod';

import { appNotificationKindSchema } from './dto';

const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// Event schemas
// ---------------------------------------------------------------------------

/** Token usage reported by the gateway's trailing usage chunk. */
export const usageSchema = z.object({
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

/** A turn was accepted (manna debited) and streaming is about to begin. */
export const turnStartedEventSchema = z.object({
  type: z.literal('turn.started'),
  sessionId: uuid,
  turnId: uuid,
});
export type TurnStartedEvent = z.infer<typeof turnStartedEventSchema>;

/** Incremental assistant text (delta may be empty or contain newlines). */
export const tokenEventSchema = z.object({
  type: z.literal('token'),
  turnId: uuid,
  delta: z.string(),
});
export type TokenEvent = z.infer<typeof tokenEventSchema>;

/** Assistant message persisted; `messageId` is its row id. */
export const turnCompletedEventSchema = z.object({
  type: z.literal('turn.completed'),
  turnId: uuid,
  messageId: uuid,
  usage: usageSchema.optional(),
});
export type TurnCompletedEvent = z.infer<typeof turnCompletedEventSchema>;

/** The agent invoked a media tool; a file will land asynchronously. */
export const mediaPendingEventSchema = z.object({
  type: z.literal('media.pending'),
  sessionId: uuid,
  /** Tool name, e.g. "image_generate". */
  tool: z.string().min(1),
});
export type MediaPendingEvent = z.infer<typeof mediaPendingEventSchema>;

/** The media watcher correlated a generated file into the session. */
export const mediaAttachedEventSchema = z.object({
  type: z.literal('media.attached'),
  sessionId: uuid,
  /** The (media) assistant message the file was attached to. */
  messageId: uuid,
  /** Servable URL (local /media path for new files). */
  url: z.string().min(1),
  mime: z.string().min(1),
  creationId: uuid,
});
export type MediaAttachedEvent = z.infer<typeof mediaAttachedEventSchema>;

/** Balance changed (debit, media charge, or refund). */
export const mannaUpdatedEventSchema = z.object({
  type: z.literal('manna.updated'),
  accountId: uuid,
  balance: z.number().finite(),
});
export type MannaUpdatedEvent = z.infer<typeof mannaUpdatedEventSchema>;

/** Something failed; if turn-scoped, `turnId` is set (debit already refunded). */
export const errorEventSchema = z.object({
  type: z.literal('error'),
  turnId: uuid.optional(),
  /** Machine-readable code, e.g. "insufficient_manna", "gateway_error". */
  code: z.string().min(1),
  message: z.string(),
});
export type ErrorEvent = z.infer<typeof errorEventSchema>;

/** A durable notification was committed for the authenticated account. */
export const notificationCreatedEventSchema = z.object({
  type: z.literal('notification.created'),
  notificationId: uuid,
  kind: appNotificationKindSchema,
});
export type NotificationCreatedEvent = z.infer<typeof notificationCreatedEventSchema>;

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const sessionEventSchema = z.discriminatedUnion('type', [
  turnStartedEventSchema,
  tokenEventSchema,
  turnCompletedEventSchema,
  mediaPendingEventSchema,
  mediaAttachedEventSchema,
  mannaUpdatedEventSchema,
  notificationCreatedEventSchema,
  errorEventSchema,
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent['type'];

export const SESSION_EVENT_TYPES = [
  'turn.started',
  'token',
  'turn.completed',
  'media.pending',
  'media.attached',
  'manna.updated',
  'notification.created',
  'error',
] as const satisfies readonly SessionEventType[];

// ---------------------------------------------------------------------------
// SSE framing — encode
// ---------------------------------------------------------------------------

/**
 * Encode an event as a complete SSE frame: `data: <json>\n\n`.
 * Validates (and canonicalizes — unknown keys are stripped) via the schema;
 * throws ZodError on a malformed event. JSON.stringify escapes all newlines,
 * so the payload is always a single `data:` line.
 */
export function encodeSseEvent(event: SessionEvent): string {
  const validated = sessionEventSchema.parse(event);
  return `data: ${JSON.stringify(validated)}\n\n`;
}

/** SSE comment frame (heartbeat/keep-alive): `: ping\n\n`. */
export function encodeSseComment(comment = 'ping'): string {
  return `: ${comment.replace(/[\r\n]+/g, ' ')}\n\n`;
}

// ---------------------------------------------------------------------------
// SSE framing — decode
// ---------------------------------------------------------------------------

/**
 * Extract the data payload from one SSE frame, per the SSE spec: collect
 * every `data:` line (strip one optional leading space), join with "\n".
 * Returns null for frames without data (comments, retry:, empty).
 */
export function extractSseData(frame: string): string | null {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line === 'data') {
      dataLines.push('');
    } else if (line.startsWith('data:')) {
      let value = line.slice('data:'.length);
      if (value.startsWith(' ')) value = value.slice(1);
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

/**
 * Decode one SSE frame into a SessionEvent. Throws on comment/empty frames,
 * invalid JSON, or schema mismatch.
 */
export function decodeSseEvent(frame: string): SessionEvent {
  const payload = extractSseData(frame);
  if (payload === null) {
    throw new Error('Not an SSE data frame (no "data:" line)');
  }
  return parseSessionEvent(payload);
}

/** Like decodeSseEvent, but returns null instead of throwing. */
export function tryDecodeSseEvent(frame: string): SessionEvent | null {
  const payload = extractSseData(frame);
  if (payload === null) return null;
  return tryParseSessionEvent(payload);
}

/**
 * Parse a bare JSON payload (e.g. browser `MessageEvent#data`, which arrives
 * already de-framed) into a SessionEvent. Throws on invalid input.
 */
export function parseSessionEvent(json: string): SessionEvent {
  return sessionEventSchema.parse(JSON.parse(json));
}

/** Like parseSessionEvent, but returns null instead of throwing. */
export function tryParseSessionEvent(json: string): SessionEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = sessionEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
