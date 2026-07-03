import { createParser } from 'eventsource-parser';

import {
  NO_RESPONSE_SENTINEL,
  compatChunkSchema,
  isNoResponseSentinel,
  scopedSessionKey,
  toGatewayUsage,
  type ChatTurnParams,
  type GatewayClientOptions,
  type GatewayTurnEvent,
  type GatewayUsage,
} from './types';

/**
 * Streaming chat client for the OpenClaw gateway's OpenAI-compat endpoint.
 *
 * Wire format (probed live 2026-07-02 against openclaw 2026.6.10):
 *
 *   POST /v1/chat/completions   {model:"openclaw/<agentId>", stream:true,
 *     stream_options:{include_usage:true}, user:<scoped key>,
 *     messages:[{role:"user",content:<newest user message ONLY>}]}
 *   headers: Authorization bearer, x-openclaw-session-key: <scoped key>
 *
 * SSE frames observed, in order:
 *   1. role chunk        {"choices":[{"delta":{"role":"assistant"},...}]}
 *   2. content chunk(s)  {"choices":[{"delta":{"content":"pom"},...}]}
 *      (block granularity — short replies may arrive as ONE chunk)
 *   3. finish chunk      {"choices":[{"delta":{},"finish_reason":"stop"}]}
 *   4. usage tail        {"choices":[],"usage":{prompt_tokens,completion_tokens,
 *        total_tokens, prompt_tokens_details:{cached_tokens}}}
 *   5. data: [DONE]
 *
 * Empty assistant turns (agent kicked off an async tool and said nothing) are
 * filled by the compat shim with the literal text "No response from OpenClaw."
 * (trailing period included — see NO_RESPONSE_SENTINEL; the shim emits it as
 * one single content chunk when no delta was streamed). That exact full-turn
 * content is mapped to `turn.completed.emptyTurn === true` with text '' and
 * is never leaked as token events.
 */
export class OpenClawCompatClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Run one chat turn, yielding gateway turn events:
   * `turn.started` → `token`* → `turn.completed` (or a single `error` event).
   *
   * The upstream turn cannot be cancelled; when `signal` aborts we simply stop
   * reading and end the iteration (no error / no turn.completed).
   */
  async *chatTurn(params: ChatTurnParams): AsyncGenerator<GatewayTurnEvent, void, void> {
    const { agentId, sessionKey, userMessage, signal } = params;
    if (signal?.aborted) return;

    // Scoped key routes the turn to the agent (see types.ts: the `model`
    // field does NOT route; the `agent:<id>:` session-key prefix does).
    const scoped = scopedSessionKey(agentId, sessionKey);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'x-openclaw-session-key': scoped,
        },
        body: JSON.stringify({
          model: `openclaw/${agentId}`,
          user: scoped,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: userMessage }],
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) return;
      yield {
        type: 'error',
        code: 'gateway_unreachable',
        message: `POST /v1/chat/completions failed: ${describeError(err)}`,
        detail: describeError(err),
      };
      return;
    }

    if (!res.ok) {
      const detail = await safeBodyText(res);
      yield {
        type: 'error',
        code: 'gateway_http_error',
        message: `gateway responded ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
        status: res.status,
        ...(detail !== undefined ? { detail } : {}),
      };
      return;
    }
    if (!res.body) {
      yield {
        type: 'error',
        code: 'gateway_stream_error',
        message: 'gateway returned a 2xx response without a body',
      };
      return;
    }

    yield { type: 'turn.started' };

    // ---- streaming state ----------------------------------------------
    const pending: GatewayTurnEvent[] = [];
    let emitted = ''; // text already yielded as token events
    let held = ''; // buffered tail, withheld while it could still be the filler
    let usage: GatewayUsage | undefined;
    let finishReason: string | null = null;
    let sawDone = false;
    let upstreamError: GatewayTurnEvent | null = null;

    // Sentinel suppression: while nothing has been emitted yet and the
    // accumulated text is a prefix of NO_RESPONSE_SENTINEL (the longest
    // filler variant — every other variant is a prefix of it), hold it back.
    // If the turn ends exactly on a filler variant we emit an empty turn; the
    // moment the text diverges we flush the held buffer as a normal token.
    const onDelta = (delta: string): void => {
      if (delta === '') return;
      held += delta;
      if (emitted === '' && NO_RESPONSE_SENTINEL.startsWith(held)) return;
      pending.push({ type: 'token', delta: held });
      emitted += held;
      held = '';
    };

    const parser = createParser({
      onEvent: (event) => {
        if (sawDone || upstreamError !== null) return;
        const data = event.data.trim();
        if (data === '[DONE]') {
          sawDone = true;
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(data);
        } catch {
          return; // tolerate non-JSON frames (forward compat)
        }
        const parsed = compatChunkSchema.safeParse(raw);
        if (!parsed.success) return;
        const chunk = parsed.data;
        if (chunk.error !== undefined) {
          upstreamError = {
            type: 'error',
            code: 'gateway_upstream_error',
            message: describeUpstreamError(chunk.error),
            detail: chunk.error,
          };
          return;
        }
        for (const choice of chunk.choices ?? []) {
          const content = choice.delta?.content;
          if (typeof content === 'string') onDelta(content);
          if (choice.finish_reason != null) finishReason = choice.finish_reason;
        }
        if (chunk.usage != null) usage = toGatewayUsage(chunk.usage);
      },
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (signal?.aborted) return; // stop reading; no further events
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
        while (pending.length > 0) yield pending.shift()!;
        const errEvent = upstreamError;
        if (errEvent !== null) {
          yield errEvent;
          return;
        }
        if (sawDone) break;
      }
    } catch (err) {
      if (signal?.aborted) return;
      while (pending.length > 0) yield pending.shift()!;
      yield {
        type: 'error',
        code: 'gateway_stream_error',
        message: `gateway stream read failed: ${describeError(err)}`,
      };
      return;
    } finally {
      reader.cancel().catch(() => {});
    }

    // Flush decoder + parser remainders (stream may end without [DONE]).
    parser.feed(decoder.decode());
    while (pending.length > 0) yield pending.shift()!;
    const errEvent = upstreamError;
    if (errEvent !== null) {
      yield errEvent;
      return;
    }

    const total = emitted + held;
    if (isNoResponseSentinel(total)) {
      // Compat filler for an empty turn — held text is dropped on purpose.
      yield { type: 'turn.completed', text: '', emptyTurn: true, usage, finishReason };
      return;
    }
    if (held !== '') {
      // Diverged-at-end remainder (e.g. text that is a strict prefix of the
      // sentinel) — deliver it before completing the turn.
      yield { type: 'token', delta: held };
    }
    yield {
      type: 'turn.completed',
      text: total,
      emptyTurn: total === '',
      usage,
      finishReason,
    };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function describeUpstreamError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  if (typeof error === 'string' && error.length > 0) return error;
  return 'gateway reported an upstream error';
}

async function safeBodyText(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.slice(0, 2000);
  } catch {
    return undefined;
  }
}
