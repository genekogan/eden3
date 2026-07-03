import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { OpenClawCompatClient } from '../../src/compat-client';
import { OpenClawToolsClient } from '../../src/tools-client';
import {
  NO_RESPONSE_SENTINEL,
  historyMessageText,
  scopedSessionKey,
  type GatewayTurnEvent,
} from '../../src/types';

/**
 * Integration tests against the LIVE OpenClaw gateway.
 *
 * Requirements (see docs/dev/spike.md and infra/):
 *   - gateway at OPENCLAW_BASE_URL (default http://127.0.0.1:18789)
 *   - agent "testbot" registered (haiku — cheap; used for all turns here)
 *   - OPENCLAW_GATEWAY_TOKEN in the environment or the repo-root .env
 *
 * Run: pnpm --filter @eden3/gateway test:integration
 *
 * Latency note: gateway turns regularly take 5-15s (cold-cache first turns
 * longer); vitest.integration.config.ts sets testTimeout to 120s on purpose.
 * The image_generate test only asserts the TURN result — it never waits for
 * the async media file.
 */

const AGENT_ID = 'testbot';

/**
 * Mirror of @eden3/db loadRootEnv (gateway must not depend on db): walk up
 * from cwd and load the first .env into process.env. Real env vars win, per
 * Node --env-file semantics. The token value is never logged.
 */
function loadRootEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function freshSessionKey(): string {
  // Same shape @eden3/core gatewaySessionKey() produces: eden3:s:<uuid>.
  return `eden3:s:${randomUUID()}`;
}

async function collect(iter: AsyncIterable<GatewayTurnEvent>): Promise<GatewayTurnEvent[]> {
  const out: GatewayTurnEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

type CompletedEvent = Extract<GatewayTurnEvent, { type: 'turn.completed' }>;

/** Assert the stream ended in turn.completed with no error events; return it. */
function expectCompleted(events: GatewayTurnEvent[]): CompletedEvent {
  expect(events.filter((e) => e.type === 'error')).toEqual([]);
  const last = events.at(-1);
  if (last?.type !== 'turn.completed') {
    throw new Error(`expected trailing turn.completed, got: ${JSON.stringify(last)}`);
  }
  return last;
}

function tokenText(events: GatewayTurnEvent[]): string {
  return events
    .filter((e): e is Extract<GatewayTurnEvent, { type: 'token' }> => e.type === 'token')
    .map((e) => e.delta)
    .join('');
}

let compat: OpenClawCompatClient;
let tools: OpenClawToolsClient;

beforeAll(async () => {
  loadRootEnv();
  const baseUrl = process.env.OPENCLAW_BASE_URL ?? 'http://127.0.0.1:18789';
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error(
      'OPENCLAW_GATEWAY_TOKEN is not set (env or repo-root .env) — cannot run gateway integration tests',
    );
  }

  // Preflight: fail fast with a clear message when the stack is down or the
  // test agent is missing (instead of 15 opaque timeouts later).
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`gateway preflight failed: GET /v1/models responded ${res.status}`);
  }
  const models = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (models.data ?? []).map((m) => m.id);
  if (!ids.includes(`openclaw/${AGENT_ID}`)) {
    throw new Error(
      `agent "${AGENT_ID}" is not registered on the gateway (models: ${ids.join(', ')})`,
    );
  }

  compat = new OpenClawCompatClient({ baseUrl, token });
  tools = new OpenClawToolsClient({ baseUrl, token });
});

