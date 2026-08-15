import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  COST_TABLE_VERSION,
  VOICE_CATALOG,
  catalogVoice,
  debit,
  mannaForEstimate,
  costFromParams,
  reverseReservation,
  type DbHandle,
  type MediaStore,
  type StoredObject,
} from '@eden3/core';
import { db, pg } from '@eden3/db';
import { messageAttachmentDto } from '@eden3/shared';
import type { MessageDto, VoiceAssignmentDto, VoiceCatalogEntryDto, VoiceCloneDto, VoiceExecutionDto, VoiceQuoteDto } from '@eden3/shared';
import { sql } from 'drizzle-orm';

import type { MediaObjectResolver } from './media-object-repository';
import type { VoiceAudioProcessor } from './voice-audio';
import { VoiceAudioError } from './voice-audio';
import type { VoiceProviderClient } from './voice-provider';
import { VoiceProviderError } from './voice-provider';

type VoiceOperation = 'preview' | 'chat' | 'discord' | 'telegram';

export class VoiceKernelError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message = code) {
    super(message);
    this.name = 'VoiceKernelError';
  }
}

interface AuthorizedVoice {
  voiceId: string;
  provider: 'deepinfra' | 'cartesia' | 'elevenlabs';
  model: string;
  providerVoiceId: string;
}

