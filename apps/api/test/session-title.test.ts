import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ChatTurnParams, GatewayTurnEvent } from '@eden3/gateway';
import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_TITLE_MAX_OUTPUT_TOKENS,
  SESSION_TITLE_MODEL,
  SESSION_TITLE_TIMEOUT_MS,
  generateSessionTitle,
  normalizeSessionTitle,
  sessionTitlePrompt,
} from '../src/services/session-title';

function compatWith(events: GatewayTurnEvent[], capture: ChatTurnParams[]) {
  return {
    async *chatTurn(params: ChatTurnParams) {
      capture.push(params);
      for (const event of events) yield event;
    },
  };
}

describe('asynchronous session titles', () => {
  it('uses one isolated cheap bounded turn and persists the normalized result', async () => {
    const calls: ChatTurnParams[] = [];
    const persist = vi.fn(async () => true);
    const saved = await generateSessionTitle({
      compat: compatWith(
        [
          { type: 'turn.started' },
          { type: 'token', delta: '**Rocket' },
          { type: 'turn.completed', text: '**Rocket Image Ideas.**', emptyTurn: false },
        ],
        calls,
      ),
      agentId: 'rocket',
      sessionId: '00000000-0000-4000-8000-000000000001',
      firstMessage: 'Can you make me a dramatic image of a rocket?',
      persistIfCurrent: persist,
    });

    expect(saved).toBe(true);
    expect(persist).toHaveBeenCalledWith('Rocket Image Ideas');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agentId: 'rocket',
      sessionKey: 'eden3:title:00000000-0000-4000-8000-000000000001',
      modelOverride: SESSION_TITLE_MODEL,
      maxOutputTokens: SESSION_TITLE_MAX_OUTPUT_TOKENS,
    });
    expect(calls[0]?.userMessage).toContain('Return only the title');
    expect(calls[0]?.userMessage).toContain('do not use tools');
    expect(SESSION_TITLE_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  it('does not persist errors, empty turns, or a title superseded by human rename', async () => {
    const persist = vi.fn(async () => false);
    await expect(
      generateSessionTitle({
        compat: compatWith(
          [{ type: 'turn.completed', text: 'Human Override Loses', emptyTurn: false }],
          [],
        ),
        agentId: 'agent',
        sessionId: '00000000-0000-4000-8000-000000000001',
        firstMessage: 'hello',
        persistIfCurrent: persist,
      }),
    ).resolves.toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);

    const never = vi.fn(async () => true);
    await expect(
      generateSessionTitle({
        compat: compatWith([{ type: 'error', code: 'gateway_error', message: 'nope' }], []),
        agentId: 'agent',
        sessionId: '00000000-0000-4000-8000-000000000002',
        firstMessage: 'hello',
        persistIfCurrent: never,
      }),
    ).resolves.toBe(false);
    expect(never).not.toHaveBeenCalled();
  });

  it('clamps untrusted output and cheap input context', () => {
    expect(normalizeSessionTitle('  Title: “One two three four five six seven eight!”  ')).toBe(
      'One two three four five six seven',
    );
    expect(normalizeSessionTitle('***')).toBeNull();
    expect(normalizeSessionTitle('rocket', ['rocket'])).toBeNull();
    expect(sessionTitlePrompt('x'.repeat(5_000)).length).toBeLessThan(1_500);
  });

  it('wires a null pending title then compare-and-set, never agent or first-message copy', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/routes/chat.ts'), 'utf8');
    const createStart = source.indexOf('export async function createSession');
    const createEnd = source.indexOf('/** Resolve an existing session', createStart);
    const createSlice = source.slice(createStart, createEnd);
    expect(createSlice).toContain('title: null');
    expect(createSlice).not.toContain('provisionalSessionTitle');
    expect(createSlice).not.toContain('titleFromContent');
    expect(source).toContain('void generateSessionTitle({');
    expect(source).toContain('${sessions.title} is null');
    expect(source).toContain('forbiddenTitles: [target.agent.username]');
  });
});
