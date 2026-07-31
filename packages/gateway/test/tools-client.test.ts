import { describe, expect, it } from 'vitest';

import { OpenClawToolsClient } from '../src/tools-client';
import { GatewayHttpError, GatewayToolError, historyMessageText } from '../src/types';

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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch): OpenClawToolsClient {
  return new OpenClawToolsClient({ baseUrl: 'http://gw.test', token: 'tok-secret', fetchImpl });
}

describe('OpenClawToolsClient.invokeTool', () => {
  it('parses async task details ({async, taskId})', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({
        ok: true,
        result: {
          content: [{ type: 'text', text: 'Started image generation' }],
          details: { async: true, taskId: 'task-123', status: 'accepted' },
        },
      }),
    );
    const result = await client(fetchImpl).invokeTool({
      tool: 'image_generate',
      args: { prompt: 'a red cube' },
      agentId: 'testbot',
    });
    expect(result.async).toBe(true);
    expect(result.taskId).toBe('task-123');
    expect(result.details).toMatchObject({ status: 'accepted' });

    const call = calls[0]!;
    expect(call.url).toBe('http://gw.test/tools/invoke');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-secret');
    const body = JSON.parse(String(call.init.body));
    expect(body).toEqual({
      tool: 'image_generate',
      args: { prompt: 'a red cube' },
      agentId: 'testbot',
    });
    expect('sessionKey' in body).toBe(false);
  });

  it('scopes and sends a top-level sessionKey when provided', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({ ok: true, result: { details: { async: true, taskId: 't' } } }),
    );
    await client(fetchImpl).invokeTool({
      tool: 'image_generate',
      args: { prompt: 'x' },
      agentId: 'testbot',
      sessionKey: 'eden3:s:abc',
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.sessionKey).toBe('agent:testbot:eden3:s:abc');
  });

  it('returns async:false for sync tool payloads', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ ok: true, result: { details: { count: 1, sessions: [] } } }),
    );
    const result = await client(fetchImpl).invokeTool({
      tool: 'sessions_list',
      args: {},
      agentId: 'testbot',
    });
    expect(result.async).toBe(false);
    expect(result.taskId).toBeUndefined();
    expect(result.details).toMatchObject({ count: 1 });
  });

  it('throws GatewayToolError on ok:false envelopes', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ ok: false, error: { type: 'tool_error', message: 'sessionKey required' } }),
    );
    await expect(
      client(fetchImpl).invokeTool({ tool: 'sessions_history', args: {}, agentId: 'testbot' }),
    ).rejects.toThrowError(/sessionKey required/);
  });

  it('throws GatewayHttpError on non-2xx responses', async () => {
    const { fetchImpl } = makeFetch(() => new Response('nope', { status: 500 }));
    const promise = client(fetchImpl).invokeTool({ tool: 'x', args: {}, agentId: 'testbot' });
    await expect(promise).rejects.toBeInstanceOf(GatewayHttpError);
    await expect(promise).rejects.toMatchObject({ status: 500, detail: 'nope' });
  });
});

describe('OpenClawToolsClient.memorySearch', () => {
  it('uses the live gateway tool path and reports the in-gateway tool duration', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({
        ok: true,
        result: {
          details: {
            results: [
              {
                path: 'MEMORY.md',
                startLine: 2,
                endLine: 4,
                score: 0.91,
                snippet: 'covenant',
                vectorScore: 0.88,
              },
            ],
            provider: 'openai',
            model: 'text-embedding-3-small',
            debug: { searchMs: 1180, toolMs: 1215 },
          },
        },
      }),
    );
    const result = await client(fetchImpl).memorySearch({
      agentId: 'abraham',
      query: ' covenant ',
      maxResults: 5,
    });

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      tool: 'memory_search',
      args: { query: 'covenant', maxResults: 5 },
      agentId: 'abraham',
    });
    expect(result).toEqual({
      agentId: 'abraham',
      latencyMs: 1215,
      results: [
        {
          path: 'MEMORY.md',
          startLine: 2,
          endLine: 4,
          score: 0.91,
          snippet: 'covenant',
        },
      ],
    });
  });

  it('rejects invalid bounds and surfaces failure details', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({
        ok: true,
        result: { details: { status: 'error', error: 'embedding provider unavailable' } },
      }),
    );
    const tools = client(fetchImpl);
    await expect(tools.memorySearch({ agentId: 'a', query: ' ', maxResults: 5 })).rejects.toThrow(
      'must not be empty',
    );
    await expect(tools.memorySearch({ agentId: 'a', query: 'x', maxResults: 21 })).rejects.toThrow(
      '1 to 20',
    );
    expect(calls).toHaveLength(0);
    await expect(tools.memorySearch({ agentId: 'a', query: 'x' })).rejects.toThrow(
      'embedding provider unavailable',
    );
  });
});

