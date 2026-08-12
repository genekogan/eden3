import type { GatewayHistoryMessage } from '@eden3/gateway';
import { describe, expect, it, vi } from 'vitest';

import {
  HistorySync,
  PEER_CONTEXT_HEADER,
  PRIMER_HEADER,
  SAME_TURN_DEDUPE_WINDOW_MS,
  extractAttachmentPaths,
  gatewayExternalId,
  historyMessageDate,
  isInterSessionBanner,
  planHistorySync,
  type ExistingMessageLike,
} from '../src/services/history-sync';

/**
 * Unit tests for the pure planning layer. The payload fixtures mirror the
 * LIVE gateway shapes probed 2026-07-03 (see the module docblock): text
 * blocks, ms `timestamp`, `__openclaw:{id,recordTimestampMs,seq}`, and the
 * inter-session completion pair (provenance banner + MEDIA: assistant text).
 */

function gwMessage(
  role: string,
  text: string,
  id: string,
  extra: Record<string, unknown> = {},
): GatewayHistoryMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp: 1_783_083_522_595,
    __openclaw: { id, recordTimestampMs: 1_783_083_522_598, seq: 1 },
    ...extra,
  } as GatewayHistoryMessage;
}

const BANNER = gwMessage(
  'user',
  '[Inter-session message] sourceSession=image_generate:a283b63f… sourceTool=image_generate isUser=false\nThis content was routed by OpenClaw…',
  'd713cc91',
  {
    provenance: {
      kind: 'inter_session',
      sourceSessionKey: 'image_generate:a283b63f-9ace-4b6d-ae66-fa312f747800',
      sourceChannel: 'webchat',
      sourceTool: 'image_generate',
    },
  },
);

const MEDIA_COMPLETION = gwMessage(
  'assistant',
  'DONE\n\nMEDIA:/home/node/.openclaw/media/tool-image-generation/image-1---58bdd483.jpg',
  '89ce1a23',
);

describe('gateway payload helpers', () => {
  it('derives gw:<__openclaw.id> external ids', () => {
    expect(gatewayExternalId(gwMessage('user', 'hi', '1fc165a6'))).toBe('gw:1fc165a6');
    expect(gatewayExternalId({ role: 'user' } as GatewayHistoryMessage)).toBeNull();
  });

  it('detects the inter-session banner (role user + provenance.kind)', () => {
    expect(isInterSessionBanner(BANNER)).toBe(true);
    expect(isInterSessionBanner(MEDIA_COMPLETION)).toBe(false);
    expect(isInterSessionBanner(gwMessage('user', 'hello', 'aa'))).toBe(false);
  });

  it('prefers timestamp, falls back to recordTimestampMs, then now', () => {
    expect(historyMessageDate(gwMessage('user', 'x', 'aa')).getTime()).toBe(1_783_083_522_595);
    const noTs = { role: 'user', __openclaw: { id: 'bb', recordTimestampMs: 123 } };
    expect(historyMessageDate(noTs as GatewayHistoryMessage).getTime()).toBe(123);
    const bare = { role: 'user' } as GatewayHistoryMessage;
    expect(historyMessageDate(bare, () => 456).getTime()).toBe(456);
  });

  it('extracts MEDIA: and Attachment: lines', () => {
    const text =
      'DONE\n\nMEDIA:/home/node/.openclaw/media/tool-image-generation/a.jpg\n' +
      'Attachment: /home/node/.openclaw/media/b.png\nplain line';
    expect(extractAttachmentPaths(text)).toEqual([
      '/home/node/.openclaw/media/tool-image-generation/a.jpg',
      '/home/node/.openclaw/media/b.png',
    ]);
    expect(extractAttachmentPaths('no attachments here')).toEqual([]);
  });
});

