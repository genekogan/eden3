import { describe, expect, it, vi } from 'vitest';

import { OpenClawCompatClient } from '../src/compat-client';
import { normalizeOpenClawGatewayAuthority } from '../src/gateway-origin';
import { AgentProvisioner } from '../src/provisioner';
import { OpenClawToolsClient } from '../src/tools-client';

const HOSTILE_OR_AMBIGUOUS_ORIGINS = [
  'https://127.0.0.1:18789',
  'http://gateway.invalid:18789',
  'http://127.0.0.1.attacker.invalid:18789',
  'http://169.254.169.254:18789',
  'http://localhost:18789',
  'http://[::1]:18789',
  'http://user:pass@127.0.0.1:18789',
  'http://127.0.0.1',
  'http://127.0.0.1:0',
  'http://127.0.0.1:65536',
  'http://127.0.0.1:18789/v1',
  'http://127.0.0.1:18789/../',
  'http://127.0.0.1:028789',
  'http://127.0.0.1:18789/?next=evil',
  'http://127.0.0.1:18789/#fragment',
  '//127.0.0.1:18789',
] as const;

describe('OpenClaw gateway credential authority', () => {
  it.each(HOSTILE_OR_AMBIGUOUS_ORIGINS)('refuses %s before any client can fetch', (baseUrl) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => normalizeOpenClawGatewayAuthority({ baseUrl, token: 'synthetic-secret' })).toThrow(
      /gateway/i,
    );
    expect(() => new OpenClawCompatClient({ baseUrl, token: 'synthetic-secret', fetchImpl })).toThrow(
      /gateway/i,
    );
    expect(() => new OpenClawToolsClient({ baseUrl, token: 'synthetic-secret', fetchImpl })).toThrow(
      /gateway/i,
    );
    expect(
      () =>
        new AgentProvisioner({
          gateway: { baseUrl, token: 'synthetic-secret', fetchImpl },
          dataDir: '/tmp/unused-openclaw-origin-test',
          templatesDir: '/tmp/unused-openclaw-template-test',
          prepareMemoryIndexTarget: async () => {},
        }),
    ).toThrow(/gateway/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['', ' ', '\ttoken', 'token\n', 'token '])('refuses an empty or noncanonical bearer token', (token) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const options = { baseUrl: 'http://127.0.0.1:18789', token, fetchImpl };
    expect(() => normalizeOpenClawGatewayAuthority(options)).toThrow(/token/i);
    expect(() => new OpenClawCompatClient(options)).toThrow(/token/i);
    expect(() => new OpenClawToolsClient(options)).toThrow(/token/i);
    expect(
      () =>
        new AgentProvisioner({
          gateway: options,
          dataDir: '/tmp/unused-openclaw-origin-test',
          templatesDir: '/tmp/unused-openclaw-template-test',
          prepareMemoryIndexTarget: async () => {},
        }),
    ).toThrow(/token/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('normalizes only an explicit IPv4 loopback origin with an alternate port', () => {
    expect(
      normalizeOpenClawGatewayAuthority({
        baseUrl: 'http://127.0.0.1:28789/',
        token: 'synthetic-secret',
      }),
    ).toEqual({ origin: 'http://127.0.0.1:28789', token: 'synthetic-secret' });
  });
});
