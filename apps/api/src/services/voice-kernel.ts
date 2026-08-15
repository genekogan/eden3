import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

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
  /** Idempotently removes one unshared, private voice-clip object and cache entry. */
  deletePrivateClip?: (object: StoredObject) => Promise<void>;
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

  constructor(private readonly options: VoiceKernelOptions) {
    this.dbc = options.db ?? db;
    this.now = options.now ?? (() => new Date());
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
  }): Promise<VoiceExecutionDto> {
    const transcript = exactTranscript(input.text, input.operation);
    const requestSha256 = executionRequestHash({ ...input, textSha256: transcript.sha256 });

    const admission = await this.dbc.transaction(async (tx) => {
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
      });
      await this.dbc.transaction(async (tx) => {
        await this.resolveAuthorizedVoiceTx(tx, input.ownerAccountId, admission.voice.voiceId, input.operation);
        await tx.execute(sql`update voice_executions set status='transcoding',provider_request_id=${generated.requestId},updated_at=statement_timestamp() where id=${admission.executionId} and status='provider_started'`);
      });
      const output = await this.options.audio.process(generated.audio, generated.mime, input.operation);
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
      await this.dbc.transaction(async (tx) => {
        await this.resolveAuthorizedVoiceTx(tx, input.ownerAccountId, admission.voice.voiceId, input.operation);
        await tx.execute(sql`
          update voice_executions set output_sha256=${outputSha256},output_mime=${output.mime},
            output_size_bytes=${output.bytes.length},output_duration_ms=${output.durationMs},
            billed_character_count=${billedCharacters},cost_usd=${actual.totalCostUsd},updated_at=statement_timestamp()
          where id=${admission.executionId} and status='transcoding'
        `);
      });
      const stored = await this.options.mediaStore.put(output.bytes, { mime: output.mime });
      if (stored.sha256 !== outputSha256 || stored.mime !== output.mime || stored.sizeBytes !== output.bytes.length) {
        throw new VoiceAudioError('audio_invalid');
      }
      const completed = await this.dbc.transaction(async (tx) => {
        await this.resolveAuthorizedVoiceTx(tx, input.ownerAccountId, admission.voice.voiceId, input.operation);
        const updated = await tx.execute(sql`
          update voice_executions set status='completed',output_url=${stored.url},output_sha256=${stored.sha256},
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
      await this.failExecution(admission.executionId, admission.reservationKey, code);
      await this.cleanupFailedArtifact(admission.executionId);
      if (error instanceof VoiceKernelError) throw error;
      if (error instanceof VoiceProviderError && error.code === 'provider_result_indeterminate') {
        throw new VoiceKernelError(502, 'voice_provider_result_indeterminate', 'Voice provider result is indeterminate and will not be retried');
      }
      throw new VoiceKernelError(error instanceof VoiceAudioError ? 422 : 502, code, 'Voice execution failed');
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
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('voice-output:'||${row.output_sha256},0))`);
      const referenceResult = await tx.execute(sql`
        select
          exists(select 1 from voice_executions live where live.id<>${executionId}
            and live.output_sha256=${row.output_sha256}
            and live.status not in ('failed','artifact_cleanup_pending'))
          or exists(select 1 from media_assets m where m.sha256=${row.output_sha256})
          or exists(select 1 from concept_images i where i.sha256=${row.output_sha256})
          or exists(select 1 from agent_avatar_assets a where a.sha256=${row.output_sha256})
          or exists(select 1 from creations c where c.url like ${`%/${row.output_sha256}.%`} or c.thumbnail_url like ${`%/${row.output_sha256}.%`}) shared,
          (select min(id)::text from voice_executions queued where queued.output_sha256=${row.output_sha256}
            and queued.status='artifact_cleanup_pending') elected_id
      `);
      const reference = rows<{ shared: boolean; elected_id: string | null }>(referenceResult)[0];
      if (reference?.shared === false && reference.elected_id === executionId) {
        await this.options.cleanupArtifact(row.output_sha256, row.output_mime);
      }
      await tx.execute(sql`update voice_executions set status='failed',updated_at=statement_timestamp() where id=${executionId} and status='artifact_cleanup_pending'`);
    });
  }

  /** Conservative crash recovery: indeterminate work is never replayed and never charged without output. */
  async reconcileStaleExecutions(cutoff = new Date(this.now().getTime() - 15 * 60_000)): Promise<number> {
    const result = await this.dbc.execute(sql`
      select id from voice_executions
      where status in ('provider_started','transcoding','refund_pending','artifact_cleanup_pending') and updated_at<${cutoff.toISOString()}
      order by updated_at,id limit 100
    `);
    for (const row of rows<{ id: string }>(result)) {
      await this.failExecution(row.id, `voice:${row.id}`, 'voice_execution_recovered_indeterminate');
      await this.cleanupFailedArtifact(row.id);
    }
    return rows(result).length;
  }

  async assignment(ownerAccountId: string, username: string, value: Omit<VoiceAssignmentDto, 'updatedAt'>): Promise<VoiceAssignmentDto> {
    return await this.dbc.transaction(async (tx) => {
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
    const result = await this.dbc.execute(sql`delete from agent_voice_assignments av using agents g,accounts a where av.agent_account_id=g.account_id and g.account_id=a.id and a.username=${username} and g.owner_id=${ownerAccountId} returning av.agent_account_id`);
    if (rows(result).length === 0) throw new VoiceKernelError(404, 'voice_assignment_not_found', 'Voice assignment not found');
  }

  async directVoiceNote(
    ownerAccountId: string,
    sessionId: string,
    messageId: string,
    idempotencyKey: string,
    requiredMode?: 'always',
  ): Promise<{ execution: VoiceExecutionDto; message: MessageDto }> {
    const result = await this.dbc.execute(sql`
      select m.content,m.sender_id agent_account_id,av.voice_id
      from messages m join sessions s on s.id=m.session_id
      join agents g on g.account_id=m.sender_id
      join agent_voice_assignments av on av.agent_account_id=m.sender_id and av.chat_mode in ('on_demand','always')
      where s.id=${sessionId} and m.id=${messageId} and m.session_id=s.id and m.role='assistant'
        and s.deleted=false and s.visible is distinct from false and s.channel_connection_id is null
        and (s.owner_id=${ownerAccountId} or exists (select 1 from session_users su where su.session_id=s.id and su.user_account_id=${ownerAccountId}))
        and (g.owner_id=${ownerAccountId} or exists (select 1 from session_agents sa where sa.session_id=s.id and sa.agent_account_id=g.account_id))
        and (${requiredMode ?? null}::text is null or av.chat_mode=${requiredMode ?? null})
    `);
    const row = rows<{ content: string | null; agent_account_id: string; voice_id: string }>(result)[0];
    if (!row?.content) throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
    const quote = await this.quote(ownerAccountId, 'chat', row.voice_id, row.content);
    const execution = await this.synthesize({ ownerAccountId, operation: 'chat', voiceId: row.voice_id, quoteId: quote.quoteId, text: row.content, idempotencyKey, agentAccountId: row.agent_account_id, sessionId, messageId });
    const messageResult = await this.dbc.execute(sql`
      update messages set attachments=coalesce(attachments,'[]'::jsonb)||${JSON.stringify([{ url: execution.url, mime: execution.mime, durationMs: execution.durationMs, voiceExecutionId: execution.id }])}::jsonb
      where id=${messageId} and session_id=${sessionId} and not exists (
        select 1 from jsonb_array_elements(coalesce(attachments,'[]'::jsonb)) item
        where item->>'voiceExecutionId'=${execution.id}
      ) returning id,external_id,session_id,sender_id,role,content,attachments,tool_calls,reactions,reply_to_external_id,created_at
    `);
    let message = rows<Record<string, unknown>>(messageResult)[0];
    if (!message) {
      const replayResult = await this.dbc.execute(sql`
        select id,external_id,session_id,sender_id,role,content,attachments,tool_calls,reactions,reply_to_external_id,created_at
        from messages where id=${messageId} and session_id=${sessionId}
      `);
      message = rows<Record<string, unknown>>(replayResult)[0];
    }
    if (!message) throw new VoiceKernelError(404, 'voice_message_not_eligible', 'Assistant message is not eligible for a voice note');
    return { execution, message: directVoiceMessageDto(message) };
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
    const quote = await this.quote(row.account_id, row.channel, row.voice_id, input.text);
    const execution = await this.synthesize({ ownerAccountId: row.account_id, operation: row.channel, voiceId: row.voice_id, quoteId: quote.quoteId, text: input.text, idempotencyKey: input.idempotencyKey, agentAccountId: row.agent_id, sessionId: row.session_id ?? undefined, channelTurnId: input.turnId });
    const waveformResult = await this.dbc.execute(sql`select waveform from voice_executions where id=${execution.id}`);
    return { ...execution, waveform: rows<{ waveform: string | null }>(waveformResult)[0]?.waveform ?? null };
  }

  async createClone(input: { ownerAccountId: string; name: string; clipObjectIds: string[]; consentVersion: string; consentAttested: true; idempotencyKey: string }): Promise<VoiceCloneDto> {
    if (!input.consentAttested || input.consentVersion !== 'voice-clone-consent-v1') throw new VoiceKernelError(422, 'voice_consent_required', 'Current voice consent is required');
    if (!this.options.mediaResolver) throw new VoiceKernelError(503, 'voice_storage_unavailable', 'Voice clip storage is unavailable');
    if (input.clipObjectIds.length < 1 || input.clipObjectIds.length > 5 || new Set(input.clipObjectIds).size !== input.clipObjectIds.length) {
      throw new VoiceKernelError(422, 'voice_clip_not_ready', 'Choose between one and five distinct voice clips');
    }
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
  ): Promise<'resolved' | 'pending'> {
    const currentResult = await this.dbc.execute(sql`
      select id,status,provider_request_id from voice_clones
      where id=${id} and owner_account_id=${ownerAccountId}
    `);
    const current = rows<{ id: string; status: string; provider_request_id: string | null }>(currentResult)[0];
    if (!current || current.status !== 'provider_create_ambiguous') return 'resolved';
    const provider = this.options.providers.cartesia;
    if (!provider?.findOwnedCloneByName) return 'pending';
    const found = await provider.findOwnedCloneByName(providerCloneName(id));
    if (found) {
      await this.dbc.execute(sql`
        update voice_clones set status='provider_delete_pending',provider_voice_id=${found.providerVoiceId},
          consent_revoked_at=coalesce(consent_revoked_at,statement_timestamp()),
          revoked_at=coalesce(revoked_at,statement_timestamp()),failure_code='provider_create_reconciled',
          updated_at=statement_timestamp()
        where id=${id} and owner_account_id=${ownerAccountId} and status='provider_create_ambiguous'
      `);
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
      await this.dbc.execute(sql`
        update voice_clones set consent_revoked_at=coalesce(consent_revoked_at,statement_timestamp()),
          provider_request_id=coalesce(provider_request_id,${`absence:${this.now().toISOString()}`}),
          failure_code='provider_create_absence_observed',updated_at=statement_timestamp()
        where id=${id} and owner_account_id=${ownerAccountId} and status='provider_create_ambiguous'
          and provider_request_id is null
      `);
      return 'pending';
    }
    if (absence === 'pending') return 'pending';
    await this.dbc.execute(sql`
      update voice_clones set status='revoked',revoked_at=coalesce(revoked_at,statement_timestamp()),
        failure_code='provider_create_absence_confirmed',updated_at=statement_timestamp()
      where id=${id} and owner_account_id=${ownerAccountId} and status='provider_create_ambiguous'
        and consent_revoked_at is not null
    `);
    return 'resolved';
  }

  /**
   * Resolve lost clone-create responses without replaying POST. Positive exact
   * matches are deleted; absence requires two authoritative observations at
   * least thirty minutes apart before local clip custody is released.
   */
  async reconcileAmbiguousClones(
    cutoff = new Date(this.now().getTime() - 30 * 60_000),
  ): Promise<number> {
    const result = await this.dbc.execute(sql`
      select id,owner_account_id,provider_request_id from voice_clones
      where status='provider_create_ambiguous' and updated_at<${cutoff.toISOString()}
      order by updated_at,id limit 100
    `);
    let processed = 0;
    for (const row of rows<{ id: string; owner_account_id: string; provider_request_id: string | null }>(result)) {
      try {
        const resolved = await this.reconcileAmbiguousClone(
          row.owner_account_id,
          row.id,
          row.provider_request_id?.startsWith('absence:') === true,
        );
        if (resolved === 'resolved') await this.deleteClone(row.owner_account_id, row.id);
        processed += 1;
      } catch {
        // Keep the durable locator/status for the next bounded pass. One
        // provider outage or storage cleanup failure cannot orphan the row.
      }
    }
    return processed;
  }

  async deleteClone(ownerAccountId: string, id: string): Promise<VoiceCloneDto> {
    let clone = await this.revokeClone(ownerAccountId, id);
    const detail = await this.dbc.execute(sql`select provider_voice_id,status from voice_clones where id=${id} and owner_account_id=${ownerAccountId}`);
    const row = rows<{ provider_voice_id: string | null; status: string }>(detail)[0]!;
    if (row.status === 'deleted') return clone;
    if (row.status === 'provider_create_ambiguous') {
      const reconciled = await this.reconcileAmbiguousClone(ownerAccountId, id, false);
      if (reconciled === 'resolved') return await this.deleteClone(ownerAccountId, id);
      throw new VoiceKernelError(409, 'clone_reconciliation_required', 'Provider clone absence must be reconciled before deletion');
    }
    if (row.provider_voice_id) {
      const provider = this.options.providers.cartesia;
      if (!provider?.deleteClone) throw new VoiceKernelError(503, 'voice_provider_unavailable', 'Clone deletion provider is unavailable');
      if (row.status === 'provider_delete_failed' || row.status === 'revoked') {
        await this.dbc.execute(sql`update voice_clones set status='provider_delete_pending',updated_at=statement_timestamp() where id=${id} and owner_account_id=${ownerAccountId} and status=${row.status}`);
      }
      try { await provider.deleteClone(row.provider_voice_id); }
      catch {
        await this.dbc.execute(sql`update voice_clones set status='provider_delete_failed',failure_code='provider_delete_failed',updated_at=statement_timestamp() where id=${id} and status='provider_delete_pending'`);
        throw new VoiceKernelError(502, 'clone_delete_pending', 'Clone deletion requires reconciliation');
      }
    }
    clone = await this.dbc.transaction(async (tx) => {
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
          });
        } catch {
          throw new VoiceKernelError(503, 'clone_clip_cleanup_pending', 'Voice clip deletion requires retry');
        }
      }
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
  TEXT_LIMITS,
};
