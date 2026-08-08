import { describe, expect, it } from 'vitest';

import {
  SESSION_EVENT_TYPES,
  decodeSseEvent,
  encodeSseComment,
  encodeSseEvent,
  extractSseData,
  parseSessionEvent,
  sessionEventSchema,
  tryDecodeSseEvent,
  tryParseSessionEvent,
  type SessionEvent,
} from '../src/events';

const ids = {
  session: '019797a8-2b2e-7bbb-8f2a-111111111111',
  turn: '019797a8-2b2e-7bbb-8f2a-222222222222',
  message: '019797a8-2b2e-7bbb-8f2a-333333333333',
  creation: '019797a8-2b2e-7bbb-8f2a-444444444444',
  account: '019797a8-2b2e-7bbb-8f2a-555555555555',
} as const;

/** One representative fixture per member of the union. */
const fixtures: SessionEvent[] = [
  { type: 'turn.started', sessionId: ids.session, turnId: ids.turn },
  { type: 'token', turnId: ids.turn, delta: 'Hello' },
  {
    type: 'turn.completed',
    turnId: ids.turn,
    messageId: ids.message,
    usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
  },
  { type: 'turn.completed', turnId: ids.turn, messageId: ids.message },
  { type: 'media.pending', sessionId: ids.session, tool: 'image_generate' },
  {
    type: 'media.attached',
    sessionId: ids.session,
    messageId: ids.message,
    url: '/media/ab12cd.png',
    mime: 'image/png',
    creationId: ids.creation,
  },
  { type: 'manna.updated', accountId: ids.account, balance: 42.5 },
  {
    type: 'notification.created',
    notificationId: ids.message,
    kind: 'agent_build_ready',
  },
  { type: 'error', turnId: ids.turn, code: 'gateway_error', message: 'upstream 502' },
  { type: 'error', code: 'insufficient_manna', message: 'balance is 0' },
];

describe('SSE round-trip', () => {
  it.each(fixtures.map((event) => [event.type, event] as const))(
    'encode -> decode round-trips %s',
    (_type, event) => {
      const frame = encodeSseEvent(event);
      expect(frame.startsWith('data: ')).toBe(true);
      expect(frame.endsWith('\n\n')).toBe(true);
      // Single data line — JSON.stringify escapes any embedded newlines.
      expect(frame.slice(0, -2)).not.toContain('\n');
      expect(decodeSseEvent(frame)).toEqual(event);
      expect(tryDecodeSseEvent(frame)).toEqual(event);
    },
  );

  it('round-trips deltas with newlines, unicode, and empty strings', () => {
    for (const delta of ['', '\n\n', 'line1\nline2\r\n', 'héllo 🌍 — data: fake', '\t "quoted"']) {
      const event: SessionEvent = { type: 'token', turnId: ids.turn, delta };
      expect(decodeSseEvent(encodeSseEvent(event))).toEqual(event);
    }
  });

  it('strips unknown keys on encode (schema canonicalization)', () => {
    const dirty = {
      type: 'token',
      turnId: ids.turn,
      delta: 'hi',
      internal: 'do-not-leak',
    } as unknown as SessionEvent;
    const decoded = decodeSseEvent(encodeSseEvent(dirty));
    expect(decoded).toEqual({ type: 'token', turnId: ids.turn, delta: 'hi' });
    expect(decoded).not.toHaveProperty('internal');
  });

  it('rejects malformed events at encode time', () => {
    expect(() =>
      encodeSseEvent({ type: 'token', turnId: 'not-a-uuid', delta: 'x' } as SessionEvent),
    ).toThrow();
    expect(() =>
      encodeSseEvent({ type: 'nope', turnId: ids.turn } as unknown as SessionEvent),
    ).toThrow();
  });
});

