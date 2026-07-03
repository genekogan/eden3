import type { Usage } from '@eden3/shared';
import { z } from 'zod';

/**
 * @eden3/gateway — types shared by the compat (streaming chat) and tools
 * (/tools/invoke) clients for the OpenClaw gateway.
 *
 * ## Agent addressing (probed live 2026-07-02, openclaw 2026.6.10)
 *
 * The gateway stores every session under a GLOBAL key of the form
 * `agent:<agentId>:<key>`. Routing a request to a specific agent happens via
 * that scoped session key — NOT via the OpenAI `model` field:
 *
 *   - `model: "openclaw/testbot"` + plain `x-openclaw-session-key: eden3:s:<uuid>`
 *     → session landed at `agent:main:eden3:s:<uuid>` (default agent answered).
 *   - `x-openclaw-agent-id: testbot` header → also landed on `agent:main:...`.
 *   - `x-openclaw-session-key: agent:testbot:eden3:s:<uuid>` → session landed
 *     at `agent:testbot:...` and testbot's (smaller) workspace context was
 *     used. This is the mechanism we rely on.
 *
 * We still send `model: "openclaw/<agentId>"` (it is echoed back in chunks and
 * is the id listed by `/v1/models`), plus the scoped key in BOTH the
 * `x-openclaw-session-key` header and the OpenAI `user` field.
 */

// ---------------------------------------------------------------------------
// Client options + addressing
// ---------------------------------------------------------------------------

export interface GatewayClientOptions {
  /** Gateway origin, e.g. "http://127.0.0.1:18789" (trailing slashes ok). */
  baseUrl: string;
  /** Gateway bearer token (OPENCLAW_GATEWAY_TOKEN). Never log it. */
  token: string;
  /** Injectable fetch for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Canonical global session key for `(agentId, sessionKey)`:
 * `agent:<agentId>:<sessionKey>`. Idempotent — keys already scoped with
 * `agent:` are returned unchanged (so callers may pass either the eden3 key
 * `eden3:s:<uuid>` from @eden3/core or a fully-scoped gateway key).
 */
export function scopedSessionKey(agentId: string, sessionKey: string): string {
  if (sessionKey.startsWith('agent:')) return sessionKey;
  return `agent:${agentId}:${sessionKey}`;
}

// ---------------------------------------------------------------------------
// Chat turn events (compat client)
// ---------------------------------------------------------------------------

/**
 * The exact filler string the gateway's OpenAI-compat shim substitutes when an
 * assistant turn produced no text (typically: the agent kicked off an async
 * tool like image_generate and said nothing). Treat it as an EMPTY turn.
 *
 * Source of truth: openclaw `src/gateway/openai-http.ts`
 * (`resolveAgentResponseText`) — note the literal INCLUDES the trailing
 * period. Verified live 2026-07-03 (an image_generate turn streamed exactly
 * this 26-char chunk). Early spike notes quoted it without the period; the
 * unpunctuated variant is kept in {@link NO_RESPONSE_SENTINELS} defensively.
 */
export const NO_RESPONSE_SENTINEL = 'No response from OpenClaw.';

/**
 * All known filler variants, longest first. A turn whose ENTIRE text equals
 * any of these is an empty turn. (Every entry must be a prefix of the first,
 * longest entry — the streaming hold-back logic relies on that.)
 */
export const NO_RESPONSE_SENTINELS: readonly string[] = [
  NO_RESPONSE_SENTINEL,
  'No response from OpenClaw',
];

/** True when `text` (the FULL turn text) is a compat empty-turn filler. */
export function isNoResponseSentinel(text: string): boolean {
  return NO_RESPONSE_SENTINELS.includes(text);
}

/** Usage from the trailing usage chunk, in @eden3/shared terms (+ cache). */
export interface GatewayUsage extends Usage {
  /** Prompt tokens served from the provider prompt cache (metering input). */
  cachedTokens?: number;
}

export interface ChatTurnParams {
  /** OpenClaw agent id, e.g. "testbot". */
  agentId: string;
  /** eden3 gateway session key (`eden3:s:<uuid>`) or a fully-scoped key. */
  sessionKey: string;
  /**
   * ONLY the newest user message. Gateway sessions hold history server-side;
   * sending prior turns would duplicate them (spike probe #7).
   */
  userMessage: string;
  /**
   * Abort streaming: the upstream turn cannot be cancelled, so on abort the
   * client just stops reading and the iterator ends (no further events).
   */
  signal?: AbortSignal;
}

/**
 * Internal gateway-level turn events. These map 1:1 onto the @eden3/shared
 * session events (`turn.started`, `token`, `turn.completed`, `error`) — the
 * api layer adds persistence-level fields (sessionId/turnId/messageId) when
 * fanning out over the session bus.
 */
export type GatewayTurnEvent =
  | { type: 'turn.started' }
  | { type: 'token'; delta: string }
  | {
      type: 'turn.completed';
      /** Full assistant text; '' when the turn was empty (see emptyTurn). */
      text: string;
      /**
       * True when the assistant produced no real text — either genuinely
       * empty or the literal NO_RESPONSE_SENTINEL filler (async tool pending;
       * map to media.pending upstream rather than showing filler text).
       */
      emptyTurn: boolean;
      usage?: GatewayUsage;
      finishReason?: string | null;
    }
  | {
      type: 'error';
      /** e.g. "gateway_http_error" | "gateway_stream_error" | "gateway_upstream_error" | "gateway_unreachable". */
      code: string;
      message: string;
      /** HTTP status when code === "gateway_http_error". */
      status?: number;
      detail?: unknown;
    };

// ---------------------------------------------------------------------------
// OpenAI-compat wire schemas (permissive — unknown fields pass through)
// ---------------------------------------------------------------------------
// Observed tail chunk (live probe): cold session
//   {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":7,"total_tokens":26374}}
// warm session
//   {"choices":[],"usage":{"prompt_tokens":26367,"completion_tokens":7,
//     "total_tokens":26413,"prompt_tokens_details":{"cached_tokens":26364}}}

export const compatUsageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    /** Not observed flat on this gateway, but tolerated. */
    cached_tokens: z.number().optional(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).nullish(),
  })
  .passthrough();
