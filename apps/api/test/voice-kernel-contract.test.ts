import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { quoteCatalogVoice } from '@eden3/core';
import { voiceIdSchema } from '@eden3/shared';

import { VoiceKernelError, voiceKernelInternals } from '../src/services/voice-kernel';
import { voiceAudioInternals } from '../src/services/voice-audio';

const kernelSource = readFileSync(new URL('../src/services/voice-kernel.ts', import.meta.url), 'utf8');
const chatRouteSource = readFileSync(new URL('../src/routes/chat.ts', import.meta.url), 'utf8');

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

  it('binds retry identity to the voice and transcript, not a disposable quote row', () => {
    const stable = {
      operation: 'preview' as const,
      voiceId: 'deepinfra:kokoro:af_bella:v1',
      textSha256: 'a'.repeat(64),
    };
    expect(voiceKernelInternals.executionRequestHash(stable))
      .toBe(voiceKernelInternals.executionRequestHash({ ...stable }));
    expect(voiceKernelInternals.executionRequestHash(stable))
      .not.toBe(voiceKernelInternals.executionRequestHash({ ...stable, voiceId: 'deepinfra:kokoro:af_heart:v1' }));
  });

  it('keeps pre/post transcode limits conservative per destination', () => {
    expect(voiceAudioInternals.LIMITS.preview).toEqual({ durationMs: 30_000, bytes: 2 * 1024 * 1024 });
    expect(voiceAudioInternals.LIMITS.discord).toEqual({ durationMs: 120_000, bytes: 8 * 1024 * 1024 });
    expect(voiceAudioInternals.CLONE_CLIP_LIMITS).toEqual({ minimumDurationMs: 100, maximumDurationMs: 30_000, maximumBytes: 20 * 1024 * 1024 });
    expect(Buffer.from(voiceAudioInternals.waveform(Buffer.alloc(1024, 7)), 'base64')).toHaveLength(64);
  });

  it('refunds every terminal execution that produced no playable attachment', () => {
    expect(voiceKernelInternals.shouldRefundVoiceFailure('provider_started')).toBe(true);
    expect(voiceKernelInternals.shouldRefundVoiceFailure('transcoding')).toBe(true);
    expect(voiceKernelInternals.shouldRefundVoiceFailure('artifact_cleanup_pending')).toBe(true);
    expect(voiceKernelInternals.shouldRefundVoiceFailure('completed')).toBe(false);
    expect(kernelSource).toContain("const refund = shouldRefundVoiceFailure(row.status");
    expect(kernelSource).not.toContain("preProvider");
  });

  it('uses a provider-only deterministic clone marker rather than a user name', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    expect(voiceKernelInternals.providerCloneName(id)).toBe(`eden3-clone-${id}`);
    expect(voiceKernelInternals.providerCloneName(id)).not.toContain('My voice');
    expect(kernelSource).toContain('name: providerCloneName(String(clone.row.id))');
    expect(kernelSource).toContain('provider.findOwnedCloneByName(providerCloneName(id))');
    expect(kernelSource).toContain("failure_code='provider_create_absence_observed'");
    expect(kernelSource).toContain("failure_code='provider_create_absence_confirmed'");
  });

  it('requires two time-separated provider absences even after consent revocation', () => {
    expect(voiceKernelInternals.ambiguousCloneAbsenceDisposition(null, false)).toBe('observe');
    expect(voiceKernelInternals.ambiguousCloneAbsenceDisposition(null, true)).toBe('observe');
    expect(voiceKernelInternals.ambiguousCloneAbsenceDisposition('absence:first', false)).toBe('pending');
    expect(voiceKernelInternals.ambiguousCloneAbsenceDisposition('absence:first', true)).toBe('confirm');
    expect(kernelSource).toContain('and provider_request_id is null');
    expect(kernelSource).toContain("row.provider_request_id?.startsWith('absence:') === true");
  });

  it('runs always-mode direct voice after the assistant row commits with a stable key', () => {
    expect(chatRouteSource).toContain('if (outcome.assistantMessageId)');
    expect(chatRouteSource).toContain('void attachAutomaticDirectVoiceNote({');
    expect(chatRouteSource).toContain('`direct-voice:${input.assistantMessageId}`');
    expect(chatRouteSource).toContain("'always',");
    expect(kernelSource).toContain("and (${requiredMode ?? null}::text is null or av.chat_mode=${requiredMode ?? null})");
  });
});
