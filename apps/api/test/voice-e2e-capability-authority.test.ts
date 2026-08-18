import type { AuthProvider } from '@eden3/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerVoiceE2eCapabilityAuthority } from '../src/voice-e2e-capability-authority';
import { registerAuth } from '../src/auth-plugin';
import { voiceRoutesInternals } from '../src/routes/voices';

const anonymousProvider: AuthProvider = { async getSession() { return null; } };
const runtimeCapabilityKey = 'runtime-capability-key-0123456789abcdef';
const authorityNonce = 'authority-nonce-0123456789abcdefghi';
const coordinate = {
  turnId: '11111111-1111-4111-8111-111111111111',
  executionId: '22222222-2222-4222-8222-222222222222',
  operationId: '33333333-3333-4333-8333-333333333333',
  expires: '1999999999',
};

describe('isolated voice capability authority', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  function appWithAuthority(): FastifyInstance {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerAuth(app, { provider: anonymousProvider, accessAllowlist: ['alex'] });
    registerVoiceE2eCapabilityAuthority(app, { runtimeCapabilityKey, authorityNonce });
    return app;
  }

  it('bypasses the closed-alpha gate only for exact dual authority and the production signer', async () => {
    const app = appWithAuthority();
    for (const headers of [
      {},
      { authorization: `Bearer ${runtimeCapabilityKey}` },
      { authorization: 'Bearer wrong-runtime-capability-key-000000000', 'x-eden3-voice-authority-nonce': authorityNonce },
      { authorization: `Bearer ${runtimeCapabilityKey}`, 'x-eden3-voice-authority-nonce': 'wrong-authority-nonce-000000000000000' },
    ]) {
      const denied = await app.inject({ method: 'POST', url: '/__e2e/voice-capability/derive', headers, payload: coordinate });
      expect(denied.statusCode).toBe(404);
      expect(denied.statusCode).not.toBe(403);
      expect(denied.body).not.toContain(runtimeCapabilityKey);
      expect(denied.body).not.toContain(authorityNonce);
    }
    const accepted = await app.inject({
      method: 'POST', url: '/__e2e/voice-capability/derive',
      headers: { authorization: `Bearer ${runtimeCapabilityKey}`, 'x-eden3-voice-authority-nonce': authorityNonce },
      payload: coordinate,
    });
    expect(accepted.statusCode).toBe(200);
    const expected = voiceRoutesInternals.channelVoiceCapabilityPathAtExpiry(runtimeCapabilityKey, coordinate);
    expect(accepted.json()).toEqual({ path: expected });
    expect(expected).not.toBe(voiceRoutesInternals.channelVoiceCapabilityPathAtExpiry(`${runtimeCapabilityKey}x`, coordinate));
    expect(expected).not.toContain(runtimeCapabilityKey);
  });

  it('does not admit lookalike paths or malformed signer coordinates', async () => {
    const app = appWithAuthority();
    const headers = { authorization: `Bearer ${runtimeCapabilityKey}`, 'x-eden3-voice-authority-nonce': authorityNonce };
    const lookalike = await app.inject({ method: 'POST', url: '/__e2e/voice-capability/derive/extra', headers, payload: coordinate });
    expect(lookalike.statusCode).toBe(403);
    const malformed = await app.inject({
      method: 'POST', url: '/__e2e/voice-capability/derive', headers,
      payload: { ...coordinate, executionId: 'not-a-uuid' },
    });
    expect(malformed.statusCode).toBe(404);
  });
});
