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

  it('cancels a never-ending response body when its reconciliation lease aborts', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel,
    }));
    const controller = new AbortController();
    const pending = voiceProviderInternals.boundedBytes(response, 1024, controller.signal);
    controller.abort(new DOMException('lease expired', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ code: 'provider_result_indeterminate' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('uses one cumulative deadline across slow headers and a slow response body', async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const added = vi.spyOn(external.signal, 'addEventListener');
    const removed = vi.spyOn(external.signal, 'removeEventListener');
    try {
      const fetchFn = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        const headerTimer = setTimeout(() => {
          resolve(new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              const bodyTimer = setTimeout(() => {
                controller.enqueue(new Uint8Array([1]));
                controller.close();
              }, 10_000);
              signal.addEventListener('abort', () => {
                clearTimeout(bodyTimer);
                controller.error(signal.reason);
              }, { once: true });
            },
          })));
        }, 20_000);
        signal.addEventListener('abort', () => {
          clearTimeout(headerTimer);
          reject(signal.reason);
        }, { once: true });
      }));
      const client = new DeepInfraKokoroClient('test-token', fetchFn as typeof fetch);
      const pending = client.synthesize({
        model: 'hexgrad/Kokoro-82M', providerVoiceId: 'af_bella', text: 'hello', signal: external.signal,
      });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'provider_result_indeterminate' });
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(voiceProviderInternals.DEFAULT_TIMEOUT_MS - 20_000);
      await rejected;
      expect(added).toHaveBeenCalled();
      expect(removed).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and cancels every rejected provider response body without retaining deadlines', async () => {
    const signals: AbortSignal[] = [];
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      const cancel = vi.fn();
      cancels.push(cancel);
      return new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      }), { status: 503 });
    });
    const client = new DeepInfraKokoroClient('test-token', fetchFn as typeof fetch);
    for (let index = 0; index < 3; index += 1) {
      await expect(client.synthesize({
        model: 'hexgrad/Kokoro-82M', providerVoiceId: 'af_bella', text: 'hello',
      })).rejects.toMatchObject({ code: 'provider_unavailable' });
    }
    await Promise.resolve();
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(cancels.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
  });

  it('aborts and cancels an accepted clone-absence response with a never-ending body', async () => {
    let requestSignal: AbortSignal | undefined;
    const cancel = vi.fn();
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      }), { status: 404 });
    });
    const client = new CartesiaVoiceClient('test-token', fetchFn as typeof fetch);
    await expect(client.deleteClone('already-gone')).resolves.toBeUndefined();
    await Promise.resolve();
    expect(requestSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('releases provider custody on boundedBytes early rejection', async () => {
    const oversized = new Response(new Uint8Array([1]), {
      headers: { 'content-length': String(voiceProviderInternals.MAX_PROVIDER_BYTES + 1) },
    });
    await expect(voiceProviderInternals.boundedBytes(oversized)).rejects.toMatchObject({
      code: 'provider_response_too_large',
    });
    expect(oversized.bodyUsed).toBe(true);
  });

  it('aborts the absolute request deadline on oversized and missing response bodies', async () => {
    const signals: AbortSignal[] = [];
    const oversizedCancel = vi.fn();
    const responses = [
      new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel: oversizedCancel,
      }), { headers: { 'content-length': String(voiceProviderInternals.MAX_PROVIDER_BYTES + 1) } }),
      new Response(null, { status: 200 }),
    ];
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return responses.shift()!;
    });
    const client = new DeepInfraKokoroClient('test-token', fetchFn as typeof fetch);
    await expect(client.synthesize({
      model: 'hexgrad/Kokoro-82M', providerVoiceId: 'af_bella', text: 'too large',
    })).rejects.toMatchObject({ code: 'provider_response_too_large' });
    await expect(client.synthesize({
      model: 'hexgrad/Kokoro-82M', providerVoiceId: 'af_bella', text: 'missing body',
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
    await Promise.resolve();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(oversizedCancel).toHaveBeenCalledOnce();
  });

  it('never admits a provider request after its caller lease is already aborted', async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1])));
    const preAborted = new AbortController();
    preAborted.abort(new DOMException('lease expired', 'AbortError'));
    const client = new DeepInfraKokoroClient('test-token', fetchFn as typeof fetch);
    await expect(client.synthesize({
      model: 'hexgrad/Kokoro-82M', providerVoiceId: 'af_bella', text: 'do not send', signal: preAborted.signal,
    })).rejects.toMatchObject({ code: 'provider_unavailable', mayHaveReachedProvider: false });
    expect(fetchFn).not.toHaveBeenCalled();

    const boundary = new AbortController();
    const originalAdd = boundary.signal.addEventListener.bind(boundary.signal);
    vi.spyOn(boundary.signal, 'addEventListener').mockImplementation(((type: any, listener: any, options?: any) => {
      originalAdd(type, listener, options);
      boundary.abort(new DOMException('boundary lease expired', 'AbortError'));
    }) as typeof boundary.signal.addEventListener);
    await expect(client.synthesize({
      model: 'hexgrad/Kokoro-82M', providerVoiceId: 'af_bella', text: 'still do not send', signal: boundary.signal,
    })).rejects.toMatchObject({ code: 'provider_unavailable', mayHaveReachedProvider: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
