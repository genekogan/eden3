import { describe, expect, it } from 'vitest';

import { quoteCatalogVoice } from '@eden3/core';
import { voiceIdSchema } from '@eden3/shared';

import { VoiceKernelError, voiceKernelInternals } from '../src/services/voice-kernel';
import { voiceAudioInternals } from '../src/services/voice-audio';

describe('voice contract invariants', () => {
  it('counts Unicode scalar values on the exact NFC provider transcript', () => {
    const first = voiceKernelInternals.exactTranscript('Cafe\u0301 🙂');
    const second = voiceKernelInternals.exactTranscript('Café 🙂');
    expect(first.text).toBe('Café 🙂');
    expect(first.sha256).toBe(second.sha256);
    expect(first.characterCount).toBe(6);
  });

  it('rejects blank/control text and raw provider voice ids', () => {
    expect(() => voiceKernelInternals.exactTranscript(' \n ')).toThrow(VoiceKernelError);
    expect(voiceIdSchema.safeParse('af_bella').success).toBe(false);
    expect(voiceIdSchema.safeParse('provider_voice_123').success).toBe(false);
    expect(voiceIdSchema.safeParse('deepinfra:kokoro:af_bella:v1').success).toBe(true);
    expect(() => voiceKernelInternals.exactTranscript('x'.repeat(501), 'preview')).toThrow(VoiceKernelError);
    expect(() => voiceKernelInternals.exactTranscript('x'.repeat(2_001), 'discord')).toThrow(VoiceKernelError);
  });

  it('quotes the cheap default from the effective DeepInfra character rate', () => {
    const quote = quoteCatalogVoice('deepinfra:kokoro:af_bella:v1', 1_000_000)!;
    expect(quote.costUsd).toBe(0.62);
    expect(quote.provider).toBe('deepinfra');
    expect(quote.model).toBe('hexgrad/Kokoro-82M');
  });

  it('keeps pre/post transcode limits conservative per destination', () => {
    expect(voiceAudioInternals.LIMITS.preview).toEqual({ durationMs: 30_000, bytes: 2 * 1024 * 1024 });
    expect(voiceAudioInternals.LIMITS.discord).toEqual({ durationMs: 120_000, bytes: 8 * 1024 * 1024 });
    expect(Buffer.from(voiceAudioInternals.waveform(Buffer.alloc(1024, 7)), 'base64')).toHaveLength(64);
  });
});
