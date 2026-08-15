import { createHash, randomUUID } from 'node:crypto';

import {
  DailyCapExceededError,
  debit,
  InsufficientMannaError,
  reverseReservation,
  type DbHandle,
} from '@eden3/core';
import {
  db,
  transcriptionChunks,
  transcriptionSessions,
  usageEvents,
  type TranscriptionSession,
} from '@eden3/db';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';

import { ApiError } from '../errors';
import { PrivateTranscriptionAudioStore } from './transcription-audio-custody';
import {
  quoteTranscription,
  TRANSCRIPTION_CHANNELS,
  TRANSCRIPTION_ENCODING,
  TRANSCRIPTION_EVENT_TYPE,
  TRANSCRIPTION_MODEL,
  TRANSCRIPTION_PROVIDER,
  TRANSCRIPTION_SAMPLE_RATE_HZ,
  type AppendTranscriptionChunkInput,
  type ChunkAck,
  type CreateTranscriptionInput,
  type FinalizeTranscriptionInput,
  type TranscriptionDto,
  type TranscriptionProviderResult,
  type TranscriptionRepository,
} from './transcriptions';

const ACTIVE_STATUSES = ['uploading', 'reserving', 'queued', 'processing'] as const;
const TERMINAL_STATUSES = ['completed', 'failed', 'deleted', 'expired'] as const;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1_000;
const RESULT_TTL_MS = 24 * 60 * 60 * 1_000;
// Cartesia's realtime endpoint expects roughly realtime pacing. A ten-minute
// upload therefore needs a lease comfortably longer than ten minutes.
const CLAIM_LEASE_MS = 15 * 60 * 1_000;

interface ReservationMetadata {
  version: 1;
  transcriptionId: string;
  quote: NonNullable<TranscriptionDto['quote']>;
  reservation: {
    idempotencyKey: string;
    transactionId: string;
    reservedManna: number;
    subscriptionManna: number;
    durableManna: number;
  };
}

function reservationKey(sessionId: string): string {
  return `transcription:${sessionId}`;
}

function rowDto(row: TranscriptionSession): TranscriptionDto {
  const quote = row.quotedManna === null || row.quotedCostUsd === null || row.tableVersion === null
    ? null
    : {
        provider: TRANSCRIPTION_PROVIDER,
        model: TRANSCRIPTION_MODEL,
        tableVersion: row.tableVersion,
        costUsd: Number(row.quotedCostUsd),
        manna: row.quotedManna,
      };
  return {
    id: row.id,
    status: row.status,
    language: 'en',
    format: {
      encoding: TRANSCRIPTION_ENCODING,
      sampleRateHz: TRANSCRIPTION_SAMPLE_RATE_HZ,
      channels: TRANSCRIPTION_CHANNELS,
    },
    acknowledgedThrough: row.acknowledgedThrough,
    nextChunkNumber: row.nextChunkNumber,
    receivedBytes: row.receivedBytes,
    receivedDurationMs: row.receivedDurationMs,
    maxDurationMs: row.maxDurationMs,
    expiresAt: row.expiresAt.toISOString(),
    transcript: row.transcript,
    errorCode: row.errorCode,
    quote,
  };
}

function isReservationMetadata(value: unknown): value is ReservationMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ReservationMetadata>;
  return candidate.version === 1 &&
    typeof candidate.transcriptionId === 'string' &&
    Boolean(candidate.reservation) &&
    typeof candidate.reservation!.idempotencyKey === 'string' &&
    typeof candidate.reservation!.subscriptionManna === 'number';
}

export interface PostgresTranscriptionRepositoryOptions {
  db?: DbHandle;
  audio: PrivateTranscriptionAudioStore;
  dailyMannaCap: number;
  maxActivePerOwner: number;
  maxCreatedPerOwnerPerDay: number;
}

/** Durable repository: DB checkpoints and private files converge fail-closed. */
export class PostgresTranscriptionRepository implements TranscriptionRepository {
  private readonly db: DbHandle;
  private readonly audio: PrivateTranscriptionAudioStore;
  private readonly dailyMannaCap: number;
  private readonly maxActive: number;
  private readonly maxDaily: number;

