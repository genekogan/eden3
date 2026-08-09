import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { elevenLabsTtsFallback } from '../src/routes/studio';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.ELEVENLABS_API_KEY;
const originalLegacyApiKey = process.env.ELEVEN_API_KEY;
const originalBaseUrl = process.env.ELEVENLABS_BASE_URL;
const originalVoiceId = process.env.ELEVENLABS_VOICE_ID;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restore('ELEVENLABS_API_KEY', originalApiKey);
  restore('ELEVEN_API_KEY', originalLegacyApiKey);
  restore('ELEVENLABS_BASE_URL', originalBaseUrl);
  restore('ELEVENLABS_VOICE_ID', originalVoiceId);
});

describe('Studio ElevenLabs credential origin', () => {
  it.each([
    'http://api.elevenlabs.io',
    'https://api.elevenlabs.io.attacker.invalid',
    'https://127.0.0.1:18789',
    'https://169.254.169.254',
    'https://user:pass@api.elevenlabs.io',
    'https://api.elevenlabs.io:444',
    'https://api.elevenlabs.io/unreviewed',
    'https://api.elevenlabs.io?next=https://attacker.invalid',
    '//attacker.invalid',
  ])('ignores untrusted base override %s and sends the key only to the fixed origin', async (base) => {
    process.env.ELEVENLABS_API_KEY = 'synthetic-elevenlabs-key';
    process.env.ELEVENLABS_BASE_URL = base;
    process.env.ELEVENLABS_VOICE_ID = 'voice/id?fragment';
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('synthetic mp3')));
    globalThis.fetch = fetchImpl as typeof fetch;

    const output = await elevenLabsTtsFallback({
      args: { text: 'hello' },
      requestId: 'synthetic-request',
      timeoutMs: 1_000,
    });
    try {
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid%3Ffragment?output_format=mp3_44100_128',
        expect.objectContaining({
          method: 'POST',
          redirect: 'error',
          headers: expect.objectContaining({ 'xi-api-key': 'synthetic-elevenlabs-key' }),
        }),
      );
      expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(base);
    } finally {
      await output.cleanup?.();
    }
  });

  it('refuses a missing key before any outbound request', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVEN_API_KEY;
    const fetchImpl = vi.fn();
    globalThis.fetch = fetchImpl as typeof fetch;
    await expect(
      elevenLabsTtsFallback({
        args: { text: 'hello' },
        requestId: 'synthetic-request',
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'tts_not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('pins the fixed origin and redirect refusal in the production adapter', () => {
    const source = readFileSync(new URL('../src/routes/studio.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function elevenLabsTtsFallback');
    const end = source.indexOf('// ---------------------------------------------------------------------------', start);
    const fallback = source.slice(start, end);
    expect(fallback).toContain("const url = `https://api.elevenlabs.io/v1/text-to-speech/");
    expect(fallback).not.toContain('ELEVENLABS_BASE_URL');
    expect(fallback).toContain("redirect: 'error'");
  });
});