interface QuoteRow {
  id: string;
  owner_account_id: string;
  operation: VoiceOperation;
  voice_id: string;
  text_sha256: string;
  character_count: number;
  provider: AuthorizedVoice['provider'];
  model: string;
  cost_usd: string | number;
  manna: string | number;
  table_version: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

interface ExecutionRow {
  id: string;
  voice_id: string;
  purpose: VoiceOperation;
  status: VoiceExecutionDto['status'];
  output_url: string | null;
  output_mime: string | null;
  output_duration_ms: number | null;
  output_size_bytes: string | number | null;
  character_count: number;
  reserved_manna: string | number;
  request_sha256: string;
  output_sha256?: string | null;
  output_local_path?: string | null;
  text_sha256?: string;
  idempotency_key?: string;
  channel_turn_id?: string | null;
}

interface DirectVoiceJobRow {
  message_id: string;
  owner_account_id: string;
  session_id: string;
  agent_account_id: string | null;
  voice_id: string;
  text_sha256: string;
  mode: 'on_demand' | 'always';
  status: 'queued' | 'generating' | 'attachment_pending' | 'completed' | 'failed';
  generation: number;
  execution_id: string | null;
  refresh_state: 'none' | 'pending' | 'published';
  last_error_code: string | null;
  updated_at: Date | string;
}

interface ClipMeta {
  object_id: string;
  mime: 'audio/wav' | 'audio/mpeg';
  size_bytes: string | number;
  sha256: string;
}

export interface VoiceKernelOptions {
  db?: DbHandle;
  mediaStore: MediaStore;
  mediaResolver?: MediaObjectResolver;
  audio: VoiceAudioProcessor;
  providers: Partial<Record<AuthorizedVoice['provider'], VoiceProviderClient>>;
  now?: () => Date;
  dailyMannaCap?: number;
  cleanupArtifact: (sha256: string, mime: string) => Promise<void>;
  /** Exact LocalMediaStore root; voice bytes may never be read outside it. */
  voiceOutputRoot?: string;
  /** Idempotently removes one unshared, private voice-clip object and cache entry. */
  deletePrivateClip?: (object: StoredObject, signal?: AbortSignal) => Promise<void>;
  /** Deterministic PostgreSQL lock-race seam; never configured by production. */
  afterDirectVoiceEligibilityLocked?: () => Promise<void>;
}

export interface VoiceOutputBytes {
  bytes: Buffer;
  mime: string;
  sizeBytes: number;
  sha256: string;
}

function rows<T>(result: unknown): T[] {
  return result as T[];
}

const TEXT_LIMITS: Record<VoiceOperation, number> = { preview: 500, chat: 4_000, discord: 2_000, telegram: 2_000 };

function exactTranscript(raw: string, operation: VoiceOperation = 'chat'): { text: string; sha256: string; characterCount: number } {
  const text = raw.normalize('NFC');
  const characterCount = Array.from(text).length;
  if (text.trim().length === 0 || characterCount > TEXT_LIMITS[operation] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new VoiceKernelError(422, 'voice_text_invalid', 'Voice text is invalid');
  }
  return { text, characterCount, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function executionRequestHash(input: {
  operation: VoiceOperation;
  voiceId: string;
  textSha256: string;
  agentAccountId?: string;
  sessionId?: string;
  messageId?: string;
  channelTurnId?: string;
}): string {
  return requestHash({
    operation: input.operation,
    voiceId: input.voiceId,
    textSha256: input.textSha256,
    agentAccountId: input.agentAccountId ?? null,
    sessionId: input.sessionId ?? null,
    messageId: input.messageId ?? null,
    channelTurnId: input.channelTurnId ?? null,
  });
}

function shouldRefundVoiceFailure(status: VoiceExecutionDto['status']): boolean {
  // A reservation settles only when a playable, durable attachment exists.
  // Provider admission/cost is Eden's operational loss, never the user's.
  return status !== 'completed';
}

function providerCloneName(id: string): string {
  return `eden3-clone-${id}`;
}

function directVoiceExecutionKey(messageId: string, generation: number): string {
  return `direct-voice:${messageId}:generation:${generation}`;
}

function assertVoiceReconciliationActive(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function ambiguousCloneAbsenceDisposition(
  providerRequestId: string | null,
  finalizeConfirmedAbsence: boolean,
): 'observe' | 'pending' | 'confirm' {
  const priorAbsenceObserved = providerRequestId?.startsWith('absence:') === true;
  if (!priorAbsenceObserved) return 'observe';
  return finalizeConfirmedAbsence ? 'confirm' : 'pending';
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function executionDto(row: ExecutionRow, replayed: boolean): VoiceExecutionDto {
  return {
    id: row.id,
    voiceId: row.voice_id,
    purpose: row.purpose,
    status: row.status,
    url: row.output_url,
    mime: row.output_mime,
    durationMs: row.output_duration_ms,
    sizeBytes: row.output_size_bytes === null ? null : Number(row.output_size_bytes),
    characterCount: row.character_count,
    manna: Number(row.reserved_manna),
    replayed,
  };
}

function ownerVoiceOutputPath(executionId: string): string {
  return `/media/voice/${executionId}`;
}

function cloneDto(row: Record<string, unknown>): VoiceCloneDto {
  return {
    id: String(row.id),
    voiceId: String(row.voice_id),
    name: String(row.name),
    provider: row.provider as 'cartesia',
    status: row.status as VoiceCloneDto['status'],
    clipManifestSha256: String(row.clip_manifest_sha256),
    consentVersion: String(row.consent_version),
    quarantineCode: row.quarantine_code === null ? null : String(row.quarantine_code),
    failureCode: row.failure_code === null ? null : String(row.failure_code),
    createdAt: iso(row.created_at as Date | string),
    updatedAt: iso(row.updated_at as Date | string),
    revokedAt: row.consent_revoked_at === null && row.revoked_at === null
      ? null
      : iso((row.consent_revoked_at ?? row.revoked_at) as Date | string),
    deletedAt: row.deleted_at === null ? null : iso(row.deleted_at as Date | string),
  };
}

function directVoiceMessageDto(row: Record<string, unknown>): MessageDto {
  const rawAttachments = Array.isArray(row.attachments) ? row.attachments : [];
  const attachments = rawAttachments.flatMap((item) => {
    const candidate = typeof item === 'string' ? { url: item } : item;
    const parsed = messageAttachmentDto.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
  return {
    id: String(row.id),
    externalId: row.external_id === null ? null : String(row.external_id),
    sessionId: String(row.session_id),
    senderId: row.sender_id === null ? null : String(row.sender_id),
    role: row.role === null ? null : String(row.role),
    content: row.content === null ? null : String(row.content),
    attachments,
    toolCalls: Array.isArray(row.tool_calls) ? row.tool_calls as Array<Record<string, unknown>> : null,
    reactions: row.reactions && typeof row.reactions === 'object' && !Array.isArray(row.reactions)
      ? row.reactions as Record<string, unknown>
      : null,
    replyToExternalId: row.reply_to_external_id === null ? null : String(row.reply_to_external_id),
    createdAt: iso(row.created_at as Date | string),
  };
}

export class VoiceKernel {
  private readonly dbc: DbHandle;
  private readonly now: () => Date;
  private privateOutputDirty = true;
  private privateOutputScanFlight: Promise<number> | null = null;
  private privateOutputCustodyTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: VoiceKernelOptions) {
    this.dbc = options.db ?? db;
    this.now = options.now ?? (() => new Date());
  }

  private async assertOwnerWritableTx(tx: DbHandle, ownerAccountId: string): Promise<void> {
    const owner = await tx.execute(sql`
      select id from accounts where id=${ownerAccountId} and deleted=false for key share
    `);
    if (rows(owner).length !== 1) {
      throw new VoiceKernelError(409, 'account_erasure_active', 'Account deletion is in progress');
    }
    await tx.execute(sql`select account_erasure_assert_account_writable(${ownerAccountId})`);
  }

  async catalog(ownerAccountId: string) {
    const owned = await this.dbc.execute(sql`
      select id,voice_id,name from voice_clones
      where owner_account_id=${ownerAccountId} and status='ready' and consent_revoked_at is null
      order by created_at,id
    `);
    const items: VoiceCatalogEntryDto[] = VOICE_CATALOG.map((voice) => {
      const pricing = costFromParams({ provider: voice.provider, model: voice.model, units: { audio_character: 1 } });
      return {
        id: voice.id,
        provider: voice.provider,
        model: voice.model,
        name: voice.name,
        language: voice.locale,
        kind: 'roster',
        preview: { available: voice.previewable },
        pricing: { unit: 'character', usdPerUnit: pricing.totalCostUsd, tableVersion: pricing.tableVersion },
        capabilities: { preview: voice.previewable, chat: true, discord: true, telegram: true },
      };
    });
    for (const clone of rows<{ id: string; voice_id: string; name: string }>(owned)) {
      const pricing = costFromParams({ provider: 'cartesia', model: 'sonic-3.5-2026-05-04', units: { audio_character: 1 } });
      items.push({
        id: clone.voice_id,
        provider: 'cartesia',
        model: 'sonic-3.5-2026-05-04',
        name: clone.name,
        language: 'en',
        kind: 'clone',
        preview: { available: true },
        pricing: { unit: 'character', usdPerUnit: pricing.totalCostUsd, tableVersion: pricing.tableVersion },
        capabilities: { preview: true, chat: true, discord: true, telegram: true },
      });
    }
    return {
      version: '2026-08-15.kokoro-v1',
      items,
    };
  }

  private async resolveAuthorizedVoiceTx(
    tx: DbHandle,
    ownerAccountId: string,
    voiceId: string,
    operation: VoiceOperation | 'clone',
  ): Promise<AuthorizedVoice> {
    const ownerResult = await tx.execute(sql`
      select a.id from accounts a where a.id=${ownerAccountId} and a.deleted=false
        and not exists (select 1 from account_erasure_jobs j where j.account_id=a.id and j.state<>'succeeded')
      for share
    `);
    if (rows(ownerResult).length === 0) {
      throw new VoiceKernelError(409, 'voice_not_authorized', `Voice is not authorized for ${operation}`);
    }
    const catalog = catalogVoice(voiceId);
    if (catalog) return {
      voiceId: catalog.id,
      provider: catalog.provider,
      model: catalog.model,
      providerVoiceId: catalog.providerVoiceId,
    };
    const result = await tx.execute(sql`
      select vc.voice_id,vc.provider,vc.provider_voice_id,vc.status
      from voice_clones vc
      where vc.voice_id=${voiceId} and vc.owner_account_id=${ownerAccountId}
        and vc.consent_revoked_at is null
        and not exists (select 1 from account_erasure_jobs j
          where j.account_id=vc.owner_account_id and j.state<>'succeeded')
      for update
    `);
    const row = rows<{ voice_id: string; provider: 'cartesia'; provider_voice_id: string | null; status: string }>(result)[0];
    if (!row || row.status !== 'ready' || !row.provider_voice_id) {
      throw new VoiceKernelError(409, 'voice_not_authorized', `Voice is not authorized for ${operation}`);
    }
    const clips = await tx.execute(sql`
      select o.owner_account_id,o.purpose,o.state,o.verified_sha256,o.verified_mime,
        o.verified_size_bytes,vcc.sha256,vcc.mime,vcc.size_bytes
      from voice_clone_clips vcc join storage_objects o on o.id=vcc.object_id
      where vcc.clone_id=(select id from voice_clones where voice_id=${voiceId})
      order by vcc.position for share of o,vcc
    `);
    const clipRows = rows<{
      owner_account_id: string; purpose: string; state: string; verified_sha256: string | null;
      verified_mime: string | null; verified_size_bytes: string | number | null;
      sha256: string; mime: string; size_bytes: string | number;
    }>(clips);
    if (clipRows.length < 1 || !clipRows.every((clip) =>
      clip.owner_account_id === ownerAccountId && clip.purpose === 'voice-clip' &&
      clip.state === 'available' && clip.verified_sha256 === clip.sha256 &&
      clip.verified_mime === clip.mime && Number(clip.verified_size_bytes) === Number(clip.size_bytes)
    )) {
      throw new VoiceKernelError(409, 'voice_not_authorized', `Voice is not authorized for ${operation}`);
    }
    return { voiceId: row.voice_id, provider: row.provider, model: 'sonic-3.5-2026-05-04', providerVoiceId: row.provider_voice_id };
  }

  async quote(ownerAccountId: string, operation: VoiceOperation, voiceId: string, rawText: string) {
    const transcript = exactTranscript(rawText, operation);
    return await this.dbc.transaction(async (tx) => {
      await this.assertOwnerWritableTx(tx, ownerAccountId);
      const voice = await this.resolveAuthorizedVoiceTx(tx, ownerAccountId, voiceId, operation);
      const estimate = costFromParams({ provider: voice.provider, model: voice.model, units: { audio_character: transcript.characterCount } });
      const manna = mannaForEstimate(estimate);
      const id = randomUUID();
      const created = this.now();
      const expires = new Date(created.getTime() + 5 * 60_000);
      await tx.execute(sql`
        insert into voice_quotes (id,owner_account_id,operation,voice_id,text_sha256,character_count,
          provider,model,cost_usd,manna,table_version,pricing_effective_date,expires_at,created_at)
        values (${id},${ownerAccountId},${operation},${voice.voiceId},${transcript.sha256},${transcript.characterCount},
          ${voice.provider},${voice.model},${estimate.totalCostUsd},${manna},${estimate.tableVersion},${created.toISOString().slice(0,10)},${expires.toISOString()},${created.toISOString()})
      `);
      return {
        quoteId: id,
        expiresAt: expires.toISOString(),
        transcriptSha256: transcript.sha256,
        operation,
        voiceId: voice.voiceId,
        provider: voice.provider,
        model: voice.model,
        characterCount: transcript.characterCount,
        costUsd: estimate.totalCostUsd,
        manna,
        authorizedMaxManna: manna,
        tableVersion: estimate.tableVersion,
        pricingEffectiveDate: created.toISOString().slice(0, 10),
        estimated: estimate.estimated,
      } satisfies VoiceQuoteDto;
    });
  }

  async synthesize(input: {
    ownerAccountId: string;
    operation: VoiceOperation;
    voiceId: string;
    quoteId: string;
    text: string;
    idempotencyKey: string;
    agentAccountId?: string;
    sessionId?: string;
    messageId?: string;
    channelTurnId?: string;
    /** Direct chat owns settlement until its message attachment commits. */
    deferSettlement?: boolean;
    /** Reconciler-only deadline fence; interactive calls omit it. */
    signal?: AbortSignal;
  }): Promise<VoiceExecutionDto> {
    if (this.privateOutputScanFlight) await this.privateOutputScanFlight;
    if (this.privateOutputDirty) {
      await this.reconcileOrphanedOutputs(input.signal);
    }
    assertVoiceReconciliationActive(input.signal);
    const transcript = exactTranscript(input.text, input.operation);
    const requestSha256 = executionRequestHash({ ...input, textSha256: transcript.sha256 });

    const admission = await this.dbc.transaction(async (tx) => {
      const owner = await tx.execute(sql`
        select id from accounts where id=${input.ownerAccountId} and deleted=false for key share
      `);
      if (rows(owner).length !== 1) {
        throw new VoiceKernelError(409, 'account_erasure_active', 'Account deletion is in progress');
      }
      await tx.execute(sql`select account_erasure_assert_account_writable(${input.ownerAccountId})`);
      // Missing-row SELECT ... FOR UPDATE does not serialize two first-time
      // callers. Lock the canonical idempotency coordinate before looking for
      // the row so only one request may reserve manna/admit provider work.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
        'eden3-voice-execution:'||${input.ownerAccountId}::text||':'||${input.operation}||':'||${input.idempotencyKey},0))`);
      const priorResult = await tx.execute(sql`
        select * from voice_executions where owner_account_id=${input.ownerAccountId}
          and purpose=${input.operation} and idempotency_key=${input.idempotencyKey} for update
      `);
      const prior = rows<ExecutionRow>(priorResult)[0];
      if (prior) {
        if (prior.request_sha256 !== requestSha256) throw new VoiceKernelError(409, 'idempotency_conflict', 'Idempotency key was used for another request');
        if (prior.status === 'completed') return { replay: executionDto(prior, true) } as const;
        throw new VoiceKernelError(409, prior.status === 'failed' ? 'voice_execution_terminal' : 'voice_execution_in_progress', 'Voice execution cannot be replayed');
      }
      const quoteResult = await tx.execute(sql`select * from voice_quotes where id=${input.quoteId} and owner_account_id=${input.ownerAccountId} for update`);
      const quote = rows<QuoteRow>(quoteResult)[0];
      if (!quote || quote.consumed_at !== null || new Date(quote.expires_at).getTime() <= this.now().getTime() ||
        quote.operation !== input.operation || quote.voice_id !== input.voiceId || quote.text_sha256 !== transcript.sha256 ||
        quote.character_count !== transcript.characterCount || quote.table_version !== COST_TABLE_VERSION) {
        throw new VoiceKernelError(409, 'voice_quote_mismatch', 'Voice quote is expired, consumed, or mismatched');
      }
      const voice = await this.resolveAuthorizedVoiceTx(tx, input.ownerAccountId, quote.voice_id, input.operation);
      if (voice.provider !== quote.provider || voice.model !== quote.model) throw new VoiceKernelError(409, 'voice_quote_mismatch', 'Voice provider snapshot changed');
      const executionId = randomUUID();
      const reservationKey = `voice:${executionId}`;
      const charged = await debit({
        accountId: input.ownerAccountId,
        amount: Number(quote.manna),
        type: `spend:voice_${input.operation}`,
        idempotencyKey: reservationKey,
        dailyCap: { limit: this.options.dailyMannaCap ?? 10_000 },
        db: tx,
      });
      if (charged.alreadyApplied) throw new Error('voice execution minted a replayed reservation');
      await tx.execute(sql`
        insert into voice_executions (id,owner_account_id,agent_account_id,session_id,message_id,channel_turn_id,
          purpose,voice_id,text_sha256,request_sha256,idempotency_key,character_count,provider,model,status,
          reserved_manna,reserved_subscription_manna,cost_usd,table_version,attempt_count)
        values (${executionId},${input.ownerAccountId},${input.agentAccountId ?? null},${input.sessionId ?? null},${input.messageId ?? null},${input.channelTurnId ?? null},
          ${input.operation},${voice.voiceId},${transcript.sha256},${requestSha256},${input.idempotencyKey},${transcript.characterCount},${voice.provider},${voice.model},'provider_started',
          ${Number(quote.manna)},${charged.subscriptionDrawn ?? 0},${Number(quote.cost_usd)},${quote.table_version},1)
      `);
      await tx.execute(sql`
        insert into usage_events (event_type,status,user_id,agent_id,session_id,message_id,turn_id,provider,model,pricing_basis,table_version,cost_usd,manna,metadata)
        values ('voice_generation','provider_admitted',${input.ownerAccountId},${input.agentAccountId ?? null},${input.sessionId ?? null},${input.messageId ?? null},${executionId},${voice.provider},${voice.model},'provider-api',${quote.table_version},null,${Number(quote.manna)},${JSON.stringify({ version: 1, purpose: input.operation, characterCount: transcript.characterCount, voiceId: voice.voiceId })}::jsonb)
      `);
      await tx.execute(sql`update voice_quotes set consumed_at=statement_timestamp() where id=${quote.id}`);
      return { executionId, reservationKey, voice, quote, replay: null } as const;
    });
    if (admission.replay) return admission.replay;
    assertVoiceReconciliationActive(input.signal);

    const provider = this.options.providers[admission.voice.provider];
    if (!provider || provider.provider !== admission.voice.provider) {
      await this.failExecution(admission.executionId, admission.reservationKey, 'voice_provider_unavailable');
      throw new VoiceKernelError(503, 'voice_provider_unavailable', 'Voice provider is unavailable');
    }

    try {
      const generated = await provider.synthesize({
        model: admission.voice.model,
        providerVoiceId: admission.voice.providerVoiceId,
        text: transcript.text,
        signal: input.signal,
      });
      assertVoiceReconciliationActive(input.signal);
      await this.dbc.transaction(async (tx) => {
        assertVoiceReconciliationActive(input.signal);
        await this.resolveAuthorizedVoiceTx(tx, input.ownerAccountId, admission.voice.voiceId, input.operation);
        assertVoiceReconciliationActive(input.signal);
        await tx.execute(sql`update voice_executions set status='transcoding',provider_request_id=${generated.requestId},updated_at=statement_timestamp() where id=${admission.executionId} and status='provider_started'`);
      });
      const output = await this.options.audio.process(generated.audio, generated.mime, input.operation);
      assertVoiceReconciliationActive(input.signal);
      const outputSha256 = createHash('sha256').update(output.bytes).digest('hex');
      const billedCharacters = generated.billedCharacters ?? transcript.characterCount;
      if (!Number.isSafeInteger(billedCharacters) || billedCharacters < 1 || billedCharacters > 8_000) {
        throw new VoiceProviderError('provider_response_invalid', true);
      }
      const actual = costFromParams({
        provider: admission.voice.provider,
        model: admission.voice.model,
        units: { audio_character: billedCharacters },
      });
      const protectedOutputUrl = ownerVoiceOutputPath(admission.executionId);
      let stored: Awaited<ReturnType<VoiceKernelOptions['mediaStore']['put']>>;
      stored = await this.withPrivateOutputCustody(async () => {
        // Another admitted request may have failed publication before this
        // request reached the serialized publication boundary.
        if (this.privateOutputDirty) await this.scanOrphanedOutputs(input.signal);
        try {
          return await this.dbc.transaction(async (tx) => {
            assertVoiceReconciliationActive(input.signal);
            const owner = await tx.execute(sql`
              select id from accounts where id=${input.ownerAccountId} and deleted=false for key share
            `);
            if (rows(owner).length !== 1) {
              throw new VoiceKernelError(409, 'account_erasure_active', 'Account deletion is in progress');
            }
            await tx.execute(sql`select account_erasure_assert_account_writable(${input.ownerAccountId})`);
            await this.resolveAuthorizedVoiceTx(tx, input.ownerAccountId, admission.voice.voiceId, input.operation);
            assertVoiceReconciliationActive(input.signal);
            // The digest lock, byte publication, and first authoritative output
            // reference share one transaction. An erasure election therefore sees
            // either the durable voice reference or no newly published bytes.
            await tx.execute(sql`select account_erasure_assert_voice_output_writable(${outputSha256})`);
            const next = await this.options.mediaStore.put(output.bytes, { mime: output.mime });
            assertVoiceReconciliationActive(input.signal);
            if (next.sha256 !== outputSha256 || next.mime !== output.mime || next.sizeBytes !== output.bytes.length) {
              throw new VoiceAudioError('audio_invalid');
            }
            const published = await tx.execute(sql`
              update voice_executions set output_url=${protectedOutputUrl},output_sha256=${next.sha256},
                output_local_path=${next.localPath},output_mime=${next.mime},output_size_bytes=${next.sizeBytes},output_duration_ms=${output.durationMs},
                waveform=${output.waveform},
                billed_character_count=${billedCharacters},cost_usd=${actual.totalCostUsd},updated_at=statement_timestamp()
              where id=${admission.executionId} and status='transcoding' returning id
            `);
            if (rows(published).length !== 1) throw new Error('voice execution lost output publication custody');
            return next;
          });
        } catch (error) {
          this.privateOutputDirty = true;
          throw error;
        }
      });
      const completed = await this.dbc.transaction(async (tx) => {
        assertVoiceReconciliationActive(input.signal);
        await this.resolveAuthorizedVoiceTx(tx, input.ownerAccountId, admission.voice.voiceId, input.operation);
        assertVoiceReconciliationActive(input.signal);
        if (input.deferSettlement) {
          const pending = await tx.execute(sql`
            update voice_executions set output_url=${protectedOutputUrl},output_sha256=${stored.sha256},
              output_local_path=${stored.localPath},output_mime=${stored.mime},output_size_bytes=${stored.sizeBytes},output_duration_ms=${output.durationMs},
              waveform=${output.waveform},updated_at=statement_timestamp(),last_error_code=null
            where id=${admission.executionId} and status='transcoding' returning *
          `);
          const row = rows<ExecutionRow>(pending)[0];
          if (!row) throw new Error('voice execution lost direct attachment custody');
          await tx.execute(sql`
            update usage_events set metadata=coalesce(metadata,'{}'::jsonb)||${JSON.stringify({
              providerRequestId: generated.requestId,
              billedCharacters: generated.billedCharacters,
              outputSha256: stored.sha256,
              outputBytes: stored.sizeBytes,
              durationMs: output.durationMs,
              attachmentPending: true,
            })}::jsonb
            where event_type='voice_generation' and turn_id=${admission.executionId} and status='provider_admitted'
          `);
          return executionDto(row, false);
        }
        const updated = await tx.execute(sql`
          update voice_executions set status='completed',output_url=${protectedOutputUrl},output_sha256=${stored.sha256},
            output_local_path=${stored.localPath},output_mime=${stored.mime},output_size_bytes=${stored.sizeBytes},output_duration_ms=${output.durationMs},
            waveform=${output.waveform},completed_at=statement_timestamp(),updated_at=statement_timestamp(),last_error_code=null
          where id=${admission.executionId} and status='transcoding' returning *
        `);
        const row = rows<ExecutionRow>(updated)[0];
        if (!row) throw new Error('voice execution completion lost its saga state');
        await tx.execute(sql`
          update usage_events set status='completed',cost_usd=${actual.totalCostUsd},latency_ms=null,
            metadata=coalesce(metadata,'{}'::jsonb)||${JSON.stringify({ providerRequestId: generated.requestId, billedCharacters: generated.billedCharacters, outputSha256: stored.sha256, outputBytes: stored.sizeBytes, durationMs: output.durationMs })}::jsonb
          where event_type='voice_generation' and turn_id=${admission.executionId}
        `);
        return executionDto(row, false);
      });
      return completed;
    } catch (error) {
      const code = error instanceof VoiceProviderError
        ? error.code
        : error instanceof VoiceAudioError
          ? error.code
          : error instanceof VoiceKernelError
            ? error.code
            : 'voice_execution_failed';
      await this.recoverFailedExecution(admission.executionId, admission.reservationKey, code, input.signal);
      if (error instanceof VoiceKernelError) throw error;
      if (error instanceof VoiceProviderError && error.code === 'provider_result_indeterminate') {
        throw new VoiceKernelError(502, 'voice_provider_result_indeterminate', 'Voice provider result is indeterminate and will not be retried');
      }
      throw new VoiceKernelError(error instanceof VoiceAudioError ? 422 : 502, code, 'Voice execution failed');
    }
  }

  private async recoverFailedExecution(
    executionId: string,
    reservationKey: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.failExecution(executionId, reservationKey, code);
    } catch {
      // Stale reconciliation owns the durable refund/status repair. Do not
      // let a database outage skip private filesystem custody below.
    }
    try {
      await this.cleanupFailedArtifact(executionId);
    } catch {
      // The orphan/reference scanner is independent and must still run.
    }
    try {
      await this.reconcileOrphanedOutputs(signal);
    } catch {
      // The original request still receives its bounded execution error.
      // Every later admission scans again, so this failure cannot be masked
      // by another writer succeeding in the meantime.
    }
  }

  private async withPrivateOutputCustody<T>(work: () => Promise<T>): Promise<T> {
    const predecessor = this.privateOutputCustodyTail;
    let release!: () => void;
    this.privateOutputCustodyTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async failExecution(executionId: string, reservationKey: string, code: string): Promise<void> {
    await this.dbc.transaction(async (tx) => {
      const result = await tx.execute(sql`select reserved_subscription_manna,status,output_sha256 from voice_executions where id=${executionId} for update`);
      const row = rows<{ reserved_subscription_manna: string | number; status: string; output_sha256: string | null }>(result)[0];
      if (!row || row.status === 'completed' || row.status === 'failed') return;
      const refund = shouldRefundVoiceFailure(row.status as VoiceExecutionDto['status']);
      if (refund) {
        await reverseReservation({ reservationKey, reservedSubscriptionManna: Number(row.reserved_subscription_manna), type: 'refund:voice', db: tx });
      }
      const terminalStatus = row.output_sha256 ? 'artifact_cleanup_pending' : 'failed';
      await tx.execute(sql`update voice_executions set status=${terminalStatus},last_error_code=${code},updated_at=statement_timestamp() where id=${executionId}`);
      await tx.execute(sql`update usage_events set status='error',error_code=${code},cost_usd=${refund ? null : sql`coalesce((select cost_usd from voice_executions where id=${executionId}),0)`},manna=${refund ? 0 : sql`manna`} where event_type='voice_generation' and turn_id=${executionId}`);
    });
  }

  private async cleanupFailedArtifact(executionId: string): Promise<void> {
    await this.dbc.transaction(async (tx) => {
      const result = await tx.execute(sql`
        select output_sha256,output_mime from voice_executions
        where id=${executionId} and status='artifact_cleanup_pending'
          and output_sha256 is not null and output_mime is not null for update
      `);
      const row = rows<{ output_sha256: string; output_mime: string }>(result)[0];
      if (!row) return;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('eden3-erasure-voice:sha:'||${row.output_sha256},0))`);
      const referenceResult = await tx.execute(sql`
        select
          exists(select 1 from voice_executions live where live.id<>${executionId}
            and live.output_sha256=${row.output_sha256}
            and live.status not in ('failed','artifact_cleanup_pending')) shared,
          (select min(id::text) from voice_executions queued where queued.output_sha256=${row.output_sha256}
            and queued.status='artifact_cleanup_pending') elected_id
      `);
      const reference = rows<{ shared: boolean; elected_id: string | null }>(referenceResult)[0];
      if (reference?.shared === false && reference.elected_id === executionId) {
        await this.options.cleanupArtifact(row.output_sha256, row.output_mime);
      }
      await tx.execute(sql`
        update voice_executions set status='failed',output_url=null,output_local_path=null,
          output_mime=null,output_size_bytes=null,output_duration_ms=null,waveform=null,
          updated_at=statement_timestamp()
        where id=${executionId} and status='artifact_cleanup_pending'
      `);
    });
  }

  /**
   * Remove crash-orphaned private voice files before admission and periodically.
   * Unknown filesystem state is deliberately fatal: this root is private and
   * should contain only LocalMediaStore canonical or crash-temp names.
   */
  async reconcileOrphanedOutputs(signal?: AbortSignal): Promise<number> {
    if (this.privateOutputScanFlight) return await this.privateOutputScanFlight;
    // Startup begins dirty, and every failed publication marks dirty. A clean
    // periodic tick must not enumerate a lifetime of retained private audio or
    // stall new publications behind an O(history) global scan.
    if (!this.privateOutputDirty) return 0;
    const flight = this.withPrivateOutputCustody(async () => await this.scanOrphanedOutputs(signal));
    this.privateOutputScanFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.privateOutputScanFlight === flight) this.privateOutputScanFlight = null;
    }
  }

  private async scanOrphanedOutputs(signal?: AbortSignal): Promise<number> {
    this.privateOutputDirty = true;
    const root = this.options.voiceOutputRoot;
    if (!root) {
      this.privateOutputDirty = false;
      return 0;
    }
    const canonicalRoot = await realpath(root);
    const entries = await readdir(canonicalRoot, { withFileTypes: true });
    const referenceResult = entries.length === 0
      ? []
      : await this.dbc.execute(sql`
          select output_local_path,output_sha256,output_mime from voice_executions
          where output_local_path is not null and status<>'failed'
        `);
    const references = new Map(rows<{
      output_local_path: string;
      output_sha256: string | null;
      output_mime: string | null;
    }>(referenceResult).map((reference) => [reference.output_local_path, reference]));
    let removed = 0;
    for (const entry of entries) {
      assertVoiceReconciliationActive(signal);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('private voice output root contains an unsupported filesystem entry');
      }
      const canonical = /^([0-9a-f]{64})\.(ogg|mp3)$/.exec(entry.name);
      const temporary = /^\.([0-9a-f]{64})\.(ogg|mp3)\.[0-9]+\.[0-9a-f-]{36}\.tmp$/.exec(entry.name);
      const match = canonical ?? temporary;
      if (!match) throw new Error('private voice output root contains an unknown file');
      const sha256 = match[1]!;
      const candidate = path.join(canonicalRoot, entry.name);
      const snapshottedReference = references.get(candidate);
      if (temporary && snapshottedReference) {
        throw new Error('voice execution references a crash-temp output path');
      }
      if (canonical && snapshottedReference) {
        const expectedMime = match[2] === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
        if (snapshottedReference.output_sha256 !== sha256 || snapshottedReference.output_mime !== expectedMime) {
          throw new Error('voice execution output metadata does not match its private file');
        }
        continue;
      }
      const didRemove = await this.dbc.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('eden3-erasure-voice:sha:'||${sha256},0))`);
        const references = temporary
          ? await tx.execute(sql`select exists(select 1 from voice_executions
              where output_local_path=${candidate} and status<>'failed') referenced`)
          : await tx.execute(sql`select exists(select 1 from voice_executions
              where output_local_path=${candidate} and output_sha256=${sha256}
                and output_mime=${match[2] === 'ogg' ? 'audio/ogg' : 'audio/mpeg'}
                and status<>'failed') referenced`);
        if (rows<{ referenced: boolean }>(references)[0]?.referenced) {
          if (temporary) throw new Error('voice execution references a crash-temp output path');
          return false;
        }
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          const stat = await handle.stat();
          const lexical = await lstat(candidate);
          if (!stat.isFile() || !lexical.isFile() || lexical.isSymbolicLink()) {
            throw new Error('private voice output orphan is not a regular file');
          }
          await unlink(candidate);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        } finally {
          await handle?.close().catch(() => undefined);
        }
      });
      if (didRemove) removed += 1;
    }
    this.privateOutputDirty = false;
    return removed;
  }

  /** Conservative crash recovery: indeterminate work is never replayed and never charged without output. */
  async reconcileStaleExecutions(
    cutoff = new Date(this.now().getTime() - 15 * 60_000),
    signal?: AbortSignal,
  ): Promise<number> {
    assertVoiceReconciliationActive(signal);
    const result = await this.dbc.execute(sql`
      select v.id,v.status,v.output_url,v.channel_turn_id,ct.status channel_status from voice_executions v
      left join channel_turns ct on ct.turn_id=v.channel_turn_id
      where v.status in ('provider_started','transcoding','refund_pending','artifact_cleanup_pending') and v.updated_at<${cutoff.toISOString()}
        and not exists (
          select 1 from direct_voice_jobs j where j.message_id=v.message_id
            and j.status in ('queued','generating','attachment_pending')
            and v.idempotency_key=('direct-voice:'||j.message_id::text||':generation:'||j.generation::text)
        )
      order by v.updated_at,v.id limit 100
    `);
    for (const row of rows<{ id: string; status: string; output_url: string | null; channel_turn_id: string | null; channel_status: string | null }>(result)) {
      assertVoiceReconciliationActive(signal);
      if (row.channel_turn_id && row.status === 'transcoding' && row.output_url) {
        if (row.channel_status === 'delivered') {
          await this.settleChannelVoiceDelivery(row.channel_turn_id);
          continue;
        }
        if (row.channel_status === 'refunded') {
          await this.refundChannelVoiceDelivery(row.channel_turn_id, 'channel_delivery_failed');
          continue;
        }
        // A delivery acknowledgement may still rescue a claimed compensation
        // until its ledger reversal commits. Never decide voice custody while
        // the channel turn is delivery-pending or refunding.
        if (row.channel_status === 'delivery_pending' || row.channel_status === 'refunding') continue;
      }
      await this.failExecution(row.id, `voice:${row.id}`, 'voice_execution_recovered_indeterminate');
      assertVoiceReconciliationActive(signal);
      await this.cleanupFailedArtifact(row.id);
    }
    return rows(result).length;
  }

  async assignment(ownerAccountId: string, username: string, value: Omit<VoiceAssignmentDto, 'updatedAt'>): Promise<VoiceAssignmentDto> {
    return await this.dbc.transaction(async (tx) => {
      await this.assertOwnerWritableTx(tx, ownerAccountId);
      const agentResult = await tx.execute(sql`select a.id from accounts a join agents g on g.account_id=a.id where a.username=${username} and g.owner_id=${ownerAccountId} and a.deleted=false for update of g`);
      const agent = rows<{ id: string }>(agentResult)[0];
      if (!agent) throw new VoiceKernelError(404, 'agent_not_found', 'Agent not found');
      await this.resolveAuthorizedVoiceTx(tx, ownerAccountId, value.voiceId, 'chat');
      const result = await tx.execute(sql`
        insert into agent_voice_assignments (agent_account_id,voice_id,chat_mode,discord_mode,telegram_mode)
        values (${agent.id},${value.voiceId},${value.delivery.chat},${value.delivery.discord},${value.delivery.telegram})
        on conflict (agent_account_id) do update set voice_id=excluded.voice_id,chat_mode=excluded.chat_mode,
          discord_mode=excluded.discord_mode,telegram_mode=excluded.telegram_mode,updated_at=statement_timestamp()
        returning voice_id,chat_mode,discord_mode,telegram_mode,updated_at
      `);
      const row = rows<{ voice_id: string; chat_mode: VoiceAssignmentDto['delivery']['chat']; discord_mode: VoiceAssignmentDto['delivery']['discord']; telegram_mode: VoiceAssignmentDto['delivery']['telegram']; updated_at: Date | string }>(result)[0]!;
      return { voiceId: row.voice_id, delivery: { chat: row.chat_mode, discord: row.discord_mode, telegram: row.telegram_mode }, updatedAt: iso(row.updated_at) };
    });
  }

  async deleteAssignment(ownerAccountId: string, username: string): Promise<void> {
    const result = await this.dbc.transaction(async (tx) => {
      await this.assertOwnerWritableTx(tx, ownerAccountId);
      return await tx.execute(sql`delete from agent_voice_assignments av using agents g,accounts a where av.agent_account_id=g.account_id and g.account_id=a.id and a.username=${username} and g.owner_id=${ownerAccountId} returning av.agent_account_id`);
    });
    if (rows(result).length === 0) throw new VoiceKernelError(404, 'voice_assignment_not_found', 'Voice assignment not found');
  }

  /** Insert `always` work inside the assistant-message terminal transaction. */
  async enqueueAutomaticDirectVoice(
    tx: DbHandle,
    input: { ownerAccountId: string; sessionId: string; messageId: string; agentAccountId: string; text: string },
  ): Promise<boolean> {
    let transcript: ReturnType<typeof exactTranscript>;
    try { transcript = exactTranscript(input.text, 'chat'); }
    catch (error) {
      if (error instanceof VoiceKernelError) return false;
      throw error;
    }
    const assignmentResult = await tx.execute(sql`
      select av.voice_id from agent_voice_assignments av join agents g on g.account_id=av.agent_account_id
      where av.agent_account_id=${input.agentAccountId} and av.chat_mode='always'
        and (g.owner_id=${input.ownerAccountId} or exists (
          select 1 from session_agents sa where sa.session_id=${input.sessionId} and sa.agent_account_id=${input.agentAccountId}
        ))
    `);
    const assignment = rows<{ voice_id: string }>(assignmentResult)[0];
    if (!assignment) return false;
    await tx.execute(sql`
      insert into direct_voice_jobs (message_id,owner_account_id,session_id,agent_account_id,voice_id,text_sha256,mode,status)
      values (${input.messageId},${input.ownerAccountId},${input.sessionId},${input.agentAccountId},${assignment.voice_id},${transcript.sha256},'always','queued')
      on conflict (message_id) do nothing
    `);
    return true;
  }

  private async loadDirectVoiceResult(tx: DbHandle, job: DirectVoiceJobRow): Promise<{ execution: VoiceExecutionDto; message: MessageDto }> {
    if (!job.execution_id) throw new VoiceKernelError(409, 'voice_execution_in_progress', 'Voice note is still being prepared');
    const executionResult = await tx.execute(sql`select * from voice_executions where id=${job.execution_id} and owner_account_id=${job.owner_account_id}`);
    const execution = rows<ExecutionRow>(executionResult)[0];
    const messageResult = await tx.execute(sql`
      select id,external_id,session_id,sender_id,role,content,attachments,tool_calls,reactions,reply_to_external_id,created_at
      from messages where id=${job.message_id} and session_id=${job.session_id}
    `);
    const message = rows<Record<string, unknown>>(messageResult)[0];
    if (!execution || !message) throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
    return { execution: executionDto(execution, true), message: directVoiceMessageDto(message) };
  }

  private async settleDirectVoiceAttachment(
    messageId: string,
    signal?: AbortSignal,
  ): Promise<{ execution: VoiceExecutionDto; message: MessageDto; refreshPending: boolean }> {
    assertVoiceReconciliationActive(signal);
    try {
      return await this.dbc.transaction(async (tx) => {
      const coordinateResult = await tx.execute(sql`
        select * from direct_voice_jobs where message_id=${messageId}
      `);
      const coordinate = rows<DirectVoiceJobRow>(coordinateResult)[0];
      if (!coordinate) throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
      await this.assertOwnerWritableTx(tx, coordinate.owner_account_id);
      const eligibleResult = await tx.execute(sql`
        select m.content,s.owner_id,g.owner_id agent_owner_id
        from messages m join sessions s on s.id=m.session_id
        join agents g on g.account_id=m.sender_id
        where m.id=${coordinate.message_id} and m.session_id=${coordinate.session_id} and m.role='assistant'
          and m.sender_id=${coordinate.agent_account_id} and s.deleted=false and s.visible is distinct from false
          and s.channel_connection_id is null
        for update of m,s,g
      `);
      const eligible = rows<{ content: string | null; owner_id: string | null; agent_owner_id: string }>(eligibleResult)[0];
      let currentTextSha256: string | null = null;
      try { if (eligible?.content) currentTextSha256 = exactTranscript(eligible.content, 'chat').sha256; }
      catch (error) { if (!(error instanceof VoiceKernelError)) throw error; }
      if (!eligible || currentTextSha256 !== coordinate.text_sha256) {
        throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
      }
      if (eligible.owner_id !== coordinate.owner_account_id) {
        const member = await tx.execute(sql`
          select 1 from session_users where session_id=${coordinate.session_id}
            and user_account_id=${coordinate.owner_account_id} for key share
        `);
        if (rows(member).length !== 1) {
          throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
        }
      }
      if (eligible.agent_owner_id !== coordinate.owner_account_id) {
        const boundAgent = await tx.execute(sql`
          select 1 from session_agents where session_id=${coordinate.session_id}
            and agent_account_id=${coordinate.agent_account_id} for key share
        `);
        if (rows(boundAgent).length !== 1) {
          throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
        }
      }
      await this.options.afterDirectVoiceEligibilityLocked?.();
      const jobResult = await tx.execute(sql`
        select * from direct_voice_jobs where message_id=${coordinate.message_id}
          and owner_account_id=${coordinate.owner_account_id} and session_id=${coordinate.session_id}
          and agent_account_id is not distinct from ${coordinate.agent_account_id}
          and text_sha256=${coordinate.text_sha256} for update
      `);
      assertVoiceReconciliationActive(signal);
      const job = rows<DirectVoiceJobRow>(jobResult)[0];
      if (!job) throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
      if (job.status === 'completed') return { ...(await this.loadDirectVoiceResult(tx, job)), refreshPending: job.refresh_state === 'pending' };
      if (job.status !== 'attachment_pending' || !job.execution_id) {
        throw new VoiceKernelError(409, 'voice_execution_in_progress', 'Voice note is still being prepared');
      }
      const executionResult = await tx.execute(sql`select * from voice_executions where id=${job.execution_id} and owner_account_id=${job.owner_account_id} for update`);
      assertVoiceReconciliationActive(signal);
      const execution = rows<ExecutionRow>(executionResult)[0];
      if (!execution || execution.status !== 'transcoding' || !execution.output_url || !execution.output_mime || !execution.output_duration_ms) {
        throw new Error('direct voice attachment lost playable output custody');
      }
      const attachment = [{
        url: execution.output_url,
        mime: execution.output_mime,
        durationMs: execution.output_duration_ms,
        voiceExecutionId: execution.id,
      }];
      const messageResult = await tx.execute(sql`
        update messages set attachments=(
          select coalesce(jsonb_agg(item order by ord) filter (
            where item->>'voiceExecutionId' is distinct from ${execution.id}
          ),'[]'::jsonb)
          from jsonb_array_elements(
            case when jsonb_typeof(attachments)='array' then attachments else '[]'::jsonb end
          ) with ordinality as existing(item,ord)
        )||${JSON.stringify(attachment)}::jsonb
        where id=${job.message_id} and session_id=${job.session_id} and role='assistant'
        returning id,external_id,session_id,sender_id,role,content,attachments,tool_calls,reactions,reply_to_external_id,created_at
      `);
      assertVoiceReconciliationActive(signal);
      const message = rows<Record<string, unknown>>(messageResult)[0];
      if (!message) throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
      const completedResult = await tx.execute(sql`
        update voice_executions set status='completed',completed_at=statement_timestamp(),updated_at=statement_timestamp(),last_error_code=null
        where id=${execution.id} and status='transcoding' returning *
      `);
      assertVoiceReconciliationActive(signal);
      const completed = rows<ExecutionRow>(completedResult)[0];
      if (!completed) throw new Error('direct voice settlement lost execution custody');
      const usageResult = await tx.execute(sql`
        update usage_events set status='completed',cost_usd=(select cost_usd from voice_executions where id=${execution.id}),
          metadata=coalesce(metadata,'{}'::jsonb)||${JSON.stringify({ directAttachmentCommitted: true })}::jsonb
        where event_type='voice_generation' and turn_id=${execution.id} and status='provider_admitted'
        returning id
      `);
      assertVoiceReconciliationActive(signal);
      if (rows(usageResult).length !== 1) throw new Error('direct voice settlement lost usage custody');
      const jobCompleted = await tx.execute(sql`
        update direct_voice_jobs set status='completed',refresh_state='pending',completed_at=statement_timestamp(),updated_at=statement_timestamp(),last_error_code=null
        where message_id=${job.message_id} and status='attachment_pending'
        returning message_id
      `);
      assertVoiceReconciliationActive(signal);
      if (rows(jobCompleted).length !== 1) throw new Error('direct voice settlement lost job custody');
        return { execution: executionDto(completed, false), message: directVoiceMessageDto(message), refreshPending: true };
      });
    } catch (error) {
      if (error instanceof VoiceKernelError && error.code === 'voice_message_not_eligible') {
        const jobResult = await this.dbc.execute(sql`select execution_id from direct_voice_jobs where message_id=${messageId}`);
        const executionId = rows<{ execution_id: string | null }>(jobResult)[0]?.execution_id;
        if (executionId) {
          await this.failExecution(executionId, `voice:${executionId}`, 'voice_message_not_eligible');
          await this.cleanupFailedArtifact(executionId);
        }
        await this.dbc.execute(sql`
          update direct_voice_jobs set status='failed',execution_id=null,last_error_code='voice_message_not_eligible',updated_at=statement_timestamp()
          where message_id=${messageId} and status='attachment_pending'
        `);
      }
      throw error;
    }
  }

  private async processDirectVoiceJob(
    messageId: string,
    signal?: AbortSignal,
  ): Promise<{ execution: VoiceExecutionDto; message: MessageDto; refreshPending: boolean }> {
    assertVoiceReconciliationActive(signal);
    const claim = await this.dbc.transaction(async (tx) => {
      assertVoiceReconciliationActive(signal);
      const result = await tx.execute(sql`select * from direct_voice_jobs where message_id=${messageId} for update`);
      const job = rows<DirectVoiceJobRow>(result)[0];
      if (!job) throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
      if (job.status === 'completed') return { result: { ...(await this.loadDirectVoiceResult(tx, job)), refreshPending: job.refresh_state === 'pending' }, job: null } as const;
      if (job.status === 'attachment_pending') return { result: null, job } as const;
      if (job.status !== 'queued') throw new VoiceKernelError(409, 'voice_execution_in_progress', 'Voice note is already being prepared');
      await tx.execute(sql`update direct_voice_jobs set status='generating',updated_at=statement_timestamp(),last_error_code=null where message_id=${messageId} and status='queued'`);
      const messageResult = await tx.execute(sql`select content from messages where id=${job.message_id} and session_id=${job.session_id} and role='assistant'`);
      const message = rows<{ content: string | null }>(messageResult)[0];
      let currentSha256: string | null = null;
      try { if (message?.content) currentSha256 = exactTranscript(message.content, 'chat').sha256; }
      catch (error) { if (!(error instanceof VoiceKernelError)) throw error; }
      if (!message?.content || currentSha256 !== job.text_sha256) {
        await tx.execute(sql`
          update direct_voice_jobs set status='failed',last_error_code='voice_message_changed',updated_at=statement_timestamp()
          where message_id=${messageId} and status='generating'
        `);
        return { result: null, job: null, invalid: true } as const;
      }
      return { result: null, job: { ...job, status: 'generating' as const }, text: message.content } as const;
    });
    assertVoiceReconciliationActive(signal);
    if (claim.result) return claim.result;
    if ('invalid' in claim && claim.invalid) {
      throw new VoiceKernelError(409, 'voice_message_changed', 'Assistant message changed before voice delivery');
    }
    if (!claim.job) throw new Error('direct voice claim missing');
    if (claim.job.status === 'attachment_pending') return await this.settleDirectVoiceAttachment(messageId, signal);
    const job = claim.job;
    const text = claim.text!;
    const stableKey = directVoiceExecutionKey(job.message_id, job.generation);
    try {
      const quote = await this.quote(job.owner_account_id, 'chat', job.voice_id, text);
      assertVoiceReconciliationActive(signal);
      const execution = await this.synthesize({
        ownerAccountId: job.owner_account_id,
        operation: 'chat',
        voiceId: job.voice_id,
        quoteId: quote.quoteId,
        text,
        idempotencyKey: stableKey,
        agentAccountId: job.agent_account_id ?? undefined,
        sessionId: job.session_id,
        messageId: job.message_id,
        deferSettlement: true,
        signal,
      });
      assertVoiceReconciliationActive(signal);
      const bound = await this.dbc.execute(sql`
        update direct_voice_jobs set status='attachment_pending',execution_id=${execution.id},updated_at=statement_timestamp()
        where message_id=${job.message_id} and status='generating' and generation=${job.generation}
        returning message_id
      `);
      if (rows(bound).length !== 1) {
        await this.failExecution(execution.id, `voice:${execution.id}`, 'voice_delivery_claim_lost');
        await this.cleanupFailedArtifact(execution.id);
        throw new VoiceKernelError(409, 'voice_execution_terminal', 'Voice delivery claim was lost and refunded');
      }
      return await this.settleDirectVoiceAttachment(job.message_id, signal);
    } catch (error) {
      const code = error instanceof VoiceKernelError ? error.code : 'voice_execution_failed';
      await this.dbc.execute(sql`
        update direct_voice_jobs set status='failed',last_error_code=${code},updated_at=statement_timestamp()
        where message_id=${job.message_id} and status='generating' and generation=${job.generation}
      `);
      throw error;
    }
  }

  async processAutomaticDirectVoice(messageId: string): Promise<{ execution: VoiceExecutionDto; message: MessageDto; refreshPending: boolean }> {
    return await this.processDirectVoiceJob(messageId);
  }

  async directVoiceNote(
    ownerAccountId: string,
    sessionId: string,
    messageId: string,
    _clientIdempotencyKey: string,
    requiredMode?: 'always',
  ): Promise<{ execution: VoiceExecutionDto; message: MessageDto; refreshPending: boolean }> {
    const disposition = await this.dbc.transaction(async (tx) => {
      const owner = await tx.execute(sql`
        select id from accounts where id=${ownerAccountId} and deleted=false for key share
      `);
      if (rows(owner).length !== 1) {
        throw new VoiceKernelError(409, 'account_erasure_active', 'Account deletion is in progress');
      }
      await tx.execute(sql`select account_erasure_assert_account_writable(${ownerAccountId})`);
      let result = await tx.execute(sql`select * from direct_voice_jobs where message_id=${messageId} for update`);
      let job = rows<DirectVoiceJobRow>(result)[0];
      if (job) {
        if (job.owner_account_id !== ownerAccountId || job.session_id !== sessionId || (requiredMode === 'always' && job.mode !== 'always')) {
          throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
        }
        if (job.status === 'completed') return { completed: await this.loadDirectVoiceResult(tx, job) } as const;
        if (job.status === 'failed') {
          result = await tx.execute(sql`
            update direct_voice_jobs set status='queued',generation=generation+1,execution_id=null,last_error_code=null,completed_at=null,updated_at=statement_timestamp()
            where message_id=${messageId} and status='failed' and generation<100 returning *
          `);
          job = rows<DirectVoiceJobRow>(result)[0];
          if (!job) throw new VoiceKernelError(409, 'voice_execution_terminal', 'Voice note retry limit reached');
        }
        return { completed: null } as const;
      }
      const eligibleResult = await tx.execute(sql`
        select m.content,m.sender_id agent_account_id,av.voice_id,av.chat_mode
        from messages m join sessions s on s.id=m.session_id join agents g on g.account_id=m.sender_id
        join agent_voice_assignments av on av.agent_account_id=m.sender_id and av.chat_mode in ('on_demand','always')
        where s.id=${sessionId} and m.id=${messageId} and m.role='assistant' and s.deleted=false
          and s.visible is distinct from false and s.channel_connection_id is null
          and (s.owner_id=${ownerAccountId} or exists (select 1 from session_users su where su.session_id=s.id and su.user_account_id=${ownerAccountId}))
          and (g.owner_id=${ownerAccountId} or exists (select 1 from session_agents sa where sa.session_id=s.id and sa.agent_account_id=g.account_id))
          and (${requiredMode ?? null}::text is null or av.chat_mode=${requiredMode ?? null})
      `);
      const eligible = rows<{ content: string | null; agent_account_id: string; voice_id: string; chat_mode: 'on_demand' | 'always' }>(eligibleResult)[0];
      if (!eligible?.content) throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
      const transcript = exactTranscript(eligible.content, 'chat');
      await this.resolveAuthorizedVoiceTx(tx, ownerAccountId, eligible.voice_id, 'chat');
      const insertedJob = await tx.execute(sql`
        insert into direct_voice_jobs (message_id,owner_account_id,session_id,agent_account_id,voice_id,text_sha256,mode,status)
        values (${messageId},${ownerAccountId},${sessionId},${eligible.agent_account_id},${eligible.voice_id},${transcript.sha256},${eligible.chat_mode},'queued')
        on conflict (message_id) do nothing returning *
      `);
      if (rows(insertedJob).length === 0) {
        result = await tx.execute(sql`select * from direct_voice_jobs where message_id=${messageId} for update`);
        job = rows<DirectVoiceJobRow>(result)[0];
        if (!job || job.owner_account_id !== ownerAccountId || job.session_id !== sessionId ||
            (requiredMode === 'always' && job.mode !== 'always')) {
          throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
        }
        if (job.status === 'completed') return { completed: await this.loadDirectVoiceResult(tx, job) } as const;
      }
      return { completed: null } as const;
    });
    if (disposition.completed) {
      const state = await this.dbc.execute(sql`select refresh_state from direct_voice_jobs where message_id=${messageId}`);
      return { ...disposition.completed, refreshPending: rows<{ refresh_state: string }>(state)[0]?.refresh_state === 'pending' };
    }
    return await this.processDirectVoiceJob(messageId);
  }

  /** A refresh event is acknowledged only after its idempotent refetch signal was published. */
  async markDirectVoiceRefreshPublished(messageId: string): Promise<boolean> {
    const result = await this.dbc.execute(sql`
      update direct_voice_jobs set refresh_state='published',updated_at=statement_timestamp()
      where message_id=${messageId} and status='completed' and refresh_state='pending'
      returning message_id
    `);
    return rows(result).length === 1;
  }

  /** Durable outbox recovery; safe to run repeatedly and across processes. */
  async reconcileDirectVoiceJobs(
    cutoff = new Date(this.now().getTime() - 15 * 60_000),
    signal?: AbortSignal,
  ): Promise<{ processed: number; settled: Array<{ sessionId: string; messageId: string }> }> {
    assertVoiceReconciliationActive(signal);
    const result = await this.dbc.execute(sql`
      select message_id,session_id,status,generation,execution_id,refresh_state from direct_voice_jobs
      where status in ('queued','attachment_pending') or (status='generating' and updated_at<${cutoff.toISOString()})
        or (status='completed' and refresh_state='pending')
      order by updated_at,message_id limit 100
    `);
    const settled: Array<{ sessionId: string; messageId: string }> = [];
    for (const pending of rows<Pick<DirectVoiceJobRow, 'message_id' | 'session_id' | 'status' | 'generation' | 'execution_id' | 'refresh_state'>>(result)) {
      assertVoiceReconciliationActive(signal);
      try {
        if (pending.status === 'completed' && pending.refresh_state === 'pending') {
          settled.push({ sessionId: pending.session_id, messageId: pending.message_id });
          continue;
        }
        if (pending.status === 'attachment_pending' && pending.execution_id) {
          const terminalResult = await this.dbc.execute(sql`select status from voice_executions where id=${pending.execution_id}`);
          const terminal = rows<{ status: string }>(terminalResult)[0];
          if (!terminal || terminal.status === 'failed' || terminal.status === 'artifact_cleanup_pending') {
            if (terminal?.status === 'artifact_cleanup_pending') await this.cleanupFailedArtifact(pending.execution_id);
            await this.dbc.execute(sql`update direct_voice_jobs set status='failed',execution_id=null,last_error_code='voice_execution_recovered_indeterminate',updated_at=statement_timestamp() where message_id=${pending.message_id} and status='attachment_pending'`);
            continue;
          }
        }
        if (pending.status === 'generating') {
          const stableKey = directVoiceExecutionKey(pending.message_id, pending.generation);
          const executionResult = await this.dbc.execute(sql`
            select id,status,output_url from voice_executions where purpose='chat' and message_id=${pending.message_id} and idempotency_key=${stableKey}
          `);
          const execution = rows<{ id: string; status: string; output_url: string | null }>(executionResult)[0];
          if (execution?.status === 'transcoding' && execution.output_url) {
            await this.dbc.execute(sql`update direct_voice_jobs set status='attachment_pending',execution_id=${execution.id},updated_at=statement_timestamp() where message_id=${pending.message_id} and status='generating'`);
          } else if (execution?.status === 'failed' || execution?.status === 'artifact_cleanup_pending') {
            await this.cleanupFailedArtifact(execution.id);
            await this.dbc.execute(sql`update direct_voice_jobs set status='failed',execution_id=null,last_error_code='voice_execution_recovered_indeterminate',updated_at=statement_timestamp() where message_id=${pending.message_id} and status in ('generating','attachment_pending')`);
            continue;
          } else if (execution) {
            await this.failExecution(execution.id, `voice:${execution.id}`, 'voice_execution_recovered_indeterminate');
            await this.cleanupFailedArtifact(execution.id);
            await this.dbc.execute(sql`update direct_voice_jobs set status='failed',last_error_code='voice_execution_recovered_indeterminate',updated_at=statement_timestamp() where message_id=${pending.message_id} and status='generating'`);
            continue;
          } else {
            await this.dbc.execute(sql`update direct_voice_jobs set status='queued',updated_at=statement_timestamp() where message_id=${pending.message_id} and status='generating'`);
          }
        }
        const recovered = await this.processDirectVoiceJob(pending.message_id, signal);
        if (recovered.refreshPending) {
          settled.push({ sessionId: recovered.message.sessionId, messageId: recovered.message.id });
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        // A failed job carries its durable error; another healthy job must continue.
      }
    }
    return { processed: rows(result).length, settled };
  }

  async channelVoiceNote(input: { turnId: string; text: string; idempotencyKey: string; connectionId: string; bindingId?: string }): Promise<VoiceExecutionDto & { waveform: string | null }> {
    const result = await this.dbc.execute(sql`
      select ct.account_id,ct.agent_id,ct.session_id,ct.channel,cc.metadata,av.voice_id,
        case ct.channel when 'discord' then av.discord_mode when 'telegram' then av.telegram_mode else 'off' end voice_mode
      from channel_turns ct join channel_connections cc on cc.id=ct.connection_id
      join agent_voice_assignments av on av.agent_account_id=ct.agent_id
      where ct.turn_id=${input.turnId} and ct.connection_id=${input.connectionId}
        and ct.status in ('settled','delivery_pending') and cc.desired_state='active' and cc.status='connected'
        and (cc.metadata->>'_runtimeBindingId') is not distinct from ${input.bindingId ?? null}
    `);
    const row = rows<{ account_id: string; agent_id: string; session_id: string | null; channel: 'discord' | 'telegram'; voice_id: string; voice_mode: string }>(result)[0];
    if (!row || row.voice_mode !== 'always') throw new VoiceKernelError(409, 'channel_voice_not_enabled', 'Channel voice is not enabled');
    const transcript = exactTranscript(input.text, row.channel);
    const priorResult = await this.dbc.execute(sql`
      select * from voice_executions where channel_turn_id=${input.turnId} and owner_account_id=${row.account_id}
    `);
    const prior = rows<ExecutionRow>(priorResult)[0];
    if (prior) {
      if (prior.idempotency_key !== input.idempotencyKey || prior.text_sha256 !== transcript.sha256) {
        throw new VoiceKernelError(409, 'idempotency_conflict', 'Channel voice retry did not match the durable execution');
      }
      if ((prior.status === 'transcoding' || prior.status === 'completed') && prior.output_url && prior.output_mime && prior.output_duration_ms) {
        const waveformResult = await this.dbc.execute(sql`select waveform from voice_executions where id=${prior.id}`);
        return { ...executionDto(prior, true), waveform: rows<{ waveform: string | null }>(waveformResult)[0]?.waveform ?? null };
      }
      throw new VoiceKernelError(409, prior.status === 'failed' ? 'voice_execution_terminal' : 'voice_execution_in_progress', 'Channel voice execution is not deliverable');
    }
    const quote = await this.quote(row.account_id, row.channel, row.voice_id, input.text);
    const execution = await this.synthesize({ ownerAccountId: row.account_id, operation: row.channel, voiceId: row.voice_id, quoteId: quote.quoteId, text: input.text, idempotencyKey: input.idempotencyKey, agentAccountId: row.agent_id, sessionId: row.session_id ?? undefined, channelTurnId: input.turnId, deferSettlement: true });
    const waveformResult = await this.dbc.execute(sql`select waveform from voice_executions where id=${execution.id}`);
    return { ...execution, waveform: rows<{ waveform: string | null }>(waveformResult)[0]?.waveform ?? null };
  }

  private async readVerifiedVoiceOutput(row: ExecutionRow): Promise<VoiceOutputBytes> {
    const root = this.options.voiceOutputRoot;
    if (!root || !row.output_local_path || !row.output_sha256 || !row.output_mime || row.output_size_bytes === null) {
      throw new VoiceKernelError(404, 'voice_output_not_found', 'Voice output not found');
    }
    const sizeBytes = Number(row.output_size_bytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 8 * 1024 * 1024 ||
        !/^[0-9a-f]{64}$/.test(row.output_sha256) || !['audio/ogg', 'audio/mpeg'].includes(row.output_mime)) {
      throw new VoiceKernelError(404, 'voice_output_not_found', 'Voice output not found');
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const canonicalRoot = await realpath(root);
      const exactFile = path.resolve(row.output_local_path);
      if (path.dirname(exactFile) !== canonicalRoot) {
        throw new Error('voice output metadata mismatch');
      }
      handle = await open(exactFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== sizeBytes) throw new Error('voice output metadata mismatch');
      const bytes = await handle.readFile();
      if (bytes.length !== sizeBytes || createHash('sha256').update(bytes).digest('hex') !== row.output_sha256) {
        throw new Error('voice output digest mismatch');
      }
      return { bytes, mime: row.output_mime, sizeBytes, sha256: row.output_sha256 };
    } catch {
      throw new VoiceKernelError(404, 'voice_output_not_found', 'Voice output not found');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Browser voice is private: preview owner or an exact readable chat attachment. */
  async ownerVoiceOutput(viewerAccountId: string, executionId: string): Promise<VoiceOutputBytes> {
    const result = await this.dbc.execute(sql`
      select v.* from voice_executions v
      left join sessions s on s.id=v.session_id
      left join messages m on m.id=v.message_id and m.session_id=v.session_id
      where v.id=${executionId} and v.status='completed' and v.purpose in ('preview','chat')
        and not exists (
          select 1 from account_erasure_jobs e where e.state<>'succeeded' and (
            e.account_id=v.owner_account_id or exists (
              select 1 from agents a where a.account_id=v.agent_account_id and a.owner_id=e.account_id
            )
          )
        )
        and (
          (v.purpose='preview' and v.owner_account_id=${viewerAccountId})
          or (
            v.purpose='chat' and s.deleted=false and s.visible is distinct from false
            and m.role='assistant' and m.sender_id=v.agent_account_id
            and (s.owner_id=${viewerAccountId} or exists (
              select 1 from session_users su where su.session_id=s.id and su.user_account_id=${viewerAccountId}
            ))
            and exists (
              select 1 from jsonb_array_elements(
                case when jsonb_typeof(m.attachments)='array' then m.attachments else '[]'::jsonb end
              ) item
              where item->>'voiceExecutionId'=v.id::text and item->>'url'=v.output_url
            )
          )
        )
    `);
    const row = rows<ExecutionRow>(result)[0];
    if (!row) throw new VoiceKernelError(404, 'voice_output_not_found', 'Voice output not found');
    return await this.readVerifiedVoiceOutput(row);
  }

  /** Docker-private capability resolution; the route verifies the HMAC first. */
  async channelVoiceOutput(turnId: string, executionId: string, operationId: string): Promise<VoiceOutputBytes> {
    const result = await this.dbc.execute(sql`
      select v.* from voice_executions v
      join channel_turns ct on ct.turn_id=v.channel_turn_id
      join channel_connections cc on cc.id=ct.connection_id
      where v.id=${executionId} and v.channel_turn_id=${turnId}
        and v.idempotency_key=${`channel:${operationId}`}
        and v.purpose in ('discord','telegram') and v.status in ('transcoding','completed')
        and ct.status='delivery_pending'
        and cc.desired_state='active' and cc.status='connected'
        and not exists (
          select 1 from account_erasure_jobs e where e.state<>'succeeded' and (
            e.account_id=v.owner_account_id or exists (
              select 1 from agents a where a.account_id=v.agent_account_id and a.owner_id=e.account_id
            )
          )
        )
    `);
    const row = rows<ExecutionRow>(result)[0];
    if (!row) throw new VoiceKernelError(404, 'voice_output_not_found', 'Voice output not found');
    return await this.readVerifiedVoiceOutput(row);
  }

  /** Charge channel voice only after the native provider has acknowledged delivery. */
  async settleChannelVoiceDelivery(turnId: string): Promise<boolean> {
    return await this.dbc.transaction(async (tx) => {
      const result = await tx.execute(sql`
        select v.* from voice_executions v join channel_turns ct on ct.turn_id=v.channel_turn_id
        where v.channel_turn_id=${turnId} and ct.status='delivered' for update of v
      `);
      const execution = rows<ExecutionRow>(result)[0];
      if (!execution) return false;
      if (execution.status === 'completed') return false;
      if (execution.status !== 'transcoding' || !execution.output_url || !execution.output_mime || !execution.output_duration_ms) {
        throw new VoiceKernelError(409, 'voice_execution_in_progress', 'Channel voice output is not ready for settlement');
      }
      const completedResult = await tx.execute(sql`
        update voice_executions set status='completed',completed_at=statement_timestamp(),updated_at=statement_timestamp(),last_error_code=null
        where id=${execution.id} and status='transcoding' returning id
      `);
      if (rows(completedResult).length !== 1) throw new Error('channel voice settlement lost execution custody');
      const usageResult = await tx.execute(sql`
        update usage_events set status='completed',cost_usd=(select cost_usd from voice_executions where id=${execution.id}),
          metadata=coalesce(metadata,'{}'::jsonb)||${JSON.stringify({ channelDeliveryCommitted: true })}::jsonb
        where event_type='voice_generation' and turn_id=${execution.id} and status='provider_admitted' returning id
      `);
      if (rows(usageResult).length !== 1) throw new Error('channel voice settlement lost usage custody');
      return true;
    });
  }

  /** Reverse and remove an undelivered channel artifact exactly once. */
  async refundChannelVoiceDelivery(turnId: string, code = 'channel_delivery_failed'): Promise<boolean> {
    // Symmetric with settlement: the authoritative channel terminal state is
    // revalidated under the execution row lock. A caller cannot refund voice
    // merely by winning an HTTP race against a native delivery acknowledgement.
    const result = await this.dbc.transaction(async (tx) => await tx.execute(sql`
      select v.id,v.status from voice_executions v join channel_turns ct on ct.turn_id=v.channel_turn_id
      where v.channel_turn_id=${turnId} and ct.status='refunded' for update of v
    `));
    const execution = rows<{ id: string; status: VoiceExecutionDto['status'] }>(result)[0];
    if (!execution || execution.status === 'completed' || execution.status === 'failed') return false;
    await this.failExecution(execution.id, `voice:${execution.id}`, code);
    await this.cleanupFailedArtifact(execution.id);
    return true;
  }

  async createClone(input: { ownerAccountId: string; name: string; clipObjectIds: string[]; consentVersion: string; consentAttested: true; idempotencyKey: string }): Promise<VoiceCloneDto> {
    if (!input.consentAttested || input.consentVersion !== 'voice-clone-consent-v1') throw new VoiceKernelError(422, 'voice_consent_required', 'Current voice consent is required');
    if (input.clipObjectIds.length < 1 || input.clipObjectIds.length > 5 || new Set(input.clipObjectIds).size !== input.clipObjectIds.length) {
      throw new VoiceKernelError(422, 'voice_clip_not_ready', 'Choose between one and five distinct voice clips');
    }
    // Resolve durable replay before touching mutable clip/object/provider
    // custody. A lost successful response must remain replayable after its
    // source clips are quarantined or removed.
    const priorClone = await this.dbc.transaction(async (tx) => {
      const owner = await tx.execute(sql`
        select id from accounts where id=${input.ownerAccountId} and deleted=false for key share
      `);
      if (rows(owner).length !== 1) {
        throw new VoiceKernelError(409, 'account_erasure_active', 'Account deletion is in progress');
      }
      await tx.execute(sql`select account_erasure_assert_account_writable(${input.ownerAccountId})`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
        'eden3-voice-clone:'||${input.ownerAccountId}::text||':'||${input.idempotencyKey},0))`);
      const priorResult = await tx.execute(sql`
        select * from voice_clones where owner_account_id=${input.ownerAccountId}
          and idempotency_key=${input.idempotencyKey} for update
      `);
      const prior = rows<Record<string, unknown>>(priorResult)[0];
      if (!prior) return null;
      const clipResult = await tx.execute(sql`
        select object_id from voice_clone_clips where clone_id=${String(prior.id)} order by position
      `);
      const priorObjectIds = rows<{ object_id: string }>(clipResult).map((row) => row.object_id);
      if (prior.name !== input.name || prior.provider !== 'cartesia' ||
          prior.consent_version !== input.consentVersion ||
          priorObjectIds.length !== input.clipObjectIds.length ||
          priorObjectIds.some((id, index) => id !== input.clipObjectIds[index])) {
        throw new VoiceKernelError(409, 'idempotency_conflict', 'Idempotency key was used for another clone');
      }
      return cloneDto(prior);
    });
    if (priorClone) return priorClone;
    if (!this.options.mediaResolver) throw new VoiceKernelError(503, 'voice_storage_unavailable', 'Voice clip storage is unavailable');
    const metaResult = await this.dbc.execute(sql`
      select id object_id,verified_mime mime,verified_size_bytes size_bytes,verified_sha256 sha256
      from storage_objects where id in (${sql.join(input.clipObjectIds.map((id) => sql`${id}`), sql`, `)}) and owner_account_id=${input.ownerAccountId}
        and purpose='voice-clip' and state='available' and verified_mime in ('audio/wav','audio/mpeg')
        and verified_size_bytes between 1 and 20971520 and verified_sha256 ~ '^[0-9a-f]{64}$'
    `);
    const byId = new Map(rows<ClipMeta>(metaResult).map((meta) => [meta.object_id, meta]));
    const metas = input.clipObjectIds.map((id) => byId.get(id)).filter((meta): meta is ClipMeta => Boolean(meta));
    if (metas.length !== input.clipObjectIds.length || metas.reduce((total, meta) => total + Number(meta.size_bytes), 0) > 40 * 1024 * 1024) {
      throw new VoiceKernelError(422, 'voice_clip_not_ready', 'Voice clips must be owned verified voice-clip WAV or MP3 objects under the aggregate limit');
    }
    const hydratedClips: Array<{ meta: ClipMeta; bytes: Buffer; durationMs: number }> = [];
    for (const meta of metas) {
      const resolved = await this.options.mediaResolver.resolve(meta.object_id, input.ownerAccountId);
      const hydrated = await this.options.mediaResolver.hydrator.hydrate(resolved.storedObject);
      let bytes: Buffer;
      try { bytes = await readFile(hydrated.localPath); } finally { await hydrated.release(); }
      if (bytes.length !== Number(meta.size_bytes) || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) {
        throw new VoiceKernelError(409, 'voice_clip_hash_mismatch', 'Voice clip hash did not match verified storage');
      }
      try {
        hydratedClips.push({ meta, bytes, durationMs: (await this.options.audio.inspectClip(bytes, meta.mime)).durationMs });
      } catch (error) {
        await this.dbc.execute(sql`update storage_objects set state='quarantined',quarantine_reason='voice_clip_decode_invalid',updated_at=statement_timestamp() where id=${meta.object_id} and owner_account_id=${input.ownerAccountId} and state='available'`);
        throw error instanceof VoiceAudioError
          ? new VoiceKernelError(422, 'voice_clip_duration_invalid', 'Voice clip failed decoded validation')
          : error;
      }
    }
    const totalDurationMs = hydratedClips.reduce((total, clip) => total + clip.durationMs, 0);
    if (totalDurationMs < 5_000 || totalDurationMs > 30_000) {
      throw new VoiceKernelError(422, 'voice_clip_duration_invalid', 'Voice clips must total between 5 and 30 seconds');
    }
    const combined = await this.options.audio.combineCloneClips(hydratedClips.map(({ bytes, meta }) => ({ bytes, mime: meta.mime })));
    const manifestItems = hydratedClips.map(({ meta, durationMs }) => ({
      objectId: meta.object_id, sha256: meta.sha256, mime: meta.mime, sizeBytes: Number(meta.size_bytes), durationMs,
    }));
    const manifest = requestHash(manifestItems);
    const requestSha256 = requestHash({ name: input.name, manifest, consentVersion: input.consentVersion, provider: 'cartesia' });
    const clone = await this.dbc.transaction(async (tx) => {
      const owner = await tx.execute(sql`
        select id from accounts where id=${input.ownerAccountId} and deleted=false for key share
      `);
      if (rows(owner).length !== 1) {
        throw new VoiceKernelError(409, 'account_erasure_active', 'Account deletion is in progress');
      }
      await tx.execute(sql`select account_erasure_assert_account_writable(${input.ownerAccountId})`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
        'eden3-voice-clone:'||${input.ownerAccountId}::text||':'||${input.idempotencyKey},0))`);
      const priorResult = await tx.execute(sql`select * from voice_clones where owner_account_id=${input.ownerAccountId} and idempotency_key=${input.idempotencyKey} for update`);
      const prior = rows<Record<string, unknown>>(priorResult)[0];
      if (prior) {
        if (prior.request_sha256 !== requestSha256) throw new VoiceKernelError(409, 'idempotency_conflict', 'Idempotency key was used for another clone');
        return { row: prior, replay: true };
      }
      const lockedResult = await tx.execute(sql`select id,verified_sha256,state from storage_objects where id in (${sql.join(input.clipObjectIds.map((id) => sql`${id}`), sql`, `)}) and owner_account_id=${input.ownerAccountId} and purpose='voice-clip' order by id for update`);
      const locked = new Map(rows<{ id: string; verified_sha256: string | null; state: string }>(lockedResult).map((row) => [row.id, row]));
      if (metas.some((meta) => locked.get(meta.object_id)?.state !== 'available' || locked.get(meta.object_id)?.verified_sha256 !== meta.sha256)) {
        throw new VoiceKernelError(409, 'voice_clip_hash_mismatch', 'Voice clip changed before clone admission');
      }
      const id = randomUUID();
      const inserted = await tx.execute(sql`
        insert into voice_clones (id,owner_account_id,name,provider,status,consent_version,consent_attested_at,clip_manifest_sha256,request_sha256,idempotency_key)
        values (${id},${input.ownerAccountId},${input.name},'cartesia','cloning',${input.consentVersion},statement_timestamp(),${manifest},${requestSha256},${input.idempotencyKey}) returning *
      `);
      for (const [position, item] of manifestItems.entries()) {
        await tx.execute(sql`insert into voice_clone_clips (clone_id,object_id,position,sha256,mime,size_bytes,duration_ms) values (${id},${item.objectId},${position},${item.sha256},${item.mime},${item.sizeBytes},${item.durationMs})`);
      }
      return { row: rows<Record<string, unknown>>(inserted)[0]!, replay: false };
    });
    if (clone.replay) return cloneDto(clone.row);
    const provider = this.options.providers.cartesia;
    if (!provider?.clone) {
      await this.dbc.execute(sql`update voice_clones set status='failed',failure_code='voice_provider_unavailable',updated_at=statement_timestamp() where id=${String(clone.row.id)} and status='cloning'`);
      throw new VoiceKernelError(503, 'voice_provider_unavailable', 'Clone provider is unavailable');
    }
    try {
      // The provider-facing marker is immutable, globally unique, and not the
      // mutable user display name. It is the only safe locator after a POST
      // response is lost and Cartesia may already have created the clone.
      const result = await provider.clone({
        name: providerCloneName(String(clone.row.id)),
        clip: combined.bytes,
        mime: combined.mime,
      });
      const updated = await this.dbc.transaction(async (tx) => {
        const current = await tx.execute(sql`select status from voice_clones where id=${String(clone.row.id)} and owner_account_id=${input.ownerAccountId} for update`);
        const status = rows<{ status: string }>(current)[0]?.status;
        if (status !== 'cloning' || result.requiresVerification || result.access !== 'private' || result.visibility !== 'owner') {
          await tx.execute(sql`update voice_clones set status='provider_delete_pending',provider_voice_id=${result.providerVoiceId},provider_request_id=${result.requestId},revoked_at=coalesce(revoked_at,statement_timestamp()),failure_code='clone_privacy_invalid',updated_at=statement_timestamp() where id=${String(clone.row.id)}`);
          return null;
        }
        const done = await tx.execute(sql`update voice_clones set status='ready',provider_voice_id=${result.providerVoiceId},provider_request_id=${result.requestId},updated_at=statement_timestamp() where id=${String(clone.row.id)} and status='cloning' returning *`);
        return rows<Record<string, unknown>>(done)[0] ?? null;
      });
      if (!updated) {
        try {
          await provider.deleteClone?.(result.providerVoiceId);
          await this.dbc.execute(sql`update voice_clones set status='deleted',provider_deleted_at=statement_timestamp(),deleted_at=statement_timestamp(),failure_code=null,updated_at=statement_timestamp() where id=${String(clone.row.id)} and status='provider_delete_pending'`);
        } catch {
          await this.dbc.execute(sql`update voice_clones set status='provider_delete_failed',failure_code='provider_delete_failed',updated_at=statement_timestamp() where id=${String(clone.row.id)} and status='provider_delete_pending'`);
        }
        throw new VoiceKernelError(409, 'clone_revoked_during_creation', 'Clone was revoked during creation');
      }
      return cloneDto(updated);
    } catch (error) {
      if (error instanceof VoiceKernelError) throw error;
      if (error instanceof VoiceProviderError && error.providerVoiceId) {
        await this.dbc.execute(sql`update voice_clones set status='provider_delete_pending',provider_voice_id=${error.providerVoiceId},revoked_at=statement_timestamp(),failure_code='clone_privacy_invalid',updated_at=statement_timestamp() where id=${String(clone.row.id)} and status='cloning'`);
        try {
          await provider.deleteClone?.(error.providerVoiceId);
          await this.dbc.execute(sql`update voice_clones set status='deleted',provider_deleted_at=statement_timestamp(),deleted_at=statement_timestamp(),failure_code=null,updated_at=statement_timestamp() where id=${String(clone.row.id)} and status='provider_delete_pending'`);
        } catch {
          await this.dbc.execute(sql`update voice_clones set status='provider_delete_failed',failure_code='provider_delete_failed',updated_at=statement_timestamp() where id=${String(clone.row.id)} and status='provider_delete_pending'`);
        }
        throw new VoiceKernelError(502, 'clone_privacy_invalid', 'Clone provider returned non-private visibility');
      }
      const ambiguous = error instanceof VoiceProviderError && error.mayHaveReachedProvider;
      await this.dbc.execute(sql`update voice_clones set status=${ambiguous ? 'provider_create_ambiguous' : 'failed'},failure_code=${ambiguous ? 'provider_create_ambiguous' : 'provider_rejected'},updated_at=statement_timestamp() where id=${String(clone.row.id)} and status='cloning'`);
      throw new VoiceKernelError(502, ambiguous ? 'clone_provider_result_indeterminate' : 'clone_provider_failed', 'Voice clone provider failed');
    }
  }

  async cloneQuote(ownerAccountId: string, clipObjectIds: string[]) {
    if (clipObjectIds.length < 1 || clipObjectIds.length > 5 || new Set(clipObjectIds).size !== clipObjectIds.length) {
      throw new VoiceKernelError(422, 'voice_clip_not_ready', 'Choose between one and five distinct voice clips');
    }
    const result = await this.dbc.execute(sql`
      select id,verified_mime,verified_size_bytes from storage_objects
      where id in (${sql.join(clipObjectIds.map((id) => sql`${id}`), sql`, `)}) and owner_account_id=${ownerAccountId}
        and purpose='voice-clip' and state='available'
        and verified_mime in ('audio/wav','audio/mpeg')
        and verified_size_bytes between 1 and 20971520
        and verified_sha256 ~ '^[0-9a-f]{64}$'
        and not exists (select 1 from account_erasure_jobs j
          where j.account_id=${ownerAccountId} and j.state<>'succeeded')
    `);
    const clips = rows<{ id: string; verified_size_bytes: string | number }>(result);
    if (clips.length !== clipObjectIds.length || clips.reduce((sum, clip) => sum + Number(clip.verified_size_bytes), 0) > 40 * 1024 * 1024) {
      throw new VoiceKernelError(422, 'voice_clip_not_ready', 'Voice clips must be owned verified voice-clip WAV or MP3 objects under the aggregate limit');
    }
    return {
      provider: 'cartesia' as const,
      kind: 'instant' as const,
      costUsd: 0,
      manna: 0,
      expiresAt: new Date(this.now().getTime() + 5 * 60_000).toISOString(),
    };
  }

  async listClones(ownerAccountId: string): Promise<VoiceCloneDto[]> {
    const result = await this.dbc.execute(sql`select * from voice_clones where owner_account_id=${ownerAccountId} order by created_at desc`);
    return rows<Record<string, unknown>>(result).map(cloneDto);
  }

  async getClone(ownerAccountId: string, id: string): Promise<VoiceCloneDto> {
    const result = await this.dbc.execute(sql`select * from voice_clones where id=${id} and owner_account_id=${ownerAccountId}`);
    const row = rows<Record<string, unknown>>(result)[0];
    if (!row) throw new VoiceKernelError(404, 'voice_clone_not_found', 'Voice clone not found');
    return cloneDto(row);
  }

  async revokeClone(ownerAccountId: string, id: string): Promise<VoiceCloneDto> {
    const result = await this.dbc.transaction(async (tx) => {
      await this.assertOwnerWritableTx(tx, ownerAccountId);
      const currentResult = await tx.execute(sql`select * from voice_clones where id=${id} and owner_account_id=${ownerAccountId} for update`);
      const current = rows<Record<string, unknown>>(currentResult)[0];
      if (!current) throw new VoiceKernelError(404, 'voice_clone_not_found', 'Voice clone not found');
      await tx.execute(sql`delete from agent_voice_assignments where voice_id=${String(current.voice_id)}`);
      if (current.status === 'provider_create_ambiguous') {
        const revoked = await tx.execute(sql`update voice_clones set consent_revoked_at=coalesce(consent_revoked_at,statement_timestamp()),updated_at=statement_timestamp() where id=${id} returning *`);
        return rows<Record<string, unknown>>(revoked)[0]!;
      }
      if (['revoked', 'provider_delete_pending', 'provider_delete_failed', 'deleted'].includes(String(current.status))) {
        return current;
      }
      const updated = await tx.execute(sql`
        update voice_clones set status=case when provider_voice_id is null then 'revoked' else 'provider_delete_pending' end,
          consent_revoked_at=coalesce(consent_revoked_at,statement_timestamp()),
          revoked_at=coalesce(revoked_at,statement_timestamp()),updated_at=statement_timestamp()
        where id=${id} returning *
      `);
      return rows<Record<string, unknown>>(updated)[0]!;
    });
    return cloneDto(result);
  }

  private async reconcileAmbiguousClone(
    ownerAccountId: string,
    id: string,
    finalizeConfirmedAbsence: boolean,
    signal?: AbortSignal,
  ): Promise<'resolved' | 'pending'> {
    assertVoiceReconciliationActive(signal);
    const currentResult = await this.dbc.execute(sql`
      select id,status,provider_request_id from voice_clones
      where id=${id} and owner_account_id=${ownerAccountId}
    `);
    const current = rows<{ id: string; status: string; provider_request_id: string | null }>(currentResult)[0];
    if (!current || current.status !== 'provider_create_ambiguous') return 'resolved';
    const provider = this.options.providers.cartesia;
    if (!provider?.findOwnedCloneByName) return 'pending';
    const found = await provider.findOwnedCloneByName(providerCloneName(id), signal);
    assertVoiceReconciliationActive(signal);
    if (found) {
      await this.dbc.transaction(async (tx) => {
        await this.assertOwnerWritableTx(tx, ownerAccountId);
        await tx.execute(sql`
          update voice_clones set status='provider_delete_pending',provider_voice_id=${found.providerVoiceId},
            consent_revoked_at=coalesce(consent_revoked_at,statement_timestamp()),
            revoked_at=coalesce(revoked_at,statement_timestamp()),failure_code='provider_create_reconciled',
            updated_at=statement_timestamp()
          where id=${id} and owner_account_id=${ownerAccountId} and status='provider_create_ambiguous'
        `);
      });
      return 'resolved';
    }
    const absence = ambiguousCloneAbsenceDisposition(
      current.provider_request_id,
      finalizeConfirmedAbsence,
    );
    if (absence === 'observe') {
      // Revocation alone is not evidence of provider absence. Persist the
      // first authoritative lookup result in the request locator; only a
      // second time-separated lookup may close local custody.
      await this.dbc.transaction(async (tx) => {
        await this.assertOwnerWritableTx(tx, ownerAccountId);
        await tx.execute(sql`
          update voice_clones set consent_revoked_at=coalesce(consent_revoked_at,statement_timestamp()),
            provider_request_id=coalesce(provider_request_id,${`absence:${this.now().toISOString()}`}),
            failure_code='provider_create_absence_observed',updated_at=statement_timestamp()
          where id=${id} and owner_account_id=${ownerAccountId} and status='provider_create_ambiguous'
            and provider_request_id is null
        `);
      });
      return 'pending';
    }
    if (absence === 'pending') return 'pending';
    assertVoiceReconciliationActive(signal);
    await this.dbc.transaction(async (tx) => {
      await this.assertOwnerWritableTx(tx, ownerAccountId);
      await tx.execute(sql`
        update voice_clones set status='revoked',revoked_at=coalesce(revoked_at,statement_timestamp()),
          failure_code='provider_create_absence_confirmed',updated_at=statement_timestamp()
        where id=${id} and owner_account_id=${ownerAccountId} and status='provider_create_ambiguous'
          and consent_revoked_at is not null
      `);
    });
    return 'resolved';
  }

  /**
   * Resolve lost clone-create responses without replaying POST. Positive exact
   * matches are deleted; absence requires two authoritative observations at
   * least thirty minutes apart before local clip custody is released.
   */
  async reconcileAmbiguousClones(
    cutoff = new Date(this.now().getTime() - 30 * 60_000),
    signal?: AbortSignal,
  ): Promise<number> {
    assertVoiceReconciliationActive(signal);
    const result = await this.dbc.execute(sql`
      select id,owner_account_id,provider_request_id from voice_clones
      where status='provider_create_ambiguous' and updated_at<${cutoff.toISOString()}
      order by updated_at,id limit 100
    `);
    let processed = 0;
    for (const row of rows<{ id: string; owner_account_id: string; provider_request_id: string | null }>(result)) {
      assertVoiceReconciliationActive(signal);
      try {
        const resolved = await this.reconcileAmbiguousClone(
          row.owner_account_id,
          row.id,
          row.provider_request_id?.startsWith('absence:') === true,
          signal,
        );
        assertVoiceReconciliationActive(signal);
        if (resolved === 'resolved') await this.deleteClone(row.owner_account_id, row.id, signal);
        processed += 1;
      } catch (error) {
        if (signal?.aborted) throw error;
        // Keep the durable locator/status for the next bounded pass. One
        // provider outage or storage cleanup failure cannot orphan the row.
      }
    }
    return processed;
  }

  async deleteClone(ownerAccountId: string, id: string, signal?: AbortSignal): Promise<VoiceCloneDto> {
    assertVoiceReconciliationActive(signal);
    let clone = await this.revokeClone(ownerAccountId, id);
    assertVoiceReconciliationActive(signal);
    const detail = await this.dbc.execute(sql`select provider_voice_id,status from voice_clones where id=${id} and owner_account_id=${ownerAccountId}`);
    const row = rows<{ provider_voice_id: string | null; status: string }>(detail)[0]!;
    if (row.status === 'deleted') return clone;
    if (row.status === 'provider_create_ambiguous') {
      const reconciled = await this.reconcileAmbiguousClone(ownerAccountId, id, false, signal);
      assertVoiceReconciliationActive(signal);
      if (reconciled === 'resolved') return await this.deleteClone(ownerAccountId, id, signal);
      throw new VoiceKernelError(409, 'clone_reconciliation_required', 'Provider clone absence must be reconciled before deletion');
    }
    if (row.provider_voice_id) {
      const provider = this.options.providers.cartesia;
      if (!provider?.deleteClone) throw new VoiceKernelError(503, 'voice_provider_unavailable', 'Clone deletion provider is unavailable');
      if (row.status === 'provider_delete_failed' || row.status === 'revoked') {
        await this.dbc.transaction(async (tx) => {
          await this.assertOwnerWritableTx(tx, ownerAccountId);
          await tx.execute(sql`update voice_clones set status='provider_delete_pending',updated_at=statement_timestamp() where id=${id} and owner_account_id=${ownerAccountId} and status=${row.status}`);
        });
      }
      try {
        await provider.deleteClone(row.provider_voice_id, signal);
        assertVoiceReconciliationActive(signal);
      }
      catch (error) {
        if (signal?.aborted) throw error;
        await this.dbc.transaction(async (tx) => {
          await this.assertOwnerWritableTx(tx, ownerAccountId);
          await tx.execute(sql`update voice_clones set status='provider_delete_failed',failure_code='provider_delete_failed',updated_at=statement_timestamp() where id=${id} and status='provider_delete_pending'`);
        });
        throw new VoiceKernelError(502, 'clone_delete_pending', 'Clone deletion requires reconciliation');
      }
    }
    clone = await this.dbc.transaction(async (tx) => {
      assertVoiceReconciliationActive(signal);
      await this.assertOwnerWritableTx(tx, ownerAccountId);
      // The row locks fence reference election while bounded storage deletion
      // runs. Abort propagates through the object backend so a stuck provider
      // cannot retain a database connection beyond the reconciliation lease;
      // any abort rolls this transaction back for a later clean retry.
      const currentResult = await tx.execute(sql`
        select * from voice_clones where id=${id} and owner_account_id=${ownerAccountId}
          and status in ('revoked','provider_delete_pending','provider_delete_failed') for update
      `);
      const current = rows<Record<string, unknown>>(currentResult)[0];
      if (!current) throw new VoiceKernelError(409, 'clone_delete_pending', 'Clone deletion requires reconciliation');
      // Lock every candidate object in canonical order first. The following
      // statement gets a fresh READ COMMITTED snapshot after any concurrent
      // clone admission finishes, so its reference election cannot be stale.
      await tx.execute(sql`
        select o.id from voice_clone_clips clip join storage_objects o on o.id=clip.object_id
        where clip.clone_id=${id} and o.owner_account_id=${ownerAccountId} and o.purpose='voice-clip'
        order by o.id for update of o
      `);
      const clipResult = await tx.execute(sql`
        select o.id,o.backing_store,o.backing_key,o.state,o.verified_sha256,o.verified_size_bytes,o.verified_mime,
          not exists (select 1 from voice_clone_clips other where other.object_id=o.id and other.clone_id<>${id}) unshared
        from voice_clone_clips clip join storage_objects o on o.id=clip.object_id
        where clip.clone_id=${id} and o.owner_account_id=${ownerAccountId} and o.purpose='voice-clip'
        order by clip.position
      `);
      const clips = rows<{
        id: string; backing_store: 'local' | 'r2' | 'legacy'; backing_key: string; state: StoredObject['state'];
        verified_sha256: string | null; verified_size_bytes: string | number | null; verified_mime: string | null; unshared: boolean;
      }>(clipResult);
      const removable = clips.filter((clip) => clip.unshared);
      if (removable.length > 0 && !this.options.deletePrivateClip) {
        throw new VoiceKernelError(503, 'voice_storage_unavailable', 'Voice clip deletion storage is unavailable');
      }
      for (const clip of removable) {
        assertVoiceReconciliationActive(signal);
        if (!clip.verified_sha256 || clip.verified_size_bytes === null || !clip.verified_mime || clip.backing_store === 'legacy') {
          throw new VoiceKernelError(409, 'clone_delete_pending', 'Voice clip deletion metadata is incomplete');
        }
        try {
          await this.options.deletePrivateClip!({
            objectId: clip.id,
            backingStore: clip.backing_store,
            backingKey: clip.backing_key,
            state: clip.state,
            sha256: clip.verified_sha256,
            sizeBytes: Number(clip.verified_size_bytes),
            mime: clip.verified_mime,
          }, signal);
          assertVoiceReconciliationActive(signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new VoiceKernelError(503, 'clone_clip_cleanup_pending', 'Voice clip deletion requires retry');
        }
      }
      assertVoiceReconciliationActive(signal);
      await tx.execute(sql`delete from voice_clone_clips where clone_id=${id}`);
      if (removable.length > 0) {
        const ids = removable.map((clip) => clip.id);
        await tx.execute(sql`
          delete from storage_objects where id in (${sql.join(ids.map((objectId) => sql`${objectId}`), sql`, `)})
            and owner_account_id=${ownerAccountId} and purpose='voice-clip'
            and not exists (select 1 from voice_clone_clips remaining where remaining.object_id=storage_objects.id)
        `);
      }
      const completed = await tx.execute(sql`
        update voice_clones set status='deleted',provider_deleted_at=coalesce(provider_deleted_at,statement_timestamp()),
          deleted_at=statement_timestamp(),failure_code=null,updated_at=statement_timestamp()
        where id=${id} and owner_account_id=${ownerAccountId} returning *
      `);
      return cloneDto(rows<Record<string, unknown>>(completed)[0]!);
    });
    return clone;
  }
}

export const voiceKernelInternals = {
  exactTranscript,
  requestHash,
  executionRequestHash,
  shouldRefundVoiceFailure,
  providerCloneName,
  ambiguousCloneAbsenceDisposition,
  directVoiceExecutionKey,
  ownerVoiceOutputPath,
  TEXT_LIMITS,
};
