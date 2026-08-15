import { createHash, randomUUID } from 'node:crypto';

import { costFromParams, mannaForEstimate } from '@eden3/core';

import { ApiError } from '../errors';

export const TRANSCRIPTION_ENCODING = 'pcm_s16le' as const;
export const TRANSCRIPTION_SAMPLE_RATE_HZ = 16_000;
export const TRANSCRIPTION_CHANNELS = 1;
export const TRANSCRIPTION_BYTES_PER_SECOND = 32_000;
export const TRANSCRIPTION_FRAME_BYTES = 320;
export const TRANSCRIPTION_MAX_CHUNK_BYTES = 320_000;
export const TRANSCRIPTION_MAX_DURATION_MS = 600_000;
export const TRANSCRIPTION_MAX_TRANSCRIPT_CHARS = 200_000;
export const TRANSCRIPTION_PROVIDER = 'cartesia' as const;
export const TRANSCRIPTION_MODEL = 'ink-2' as const;
export const TRANSCRIPTION_EVENT_TYPE = 'speech_transcription' as const;
const STABLE_PROVIDER_ERROR_CODES = new Set([
  'provider_auth_error',
  'provider_error',
  'provider_rate_limited',
  'provider_response_invalid',
  'provider_timeout',
  'provider_unavailable',
  'transcription_deleted',
]);

export function quoteTranscription(durationMs: number): NonNullable<TranscriptionDto['quote']> {
  const estimate = costFromParams({
    provider: TRANSCRIPTION_PROVIDER,
    model: TRANSCRIPTION_MODEL,
    units: { audio_second: durationMs / 1_000 },
  });
  return {
    provider: TRANSCRIPTION_PROVIDER,
    model: TRANSCRIPTION_MODEL,
    tableVersion: estimate.tableVersion,
    costUsd: estimate.totalCostUsd,
    manna: mannaForEstimate(estimate),
  };
}

export type TranscriptionStatus =
  | 'uploading'
  | 'reserving'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'deleted'
  | 'expired';

export interface TranscriptionFormat {
  encoding: typeof TRANSCRIPTION_ENCODING;
  sampleRateHz: typeof TRANSCRIPTION_SAMPLE_RATE_HZ;
  channels: typeof TRANSCRIPTION_CHANNELS;
}

export interface TranscriptionDto {
  id: string;
  status: TranscriptionStatus;
  language: 'en';
  format: TranscriptionFormat;
  acknowledgedThrough: number;
  nextChunkNumber: number;
  receivedBytes: number;
  receivedDurationMs: number;
  maxDurationMs: number;
  expiresAt: string;
  transcript: string | null;
  errorCode: string | null;
  quote: null | {
    provider: typeof TRANSCRIPTION_PROVIDER;
    model: typeof TRANSCRIPTION_MODEL;
    tableVersion: string;
    costUsd: number;
    manna: number;
  };
}

export interface ChunkAck {
  id: string;
  chunkNumber: number;
  acknowledgedThrough: number;
  nextChunkNumber: number;
  receivedBytes: number;
  receivedDurationMs: number;
  replayed: boolean;
}

export interface TranscriptionProviderResult {
  transcript: string;
  providerRequestId: string | null;
  durationMs: number;
}

export interface TranscriptionProvider {
  readonly name: string;
  readonly model: string;
  transcribe(input: {
    sessionId: string;
    language: 'en';
    format: TranscriptionFormat;
    chunks: readonly Buffer[];
    durationMs: number;
    isCancelled: () => Promise<boolean>;
  }): Promise<TranscriptionProviderResult>;
}

interface StoredChunk {
  number: number;
  sha256: string;
  body: Buffer;
}

interface StoredSession {
  id: string;
  ownerId: string;
  createKey: string;
  finalizeKey: string | null;
  finalChunkNumber: number | null;
  status: TranscriptionStatus;
  language: 'en';
  maxDurationMs: number;
  expiresAt: Date;
  createdAt: Date;
  receivedBytes: number;
  receivedDurationMs: number;
  transcript: string | null;
  errorCode: string | null;
  providerRequestId: string | null;
  providerStartedAt: Date | null;
  deleteRequestedAt: Date | null;
  quote: TranscriptionDto['quote'];
  chargedManna: number;
  chunks: StoredChunk[];
}

