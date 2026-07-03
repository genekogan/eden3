import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  GATEWAY_SESSION_KEY_PREFIX,
  InvalidSessionKeyError,
  RESERVED_SESSION_KEY_PREFIXES,
  assertSafeSessionKey,
  gatewaySessionKey,
  isReservedSessionKey,
  parseGatewaySessionKey,
} from './session-key';

describe('gatewaySessionKey', () => {
  it('builds eden3:s:<uuid> from a session uuid', () => {
    const id = '018f7d3e-1111-7abc-8def-0123456789ab';
    expect(gatewaySessionKey(id)).toBe(`eden3:s:${id}`);
  });

  it('lowercases the uuid', () => {
    const id = '018F7D3E-1111-7ABC-8DEF-0123456789AB';
    expect(gatewaySessionKey(id)).toBe(`eden3:s:${id.toLowerCase()}`);
  });

  it('rejects non-uuid input', () => {
    for (const bad of ['', 'abc', '665f0a1b2c3d4e5f60718293', 'eden3:s:x', '   ']) {
      expect(() => gatewaySessionKey(bad)).toThrow(InvalidSessionKeyError);
    }
  });

  it('never produces a key with a reserved prefix', () => {
    for (let i = 0; i < 50; i += 1) {
      const key = gatewaySessionKey(randomUUID());
      expect(isReservedSessionKey(key)).toBe(false);
      expect(key.startsWith(GATEWAY_SESSION_KEY_PREFIX)).toBe(true);
    }
    // The static prefix itself can never collide with a reserved prefix.
    for (const reserved of RESERVED_SESSION_KEY_PREFIXES) {
      expect(GATEWAY_SESSION_KEY_PREFIX.startsWith(reserved)).toBe(false);
    }
  });
});

describe('reserved prefixes', () => {
  it('flags subagent:/cron:/acp: keys as reserved', () => {
    expect(isReservedSessionKey('subagent:foo')).toBe(true);
    expect(isReservedSessionKey('cron:job-1')).toBe(true);
    expect(isReservedSessionKey('acp:whatever')).toBe(true);
    expect(isReservedSessionKey('SUBAGENT:foo')).toBe(true); // case-insensitive
    expect(isReservedSessionKey('eden3:s:abc')).toBe(false);
  });

  it('assertSafeSessionKey throws on reserved or empty keys', () => {
    expect(() => assertSafeSessionKey('subagent:x')).toThrow(InvalidSessionKeyError);
    expect(() => assertSafeSessionKey('cron:x')).toThrow(InvalidSessionKeyError);
    expect(() => assertSafeSessionKey('acp:x')).toThrow(InvalidSessionKeyError);
    expect(() => assertSafeSessionKey('')).toThrow(InvalidSessionKeyError);
    expect(() => assertSafeSessionKey('eden3:s:018f7d3e')).not.toThrow();
  });
});

describe('parseGatewaySessionKey', () => {
  it('round-trips with gatewaySessionKey', () => {
    const id = randomUUID();
    expect(parseGatewaySessionKey(gatewaySessionKey(id))).toBe(id.toLowerCase());
  });

  it('returns null for foreign or malformed keys', () => {
    expect(parseGatewaySessionKey('subagent:abc')).toBeNull();
    expect(parseGatewaySessionKey('eden3:s:not-a-uuid')).toBeNull();
    expect(parseGatewaySessionKey('eden3:s:')).toBeNull();
    expect(parseGatewaySessionKey('')).toBeNull();
  });
});
