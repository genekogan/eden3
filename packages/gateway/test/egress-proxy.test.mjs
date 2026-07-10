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

// ---------------------------------------------------------------------------
// Open-exterior / sealed-interior policy (decided 2026-07-10)
// ---------------------------------------------------------------------------
import { blockedAddress, blockedHostname, parseMode, vetTarget } from '../../../infra/egress-proxy/policy.mjs';

describe('egress policy — blocked addresses (the sealed interior)', () => {
  it('blocks loopback, private, link-local, metadata, cgnat, reserved ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '169.254.0.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'fc00::1',
      'ff02::1',
      '::ffff:10.0.0.1', // v4-mapped private
      '::ffff:127.0.0.1',
    ]) {
      expect(blockedAddress(ip), ip).toBeTruthy();
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['93.184.215.14', '1.1.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']) {
      expect(blockedAddress(ip), ip).toBeNull();
    }
  });

  it('blocks IPv4-mapped IPv6 embedding an interior v4 — in ANY spelling (rebinding-class hole)', () => {
    // The WHATWG URL parser rewrites ::ffff:127.0.0.1 to the hex form
    // ::ffff:7f00:1; the old dotted-decimal-only match let the hex form
    // through, defeating the sealed interior. Every spelling must block.
    for (const ip of [
      '::ffff:7f00:1', // 127.0.0.1 (hex)
      '::ffff:127.0.0.1', // 127.0.0.1 (dotted)
      '[::ffff:7f00:1]', // bracketed literal
      '::ffff:a9fe:a9fe', // 169.254.169.254 cloud metadata
      '::ffff:0a00:0001', // 10.0.0.1
      '::ffff:ac10:0001', // 172.16.0.1
      '::ffff:c0a8:0101', // 192.168.1.1
      '::ffff:6440:0001', // 100.64.0.1 cgnat
      '::7f00:1', // v4-compatible ::127.0.0.1 (deprecated)
    ]) {
      expect(blockedAddress(ip), ip).toBeTruthy();
    }
    // …but a PUBLIC v4 via the mapped form stays allowed.
    expect(blockedAddress('::ffff:5db8:d70e')).toBeNull(); // 93.184.215.14
    expect(blockedAddress('::ffff:0808:0808')).toBeNull(); // 8.8.8.8
  });

  it('classifies canonical and non-canonical IPv6 special ranges on the expanded form', () => {
    expect(blockedAddress('::1')).toBe('loopback');
    expect(blockedAddress('0:0:0:0:0:0:0:1')).toBe('loopback'); // uncompressed ::1
    expect(blockedAddress('::')).toBe('unspecified');
    expect(blockedAddress('fe80::1')).toBe('link-local fe80::/10');
    expect(blockedAddress('febf::1')).toBe('link-local fe80::/10'); // top of the /10
    expect(blockedAddress('fc00::1')).toBe('unique-local fc00::/7');
    expect(blockedAddress('fd12:3456::1')).toBe('unique-local fc00::/7');
    expect(blockedAddress('ff02::1')).toBe('multicast');
  });
});

describe('egress policy — blocked hostnames', () => {
  it('rejects loopback names, single-label (docker service) names, internal suffixes', () => {
    for (const host of [
      'localhost',
      'api.localhost',
      'eden3-postgres', // docker service name — single label
      'eden3-openclaw',
      'metadata',
      'metadata.google.internal',
      'foo.internal',
      'printer.local',
      'nas.lan',
    ]) {
      expect(blockedHostname(host), host).toBeTruthy();
    }
  });

  it('accepts ordinary public names', () => {
    for (const host of ['example.com', 'news.ycombinator.com', 'api.anthropic.com']) {
      expect(blockedHostname(host), host).toBeNull();
    }
  });
});

describe('egress policy — vetTarget (resolve-then-pin)', () => {
  const lookupMap = (map) => async (host) => {
    if (!map[host]) throw new Error('ENOTFOUND');
    return map[host];
  };

  it('pins the vetted public address', async () => {
    const verdict = await vetTarget('example.com', {
      lookup: lookupMap({ 'example.com': [{ address: '93.184.215.14', family: 4 }] }),
    });
    expect(verdict).toEqual({ ok: true, address: '93.184.215.14' });
  });

  it('rejects names resolving to any blocked address (rebinding defense)', async () => {
    const verdict = await vetTarget('evil.example.com', {
      lookup: lookupMap({
        'evil.example.com': [
          { address: '93.184.215.14', family: 4 },
          { address: '10.0.0.7', family: 4 }, // one private record poisons the set
        ],
      }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('blocked address');
  });

  it('classifies IP literals without DNS', async () => {
    expect((await vetTarget('169.254.169.254')).ok).toBe(false);
    expect((await vetTarget('8.8.8.8')).ok).toBe(true);
  });

  it('fails closed on DNS errors and empty answers', async () => {
    expect((await vetTarget('nx.example.com', { lookup: lookupMap({}) })).ok).toBe(false);
    expect(
      (await vetTarget('empty.example.com', { lookup: lookupMap({ 'empty.example.com': [] }) })).ok,
    ).toBe(false);
  });
});

describe('egress policy — mode parsing', () => {
  it('defaults to open; only "allowlist" selects legacy behavior', () => {
    expect(parseMode(undefined)).toBe('open');
    expect(parseMode('')).toBe('open');
    expect(parseMode('open')).toBe('open');
    expect(parseMode('ALLOWLIST')).toBe('allowlist');
  });
});