export interface CreateTranscriptionInput {
  ownerId: string;
  idempotencyKey: string;
  language: 'en';
  maxDurationMs: number;
  now: Date;
}

export interface AppendTranscriptionChunkInput {
  ownerId: string;
  sessionId: string;
  chunkNumber: number;
  sha256: string;
  body: Buffer;
  now: Date;
}

export interface FinalizeTranscriptionInput {
  ownerId: string;
  sessionId: string;
  idempotencyKey: string;
  finalChunkNumber: number;
  now: Date;
}

export interface TranscriptionRepository {
  create(input: CreateTranscriptionInput): Promise<TranscriptionDto>;
  getOwned(ownerId: string, sessionId: string): Promise<TranscriptionDto | null>;
  append(input: AppendTranscriptionChunkInput): Promise<ChunkAck>;
  finalize(input: FinalizeTranscriptionInput): Promise<TranscriptionDto>;
  maintain(now: Date): Promise<void>;
  claimNext(now: Date): Promise<null | {
    claimToken: string;
    session: TranscriptionDto;
    chunks: readonly Buffer[];
  }>;
  markProviderStarted(sessionId: string, claimToken: string, now: Date): Promise<void>;
  isDeleteRequested(sessionId: string, claimToken: string): Promise<boolean>;
  complete(
    sessionId: string,
    claimToken: string,
    result: TranscriptionProviderResult,
    now: Date,
  ): Promise<void>;
  failAndRefund(sessionId: string, claimToken: string, errorCode: string, now: Date): Promise<void>;
  deleteOwned(ownerId: string, sessionId: string, now: Date): Promise<TranscriptionDto | null>;
}

function dto(row: StoredSession): TranscriptionDto {
  return {
    id: row.id,
    status: row.status,
    language: row.language,
    format: {
      encoding: TRANSCRIPTION_ENCODING,
      sampleRateHz: TRANSCRIPTION_SAMPLE_RATE_HZ,
      channels: TRANSCRIPTION_CHANNELS,
    },
    acknowledgedThrough: row.chunks.length - 1,
    nextChunkNumber: row.chunks.length,
    receivedBytes: row.receivedBytes,
    receivedDurationMs: row.receivedDurationMs,
    maxDurationMs: row.maxDurationMs,
    expiresAt: row.expiresAt.toISOString(),
    transcript: row.transcript,
    errorCode: row.errorCode,
    quote: row.quote,
  };
}

function notFound(): ApiError {
  return new ApiError(404, 'transcription_not_found', 'Transcription not found');
}

/** Deterministic, DB-free repository used by invariant and HTTP contract tests. */
export class MemoryTranscriptionRepository implements TranscriptionRepository {
  private readonly sessions = new Map<string, StoredSession>();
  private balance: number;
  private readonly maxActive: number;
  private readonly maxDaily: number;
  debitCount = 0;
  refundCount = 0;

  constructor(options: {
    initialManna?: number;
    maxActivePerOwner?: number;
    maxCreatedPerOwnerPerDay?: number;
  } = {}) {
    this.balance = options.initialManna ?? 10_000;
    this.maxActive = options.maxActivePerOwner ?? 2;
    this.maxDaily = options.maxCreatedPerOwnerPerDay ?? 100;
  }

  async create(input: CreateTranscriptionInput): Promise<TranscriptionDto> {
    const replay = [...this.sessions.values()].find(
      (row) => row.ownerId === input.ownerId && row.createKey === input.idempotencyKey,
    );
    if (replay) return dto(replay);
    const day = input.now.toISOString().slice(0, 10);
    const owned = [...this.sessions.values()].filter((row) => row.ownerId === input.ownerId);
    const active = owned.filter((row) => ['uploading', 'reserving', 'queued', 'processing'].includes(row.status));
    if (active.length >= this.maxActive) {
      throw new ApiError(429, 'transcription_concurrency_limit', 'Too many active transcriptions');
    }
    const today = owned.filter((row) => row.createdAt.toISOString().slice(0, 10) === day);
    if (today.length >= this.maxDaily) {
      throw new ApiError(429, 'transcription_daily_limit', 'Daily transcription limit reached');
    }
    const row: StoredSession = {
      id: randomUUID(),
      ownerId: input.ownerId,
      createKey: input.idempotencyKey,
      finalizeKey: null,
      finalChunkNumber: null,
      status: 'uploading',
      language: input.language,
      maxDurationMs: input.maxDurationMs,
      expiresAt: new Date(input.now.getTime() + 2 * 60 * 60 * 1_000),
      createdAt: input.now,
      receivedBytes: 0,
      receivedDurationMs: 0,
      transcript: null,
      errorCode: null,
      providerRequestId: null,
      providerStartedAt: null,
      deleteRequestedAt: null,
      quote: null,
      chargedManna: 0,
      chunks: [],
    };
    this.sessions.set(row.id, row);
    return dto(row);
  }

