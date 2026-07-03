import { encodeSseEvent, type SessionEvent } from '@eden3/shared';
import { describe, expect, it } from 'vitest';

import { EventsBus, type SseSink } from '../src/events-bus';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';

const event: SessionEvent = { type: 'turn.started', sessionId: SESSION_A, turnId: TURN_ID };

function makeSink(): SseSink & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
}

describe('EventsBus', () => {
  it('broadcasts a published event to two subscribers as one SSE frame each', () => {
    const bus = new EventsBus();
    const a = makeSink();
    const b = makeSink();
    bus.subscribe(SESSION_A, a);
    bus.subscribe(SESSION_A, b);

    const delivered = bus.publish(SESSION_A, event);

    const frame = encodeSseEvent(event);
    expect(delivered).toBe(2);
    expect(a.chunks).toEqual([frame]);
    expect(b.chunks).toEqual([frame]);
    expect(frame).toBe(`data: ${JSON.stringify(event)}\n\n`);
  });

  it('scopes delivery to the published session channel', () => {
    const bus = new EventsBus();
    const a = makeSink();
    const other = makeSink();
    bus.subscribe(SESSION_A, a);
    bus.subscribe(SESSION_B, other);

    bus.publish(SESSION_A, event);

    expect(a.chunks).toHaveLength(1);
    expect(other.chunks).toHaveLength(0);
  });

  it('publish with no subscribers delivers to nobody', () => {
    const bus = new EventsBus();
    expect(bus.publish(SESSION_A, event)).toBe(0);
  });

  it('unsubscribe stops delivery and empties the channel', () => {
    const bus = new EventsBus();
    const a = makeSink();
    const unsubscribe = bus.subscribe(SESSION_A, a);
    expect(bus.subscriberCount(SESSION_A)).toBe(1);

    unsubscribe();

    expect(bus.subscriberCount(SESSION_A)).toBe(0);
    expect(bus.channelCount()).toBe(0);
    expect(bus.publish(SESSION_A, event)).toBe(0);
    expect(a.chunks).toHaveLength(0);
  });

  it('drops sinks whose write throws, keeps healthy ones', () => {
    const bus = new EventsBus();
    const broken: SseSink = {
      write() {
        throw new Error('EPIPE');
      },
    };
    const healthy = makeSink();
    bus.subscribe(SESSION_A, broken);
    bus.subscribe(SESSION_A, healthy);

    expect(bus.publish(SESSION_A, event)).toBe(1);
    expect(healthy.chunks).toHaveLength(1);
    expect(bus.subscriberCount(SESSION_A)).toBe(1);
  });

  it('rejects malformed events (zod validation) without writing', () => {
    const bus = new EventsBus();
    const a = makeSink();
    bus.subscribe(SESSION_A, a);
    const bad = { type: 'turn.started', sessionId: 'not-a-uuid', turnId: TURN_ID };
    expect(() => bus.publish(SESSION_A, bad as unknown as SessionEvent)).toThrow();
    expect(a.chunks).toHaveLength(0);
  });
});
