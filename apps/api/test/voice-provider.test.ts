import { describe, expect, it, vi } from 'vitest';

import {
  CartesiaVoiceClient,
  DeepInfraKokoroClient,
  VoiceProviderError,
  voiceProviderInternals,
} from '../src/services/voice-provider';

describe('voice providers are bounded and provider-free under test', () => {
  it('decodes deterministic DeepInfra Kokoro output and preserves request identity', async () => {
    let requestInit: RequestInit | undefined;
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({
      audio: `data:audio/mpeg;base64,${Buffer.from('mp3').toString('base64')}`,
      request_id: 'request_1',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new DeepInfraKokoroClient('test-token', fetchFn as typeof fetch);
    await expect(client.synthesize({
      model: 'hexgrad/Kokoro-82M', providerVoiceId: 'af_bella', text: '🙂 voice',
    })).resolves.toMatchObject({ audio: Buffer.from('mp3'), mime: 'audio/mpeg', requestId: 'request_1' });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({ preset_voice: ['af_bella'], output_format: 'mp3' });
  });

  it('sends Cartesia clone access=private and rejects non-owner visibility', async () => {
    let requestInit: RequestInit | undefined;
    const goodFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({ id: 'voice_1', access: 'private', visibility: 'owner' }), { status: 200 });
    });
    const good = new CartesiaVoiceClient('test-token', goodFetch as typeof fetch);
    await expect(good.clone({ name: 'Mine', clip: Buffer.from('wav'), mime: 'audio/wav' })).resolves.toMatchObject({ providerVoiceId: 'voice_1', access: 'private', visibility: 'owner' });
    const form = requestInit!.body as FormData;
    expect(form.get('access')).toBe('private');
    expect(form.get('language')).toBe('en');
    expect((requestInit!.headers as Record<string, string>)['Cartesia-Version']).toBe('2026-08-14');

    const bad = new CartesiaVoiceClient('test-token', vi.fn(async () => new Response(JSON.stringify({ id: 'voice_2', access: 'public', visibility: 'all' }), { status: 200 })) as typeof fetch);
    await expect(bad.clone({ name: 'Nope', clip: Buffer.from('wav'), mime: 'audio/wav' })).rejects.toMatchObject({ code: 'provider_response_invalid', mayHaveReachedProvider: true });
  });

  it('never retries an ambiguous network request and caps chunked responses', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('timeout'); });
    const client = new DeepInfraKokoroClient('test-token', fetchFn as typeof fetch);
    await expect(client.synthesize({ model: 'hexgrad/Kokoro-82M', providerVoiceId: 'af_bella', text: 'hello' }))
      .rejects.toMatchObject({ code: 'provider_result_indeterminate', mayHaveReachedProvider: true });
    expect(fetchFn).toHaveBeenCalledOnce();

    const oversized = new Response(new Uint8Array(4), { headers: { 'content-length': String(voiceProviderInternals.MAX_PROVIDER_BYTES + 1) } });
    await expect(voiceProviderInternals.boundedBytes(oversized)).rejects.toBeInstanceOf(VoiceProviderError);
  });
});