  async getOwned(ownerId: string, sessionId: string): Promise<TranscriptionDto | null> {
    const row = this.sessions.get(sessionId);
    return row?.ownerId === ownerId ? dto(row) : null;
  }

  async append(input: AppendTranscriptionChunkInput): Promise<ChunkAck> {
    const row = this.sessions.get(input.sessionId);
    if (!row || row.ownerId !== input.ownerId) throw notFound();
    if (row.expiresAt <= input.now) {
      throw new ApiError(410, 'transcription_expired', 'Transcription has expired');
    }
    if (row.status !== 'uploading') {
      throw new ApiError(409, 'transcription_not_uploading', 'Transcription is no longer accepting chunks');
    }
    const prior = row.chunks[input.chunkNumber];
    if (prior) {
      if (prior.sha256 !== input.sha256 || !prior.body.equals(input.body)) {
        throw new ApiError(409, 'chunk_conflict', 'Chunk number already contains different audio');
      }
      return this.ack(row, input.chunkNumber, true);
    }
    if (input.chunkNumber !== row.chunks.length) {
      throw new ApiError(409, 'chunk_out_of_order', 'Chunk number is not the next checkpoint');
    }
    const durationMs = input.body.length / 32;
    if (row.receivedDurationMs + durationMs > row.maxDurationMs) {
      throw new ApiError(413, 'transcription_too_long', 'Transcription exceeds its duration limit');
    }
    row.chunks.push({ number: input.chunkNumber, sha256: input.sha256, body: Buffer.from(input.body) });
    row.receivedBytes += input.body.length;
    row.receivedDurationMs += durationMs;
    row.expiresAt = new Date(input.now.getTime() + 2 * 60 * 60 * 1_000);
    return this.ack(row, input.chunkNumber, false);
  }

  private ack(row: StoredSession, chunkNumber: number, replayed: boolean): ChunkAck {
    return {
      id: row.id,
      chunkNumber,
      acknowledgedThrough: row.chunks.length - 1,
      nextChunkNumber: row.chunks.length,
      receivedBytes: row.receivedBytes,
      receivedDurationMs: row.receivedDurationMs,
      replayed,
    };
  }

  async finalize(input: FinalizeTranscriptionInput): Promise<TranscriptionDto> {
    const row = this.sessions.get(input.sessionId);
    if (!row || row.ownerId !== input.ownerId) throw notFound();
    if (row.expiresAt <= input.now) {
      throw new ApiError(410, 'transcription_expired', 'Transcription has expired');
    }
    if (row.finalizeKey) {
      if (row.finalizeKey !== input.idempotencyKey || row.finalChunkNumber !== input.finalChunkNumber) {
        throw new ApiError(409, 'finalization_conflict', 'Transcription was finalized with different coordinates');
      }
      return dto(row);
    }
    if (row.status !== 'uploading') {
      throw new ApiError(409, 'transcription_not_uploading', 'Transcription cannot be finalized');
    }
    if (row.chunks.length === 0 || input.finalChunkNumber !== row.chunks.length - 1) {
      throw new ApiError(409, 'transcription_incomplete', 'Final chunk does not match the durable checkpoint');
    }
    const quote = quoteTranscription(row.receivedDurationMs);
    const manna = quote.manna;
    if (this.balance < manna) {
      throw new ApiError(402, 'insufficient_manna', 'Insufficient manna');
    }
    row.status = 'reserving';
    row.finalizeKey = input.idempotencyKey;
    row.finalChunkNumber = input.finalChunkNumber;
    row.quote = quote;
    this.balance -= manna;
    row.chargedManna = manna;
    this.debitCount += 1;
    row.status = 'queued';
    return dto(row);
  }

