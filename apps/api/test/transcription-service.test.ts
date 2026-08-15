import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DeterministicTranscriptionProvider,
  MemoryTranscriptionRepository,
  type TranscriptionProvider,
  TranscriptionProviderError,
  TranscriptionService,
} from '../src/services/transcriptions';

const ownerId = randomUUID();

function pcm(milliseconds: number, fill = 7): Buffer {
  return Buffer.alloc(milliseconds * 32, fill);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function harness() {
  const repository = new MemoryTranscriptionRepository({
    initialManna: 10_000,
    maxActivePerOwner: 2,
    maxCreatedPerOwnerPerDay: 100,
  });
  const provider = new DeterministicTranscriptionProvider();
  const service = new TranscriptionService({ repository, provider });
  return { repository, provider, service };
}

describe('TranscriptionService security and durability invariants', () => {
  it('creates idempotently and never trusts an owner from client input', async () => {
    const { service } = harness();
    const key = randomUUID();
    const first = await service.create(ownerId, { idempotencyKey: key, language: 'en' });
    const replay = await service.create(ownerId, { idempotencyKey: key, language: 'en' });

    expect(replay.id).toBe(first.id);
    expect(replay.format).toEqual({ encoding: 'pcm_s16le', sampleRateHz: 16_000, channels: 1 });
    await expect(service.get(randomUUID(), first.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'transcription_not_found',
    });
  });

  it('accepts only contiguous chunks and makes exact retries idempotent', async () => {
    const { service } = harness();
    const session = await service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' });
    const body = pcm(100);

    const first = await service.appendChunk(ownerId, session.id, 0, {
      body,
      sha256: sha256(body),
    });
    const replay = await service.appendChunk(ownerId, session.id, 0, {
      body,
      sha256: sha256(body),
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.acknowledgedThrough).toBe(0);

    const different = pcm(100, 8);
    await expect(
      service.appendChunk(ownerId, session.id, 0, {
        body: different,
        sha256: sha256(different),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'chunk_conflict' });
    await expect(
      service.appendChunk(ownerId, session.id, 2, { body, sha256: sha256(body) }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'chunk_out_of_order' });
  });

  it('resumes from the durable checkpoint after a client refresh', async () => {
    const { repository, provider, service } = harness();
    const session = await service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' });
    const first = pcm(100, 1);
    await service.appendChunk(ownerId, session.id, 0, { body: first, sha256: sha256(first) });

    const refreshedService = new TranscriptionService({ repository, provider });
    expect(await refreshedService.get(ownerId, session.id)).toMatchObject({
      acknowledgedThrough: 0,
      nextChunkNumber: 1,
      receivedDurationMs: 100,
    });
    const second = pcm(100, 2);
    await refreshedService.appendChunk(ownerId, session.id, 1, {
      body: second,
      sha256: sha256(second),
    });
    await refreshedService.finalize(ownerId, session.id, {
      idempotencyKey: randomUUID(),
      finalChunkNumber: 1,
    });
    await refreshedService.runOnce();
    expect((await refreshedService.get(ownerId, session.id)).status).toBe('completed');
  });

  it('enforces exact PCM duration and the ten-minute ceiling', async () => {
    const { service } = harness();
    const session = await service.create(ownerId, {
      idempotencyKey: randomUUID(),
      language: 'en',
      maxDurationMs: 100,
    });

    const malformed = Buffer.alloc(321);
    await expect(
      service.appendChunk(ownerId, session.id, 0, {
        body: malformed,
        sha256: sha256(malformed),
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_audio_chunk' });

    const tooLong = pcm(110);
    await expect(
      service.appendChunk(ownerId, session.id, 0, {
        body: tooLong,
        sha256: sha256(tooLong),
      }),
    ).rejects.toMatchObject({ statusCode: 413, code: 'transcription_too_long' });
  });

  it('rejects append and finalization after the upload TTL', async () => {
    let now = new Date('2026-08-15T12:00:00.000Z');
    const repository = new MemoryTranscriptionRepository();
    const service = new TranscriptionService({
      repository,
      provider: new DeterministicTranscriptionProvider(),
      now: () => now,
    });
    const session = await service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' });
    const body = pcm(100);
    now = new Date(now.getTime() + 2 * 60 * 60 * 1_000 + 1);

    await expect(
      service.appendChunk(ownerId, session.id, 0, { body, sha256: sha256(body) }),
    ).rejects.toMatchObject({ statusCode: 410, code: 'transcription_expired' });
    await expect(
      service.finalize(ownerId, session.id, { idempotencyKey: randomUUID(), finalChunkNumber: 0 }),
    ).rejects.toMatchObject({ statusCode: 410, code: 'transcription_expired' });
  });

  it('charges and admits the provider exactly once across finalize retries', async () => {
    const { repository, provider, service } = harness();
    const session = await service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' });
    const body = pcm(1_000);
    await service.appendChunk(ownerId, session.id, 0, { body, sha256: sha256(body) });
    const finalizeKey = randomUUID();

    const first = await service.finalize(ownerId, session.id, {
      idempotencyKey: finalizeKey,
      finalChunkNumber: 0,
    });
    const replay = await service.finalize(ownerId, session.id, {
      idempotencyKey: finalizeKey,
      finalChunkNumber: 0,
    });
    expect(first.status).toBe('queued');
    expect(replay.status).toBe('queued');
    expect(repository.debitCount).toBe(1);

    await service.runOnce();
    await service.runOnce();
    expect(provider.calls).toBe(1);
    const completed = await service.get(ownerId, session.id);
    expect(completed.status).toBe('completed');
    expect(completed.transcript).toContain('mock transcript');
    expect(repository.audioBytes(session.id)).toBe(0);
  });

  it('refunds provider failures and deletes transient audio', async () => {
    const repository = new MemoryTranscriptionRepository({ initialManna: 10_000 });
    const provider = new DeterministicTranscriptionProvider({ failWith: 'provider_unavailable' });
    const service = new TranscriptionService({ repository, provider });
    const session = await service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' });
    const body = pcm(1_000);
    await service.appendChunk(ownerId, session.id, 0, { body, sha256: sha256(body) });
    await service.finalize(ownerId, session.id, {
      idempotencyKey: randomUUID(),
      finalChunkNumber: 0,
    });

    await service.runOnce();
    const failed = await service.get(ownerId, session.id);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable' });
    expect(repository.refundCount).toBe(1);
    expect(repository.audioBytes(session.id)).toBe(0);
  });

  it('normalizes unreviewed adapter failure codes before persistence', async () => {
    const repository = new MemoryTranscriptionRepository({ initialManna: 10_000 });
    const provider = new DeterministicTranscriptionProvider({ failWith: 'upstream-secret-detail' });
    const service = new TranscriptionService({ repository, provider });
    const session = await service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' });
    const body = pcm(100);
    await service.appendChunk(ownerId, session.id, 0, { body, sha256: sha256(body) });
    await service.finalize(ownerId, session.id, {
      idempotencyKey: randomUUID(),
      finalChunkNumber: 0,
    });

    await service.runOnce();
    expect(await service.get(ownerId, session.id)).toMatchObject({
      status: 'failed',
      errorCode: 'provider_error',
    });
  });

  it('scrubs transcript and audio on owner deletion', async () => {
    const { repository, service } = harness();
    const session = await service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' });
    const body = pcm(100);
    await service.appendChunk(ownerId, session.id, 0, { body, sha256: sha256(body) });

    await service.delete(ownerId, session.id);
    const deleted = await service.get(ownerId, session.id);
    expect(deleted).toMatchObject({ status: 'deleted', transcript: null });
    expect(repository.audioBytes(session.id)).toBe(0);
  });

  it('honors deletion requested after provider admission and refunds the reservation', async () => {
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    let sentFrames = 0;
    const provider: TranscriptionProvider = {
      name: 'gated-mock',
      model: 'gated-v1',
      async transcribe(input) {
        entered();
        await admitted;
        if (await input.isCancelled()) {
          throw new TranscriptionProviderError('transcription_deleted');
        }
        sentFrames += 1;
        return { transcript: 'must be discarded', providerRequestId: 'mock-request', durationMs: input.durationMs };
      },
    };
    const repository = new MemoryTranscriptionRepository({ initialManna: 10_000 });
    const service = new TranscriptionService({ repository, provider });
    const session = await service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' });
    const body = pcm(100);
    await service.appendChunk(ownerId, session.id, 0, { body, sha256: sha256(body) });
    await service.finalize(ownerId, session.id, {
      idempotencyKey: randomUUID(),
      finalChunkNumber: 0,
    });

    const worker = service.runOnce();
    await providerEntered;
    expect(await service.delete(ownerId, session.id)).toMatchObject({ status: 'processing', transcript: null });
    release();
    await worker;

    expect(await service.get(ownerId, session.id)).toMatchObject({ status: 'deleted', transcript: null });
    expect(repository.refundCount).toBe(1);
    expect(repository.audioBytes(session.id)).toBe(0);
    expect(sentFrames).toBe(0);
  });
});
