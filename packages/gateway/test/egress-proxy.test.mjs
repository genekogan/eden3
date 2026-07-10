import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ALLOWLIST,
  isAllowedHost,
  parseAllowedPorts,
  parseAllowlist,
} from '../../../infra/egress-proxy/allowlist.mjs';

describe('eden3 egress proxy allowlist', () => {
  it('uses the default provider host allowlist when no override is configured', () => {
    const allowlist = parseAllowlist('');
    expect(allowlist).toEqual(DEFAULT_ALLOWLIST);
    expect(isAllowedHost('api.anthropic.com', allowlist)).toBe(true);
    expect(isAllowedHost('queue.fal.ai', allowlist)).toBe(true);
    expect(isAllowedHost('example.com', allowlist)).toBe(false);
  });

  it('matches wildcard suffixes only on real label boundaries', () => {
    const allowlist = parseAllowlist('*.fal.ai,api.anthropic.com');
    expect(isAllowedHost('queue.fal.ai', allowlist)).toBe(true);
    expect(isAllowedHost('fal.ai', allowlist)).toBe(false);
    expect(isAllowedHost('notfal.ai', allowlist)).toBe(false);
    expect(isAllowedHost('api.anthropic.com.evil.test', allowlist)).toBe(false);
  });

  it('parses allowed ports conservatively', () => {
    expect(parseAllowedPorts('443,abc,70000,80,443')).toEqual([443, 80]);
    expect(parseAllowedPorts('')).toEqual([80, 443]);
  });
});