describe('planHistorySync', () => {
  const existing: ExistingMessageLike[] = [
    { id: 'row-user', externalId: null, role: 'user', content: 'Reply with exactly one word: kumquat' },
    { id: 'row-assistant', externalId: null, role: 'assistant', content: 'kumquat' },
    { id: 'row-synced', externalId: 'gw:old00001', role: 'assistant', content: 'previously synced' },
  ];

  it('backfills gateway ids onto rows we persisted ourselves (exact content match)', () => {
    const plan = planHistorySync(existing, [
      gwMessage('user', 'Reply with exactly one word: kumquat', '1fc165a6'),
      gwMessage('assistant', 'kumquat', 'abde6fa2'),
    ]);
    expect(plan.inserts).toEqual([]);
    expect(plan.backfills).toEqual([
      { messageId: 'row-user', externalId: 'gw:1fc165a6' },
      { messageId: 'row-assistant', externalId: 'gw:abde6fa2' },
    ]);
  });

  it('skips messages whose gateway id is already stored', () => {
    const plan = planHistorySync(existing, [gwMessage('assistant', 'previously synced', 'old00001')]);
    expect(plan.inserts).toEqual([]);
    expect(plan.backfills).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it('never persists the inter-session banner but inserts the media completion', () => {
    const plan = planHistorySync(existing, [BANNER, MEDIA_COMPLETION]);
    expect(plan.backfills).toEqual([]);
    expect(plan.inserts).toHaveLength(1);
    const insert = plan.inserts[0]!;
    expect(insert.externalId).toBe('gw:89ce1a23');
    expect(insert.role).toBe('assistant');
    expect(insert.attachmentPaths).toEqual([
      '/home/node/.openclaw/media/tool-image-generation/image-1---58bdd483.jpg',
    ]);
    expect(plan.skipped).toBe(1); // the banner
  });

  it('dedupes the primed first user message via the PRIMER_HEADER suffix rule', () => {
    const primed = `${PRIMER_HEADER}\n[gene]: old line\n(Older Eden conversation resumed…)\n\nwhat is my favorite fruit?`;
    const rows: ExistingMessageLike[] = [
      { id: 'row-primed', externalId: null, role: 'user', content: 'what is my favorite fruit?' },
    ];
    const plan = planHistorySync(rows, [gwMessage('user', primed, 'p1')]);
    expect(plan.inserts).toEqual([]);
    expect(plan.backfills).toEqual([{ messageId: 'row-primed', externalId: 'gw:p1' }]);
  });

  it('dedupes a fresh web turn carrying the trusted peer envelope', () => {
    const wrapped = `${PEER_CONTEXT_HEADER}\n- Immutable Eden account ID: account-a\n\nremember violet quartz`;
    const rows: ExistingMessageLike[] = [
      { id: 'row-peer', externalId: null, role: 'user', content: 'remember violet quartz' },
    ];
    const plan = planHistorySync(rows, [gwMessage('user', wrapped, 'peer1')]);
    expect(plan.inserts).toEqual([]);
    expect(plan.backfills).toEqual([{ messageId: 'row-peer', externalId: 'gw:peer1' }]);
  });

  it('backfills a multi-block reply onto the streamed row (whitespace-insensitive)', () => {
    // The gateway joins content blocks with "\n"; turns.ts persisted the same
    // reply as the block deltas concatenated with NO separator. Exact-string
    // compare would insert a duplicate — the dedupe must match whitespace-free.
    const streamedRow: ExistingMessageLike[] = [
      { id: 'row-multi', externalId: null, role: 'assistant', content: 'Hello there.General Kenobi.' },
    ];
    const multiBlock = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello there.' },
        { type: 'text', text: 'General Kenobi.' },
      ],
      timestamp: 1_783_083_522_595,
      __openclaw: { id: 'mb01', recordTimestampMs: 1_783_083_522_598, seq: 1 },
    } as GatewayHistoryMessage;

    const plan = planHistorySync(streamedRow, [multiBlock]);
    expect(plan.inserts).toEqual([]); // NOT a duplicate insert
    expect(plan.backfills).toEqual([{ messageId: 'row-multi', externalId: 'gw:mb01' }]);
  });

  it('does not let two identical history messages consume the same row', () => {
    const rows: ExistingMessageLike[] = [
      { id: 'row-1', externalId: null, role: 'assistant', content: 'ok' },
    ];
    const plan = planHistorySync(rows, [
      gwMessage('assistant', 'ok', 'id1'),
      gwMessage('assistant', 'ok', 'id2'),
    ]);
    expect(plan.backfills).toEqual([{ messageId: 'row-1', externalId: 'gw:id1' }]);
    expect(plan.inserts.map((i) => i.externalId)).toEqual(['gw:id2']);
  });

  it('does not re-insert a message the gateway re-surfaced under a second id (two-ids guard)', () => {
    // Observed 2026-07-07 (eden3_stg, agent stg-martian): the gateway emitted
    // the SAME assistant narration under TWO __openclaw ids on separate
    // trailing-sync passes — a full uuid and an 8-hex, created_at 41ms apart.
    // The first id already owns the row; the second is a fresh id-miss with no
    // backfillable row left, so the old code INSERTED a duplicate.
    const base = 1_783_083_522_595;
    const content = 'Creating a vivid landscape of Mars, its rust-red deserts…';
    const rows: ExistingMessageLike[] = [
      {
        id: 'row-narration',
        externalId: 'gw:ccba9900-8f75-4ec9-a56f-0c0f8ed07e7f', // first id, backfilled on a prior pass
        role: 'assistant',
        content,
        createdAt: new Date(base),
      },
    ];
    const plan = planHistorySync(rows, [
      // First id — already stored → skipped as a known external id.
      gwMessage('assistant', content, 'ccba9900-8f75-4ec9-a56f-0c0f8ed07e7f'),
      // Second id for the SAME logical message, 41ms later → the duplicate.
      gwMessage('assistant', content, '3c174e57', { timestamp: base + 41 }),
    ]);
    expect(plan.backfills).toEqual([]);
    expect(plan.inserts).toEqual([]); // NO duplicate row
    expect(plan.skipped).toBe(2); // known first id + deduped second id
  });

  it('still inserts identical content emitted in a LATER turn (time-window guard)', () => {
    // The time guard must NOT swallow a genuine repeat: same words, different
    // turn. Without it, an agent that legitimately says the same thing again
    // would silently lose the later message.
    const base = 1_783_083_522_595;
    const content = 'Creating a vivid landscape of Mars, its rust-red deserts…';
    const rows: ExistingMessageLike[] = [
      {
        id: 'row-earlier-turn',
        externalId: 'gw:earlier01',
        role: 'assistant',
        content,
        createdAt: new Date(base),
      },
    ];
    const plan = planHistorySync(rows, [
      // Same content, comfortably beyond the same-turn window → a real repeat.
      gwMessage('assistant', content, 'later0001', {
        timestamp: base + SAME_TURN_DEDUPE_WINDOW_MS + 60_000,
      }),
    ]);
    expect(plan.backfills).toEqual([]);
    expect(plan.inserts.map((i) => i.externalId)).toEqual(['gw:later0001']);
  });

  it('backfills two identical-content rows oldest-first (id ordering, W2 #6)', () => {
    // `existing` arrives NEWEST-first (the DB loads desc(created_at)); the
    // gateway `history` is oldest-first. Two identical assistant replies must
    // get their gateway ids assigned in chronological order, NOT swapped.
    const rowsNewestFirst: ExistingMessageLike[] = [
      { id: 'row-new', externalId: null, role: 'assistant', content: 'same text' },
      { id: 'row-old', externalId: null, role: 'assistant', content: 'same text' },
    ];
    const plan = planHistorySync(rowsNewestFirst, [
      gwMessage('assistant', 'same text', 'idOld'), // older turn
      gwMessage('assistant', 'same text', 'idNew'), // newer turn
    ]);
    expect(plan.inserts).toEqual([]);
    // Oldest row ↔ oldest gateway id.
    expect(plan.backfills).toEqual([
      { messageId: 'row-old', externalId: 'gw:idOld' },
      { messageId: 'row-new', externalId: 'gw:idNew' },
    ]);
  });

  it('skips messages without an __openclaw id (cannot dedupe safely)', () => {
    const plan = planHistorySync([], [{ role: 'assistant', content: 'text' } as GatewayHistoryMessage]);
    expect(plan.inserts).toEqual([]);
    expect(plan.skipped).toBe(1);
  });
});