describe('OpenClawToolsClient.sessionsHistory', () => {
  /** Live success payload shape (probed 2026-07-02, see tools-client.ts). */
  const liveDetails = {
    sessionKey: 'agent:testbot:eden3:s:33333333-3333-4333-8333-333333333ccc',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Say ok' }],
        timestamp: 1783049636328,
        __openclaw: { id: '8ded29b1', recordTimestampMs: 1783049636330, seq: 1 },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        stopReason: 'stop',
        timestamp: 1783049636334,
        responseId: 'msg_x',
        responseModel: 'claude-haiku-4-5-20251001',
        __openclaw: { id: 'e7bd5a68', recordTimestampMs: 1783049637449, seq: 2 },
      },
    ],
    truncated: true,
    droppedMessages: false,
    contentTruncated: true,
    contentRedacted: false,
    bytes: 505,
  };

  it('addresses the session per the probed shape and parses messages', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({ ok: true, result: { content: [{ type: 'text', text: 'json' }], details: liveDetails } }),
    );
    const result = await client(fetchImpl).sessionsHistory({
      sessionKey: 'eden3:s:33333333-3333-4333-8333-333333333ccc',
      agentId: 'testbot',
      limit: 10,
    });

    const scoped = 'agent:testbot:eden3:s:33333333-3333-4333-8333-333333333ccc';
    const body = JSON.parse(String(calls[0]!.init.body));
    // args.sessionKey must be the fully-scoped GLOBAL key, and the top-level
    // sessionKey must set the invocation context to the same session (that is
    // what satisfies tools.sessions.visibility=tree).
    expect(body).toEqual({
      tool: 'sessions_history',
      args: { sessionKey: scoped, limit: 10 },
      agentId: 'testbot',
      sessionKey: scoped,
    });

    expect(result.sessionKey).toBe(scoped);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe('user');
    expect(historyMessageText(result.messages[0]!)).toBe('Say ok');
    expect(historyMessageText(result.messages[1]!)).toBe('ok');
    expect(result.truncated).toBe(true);
    expect(result.contentTruncated).toBe(true);
  });

  it('accepts an already-scoped session key unchanged', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({ ok: true, result: { details: { ...liveDetails } } }),
    );
    await client(fetchImpl).sessionsHistory({
      sessionKey: 'agent:testbot:eden3:s:abc',
      agentId: 'testbot',
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.args.sessionKey).toBe('agent:testbot:eden3:s:abc');
    expect(body.sessionKey).toBe('agent:testbot:eden3:s:abc');
    expect('limit' in body.args).toBe(false);
  });

  it('surfaces forbidden payloads (ok:true envelope) as GatewayToolError', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({
        ok: true,
        result: {
          details: {
            status: 'forbidden',
            error:
              'Session history visibility is restricted to the current session tree (tools.sessions.visibility=tree).',
          },
        },
      }),
    );
    const promise = client(fetchImpl).sessionsHistory({ sessionKey: 'eden3:s:x', agentId: 'testbot' });
    await expect(promise).rejects.toBeInstanceOf(GatewayToolError);
    await expect(promise).rejects.toThrowError(/forbidden/);
  });

  it('surfaces "No session found" payloads as GatewayToolError', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({
        ok: true,
        result: { details: { status: 'error', error: 'No session found: eden3:s:x' } },
      }),
    );
    await expect(
      client(fetchImpl).sessionsHistory({ sessionKey: 'eden3:s:x', agentId: 'testbot' }),
    ).rejects.toThrowError(/No session found/);
  });

  it('returns empty messages when the tool omits the array', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ ok: true, result: { details: { sessionKey: 'agent:testbot:k' } } }),
    );
    const result = await client(fetchImpl).sessionsHistory({ sessionKey: 'k', agentId: 'testbot' });
    expect(result.messages).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