  async claimNext(_now: Date): Promise<null | {
    claimToken: string;
    session: TranscriptionDto;
    chunks: readonly Buffer[];
  }> {
    const row = [...this.sessions.values()].find((candidate) => candidate.status === 'queued');
    if (!row) return null;
    row.status = 'processing';
    return {
      claimToken: randomUUID(),
      session: dto(row),
      chunks: row.chunks.map((chunk) => Buffer.from(chunk.body)),
    };
  }

  async maintain(_now: Date): Promise<void> {}

  async markProviderStarted(sessionId: string, _claimToken: string, now: Date): Promise<void> {
    const row = this.sessions.get(sessionId);
    if (!row || row.status !== 'processing') throw new Error('transcription claim is stale');
    if (row.deleteRequestedAt) throw new Error('transcription was deleted before provider admission');
    row.providerStartedAt = now;
  }

  async isDeleteRequested(sessionId: string, _claimToken: string): Promise<boolean> {
    const row = this.sessions.get(sessionId);
    return !row || row.status !== 'processing' || row.deleteRequestedAt !== null;
  }

  async complete(
    sessionId: string,
    _claimToken: string,
    result: TranscriptionProviderResult,
    now: Date,
  ): Promise<void> {
    const row = this.sessions.get(sessionId);
    if (!row || row.status !== 'processing') throw new Error('transcription claim is stale');
    if (row.deleteRequestedAt) {
      if (row.chargedManna > 0) {
        this.balance += row.chargedManna;
        row.chargedManna = 0;
        this.refundCount += 1;
      }
      row.status = 'deleted';
      row.transcript = null;
      row.providerRequestId = null;
    } else {
      row.status = 'completed';
      row.transcript = result.transcript;
      row.providerRequestId = result.providerRequestId;
    }
    row.expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    row.chunks = [];
  }

  async failAndRefund(
    sessionId: string,
    _claimToken: string,
    errorCode: string,
    now: Date,
  ): Promise<void> {
    const row = this.sessions.get(sessionId);
    if (!row || !['reserving', 'queued', 'processing'].includes(row.status)) return;
    if (row.chargedManna > 0) {
      this.balance += row.chargedManna;
      row.chargedManna = 0;
      this.refundCount += 1;
    }
    const deleted = row.deleteRequestedAt !== null || errorCode === 'transcription_deleted';
    row.status = deleted ? 'deleted' : 'failed';
    row.errorCode = deleted ? null : errorCode;
    row.expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    row.chunks = [];
  }

  async deleteOwned(ownerId: string, sessionId: string, _now: Date): Promise<TranscriptionDto | null> {
    const row = this.sessions.get(sessionId);
    if (!row || row.ownerId !== ownerId) return null;
    if (row.status === 'processing' && row.providerStartedAt !== null) {
      row.deleteRequestedAt ??= _now;
      row.transcript = null;
      return dto(row);
    }
    if (['reserving', 'queued', 'processing'].includes(row.status) && row.chargedManna > 0) {
      this.balance += row.chargedManna;
      row.chargedManna = 0;
      this.refundCount += 1;
    }
    row.status = 'deleted';
    row.transcript = null;
    row.errorCode = null;
    row.providerRequestId = null;
    row.chunks = [];
    return dto(row);
  }

  audioBytes(sessionId: string): number {
    return this.sessions.get(sessionId)?.chunks.reduce((sum, chunk) => sum + chunk.body.length, 0) ?? 0;
  }
}

export class DeterministicTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'mock';
  readonly model = 'deterministic-v1';
  calls = 0;

  constructor(private readonly options: { failWith?: string } = {}) {}

  async transcribe(input: {
    sessionId: string;
    language: 'en';
    format: TranscriptionFormat;
    chunks: readonly Buffer[];
    durationMs: number;
    isCancelled: () => Promise<boolean>;
  }): Promise<TranscriptionProviderResult> {
    this.calls += 1;
    if (this.options.failWith) {
      throw new TranscriptionProviderError(this.options.failWith);
    }
    const digest = createHash('sha256');
    for (const chunk of input.chunks) digest.update(chunk);
    return {
      transcript: `mock transcript ${digest.digest('hex').slice(0, 16)}`,
      providerRequestId: `mock-${input.sessionId}`,
      durationMs: input.durationMs,
    };
  }
}

export class TranscriptionProviderError extends Error {
  constructor(readonly code: string) {
    super('Transcription provider failed');
    this.name = 'TranscriptionProviderError';
  }
}

