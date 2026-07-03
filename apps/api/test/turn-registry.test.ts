import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TURN_WINDOW_MS,
  TurnRegistry,
  plainSessionKey,
} from '../src/services/turn-registry';

const TURN = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  agentAccountId: '22222222-2222-4222-8222-222222222222',
  agentOpenclawId: 'testbot',
};

function registryAt(start = 1_000_000) {
  let now = start;
  const registry = new TurnRegistry(() => now);
  return { registry, tick: (ms: number) => (now += ms) };
}

describe('plainSessionKey', () => {
  it('strips one agent:<id>: scope prefix', () => {
    expect(plainSessionKey('agent:testbot:eden3:s:abc')).toBe('eden3:s:abc');
  });

  it('leaves plain keys untouched', () => {
    expect(plainSessionKey('eden3:s:abc')).toBe('eden3:s:abc');
  });
});

describe('TurnRegistry', () => {
  it('registers and reads back by plain or scoped key', () => {
    const { registry } = registryAt();
    registry.register('eden3:s:k1', TURN);
    expect(registry.get('eden3:s:k1')?.sessionId).toBe(TURN.sessionId);
    expect(registry.get('agent:testbot:eden3:s:k1')?.sessionId).toBe(TURN.sessionId);
    expect(registry.size).toBe(1);
  });

  it('normalizes scoped keys on register (no duplicate entries)', () => {
    const { registry } = registryAt();
    registry.register('agent:testbot:eden3:s:k1', TURN);
    registry.register('eden3:s:k1', TURN);
    expect(registry.size).toBe(1);
  });

  it('expires entries after the window', () => {
    const { registry, tick } = registryAt();
    registry.register('eden3:s:k1', TURN);
    tick(DEFAULT_TURN_WINDOW_MS - 1);
    expect(registry.get('eden3:s:k1')).not.toBeNull();
    tick(2);
    expect(registry.get('eden3:s:k1')).toBeNull();
    expect(registry.size).toBe(0); // expired read pruned it
  });

  it('touch extends the window; touching an expired entry is a no-op', () => {
    const { registry, tick } = registryAt();
    registry.register('eden3:s:k1', TURN, 1_000);
    tick(900);
    expect(registry.touch('eden3:s:k1', 1_000)).not.toBeNull();
    tick(900); // 1800 total — would be expired without the touch
    expect(registry.get('eden3:s:k1')).not.toBeNull();
    tick(200);
    expect(registry.touch('eden3:s:k1')).toBeNull();
  });

  it('active() lists live entries and prunes dead ones', () => {
    const { registry, tick } = registryAt();
    registry.register('eden3:s:short', TURN, 1_000);
    registry.register('eden3:s:long', { ...TURN, sessionId: '33333333-3333-4333-8333-333333333333' }, 60_000);
    tick(2_000);
    const active = registry.active();
    expect(active.map(([key]) => key)).toEqual(['eden3:s:long']);
    expect(registry.size).toBe(1);
  });

  it('prune() reports how many entries were dropped', () => {
    const { registry, tick } = registryAt();
    registry.register('eden3:s:a', TURN, 10);
    registry.register('eden3:s:b', TURN, 10);
    tick(11);
    expect(registry.prune()).toBe(2);
  });
});
