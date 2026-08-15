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

  it('recovers only one exact private owned Cartesia clone marker', async () => {
    let requestedUrl = '';
    let page = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      page += 1;
      return new Response(JSON.stringify({ data: page === 1 ? [
        { id: 'wrong-name', name: 'human name', access: 'private', is_owner: true, visibility: 'owner' },
        { id: 'owned-private', name: 'eden3-clone-id', access: 'private', is_owner: true, visibility: 'owner' },
      ] : [] }), { status: 200 });
    });
    const client = new CartesiaVoiceClient('test-token', fetchFn as typeof fetch);
    await expect(client.findOwnedCloneByName('eden3-clone-id')).resolves.toEqual({ providerVoiceId: 'owned-private' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(requestedUrl).toContain('starting_after=owned-private');

    const unsafeFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [
        { id: 'public', name: 'eden3-clone-id', access: 'public', is_owner: true, visibility: 'all' },
      ] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const unsafe = new CartesiaVoiceClient('test-token', unsafeFetch as typeof fetch);
    await expect(unsafe.findOwnedCloneByName('eden3-clone-id')).rejects.toMatchObject({ code: 'provider_response_invalid' });
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