export class TranscriptionService {
  private readonly repository: TranscriptionRepository;
  private readonly provider: TranscriptionProvider | null;
  private readonly now: () => Date;

  constructor(options: {
    repository: TranscriptionRepository;
    provider: TranscriptionProvider | null;
    now?: () => Date;
  }) {
    this.repository = options.repository;
    this.provider = options.provider;
    this.now = options.now ?? (() => new Date());
  }

  async create(ownerId: string, input: {
    idempotencyKey: string;
    language?: 'en';
    maxDurationMs?: number;
  }): Promise<TranscriptionDto> {
    if (!this.provider) {
      throw new ApiError(503, 'transcription_not_configured', 'Transcription service is unavailable');
    }
    return await this.repository.create({
      ownerId,
      idempotencyKey: input.idempotencyKey,
      language: input.language ?? 'en',
      maxDurationMs: input.maxDurationMs ?? TRANSCRIPTION_MAX_DURATION_MS,
      now: this.now(),
    });
  }

  async get(ownerId: string, sessionId: string): Promise<TranscriptionDto> {
    const result = await this.repository.getOwned(ownerId, sessionId);
    if (!result) throw notFound();
    return result;
  }

  async appendChunk(
    ownerId: string,
    sessionId: string,
    chunkNumber: number,
    input: { body: Buffer; sha256: string },
  ): Promise<ChunkAck> {
    if (
      input.body.length < TRANSCRIPTION_FRAME_BYTES ||
      input.body.length > TRANSCRIPTION_MAX_CHUNK_BYTES ||
      input.body.length % TRANSCRIPTION_FRAME_BYTES !== 0
    ) {
      throw new ApiError(
        400,
        'invalid_audio_chunk',
        'PCM chunks must contain whole 10ms frames and stay within the chunk limit',
      );
    }
    const actual = createHash('sha256').update(input.body).digest('hex');
    if (actual !== input.sha256) {
      throw new ApiError(400, 'chunk_checksum_mismatch', 'Chunk checksum does not match its body');
    }
    return await this.repository.append({
      ownerId,
      sessionId,
      chunkNumber,
      sha256: input.sha256,
      body: input.body,
      now: this.now(),
    });
  }

  async finalize(ownerId: string, sessionId: string, input: {
    idempotencyKey: string;
    finalChunkNumber: number;
  }): Promise<TranscriptionDto> {
    if (!this.provider) {
      throw new ApiError(503, 'transcription_not_configured', 'Transcription service is unavailable');
    }
    return await this.repository.finalize({
      ownerId,
      sessionId,
      idempotencyKey: input.idempotencyKey,
      finalChunkNumber: input.finalChunkNumber,
      now: this.now(),
    });
  }

  async delete(ownerId: string, sessionId: string): Promise<TranscriptionDto> {
    const result = await this.repository.deleteOwned(ownerId, sessionId, this.now());
    if (!result) throw notFound();
    return result;
  }

  async runOnce(): Promise<boolean> {
    await this.repository.maintain(this.now());
    if (!this.provider) return false;
    const claim = await this.repository.claimNext(this.now());
    if (!claim) return false;
    try {
      await this.repository.markProviderStarted(claim.session.id, claim.claimToken, this.now());
      const result = await this.provider.transcribe({
        sessionId: claim.session.id,
        language: claim.session.language,
        format: claim.session.format,
        chunks: claim.chunks,
        durationMs: claim.session.receivedDurationMs,
        isCancelled: () => this.repository.isDeleteRequested(claim.session.id, claim.claimToken),
      });
      if (
        typeof result.transcript !== 'string' ||
        result.transcript.length > TRANSCRIPTION_MAX_TRANSCRIPT_CHARS ||
        !Number.isFinite(result.durationMs) ||
        result.durationMs < 0
      ) {
        throw new TranscriptionProviderError('provider_response_invalid');
      }
      await this.repository.complete(claim.session.id, claim.claimToken, result, this.now());
    } catch (error) {
      const code = error instanceof TranscriptionProviderError && STABLE_PROVIDER_ERROR_CODES.has(error.code)
        ? error.code
        : 'provider_error';
      await this.repository.failAndRefund(claim.session.id, claim.claimToken, code, this.now());
    }
    return true;
  }
}