describe('extractSseData', () => {
  it('handles "data:" with no space (EventSource-compatible)', () => {
    expect(extractSseData('data:{"a":1}\n\n')).toBe('{"a":1}');
  });

  it('strips exactly one leading space', () => {
    expect(extractSseData('data:  two-spaces\n\n')).toBe(' two-spaces');
  });

  it('joins multi-line data frames with \\n per the SSE spec', () => {
    const frame = 'data: {"type":"token",\ndata: "turnId":"x"}\n\n';
    expect(extractSseData(frame)).toBe('{"type":"token",\n"turnId":"x"}');
  });

  it('handles a bare "data" line as empty string and CRLF frames', () => {
    expect(extractSseData('data\n\n')).toBe('');
    expect(extractSseData('data: {"a":1}\r\n\r\n')).toBe('{"a":1}');
  });

  it('returns null for comments, retry fields, and empty frames', () => {
    expect(extractSseData(': ping\n\n')).toBeNull();
    expect(extractSseData('retry: 3000\n\n')).toBeNull();
    expect(extractSseData('')).toBeNull();
    // "data" must be the exact field name.
    expect(extractSseData('database: nope\n\n')).toBeNull();
  });
});

describe('decode failure modes', () => {
  it('tryDecodeSseEvent returns null on heartbeats, garbage JSON, bad schema', () => {
    expect(tryDecodeSseEvent(encodeSseComment())).toBeNull();
    expect(tryDecodeSseEvent('data: {not json}\n\n')).toBeNull();
    expect(tryDecodeSseEvent('data: {"type":"unknown.event"}\n\n')).toBeNull();
    expect(tryDecodeSseEvent('data: {"type":"token","turnId":"nope","delta":""}\n\n')).toBeNull();
    expect(tryDecodeSseEvent('data: "just a string"\n\n')).toBeNull();
  });

  it('decodeSseEvent throws on the same inputs', () => {
    expect(() => decodeSseEvent(': ping\n\n')).toThrow(/data/);
    expect(() => decodeSseEvent('data: {not json}\n\n')).toThrow();
    expect(() => decodeSseEvent('data: {"type":"unknown.event"}\n\n')).toThrow();
  });

  it('multi-line frame with valid JSON decodes into a real event', () => {
    const frame = `data: {"type":"token",\ndata: "turnId":"${ids.turn}","delta":"hi"}\n\n`;
    expect(decodeSseEvent(frame)).toEqual({ type: 'token', turnId: ids.turn, delta: 'hi' });
  });
});

describe('parseSessionEvent (EventSource MessageEvent#data path)', () => {
  it('parses bare JSON payloads (already de-framed by the browser)', () => {
    const event: SessionEvent = { type: 'turn.started', sessionId: ids.session, turnId: ids.turn };
    const frame = encodeSseEvent(event);
    const bare = extractSseData(frame);
    expect(bare).not.toBeNull();
    expect(parseSessionEvent(bare as string)).toEqual(event);
    expect(tryParseSessionEvent(bare as string)).toEqual(event);
  });

  it('throws / returns null on invalid payloads', () => {
    expect(() => parseSessionEvent('nope')).toThrow();
    expect(tryParseSessionEvent('nope')).toBeNull();
    expect(tryParseSessionEvent('{"type":"token"}')).toBeNull();
  });
});

describe('encodeSseComment', () => {
  it('formats a comment frame and sanitizes newlines', () => {
    expect(encodeSseComment()).toBe(': ping\n\n');
    expect(encodeSseComment('keep\nalive\r\nnow')).toBe(': keep alive now\n\n');
  });
});

describe('event model shape', () => {
  it('SESSION_EVENT_TYPES covers exactly the union options', () => {
    const optionTypes = sessionEventSchema.options.map((option) => option.shape.type.value);
    expect([...optionTypes].sort()).toEqual([...SESSION_EVENT_TYPES].sort());
    expect(new Set(SESSION_EVENT_TYPES).size).toBe(SESSION_EVENT_TYPES.length);
  });

  it('usage is optional but validated when present', () => {
    const bad = {
      type: 'turn.completed',
      turnId: ids.turn,
      messageId: ids.message,
      usage: { promptTokens: -1 },
    };
    expect(sessionEventSchema.safeParse(bad).success).toBe(false);
  });

  it('error.turnId is optional, code/message required', () => {
    expect(sessionEventSchema.safeParse({ type: 'error', code: 'x', message: '' }).success).toBe(
      true,
    );
    expect(sessionEventSchema.safeParse({ type: 'error', message: 'no code' }).success).toBe(false);
  });
});
