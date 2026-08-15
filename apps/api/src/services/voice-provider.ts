import { setTimeout as delay } from 'node:timers/promises';

const MAX_PROVIDER_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;

export class VoiceProviderError extends Error {
  constructor(
    readonly code: 'provider_rejected' | 'provider_unavailable' | 'provider_response_too_large' | 'provider_response_invalid' | 'provider_result_indeterminate',
    readonly mayHaveReachedProvider: boolean,
    readonly providerVoiceId: string | null = null,
  ) {
    super(code);
    this.name = 'VoiceProviderError';
  }
}

export interface VoiceSynthesisResult {
  audio: Buffer;
  mime: string;
  requestId: string | null;
  billedCharacters: number | null;
}

export interface VoiceCloneResult {
  providerVoiceId: string;
  requestId: string | null;
  access: 'private';
  visibility: 'owner';
  requiresVerification: boolean;
}

export interface VoiceProviderClient {
  readonly provider: 'deepinfra' | 'cartesia' | 'elevenlabs';
  synthesize(input: {
    model: string;
    providerVoiceId: string;
    text: string;
    signal?: AbortSignal;
  }): Promise<VoiceSynthesisResult>;
  clone?(input: {
    name: string;
    clip: Buffer;
    mime: 'audio/wav' | 'audio/mpeg';
    signal?: AbortSignal;
  }): Promise<VoiceCloneResult>;
  deleteClone?(providerVoiceId: string, signal?: AbortSignal): Promise<void>;
}

function safeHeader(response: Response, name: string): string | null {
  const value = response.headers.get(name);
  return value && /^[A-Za-z0-9_.:-]{1,255}$/.test(value) ? value : null;
}