export type CompatUsage = z.infer<typeof compatUsageSchema>;

export const compatChunkSchema = z
  .object({
    id: z.string().optional(),
    object: z.string().optional(),
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            index: z.number().optional(),
            delta: z
              .object({ role: z.string().optional(), content: z.string().nullish() })
              .passthrough()
              .nullish(),
            finish_reason: z.string().nullish(),
          })
          .passthrough(),
      )
      .optional(),
    usage: compatUsageSchema.nullish(),
    /** OpenAI-style in-stream error payload. */
    error: z.unknown().optional(),
  })
  .passthrough();
export type CompatChunk = z.infer<typeof compatChunkSchema>;

/** Map a wire usage block to {@link GatewayUsage}. */
export function toGatewayUsage(usage: CompatUsage): GatewayUsage {
  const out: GatewayUsage = {};
  if (typeof usage.prompt_tokens === 'number') out.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') out.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === 'number') out.totalTokens = usage.total_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens;
  if (typeof cached === 'number') out.cachedTokens = cached;
  return out;
}

// ---------------------------------------------------------------------------
// /tools/invoke envelope + tool payloads
// ---------------------------------------------------------------------------

export const toolInvokeEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    result: z
      .object({
        content: z
          .array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough())
          .optional(),
        details: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    error: z
      .object({ type: z.string().optional(), message: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ToolInvokeEnvelope = z.infer<typeof toolInvokeEnvelopeSchema>;

/** `result.details` of async tools, e.g. image_generate → {async:true, taskId}. */
export const asyncToolDetailsSchema = z
  .object({ async: z.boolean().optional(), taskId: z.string().optional() })
  .passthrough();

export interface ToolInvokeParams {
  tool: string;
  args: Record<string, unknown>;
  agentId: string;
  /**
   * Optional session context for the invocation (plain eden3 key ok — it is
   * scoped with `agent:<agentId>:`). Async completion messages get posted
   * into this gateway session.
   */
  sessionKey?: string;
  signal?: AbortSignal;
}

export interface ToolInvokeResult {
  /** True when the tool queued an async task (media tools). */
  async: boolean;
  /** Async task id — NOT correlated with output filenames (spike probe #4). */
  taskId?: string;
  /** Raw `result.details` payload for callers needing tool-specific fields. */
  details: unknown;
}

// --- sessions_history ------------------------------------------------------

export const historyContentBlockSchema = z
  .object({ type: z.string().optional(), text: z.string().optional() })
  .passthrough();
export type HistoryContentBlock = z.infer<typeof historyContentBlockSchema>;

export const historyMessageSchema = z
  .object({
    role: z.string(),
    /** Content blocks ([{type:"text",text}]) — string tolerated defensively. */
    content: z.union([z.string(), z.array(historyContentBlockSchema)]).optional(),
    /** Message timestamp (ms epoch). */
    timestamp: z.number().optional(),
    model: z.string().optional(),
    stopReason: z.string().optional(),
  })
  .passthrough();
export type GatewayHistoryMessage = z.infer<typeof historyMessageSchema>;

/** Join the text blocks of a history message into one string. */
export function historyMessageText(message: GatewayHistoryMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export const sessionsHistoryDetailsSchema = z
  .object({
    /** "forbidden" | "error" on failure payloads (ok:true envelope!). */
    status: z.string().optional(),
    error: z.string().optional(),
    sessionKey: z.string().optional(),
    messages: z.array(historyMessageSchema).optional(),
    truncated: z.boolean().optional(),
    droppedMessages: z.union([z.boolean(), z.number()]).optional(),
    contentTruncated: z.boolean().optional(),
    contentRedacted: z.boolean().optional(),
    bytes: z.number().optional(),
  })
  .passthrough();

export interface SessionsHistoryParams {
  /** eden3 session key (`eden3:s:<uuid>`) or fully-scoped gateway key. */
  sessionKey: string;
  agentId: string;
  /** Newest-N messages (limit:1 returned just the latest assistant message). */
  limit?: number;
  signal?: AbortSignal;
}

export interface SessionsHistoryResult {
  /** Fully-scoped gateway session key the history belongs to. */
  sessionKey: string;
  messages: GatewayHistoryMessage[];
  truncated: boolean;
  contentTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Non-2xx HTTP response from the gateway. */
export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

/** Tool-level failure (ok:false envelope, or failure payload in details). */
export class GatewayToolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'GatewayToolError';
  }
}