describe('HistorySync scheduling (no db, no gateway)', () => {
  const sessionWithoutKey = { id: '44444444-4444-4444-8444-444444444444', gatewaySessionKey: null };

  it('syncSession short-circuits when the session has no gateway key', async () => {
    const tools = { sessionsHistory: vi.fn() };
    const sync = new HistorySync({ tools });
    const result = await sync.syncSession({ session: sessionWithoutKey });
    expect(result.skippedReason).toBe('no_gateway_key');
    expect(tools.sessionsHistory).not.toHaveBeenCalled();
  });

  it('trailing sync runs immediately, dedupes per session, and stop() clears timers', async () => {
    vi.useFakeTimers();
    try {
      const tools = { sessionsHistory: vi.fn() };
      const sync = new HistorySync({ tools });
      // no_gateway_key target: each pass is a cheap synchronous short-circuit.
      const passes = vi.spyOn(sync, 'syncSession');
      sync.scheduleTrailingSync({ session: sessionWithoutKey }, { windowMs: 40_000, intervalMs: 15_000 });
      sync.scheduleTrailingSync({ session: sessionWithoutKey }, { windowMs: 40_000, intervalMs: 15_000 });
      expect(sync.trailingCount).toBe(1); // re-schedule extends, never duplicates

      await vi.advanceTimersByTimeAsync(15_000); // tick 1
      await vi.advanceTimersByTimeAsync(15_000); // tick 2
      expect(sync.trailingCount).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000); // beyond the window — reaper tick
      expect(sync.trailingCount).toBe(0);
      // Immediate + t=15s + t=30s + the first boundary tick at t=45s.
      // The boundary pass is load-bearing: a completion at t=39s must not be
      // dropped merely because the preceding interval ran at t=30s.
      expect(passes).toHaveBeenCalledTimes(4);

      sync.scheduleTrailingSync({ session: sessionWithoutKey });
      expect(sync.trailingCount).toBe(1);
      sync.stop();
      expect(sync.trailingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