async function boundedBytes(response: Response, maximum = MAX_PROVIDER_BYTES): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new VoiceProviderError('provider_response_too_large', true);
  }
  if (!response.body) throw new VoiceProviderError('provider_response_invalid', true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new VoiceProviderError('provider_response_too_large', true);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function fetchAtMostOnce(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = delay(DEFAULT_TIMEOUT_MS, undefined, { signal: controller.signal })
    .then(() => controller.abort())
    .catch(() => undefined);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let started = false;
  try {
    started = true;
    return await fetchFn(url, { ...init, signal: controller.signal, redirect: 'error' });
  } catch {
    throw new VoiceProviderError(
      started ? 'provider_result_indeterminate' : 'provider_unavailable',
      started,
    );
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', abort);
    await timer;
  }
}

function assertOk(response: Response): void {
  if (response.ok) return;
  throw new VoiceProviderError(
    response.status >= 500 ? 'provider_unavailable' : 'provider_rejected',
    true,
  );
}

export class DeepInfraKokoroClient implements VoiceProviderClient {
  readonly provider = 'deepinfra' as const;
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async synthesize(input: {
    model: string;
    providerVoiceId: string;
    text: string;
    signal?: AbortSignal;
  }): Promise<VoiceSynthesisResult> {
    if (input.model !== 'hexgrad/Kokoro-82M') {
      throw new VoiceProviderError('provider_response_invalid', false);
    }
    const response = await fetchAtMostOnce(this.fetchFn, `https://api.deepinfra.com/v1/inference/${input.model}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: input.text,
        preset_voice: [input.providerVoiceId],
        output_format: 'mp3',
      }),
    }, input.signal);
    assertOk(response);
    const raw = await boundedBytes(response);
    let payload: unknown;
    try { payload = JSON.parse(raw.toString('utf8')); } catch {
      throw new VoiceProviderError('provider_response_invalid', true);
    }
    const record = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
    if (typeof record?.model === 'string' && record.model !== input.model) {
      throw new VoiceProviderError('provider_response_invalid', true);
    }
    let encoded = typeof record?.audio === 'string' ? record.audio : null;
    if (!encoded) throw new VoiceProviderError('provider_response_invalid', true);
    encoded = encoded.replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, '');
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) {
      throw new VoiceProviderError('provider_response_invalid', true);
    }
    const audio = Buffer.from(encoded, 'base64');
    if (audio.length === 0 || audio.length > MAX_PROVIDER_BYTES) {
      throw new VoiceProviderError('provider_response_invalid', true);
    }
    return {
      audio,
      mime: 'audio/mpeg',
      requestId: typeof record?.request_id === 'string' ? record.request_id : safeHeader(response, 'x-request-id'),
      billedCharacters: Array.from(input.text).length,
    };
  }
}

export class CartesiaVoiceClient implements VoiceProviderClient {
  readonly provider = 'cartesia' as const;
  static readonly apiVersion = '2026-08-14';
  static readonly model = 'sonic-3.5-2026-05-04';

  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private headers(contentType?: string): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      'Cartesia-Version': CartesiaVoiceClient.apiVersion,
      ...(contentType ? { 'content-type': contentType } : {}),
    };
  }

  async synthesize(input: { model: string; providerVoiceId: string; text: string; signal?: AbortSignal }): Promise<VoiceSynthesisResult> {
    if (input.model !== CartesiaVoiceClient.model) throw new VoiceProviderError('provider_response_invalid', false);
    const response = await fetchAtMostOnce(this.fetchFn, 'https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: this.headers('application/json'),
      body: JSON.stringify({
        model_id: input.model,
        transcript: input.text,
        voice: { mode: 'id', id: input.providerVoiceId },
        output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
      }),
    }, input.signal);
    assertOk(response);
    const audio = await boundedBytes(response);
    return { audio, mime: 'audio/mpeg', requestId: safeHeader(response, 'x-request-id'), billedCharacters: Array.from(input.text).length };
  }

  async clone(input: { name: string; clip: Buffer; mime: 'audio/wav' | 'audio/mpeg'; signal?: AbortSignal }): Promise<VoiceCloneResult> {
    const form = new FormData();
    form.set('name', input.name);
    form.set('access', 'private');
    form.set('language', 'en');
    form.set('clip', new Blob([input.clip], { type: input.mime }), input.mime === 'audio/wav' ? 'clip.wav' : 'clip.mp3');
    const response = await fetchAtMostOnce(this.fetchFn, 'https://api.cartesia.ai/voices/clone', {
      method: 'POST', headers: this.headers(), body: form,
    }, input.signal);
    assertOk(response);
    const raw = await boundedBytes(response, 64 * 1024);
    let payload: unknown;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new VoiceProviderError('provider_response_invalid', true); }
    const value = payload as Record<string, unknown>;
    if (typeof value?.id !== 'string' || value.access !== 'private' || value.visibility !== 'owner') {
      throw new VoiceProviderError(
        'provider_response_invalid',
        true,
        typeof value?.id === 'string' ? value.id : null,
      );
    }
    return { providerVoiceId: value.id, requestId: safeHeader(response, 'x-request-id'), access: 'private', visibility: 'owner', requiresVerification: false };
  }

  async deleteClone(providerVoiceId: string, signal?: AbortSignal): Promise<void> {
    const response = await fetchAtMostOnce(this.fetchFn, `https://api.cartesia.ai/voices/${encodeURIComponent(providerVoiceId)}`, {
      method: 'DELETE', headers: this.headers(),
    }, signal);
    if (response.status !== 204 && response.status !== 404) assertOk(response);
  }
}

export class ElevenLabsVoiceClient implements VoiceProviderClient {
  readonly provider = 'elevenlabs' as const;
  constructor(private readonly token: string, private readonly fetchFn: typeof fetch = fetch) {}
  async synthesize(input: { model: string; providerVoiceId: string; text: string; signal?: AbortSignal }): Promise<VoiceSynthesisResult> {
    const response = await fetchAtMostOnce(this.fetchFn, `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.providerVoiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': this.token, 'content-type': 'application/json' },
      body: JSON.stringify({ text: input.text, model_id: input.model }),
    }, input.signal);
    assertOk(response);
    const billed = Number(response.headers.get('character-cost'));
    return {
      audio: await boundedBytes(response),
      mime: 'audio/mpeg',
      requestId: safeHeader(response, 'request-id') ?? safeHeader(response, 'x-trace-id'),
      billedCharacters: Number.isSafeInteger(billed) && billed >= 0 ? billed : null,
    };
  }
}

export const voiceProviderInternals = { boundedBytes, MAX_PROVIDER_BYTES };