  constructor(options: PostgresTranscriptionRepositoryOptions) {
    this.db = options.db ?? db;
    this.audio = options.audio;
    this.dailyMannaCap = options.dailyMannaCap;
    this.maxActive = options.maxActivePerOwner;
    this.maxDaily = options.maxCreatedPerOwnerPerDay;
  }

  async create(input: CreateTranscriptionInput): Promise<TranscriptionDto> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stt-owner:${input.ownerId}`}, 46))`);
      const accountRows = (await tx.execute(sql`
        select a.id
        from accounts a
        where a.id=${input.ownerId} and a.type='user' and a.deleted=false
          and not exists (
            select 1 from account_erasure_jobs j
            where j.account_id=a.id and j.state<>'succeeded'
          )
        for update
      `)) as unknown as Array<{ id: string }>;
      if (!accountRows[0]) throw new ApiError(404, 'account_not_found', 'Account not found');
      const [replay] = await tx
        .select()
        .from(transcriptionSessions)
        .where(and(
          eq(transcriptionSessions.ownerAccountId, input.ownerId),
          eq(transcriptionSessions.createIdempotencyKey, input.idempotencyKey),
        ))
        .limit(1);
      if (replay) return rowDto(replay);
      const counts = (await tx.execute(sql`
        select
          count(*) filter (where status in ('uploading','reserving','queued','processing'))::int active,
          count(*) filter (where created_at>=date_trunc('day',${input.now.toISOString()}::timestamptz))::int daily
        from transcription_sessions where owner_account_id=${input.ownerId}
      `)) as unknown as Array<{ active: number; daily: number }>;
      if ((counts[0]?.active ?? 0) >= this.maxActive) {
        throw new ApiError(429, 'transcription_concurrency_limit', 'Too many active transcriptions');
      }
      if ((counts[0]?.daily ?? 0) >= this.maxDaily) {
        throw new ApiError(429, 'transcription_daily_limit', 'Daily transcription limit reached');
      }
      const [created] = await tx
        .insert(transcriptionSessions)
        .values({
          ownerAccountId: input.ownerId,
          createIdempotencyKey: input.idempotencyKey,
          language: input.language,
          maxDurationMs: input.maxDurationMs,
          expiresAt: new Date(input.now.getTime() + UPLOAD_TTL_MS),
        })
        .returning();
      if (!created) throw new Error('transcription create returned no row');
      return rowDto(created);
    });
  }

  async getOwned(ownerId: string, sessionId: string): Promise<TranscriptionDto | null> {
    const [row] = await this.db
      .select()
      .from(transcriptionSessions)
      .where(and(
        eq(transcriptionSessions.id, sessionId),
        eq(transcriptionSessions.ownerAccountId, ownerId),
      ))
      .limit(1);
    return row ? rowDto(row) : null;
  }

  async append(input: AppendTranscriptionChunkInput): Promise<ChunkAck> {
    let writtenPath: string | null = null;
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(transcriptionSessions)
          .where(and(
            eq(transcriptionSessions.id, input.sessionId),
            eq(transcriptionSessions.ownerAccountId, input.ownerId),
          ))
          .for('update');
        if (!row) throw new ApiError(404, 'transcription_not_found', 'Transcription not found');
        if (row.expiresAt <= input.now) {
          throw new ApiError(410, 'transcription_expired', 'Transcription has expired');
        }
        if (row.status !== 'uploading') {
          throw new ApiError(409, 'transcription_not_uploading', 'Transcription is no longer accepting chunks');
        }
        const [prior] = await tx
          .select()
          .from(transcriptionChunks)
          .where(and(
            eq(transcriptionChunks.sessionId, input.sessionId),
            eq(transcriptionChunks.chunkNumber, input.chunkNumber),
          ))
          .limit(1);
        if (prior) {
          if (prior.sha256 !== input.sha256 || prior.sizeBytes !== input.body.length) {
            throw new ApiError(409, 'chunk_conflict', 'Chunk number already contains different audio');
          }
          return this.ack(row, input.chunkNumber, true);
        }
        if (input.chunkNumber !== row.nextChunkNumber) {
          throw new ApiError(409, 'chunk_out_of_order', 'Chunk number is not the next checkpoint');
        }
        const durationMs = input.body.length / 32;
        if (row.receivedDurationMs + durationMs > row.maxDurationMs) {
          throw new ApiError(413, 'transcription_too_long', 'Transcription exceeds its duration limit');
        }
        writtenPath = await this.audio.writeChunk({
          ownerId: input.ownerId,
          sessionId: input.sessionId,
          chunkNumber: input.chunkNumber,
          body: input.body,
        });
        await tx.insert(transcriptionChunks).values({
          sessionId: input.sessionId,
          chunkNumber: input.chunkNumber,
          sizeBytes: input.body.length,
          durationMs,
          sha256: input.sha256,
          relativePath: writtenPath,
        });
        const [updated] = await tx
          .update(transcriptionSessions)
          .set({
            acknowledgedThrough: input.chunkNumber,
            nextChunkNumber: input.chunkNumber + 1,
            receivedBytes: row.receivedBytes + input.body.length,
            receivedDurationMs: row.receivedDurationMs + durationMs,
            expiresAt: new Date(input.now.getTime() + UPLOAD_TTL_MS),
            updatedAt: input.now,
          })
          .where(eq(transcriptionSessions.id, input.sessionId))
          .returning();
        if (!updated) throw new Error('transcription checkpoint update returned no row');
        writtenPath = null;
        return this.ack(updated, input.chunkNumber, false);
      });
    } catch (error) {
      if (writtenPath) await this.audio.deletePaths([writtenPath]);
      throw error;
    }
  }

  private ack(row: TranscriptionSession, chunkNumber: number, replayed: boolean): ChunkAck {
    return {
      id: row.id,
      chunkNumber,
      acknowledgedThrough: row.acknowledgedThrough,
      nextChunkNumber: row.nextChunkNumber,
      receivedBytes: row.receivedBytes,
      receivedDurationMs: row.receivedDurationMs,
      replayed,
    };
  }

  async finalize(input: FinalizeTranscriptionInput): Promise<TranscriptionDto> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(transcriptionSessions)
          .where(and(
            eq(transcriptionSessions.id, input.sessionId),
            eq(transcriptionSessions.ownerAccountId, input.ownerId),
          ))
          .for('update');
        if (!row) throw new ApiError(404, 'transcription_not_found', 'Transcription not found');
        if (row.expiresAt <= input.now) {
          throw new ApiError(410, 'transcription_expired', 'Transcription has expired');
        }
        if (row.finalizeIdempotencyKey) {
          if (
            row.finalizeIdempotencyKey !== input.idempotencyKey ||
            row.finalChunkNumber !== input.finalChunkNumber
          ) {
            throw new ApiError(409, 'finalization_conflict', 'Transcription was finalized with different coordinates');
          }
          return rowDto(row);
        }
        if (row.status !== 'uploading') {
          throw new ApiError(409, 'transcription_not_uploading', 'Transcription cannot be finalized');
        }
        if (row.nextChunkNumber === 0 || row.acknowledgedThrough !== input.finalChunkNumber) {
          throw new ApiError(409, 'transcription_incomplete', 'Final chunk does not match the durable checkpoint');
        }
        const quote = quoteTranscription(row.receivedDurationMs);
        const key = reservationKey(row.id);
        const debited = await debit({
          accountId: input.ownerId,
          amount: quote.manna,
          type: 'spend:transcription',
          idempotencyKey: key,
          dailyCap: { limit: this.dailyMannaCap, now: input.now },
          db: tx,
        });
        if (debited.alreadyApplied) {
          throw new Error('transcription fresh finalization replayed its reservation');
        }
        const subscriptionManna = debited.subscriptionDrawn ?? 0;
        const metadata: ReservationMetadata = {
          version: 1,
          transcriptionId: row.id,
          quote,
          reservation: {
            idempotencyKey: key,
            transactionId: debited.transaction.id,
            reservedManna: quote.manna,
            subscriptionManna,
            durableManna: Number((quote.manna - subscriptionManna).toFixed(4)),
          },
        };
        const [usage] = await tx.insert(usageEvents).values({
          eventType: TRANSCRIPTION_EVENT_TYPE,
          status: 'pending',
          userId: input.ownerId,
          turnId: row.id,
          provider: quote.provider,
          model: quote.model,
          tableVersion: quote.tableVersion,
          manna: quote.manna,
          metadata,
        }).returning({ id: usageEvents.id });
        if (!usage) throw new Error('transcription usage authorization returned no row');
        const [updated] = await tx
          .update(transcriptionSessions)
          .set({
            finalizeIdempotencyKey: input.idempotencyKey,
            finalChunkNumber: input.finalChunkNumber,
            status: 'queued',
            provider: quote.provider,
            providerModel: quote.model,
            quotedCostUsd: quote.costUsd.toFixed(8),
            quotedManna: quote.manna,
            tableVersion: quote.tableVersion,
            reservationTransactionId: debited.transaction.id,
            usageEventId: usage.id,
            updatedAt: input.now,
          })
          .where(eq(transcriptionSessions.id, row.id))
          .returning();
        if (!updated) throw new Error('transcription finalization returned no row');
        return rowDto(updated);
      });
    } catch (error) {
      if (error instanceof InsufficientMannaError) {
        throw new ApiError(402, 'insufficient_manna', 'Insufficient manna');
      }
      if (error instanceof DailyCapExceededError) {
        throw new ApiError(429, 'manna_daily_cap_exceeded', 'Daily manna spend limit reached');
      }
      throw error;
    }
  }

  async claimNext(now: Date): Promise<null | {
    claimToken: string;
    session: TranscriptionDto;
    chunks: readonly Buffer[];
  }> {
    const claimed = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(transcriptionSessions)
        .where(and(
          eq(transcriptionSessions.status, 'queued'),
          gt(transcriptionSessions.expiresAt, now),
        ))
        .orderBy(asc(transcriptionSessions.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      const claimToken = randomUUID();
      const [updated] = await tx
        .update(transcriptionSessions)
        .set({
          status: 'processing',
          claimToken,
          claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
          updatedAt: now,
        })
        .where(and(
          eq(transcriptionSessions.id, row.id),
          eq(transcriptionSessions.status, 'queued'),
        ))
        .returning();
      if (!updated) return null;
      const chunks = await tx
        .select()
        .from(transcriptionChunks)
        .where(eq(transcriptionChunks.sessionId, row.id))
        .orderBy(asc(transcriptionChunks.chunkNumber));
      return { row: updated, claimToken, chunks };
    });
    if (!claimed) return null;
    try {
      const buffers: Buffer[] = [];
      for (const chunk of claimed.chunks) {
        buffers.push(await this.audio.readVerified(chunk.relativePath, {
          sizeBytes: chunk.sizeBytes,
          sha256: chunk.sha256,
        }));
      }
      return { claimToken: claimed.claimToken, session: rowDto(claimed.row), chunks: buffers };
    } catch (error) {
      await this.failAndRefund(claimed.row.id, claimed.claimToken, 'audio_custody_error', now);
      throw error;
    }
  }

  async maintain(now: Date): Promise<void> {
    await this.recoverOneStaleClaim(now);
    await this.retryOneCompensation();
    await this.expireOne(now);
    await this.cleanupOneTerminalAudio(now);
  }

  async markProviderStarted(sessionId: string, claimToken: string, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(transcriptionSessions)
        .set({ providerStartedAt: now, updatedAt: now })
        .where(and(
          eq(transcriptionSessions.id, sessionId),
          eq(transcriptionSessions.status, 'processing'),
          eq(transcriptionSessions.claimToken, claimToken),
          sql`${transcriptionSessions.providerStartedAt} is null`,
          sql`${transcriptionSessions.deleteRequestedAt} is null`,
        ))
        .returning({ id: transcriptionSessions.id });
      if (!updated) throw new Error('transcription provider-admission claim is stale');
      const [usage] = await tx.update(usageEvents).set({ status: 'provider_admitted' }).where(and(
        eq(usageEvents.eventType, TRANSCRIPTION_EVENT_TYPE),
        eq(usageEvents.turnId, sessionId),
        eq(usageEvents.status, 'pending'),
      )).returning({ id: usageEvents.id });
      if (!usage) throw new Error('transcription provider admission lost its usage authorization');
    });
  }

  async isDeleteRequested(sessionId: string, claimToken: string): Promise<boolean> {
    const [row] = await this.db
      .select({ deleteRequestedAt: transcriptionSessions.deleteRequestedAt })
      .from(transcriptionSessions)
      .where(and(
        eq(transcriptionSessions.id, sessionId),
        eq(transcriptionSessions.status, 'processing'),
        eq(transcriptionSessions.claimToken, claimToken),
      ))
      .limit(1);
    return !row || row.deleteRequestedAt !== null;
  }

  async complete(
    sessionId: string,
    claimToken: string,
    result: TranscriptionProviderResult,
    now: Date,
  ): Promise<void> {
    let deleted = false;
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(transcriptionSessions)
        .where(and(
          eq(transcriptionSessions.id, sessionId),
          eq(transcriptionSessions.status, 'processing'),
          eq(transcriptionSessions.claimToken, claimToken),
        ))
        .for('update');
      if (!row) throw new Error('transcription completion claim is stale');
      deleted = row.deleteRequestedAt !== null;
      await tx.update(transcriptionSessions).set({
        status: deleted ? 'deleted' : 'completed',
        transcript: deleted ? null : result.transcript,
        providerRequestId: deleted ? null : result.providerRequestId,
        providerCompletedAt: now,
        claimToken: null,
        claimExpiresAt: null,
        completedAt: now,
        expiresAt: new Date(now.getTime() + RESULT_TTL_MS),
        updatedAt: now,
      }).where(eq(transcriptionSessions.id, sessionId));
      await tx.update(usageEvents).set(deleted ? {
        status: 'refund_pending',
        errorCode: 'transcription_deleted',
        errorMessage: null,
      } : {
        status: 'completed',
        costUsd: row.quotedCostUsd,
        manna: row.quotedManna,
        latencyMs: row.providerStartedAt ? now.getTime() - row.providerStartedAt.getTime() : null,
        errorCode: null,
        errorMessage: null,
      }).where(and(
        eq(usageEvents.eventType, TRANSCRIPTION_EVENT_TYPE),
        eq(usageEvents.turnId, sessionId),
      ));
    });
    await this.purgeAudio(sessionId, now);
    if (deleted) await this.compensate(sessionId, 'transcription_deleted');
  }

  async failAndRefund(
    sessionId: string,
    claimToken: string,
    errorCode: string,
    now: Date,
  ): Promise<void> {
    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(transcriptionSessions)
        .where(and(
          eq(transcriptionSessions.id, sessionId),
          eq(transcriptionSessions.status, 'processing'),
          eq(transcriptionSessions.claimToken, claimToken),
        ))
        .for('update');
      if (!row) return null;
      const deleted = row.deleteRequestedAt !== null || errorCode === 'transcription_deleted';
      const [session] = await tx.update(transcriptionSessions).set({
          status: deleted ? 'deleted' : 'failed',
          transcript: null,
          providerRequestId: null,
          errorCode: deleted ? null : errorCode,
          claimToken: null,
          claimExpiresAt: null,
          completedAt: now,
          expiresAt: new Date(now.getTime() + RESULT_TTL_MS),
          updatedAt: now,
        })
        .where(eq(transcriptionSessions.id, sessionId))
        .returning({ id: transcriptionSessions.id });
      if (!session) throw new Error('transcription failure update returned no row');
      const [usage] = await tx.update(usageEvents).set({
        status: 'refund_pending',
        errorCode: deleted ? 'transcription_deleted' : errorCode,
        errorMessage: null,
      }).where(and(
        eq(usageEvents.eventType, TRANSCRIPTION_EVENT_TYPE),
        eq(usageEvents.turnId, sessionId),
        inArray(usageEvents.status, ['pending', 'provider_admitted']),
      )).returning({ id: usageEvents.id });
      if (!usage) throw new Error('transcription failure lost its usage authorization');
      return { session, deleted };
    });
    if (!updated) return;
    await this.purgeAudio(sessionId, now);
    await this.compensate(sessionId, updated.deleted ? 'transcription_deleted' : errorCode);
  }

  async deleteOwned(ownerId: string, sessionId: string, now: Date): Promise<TranscriptionDto | null> {
    let refund = false;
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(transcriptionSessions)
        .where(and(
          eq(transcriptionSessions.id, sessionId),
          eq(transcriptionSessions.ownerAccountId, ownerId),
        ))
        .for('update');
      if (!row) return null;
      if (row.status === 'processing' && row.providerStartedAt !== null) {
        const [updated] = await tx.update(transcriptionSessions).set({
          deleteRequestedAt: row.deleteRequestedAt ?? now,
          transcript: null,
          updatedAt: now,
        }).where(eq(transcriptionSessions.id, sessionId)).returning();
        return updated ? rowDto(updated) : null;
      }
      refund = ['reserving', 'queued', 'processing'].includes(row.status);
      const [updated] = await tx.update(transcriptionSessions).set({
        status: 'deleted',
        transcript: null,
        providerRequestId: null,
        errorCode: null,
        claimToken: null,
        claimExpiresAt: null,
        deleteRequestedAt: now,
        completedAt: row.completedAt ?? now,
        expiresAt: new Date(now.getTime() + RESULT_TTL_MS),
        updatedAt: now,
      }).where(eq(transcriptionSessions.id, sessionId)).returning();
      if (refund) {
        await tx.update(usageEvents).set({
          status: 'refund_pending',
          errorCode: 'transcription_deleted',
          errorMessage: null,
        }).where(and(
          eq(usageEvents.eventType, TRANSCRIPTION_EVENT_TYPE),
          eq(usageEvents.turnId, sessionId),
        ));
      }
      return updated ? rowDto(updated) : null;
    });
    if (!result) return null;
    if (result.status === 'deleted') await this.purgeAudio(sessionId, now);
    if (refund) await this.compensate(sessionId, 'transcription_deleted');
    return result;
  }

  private async compensate(sessionId: string, errorCode: string): Promise<void> {
    const [usage] = await this.db
      .select({ metadata: usageEvents.metadata })
      .from(usageEvents)
      .where(and(
        eq(usageEvents.eventType, TRANSCRIPTION_EVENT_TYPE),
        eq(usageEvents.turnId, sessionId),
      ))
      .limit(1);
    if (!usage || !isReservationMetadata(usage.metadata)) {
      throw new Error('transcription compensation metadata is invalid');
    }
    await reverseReservation({
      reservationKey: usage.metadata.reservation.idempotencyKey,
      reservedSubscriptionManna: usage.metadata.reservation.subscriptionManna,
      type: 'refund:transcription',
      db: this.db,
    });
    await this.db.update(usageEvents).set({
      status: 'error',
      manna: 0,
      costUsd: null,
      errorCode,
      errorMessage: null,
    }).where(and(
      eq(usageEvents.eventType, TRANSCRIPTION_EVENT_TYPE),
      eq(usageEvents.turnId, sessionId),
      eq(usageEvents.status, 'refund_pending'),
    ));
  }

  private async retryOneCompensation(): Promise<void> {
    const [row] = await this.db
      .select({
        sessionId: transcriptionSessions.id,
        errorCode: transcriptionSessions.errorCode,
      })
      .from(transcriptionSessions)
      .innerJoin(usageEvents, eq(usageEvents.turnId, transcriptionSessions.id))
      .where(and(
        eq(usageEvents.eventType, TRANSCRIPTION_EVENT_TYPE),
        eq(usageEvents.status, 'refund_pending'),
      ))
      .limit(1);
    if (row) await this.compensate(row.sessionId, row.errorCode ?? 'provider_error');
  }

  private async purgeAudio(sessionId: string, now: Date): Promise<void> {
    const [session] = await this.db
      .select()
      .from(transcriptionSessions)
      .where(eq(transcriptionSessions.id, sessionId))
      .limit(1);
    if (!session || session.audioDeletedAt) return;
    await this.audio.deleteSession(session.ownerAccountId, sessionId);
    await this.db.transaction(async (tx) => {
      await tx.delete(transcriptionChunks).where(eq(transcriptionChunks.sessionId, sessionId));
      await tx.update(transcriptionSessions).set({ audioDeletedAt: now, updatedAt: now })
        .where(eq(transcriptionSessions.id, sessionId));
    });
  }

  private async cleanupOneTerminalAudio(now: Date): Promise<void> {
    const [row] = await this.db
      .select({ id: transcriptionSessions.id })
      .from(transcriptionSessions)
      .where(and(
        inArray(transcriptionSessions.status, [...TERMINAL_STATUSES]),
        sql`${transcriptionSessions.audioDeletedAt} is null`,
      ))
      .limit(1);
    if (row) await this.purgeAudio(row.id, now);
  }

  private async expireOne(now: Date): Promise<void> {
    const expired = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(transcriptionSessions)
        .where(and(
          inArray(transcriptionSessions.status, ['uploading', 'reserving', 'queued', 'completed', 'failed']),
          lt(transcriptionSessions.expiresAt, now),
        ))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      const refund = row.status === 'reserving' || row.status === 'queued';
      await tx.update(transcriptionSessions).set({
        status: 'expired',
        transcript: null,
        errorCode: 'transcription_expired',
        completedAt: now,
        updatedAt: now,
      }).where(eq(transcriptionSessions.id, row.id));
      if (refund) {
        const [usage] = await tx.update(usageEvents).set({
          status: 'refund_pending',
          errorCode: 'transcription_expired',
          errorMessage: null,
        }).where(and(
          eq(usageEvents.eventType, TRANSCRIPTION_EVENT_TYPE),
          eq(usageEvents.turnId, row.id),
          eq(usageEvents.status, 'pending'),
        )).returning({ id: usageEvents.id });
        if (!usage) throw new Error('expired transcription lost its usage authorization');
      }
      return { id: row.id, refund };
    });
    if (!expired) return;
    await this.purgeAudio(expired.id, now);
    if (expired.refund) await this.compensate(expired.id, 'transcription_expired');
  }

  private async recoverOneStaleClaim(now: Date): Promise<void> {
    const recovered = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(transcriptionSessions)
        .where(and(
          eq(transcriptionSessions.status, 'processing'),
          lt(transcriptionSessions.claimExpiresAt, now),
        ))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      if (!row.providerStartedAt) {
        await tx.update(transcriptionSessions).set({
          status: 'queued',
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        }).where(eq(transcriptionSessions.id, row.id));
        return null;
      }
      await tx.update(transcriptionSessions).set({
        status: 'failed',
        transcript: null,
        providerRequestId: null,
        errorCode: 'provider_outcome_unknown',
        claimToken: null,
        claimExpiresAt: null,
        completedAt: now,
        expiresAt: new Date(now.getTime() + RESULT_TTL_MS),
        updatedAt: now,
      }).where(eq(transcriptionSessions.id, row.id));
      await tx.update(usageEvents).set({
        status: 'refund_pending',
        errorCode: 'provider_outcome_unknown',
        errorMessage: null,
      }).where(and(
        eq(usageEvents.eventType, TRANSCRIPTION_EVENT_TYPE),
        eq(usageEvents.turnId, row.id),
      ));
      return row.id;
    });
    if (recovered) {
      await this.purgeAudio(recovered, now);
      await this.compensate(recovered, 'provider_outcome_unknown');
    }
  }
}
