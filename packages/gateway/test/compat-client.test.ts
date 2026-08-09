import { describe, expect, it } from 'vitest';

import { OpenClawCompatClient } from '../src/compat-client';
import { NO_RESPONSE_SENTINEL, type GatewayTurnEvent } from '../src/types';

const enc = new TextEncoder();

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function roleChunk(): unknown {
  return { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
}

function contentChunk(content: string): unknown {
  return { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

function finishChunk(reason = 'stop'): unknown {
  return { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

/** Warm-session usage tail as observed live (prompt_tokens_details). */
function usageChunk(usage: Record<string, unknown>): unknown {
  return { id: 'c1', object: 'chat.completion.chunk', choices: [], usage };
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

type FetchCall = { url: string; init: RequestInit };

function makeFetch(factory: (url: string, init: RequestInit) => Response): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: unknown) => {
    const requestInit = (init ?? {}) as RequestInit;
    calls.push({ url: String(input), init: requestInit });
    return factory(String(input), requestInit);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch): OpenClawCompatClient {
  return new OpenClawCompatClient({
    baseUrl: 'http://127.0.0.1:28789/',
    token: 'tok-secret',
    fetchImpl,
  });
}

async function collect(iter: AsyncIterable<GatewayTurnEvent>): Promise<GatewayTurnEvent[]> {
  const out: GatewayTurnEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

const turnParams = {
  agentId: 'testbot',
  sessionKey: 'eden3:s:0f7e0a5e-1111-4222-8333-444444444444',
  userMessage: 'hi',
};

describe('OpenClawCompatClient.chatTurn', () => {
  it('streams tokens and maps the warm usage tail (cached_tokens)', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseResponse([
        frame(roleChunk()),
        frame(contentChunk('pom')),
        frame(contentChunk('egranate')),
        frame(finishChunk('stop')),
        frame(
          usageChunk({
            prompt_tokens: 26367,
            completion_tokens: 7,
            total_tokens: 26413,
            cache_write_tokens: 42,
            prompt_tokens_details: { cached_tokens: 26364 },
          }),
        ),
        frame('[DONE]'),
      ]),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    expect(events).toEqual([
      { type: 'turn.started' },
      { type: 'token', delta: 'pom' },
      { type: 'token', delta: 'egranate' },
      {
        type: 'turn.completed',
        text: 'pomegranate',
        emptyTurn: false,
        usage: {
          promptTokens: 26367,
          completionTokens: 7,
          totalTokens: 26413,
          cachedTokens: 26364,
          cacheWriteTokens: 42,
        },
        finishReason: 'stop',
      },
    ]);
  });

  it('maps the cold usage tail (no prompt_tokens_details)', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseResponse([
        frame(contentChunk('ok')),
        frame(finishChunk()),
        frame(usageChunk({ prompt_tokens: 3, completion_tokens: 7, total_tokens: 26374 })),
        frame('[DONE]'),
      ]),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    const completed = events.at(-1);
    expect(completed).toMatchObject({
      type: 'turn.completed',
      usage: { promptTokens: 3, completionTokens: 7, totalTokens: 26374 },
    });
    expect((completed as { usage?: { cachedTokens?: number } }).usage?.cachedTokens).toBeUndefined();
  });

  it('sends the probed request shape (scoped session key routes the agent)', async () => {
    const { fetchImpl, calls } = makeFetch(() => sseResponse([frame(contentChunk('x')), frame('[DONE]')]));
    await collect(client(fetchImpl).chatTurn(turnParams));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://127.0.0.1:28789/v1/chat/completions');
    expect(call.init.redirect).toBe('error');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-secret');
    const scoped = `agent:testbot:${turnParams.sessionKey}`;
    expect(headers['x-openclaw-session-key']).toBe(scoped);
    const body = JSON.parse(String(call.init.body));
    expect(body).toEqual({
      model: 'openclaw/testbot',
      user: scoped,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('sends a trusted provider/model override through the 7.1 compat header only', async () => {
    const { fetchImpl, calls } = makeFetch(() => sseResponse([frame('[DONE]')]));
    await collect(
      client(fetchImpl).chatTurn({
        ...turnParams,
        modelOverride: 'anthropic/claude-sonnet-4-6',
      }),
    );

    const call = calls[0]!;
    expect((call.init.headers as Record<string, string>)['x-openclaw-model']).toBe(
      'anthropic/claude-sonnet-4-6',
    );
    expect(JSON.parse(String(call.init.body)).model).toBe('openclaw/testbot');
  });

  it('does not re-scope an already scoped session key', async () => {
    const { fetchImpl, calls } = makeFetch(() => sseResponse([frame('[DONE]')]));
    await collect(
      client(fetchImpl).chatTurn({ ...turnParams, sessionKey: 'agent:testbot:eden3:s:abc' }),
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-openclaw-session-key']).toBe('agent:testbot:eden3:s:abc');
  });

  it('maps the exact "No response from OpenClaw." filler (single chunk, as the shim emits it) to an empty turn', async () => {
    expect(NO_RESPONSE_SENTINEL).toBe('No response from OpenClaw.'); // trailing period — openclaw source literal
    const { fetchImpl } = makeFetch(() =>
      sseResponse([
        frame(roleChunk()),
        frame(contentChunk(NO_RESPONSE_SENTINEL)),
        frame(finishChunk()),
        frame(usageChunk({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })),
        frame('[DONE]'),
      ]),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    expect(events.filter((e) => e.type === 'token')).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', text: '', emptyTurn: true });
  });

  it('maps the unpunctuated filler variant to an empty turn too', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseResponse([frame(contentChunk('No response from OpenClaw')), frame(finishChunk()), frame('[DONE]')]),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    expect(events.filter((e) => e.type === 'token')).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', text: '', emptyTurn: true });
  });

  it('suppresses the filler even when split across chunks', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseResponse([
        frame(contentChunk('No response ')),
        frame(contentChunk('from OpenClaw.')),
        frame(finishChunk()),
        frame('[DONE]'),
      ]),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    expect(events.filter((e) => e.type === 'token')).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', text: '', emptyTurn: true });
  });

  it('delivers real text that starts with the full filler string', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseResponse([
        frame(contentChunk('No response from OpenClaw.')),
        frame(contentChunk(' Just kidding — here it is.')),
        frame(finishChunk()),
        frame('[DONE]'),
      ]),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    expect(events.at(-1)).toMatchObject({
      type: 'turn.completed',
      text: 'No response from OpenClaw. Just kidding — here it is.',
      emptyTurn: false,
    });
  });

  it('delivers text that extends past the filler prefix', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseResponse([
        frame(contentChunk('No response from Open')),
        frame(contentChunk('Claw is unavailable right now')),
        frame(finishChunk()),
        frame('[DONE]'),
      ]),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens.map((t) => (t as { delta: string }).delta).join('')).toBe(
      'No response from OpenClaw is unavailable right now',
    );
    expect(events.at(-1)).toMatchObject({
      type: 'turn.completed',
      text: 'No response from OpenClaw is unavailable right now',
      emptyTurn: false,
    });
  });

  it('flushes a strict prefix of the filler at end of stream', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseResponse([frame(contentChunk('No res')), frame(finishChunk()), frame('[DONE]')]),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    expect(events).toEqual([
      { type: 'turn.started' },
      { type: 'token', delta: 'No res' },
      { type: 'turn.completed', text: 'No res', emptyTurn: false, usage: undefined, finishReason: 'stop' },
    ]);
  });

  it('marks a genuinely content-less turn as empty', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseResponse([
        frame(roleChunk()),
        frame(finishChunk()),
        frame(usageChunk({ prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 })),
        frame('[DONE]'),
      ]),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', text: '', emptyTurn: true });
  });

  it('yields a single error event on non-2xx responses', async () => {
    const { fetchImpl } = makeFetch(
      () => new Response('unauthorized: bad token', { status: 401, statusText: 'Unauthorized' }),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      code: 'gateway_http_error',
      status: 401,
      detail: 'unauthorized: bad token',
    });
  });

  it('yields an error event on an in-stream error payload', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseResponse([frame(roleChunk()), frame({ error: { message: 'boom upstream' } })]),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    expect(events[0]).toEqual({ type: 'turn.started' });
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'gateway_upstream_error',
      message: 'boom upstream',
    });
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false);
  });

  it('yields gateway_unreachable when fetch itself rejects', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'gateway_unreachable' });
  });

  it('stops silently on abort: no error, no turn.completed', async () => {
    const ac = new AbortController();
    const { fetchImpl } = makeFetch(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(frame(roleChunk())));
          controller.enqueue(enc.encode(frame(contentChunk('Hello'))));
          // Never close; emulate fetch abort semantics by erroring the body.
          ac.signal.addEventListener('abort', () => {
            try {
              controller.error(new DOMException('This operation was aborted', 'AbortError'));
            } catch {
              /* already closed */
            }
          });
        },
      });
      return new Response(stream, { status: 200 });
    });

    const events: GatewayTurnEvent[] = [];
    for await (const ev of client(fetchImpl).chatTurn({ ...turnParams, signal: ac.signal })) {
      events.push(ev);
      if (ev.type === 'token') ac.abort();
    }
    expect(events).toEqual([
      { type: 'turn.started' },
      { type: 'token', delta: 'Hello' },
    ]);
  });

  it('emits nothing (and never fetches) when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { fetchImpl, calls } = makeFetch(() => sseResponse([frame('[DONE]')]));
    const events = await collect(client(fetchImpl).chatTurn({ ...turnParams, signal: ac.signal }));
    expect(events).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('completes even when the stream ends without [DONE]', async () => {
    const { fetchImpl } = makeFetch(() =>
      sseResponse([frame(contentChunk('partial')), frame(finishChunk())]),
    );
    const events = await collect(client(fetchImpl).chatTurn(turnParams));
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', text: 'partial', emptyTurn: false });
  });
});