describe('OpenClawCompatClient.chatTurn (live)', () => {
  it('streams a full turn: turn.started, token(s), turn.completed with usage', async () => {
    const sessionKey = freshSessionKey();
    const events = await collect(
      compat.chatTurn({
        agentId: AGENT_ID,
        sessionKey,
        userMessage: 'Reply with exactly one word: pomegranate',
      }),
    );

    expect(events[0]).toEqual({ type: 'turn.started' });
    const completed = expectCompleted(events);

    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens.length).toBeGreaterThan(0); // block granularity: may be just 1
    expect(tokenText(events)).toBe(completed.text);

    expect(completed.emptyTurn).toBe(false);
    expect(completed.text.toLowerCase()).toContain('pomegranate');

    // Usage tail (stream_options.include_usage) — the metering source.
    expect(completed.usage).toBeDefined();
    expect(completed.usage?.completionTokens).toBeGreaterThan(0);
    expect(completed.usage?.promptTokens).toBeGreaterThan(0);
    expect(completed.usage?.totalTokens).toBeGreaterThan(0);
  });

  it('keeps continuity across two turns on the same sessionKey (server-side history)', async () => {
    const sessionKey = freshSessionKey();
    const codeword = `verdant-${randomUUID().slice(0, 8)}`;

    const first = await collect(
      compat.chatTurn({
        agentId: AGENT_ID,
        sessionKey,
        userMessage: `Remember this codeword: ${codeword}. Acknowledge briefly.`,
      }),
    );
    expectCompleted(first);

    // Second turn sends ONLY the new message (chatTurn's contract) — recall
    // therefore proves the gateway kept the session history server-side.
    const second = await collect(
      compat.chatTurn({
        agentId: AGENT_ID,
        sessionKey,
        userMessage: 'What was the codeword I told you? Reply with only the codeword.',
      }),
    );
    const completed = expectCompleted(second);
    expect(completed.text.toLowerCase()).toContain(codeword.toLowerCase());

    // Cross-check via the tools client: the transcript is addressable through
    // sessions_history with the probed args shape (scoped key + top-level
    // sessionKey context) and contains both turns.
    const history = await tools.sessionsHistory({ sessionKey, agentId: AGENT_ID, limit: 20 });
    expect(history.sessionKey).toBe(scopedSessionKey(AGENT_ID, sessionKey));
    expect(history.messages.length).toBeGreaterThanOrEqual(4); // user,assistant × 2
    const roles = new Set(history.messages.map((m) => m.role));
    expect(roles.has('user')).toBe(true);
    expect(roles.has('assistant')).toBe(true);
    const transcript = history.messages.map((m) => historyMessageText(m)).join('\n');
    expect(transcript).toContain(codeword);
  });

  it('never surfaces the compat filler when the agent starts image_generate (throwaway session)', async () => {
    const sessionKey = freshSessionKey(); // throwaway — media lands later; we do NOT wait
    const events = await collect(
      compat.chatTurn({
        agentId: AGENT_ID,
        sessionKey,
        userMessage:
          'Use your image_generate tool right now to generate a tiny image of a plain gray ' +
          'square. Do not write any reply text at all — no acknowledgement — just start the tool.',
      }),
    );
    const completed = expectCompleted(events);

    // Spike finding: an async-tool turn may end with EMPTY assistant text,
    // which the compat shim fills with the literal "No response from
    // OpenClaw". Whichever way the agent behaves, that filler must never
    // reach us as text — it maps to emptyTurn:true with text ''.
    // eslint-disable-next-line no-console
    console.info(
      `[itest] image_generate turn: emptyTurn=${completed.emptyTurn} textLength=${completed.text.length}`,
    );
    if (completed.emptyTurn) {
      expect(completed.text).toBe('');
      expect(events.filter((e) => e.type === 'token')).toEqual([]);
    } else {
      // Agent chose to announce the generation — real text, not the filler.
      expect(completed.text.length).toBeGreaterThan(0);
    }
    expect(completed.text).not.toContain(NO_RESPONSE_SENTINEL);
    expect(tokenText(events)).not.toContain(NO_RESPONSE_SENTINEL);
  });
});

describe('OpenClawToolsClient (live)', () => {
  it('invokeTool(image_generate) returns {async:true, taskId} immediately', async () => {
    const sessionKey = freshSessionKey(); // completion agent will post here later; we do NOT wait
    const result = await tools.invokeTool({
      tool: 'image_generate',
      args: { prompt: 'a plain gray square, flat color, minimal' },
      agentId: AGENT_ID,
      sessionKey,
    });
    expect(result.async).toBe(true);
    expect(typeof result.taskId).toBe('string');
    expect(result.taskId!.length).toBeGreaterThan(0);
  });

  it('sessionsHistory on a never-used session resolves to an EMPTY history (probed 2026-07-03)', async () => {
    // With the full addressing shape (scoped args.sessionKey + top-level
    // sessionKey context) the gateway answers ok with zero messages for a
    // session that has never seen a turn — no "No session found" failure
    // payload (that only fires for unscoped/miskeyed addressing, which the
    // client never emits). Callers must treat empty as "nothing to sync".
    const sessionKey = freshSessionKey();
    const history = await tools.sessionsHistory({ sessionKey, agentId: AGENT_ID, limit: 5 });
    expect(history.sessionKey).toBe(scopedSessionKey(AGENT_ID, sessionKey));
    expect(history.messages).toEqual([]);
    expect(history.truncated).toBe(false);
  });
});
