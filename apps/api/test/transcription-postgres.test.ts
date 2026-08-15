import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { credit, getBalance } from '@eden3/core';
import { db, pg } from '@eden3/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrivateTranscriptionAudioStore } from '../src/services/transcription-audio-custody';
import { PostgresTranscriptionRepository } from '../src/services/transcription-postgres';
import {
  DeterministicTranscriptionProvider,
  TranscriptionService,
} from '../src/services/transcriptions';

const marker = `sttpg_${randomUUID().slice(0, 8)}`;
let audioRoot: string;
let audio: PrivateTranscriptionAudioStore;

function pcm(milliseconds: number, fill = 5): Buffer {
  return Buffer.alloc(milliseconds * 32, fill);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function userWithManna(input: { durable?: number; subscription?: number }): Promise<string> {
  const [row] = await pg<{ id: string }[]>`
    insert into accounts (type,username)
    values ('user',${`${marker}_${randomUUID().slice(0, 8)}`}) returning id`;
  if (!row) throw new Error('test account insert failed');
  if (input.durable) {
    await credit({ accountId: row.id, amount: input.durable, type: 'credit:test' });
  }
  if (input.subscription) {
    await credit({
      accountId: row.id,
      amount: input.subscription,
      type: 'credit:subscription',
      toSubscriptionBalance: true,
    });
  }
  return row.id;
}

function repository(): PostgresTranscriptionRepository {
  return new PostgresTranscriptionRepository({
    db,
    audio,
    dailyMannaCap: 10_000,
    maxActivePerOwner: 2,
    maxCreatedPerOwnerPerDay: 100,
  });
}

beforeAll(async () => {
  audioRoot = await mkdtemp(join(tmpdir(), 'eden-stt-pg-'));
  audio = new PrivateTranscriptionAudioStore(audioRoot);
  await audio.initialize();
});

afterAll(async () => {
  await pg`delete from transcription_sessions where owner_account_id in (
    select id from accounts where username like ${`${marker}%`}
  )`;
  await pg`delete from usage_events where user_id in (
    select id from accounts where username like ${`${marker}%`}
  )`;
  await pg`delete from manna_transactions where manna_account_id in (
    select id from manna_accounts where account_id in (
      select id from accounts where username like ${`${marker}%`}
    )
  )`;
  await pg`delete from manna_accounts where account_id in (
    select id from accounts where username like ${`${marker}%`}
  )`;
  await pg`delete from accounts where username like ${`${marker}%`}`;
  await rm(audioRoot, { recursive: true, force: true });
});

describe('Postgres resilient transcription integration', () => {
  it('persists checkpoints, charges once, completes once, and purges audio', async () => {
    const ownerId = await userWithManna({ durable: 100 });
    const repo = repository();
    const provider = new DeterministicTranscriptionProvider();
    const service = new TranscriptionService({ repository: repo, provider });
    const created = await service.create(ownerId, {
      idempotencyKey: randomUUID(),
      language: 'en',
    });
    const body = pcm(1_000);
    const [first, replay] = await Promise.all([
      service.appendChunk(ownerId, created.id, 0, { body, sha256: sha256(body) }),
      service.appendChunk(ownerId, created.id, 0, { body, sha256: sha256(body) }),
    ]);
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
    const before = await getBalance(ownerId);
    const finalizeKey = randomUUID();
    const finalized = await service.finalize(ownerId, created.id, {
      idempotencyKey: finalizeKey,
      finalChunkNumber: 0,
    });
    const finalizeReplay = await service.finalize(ownerId, created.id, {
      idempotencyKey: finalizeKey,
      finalChunkNumber: 0,
    });
    expect(finalizeReplay.quote).toEqual(finalized.quote);
    expect((await getBalance(ownerId)).total).toBe(before.total - finalized.quote!.manna);

    await service.runOnce();
    await service.runOnce();
    expect(provider.calls).toBe(1);
    expect(await service.get(ownerId, created.id)).toMatchObject({
      status: 'completed',
      acknowledgedThrough: 0,
      receivedDurationMs: 1_000,
    });
    const [custody] = await pg<{ chunks: number; audio_deleted_at: Date | null }[]>`
      select (select count(*)::int from transcription_chunks where session_id=${created.id}) chunks,
        audio_deleted_at from transcription_sessions where id=${created.id}`;
    expect(custody).toMatchObject({ chunks: 0 });
    expect(custody?.audio_deleted_at).not.toBeNull();
    const [usage] = await pg<{ status: string; manna: number; error_message: string | null }[]>`
      select status,manna,error_message from usage_events
      where event_type='speech_transcription' and turn_id=${created.id}`;
    expect(usage).toMatchObject({ status: 'completed', manna: finalized.quote!.manna, error_message: null });
  });

  it('refunds the exact subscription pot on a provider failure', async () => {
    const ownerId = await userWithManna({ subscription: 100 });
    const repo = repository();
    const service = new TranscriptionService({
      repository: repo,
      provider: new DeterministicTranscriptionProvider({ failWith: 'provider_unavailable' }),
    });
    const created = await service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' });
    const body = pcm(1_000);
    await service.appendChunk(ownerId, created.id, 0, { body, sha256: sha256(body) });
    const before = await getBalance(ownerId);
    await service.finalize(ownerId, created.id, {
      idempotencyKey: randomUUID(),
      finalChunkNumber: 0,
    });
    await service.runOnce();
    expect(await getBalance(ownerId)).toEqual(before);
    expect(await service.get(ownerId, created.id)).toMatchObject({
      status: 'failed',
      errorCode: 'provider_unavailable',
    });
    const [usage] = await pg<{ status: string; manna: number }[]>`
      select status,manna from usage_events
      where event_type='speech_transcription' and turn_id=${created.id}`;
    expect(usage).toEqual({ status: 'error', manna: 0 });
  });

  it('requeues only pre-provider stale claims and refunds unknown provider outcomes', async () => {
    const ownerId = await userWithManna({ durable: 100 });
    const repo = repository();
    const service = new TranscriptionService({
      repository: repo,
      provider: new DeterministicTranscriptionProvider(),
    });
    const created = await service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' });
    const body = pcm(1_000);
    await service.appendChunk(ownerId, created.id, 0, { body, sha256: sha256(body) });
    const before = await getBalance(ownerId);
    await service.finalize(ownerId, created.id, {
      idempotencyKey: randomUUID(),
      finalChunkNumber: 0,
    });
    const firstClaim = await repo.claimNext(new Date());
    expect(firstClaim?.session.id).toBe(created.id);
    await pg`update transcription_sessions set claim_expires_at=now()-interval '1 second' where id=${created.id}`;
    await repo.maintain(new Date());
    const secondClaim = await repo.claimNext(new Date());
    expect(secondClaim?.session.id).toBe(created.id);
    expect(secondClaim?.claimToken).not.toBe(firstClaim?.claimToken);

    await repo.markProviderStarted(created.id, secondClaim!.claimToken, new Date());
    await pg`update transcription_sessions set claim_expires_at=now()-interval '1 second' where id=${created.id}`;
    await repo.maintain(new Date());
    expect(await repo.claimNext(new Date())).toBeNull();
    expect(await getBalance(ownerId)).toEqual(before);
    expect(await service.get(ownerId, created.id)).toMatchObject({
      status: 'failed',
      errorCode: 'provider_outcome_unknown',
    });
  });

  it('never claims expired queued work even when more rows expired than one maintenance tick drains', async () => {
    const ownerId = await userWithManna({ durable: 100 });
    const repo = repository();
    const provider = new DeterministicTranscriptionProvider();
    const service = new TranscriptionService({
      repository: repo,
      provider,
    });
    const created = await Promise.all([
      service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' }),
      service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' }),
    ]);
    const body = pcm(1_000);
    for (const session of created) {
      await service.appendChunk(ownerId, session.id, 0, { body, sha256: sha256(body) });
    }
    const before = await getBalance(ownerId);
    for (const session of created) {
      await service.finalize(ownerId, session.id, {
        idempotencyKey: randomUUID(),
        finalChunkNumber: 0,
      });
    }
    await pg`update transcription_sessions set expires_at=now()-interval '1 second'
      where id in (${created[0]!.id},${created[1]!.id})`;

    expect(await service.runOnce()).toBe(false);
    expect(provider.calls).toBe(0);
    expect(await service.runOnce()).toBe(false);
    expect(provider.calls).toBe(0);
    expect(await getBalance(ownerId)).toEqual(before);
    for (const session of created) {
      expect(await service.get(ownerId, session.id)).toMatchObject({
        status: 'expired',
        errorCode: 'transcription_expired',
      });
    }
    const usage = await pg<{ status: string; manna: number }[]>`
      select status,manna from usage_events
      where event_type='speech_transcription' and turn_id in (${created[0]!.id},${created[1]!.id})
      order by turn_id`;
    expect(usage).toEqual([
      { status: 'error', manna: 0 },
      { status: 'error', manna: 0 },
    ]);
  });

  it('fences deletion before provider admission and never permits the old claim to start', async () => {
    const ownerId = await userWithManna({ durable: 100 });
    const repo = repository();
    const service = new TranscriptionService({
      repository: repo,
      provider: new DeterministicTranscriptionProvider(),
    });
    const created = await service.create(ownerId, { idempotencyKey: randomUUID(), language: 'en' });
    const body = pcm(1_000);
    await service.appendChunk(ownerId, created.id, 0, { body, sha256: sha256(body) });
    const before = await getBalance(ownerId);
    await service.finalize(ownerId, created.id, {
      idempotencyKey: randomUUID(),
      finalChunkNumber: 0,
    });
    const claim = await repo.claimNext(new Date());
    expect(claim?.session.id).toBe(created.id);

    expect(await service.delete(ownerId, created.id)).toMatchObject({ status: 'deleted' });
    await expect(
      repo.markProviderStarted(created.id, claim!.claimToken, new Date()),
    ).rejects.toThrow(/stale/);
    expect(await getBalance(ownerId)).toEqual(before);
    const [custody] = await pg<{ chunks: number; audio_deleted_at: Date | null }[]>`
      select (select count(*)::int from transcription_chunks where session_id=${created.id}) chunks,
        audio_deleted_at from transcription_sessions where id=${created.id}`;
    expect(custody).toMatchObject({ chunks: 0 });
    expect(custody?.audio_deleted_at).not.toBeNull();
  });
});
