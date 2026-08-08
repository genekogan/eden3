import { createHash } from 'node:crypto';

import {
  debit,
  numericToNumber,
  reverseReservation,
  settleReservation,
  type DbHandle,
} from '@eden3/core';
import { db, mannaAccounts, mannaTransactions, usageEvents } from '@eden3/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODEL_OPTIONS,
  quoteStudioGeneration,
  type StudioGenerationQuote,
  type StudioToolName,
} from '../routes/studio';
import { plainSessionKey } from './turn-registry';
import { STUDIO_RESERVATION_EVENT_TYPE } from './studio-reservations';

export const CHAT_MEDIA_EVENT_TYPE = 'chat_media';
export const CHAT_MEDIA_RESERVATION_TTL_MS = 60 * 60 * 1_000;
export const CHAT_MEDIA_REAPER_INTERVAL_MS = 5 * 60 * 1_000;

const MEDIA_TOOLS = new Set<StudioToolName>([
  'image_generate',
  'video_generate',
  'music_generate',
  'tts',
]);
const CHAT_VIDEO_MODEL = 'fal/fal-ai/kling-video/v3/pro/text-to-video';
const CHAT_MUSIC_MODEL = 'google/lyria-3-clip-preview';

export interface ChatMediaAuthorizationRequest {
  runId?: string;
  toolCallId?: string;
  sessionKey: string;
  agentId: string;
  tool: StudioToolName;
  args: Record<string, unknown>;
}

export interface StudioMediaAuthorization {
  authorizationId: string;
  tool: StudioToolName;
  action: string;
  quote: StudioGenerationQuote;
}

export interface ChatMediaAuthorizationMetadata {
  version: 1;
  runIdHash: string;
  toolCallIdHash: string;
  tool: StudioToolName;
  action: string;
  outputKind: 'image' | 'video' | 'audio';
  quote: {
    provider: string;
    model: string;
    tableVersion: string;
    units: Record<string, number>;
    costUsd: number;
    manna: number;
  };
  reservation: {
    idempotencyKey: string;
    transactionId: string;
    subscriptionManna: number;
    durableManna: number;
  };
  requestedAt: string;
  failureCode?: string;
  failureLatencyMs?: number;
  providerAdmittedAt?: string;
}

export interface ChatMediaAuthorization {
  authorizationId: string;
  accountId: string;
  agentAccountId: string;
  sessionId: string;
  tool: StudioToolName;
  action: string;
  quote: StudioGenerationQuote;
  metadata: ChatMediaAuthorizationMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeHostIdentity(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`chat-media-authorization: invalid ${name}`);
  }
  return trimmed;
}

function digestIdentity(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function outputKindForTool(tool: StudioToolName): 'image' | 'video' | 'audio' {
  if (tool === 'image_generate') return 'image';
  if (tool === 'video_generate') return 'video';
  return 'audio';
}

function outputKindForAction(action: string): 'image' | 'video' | 'audio' {
  if (action === 'image') return 'image';
  if (action === 'video') return 'video';
  if (action === 'music' || action === 'tts') return 'audio';
  throw new Error('chat-media-authorization: unsupported settlement action');
}

function uuidFromDigest(input: string): string {
  const bytes = createHash('sha256').update(input, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isChatMediaTool(value: string): value is StudioToolName {
  return MEDIA_TOOLS.has(value as StudioToolName);
}

function imageModelKey(raw: unknown): keyof typeof IMAGE_MODEL_OPTIONS | null {
  if (raw === undefined) return DEFAULT_IMAGE_MODEL;
  for (const [key, option] of Object.entries(IMAGE_MODEL_OPTIONS) as Array<
    [keyof typeof IMAGE_MODEL_OPTIONS, (typeof IMAGE_MODEL_OPTIONS)[keyof typeof IMAGE_MODEL_OPTIONS]]
  >) {
    if (raw === key || raw === option.openclawModel || raw === option.model) return key;
  }
  return null;
}

/**
 * Verify the separate Studio reservation for a direct OpenClaw tool invoke.
 * The `eden3:studio:<uuid>` context is only an index, never authority: the
 * callback admits provider work only after independently observing the exact
 * committed pending usage row and its linked debit.
 */
export async function verifyPendingStudioMedia(options: {
  request: ChatMediaAuthorizationRequest;
  db?: DbHandle;
}): Promise<StudioMediaAuthorization | null> {
  const sessionKey = plainSessionKey(safeHostIdentity(options.request.sessionKey, 'sessionKey'));
  const match = /^eden3:studio:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
    sessionKey,
  );
  if (!match) return null;
  if (!isChatMediaTool(options.request.tool)) {
    throw new Error('chat-media-authorization: unsupported Studio tool');
  }
  const authorizationId = match[1]!.toLowerCase();
  const quote = quoteChatMediaTool(options.request.tool, options.request.args);
  const rows = (await (options.db ?? db).execute(sql`
    select ue.user_id, ue.metadata, mt.id as transaction_id, mt.amount, mt.type,
           mt.idempotency_key
    from usage_events ue
    join manna_accounts ma on ma.account_id = ue.user_id
    join manna_transactions mt
      on mt.manna_account_id = ma.id
     and mt.id = nullif(ue.metadata->'reservation'->>'transactionId', '')::uuid
    where ue.event_type = ${STUDIO_RESERVATION_EVENT_TYPE}
      and ue.turn_id = ${authorizationId}
      and ue.status = 'pending'
    limit 2
  `)) as unknown as Array<{
    user_id: string;
    metadata: unknown;
    transaction_id: string;
    amount: string | number;
    type: string;
    idempotency_key: string | null;
  }>;
  if (rows.length !== 1) {
    throw new Error('chat-media-authorization: pending Studio authorization unavailable');
  }
  const row = rows[0]!;
  const metadata = isRecord(row.metadata) ? row.metadata : null;
  const studioQuote = metadata && isRecord(metadata.quote) ? metadata.quote : null;
  const reservation = metadata && isRecord(metadata.reservation) ? metadata.reservation : null;
  const reservationKey = `studio:${authorizationId}:reserve`;
  if (
    !metadata ||
    !studioQuote ||
    !reservation ||
    metadata.tool !== options.request.tool ||
    studioQuote.action !== quote.action ||
    studioQuote.provider !== quote.provider ||
    studioQuote.model !== quote.model ||
    studioQuote.tableVersion !== quote.tableVersion ||
    studioQuote.manna !== quote.manna ||
    studioQuote.costUsd !== quote.costUsd ||
    reservation.idempotencyKey !== reservationKey ||
    reservation.transactionId !== row.transaction_id ||
    reservation.reservedManna !== quote.manna ||
    row.idempotency_key !== reservationKey ||
    numericToNumber(String(row.amount)) !== -quote.manna ||
    row.type !== `spend:${quote.action}`
  ) {
    throw new Error('chat-media-authorization: Studio reservation identity mismatch');
  }
  return { authorizationId, tool: options.request.tool, action: quote.action, quote };
}

/**
 * The M3 chat surface intentionally supports only the cost-bounded default
 * media routes. OpenClaw exposes many provider-specific knobs (count, quality,
 * arbitrary option bags); accepting one without a matching price is the same
 * authorization bug this module closes, so unknown fields fail closed.
 */
export function quoteChatMediaTool(
  tool: StudioToolName,
  rawArgs: Record<string, unknown>,
): StudioGenerationQuote {
  const allowed =
    tool === 'image_generate'
      ? new Set(['action', 'prompt', 'model'])
      : tool === 'video_generate' || tool === 'music_generate'
        ? new Set(['action', 'prompt', 'duration', 'durationSeconds', 'model'])
        : new Set(['action', 'text']);
  for (const key of Object.keys(rawArgs)) {
    if (!allowed.has(key)) {
      throw new Error(`chat-media-authorization: unsupported ${tool} argument ${key}`);
    }
  }
  if (rawArgs.action !== undefined && rawArgs.action !== 'generate') {
    throw new Error(`chat-media-authorization: ${tool} action is not a generation`);
  }
  if (tool === 'tts') {
    const text = typeof rawArgs.text === 'string' ? rawArgs.text.trim() : '';
    if (!text || text.length > 20_000) throw new Error('chat-media-authorization: invalid tts text');
    return quoteStudioGeneration(tool, { text });
  }
  const prompt = typeof rawArgs.prompt === 'string' ? rawArgs.prompt.trim() : '';
  if (!prompt || prompt.length > 20_000) {
    throw new Error(`chat-media-authorization: invalid ${tool} prompt`);
  }
  if (tool === 'image_generate') {
    const model = imageModelKey(rawArgs.model);
    if (!model) throw new Error('chat-media-authorization: unsupported image route');
    return quoteStudioGeneration(tool, { prompt, model });
  }
  if (rawArgs.duration !== undefined && rawArgs.durationSeconds !== undefined) {
    throw new Error(`chat-media-authorization: ambiguous ${tool} duration`);
  }
  const suppliedDuration = rawArgs.durationSeconds ?? rawArgs.duration;
  const duration = suppliedDuration ?? (tool === 'video_generate' ? 5 : 30);
  const bounds = tool === 'video_generate' ? { min: 2, max: 10 } : { min: 5, max: 120 };
  if (
    typeof duration !== 'number' ||
    !Number.isFinite(duration) ||
    !Number.isInteger(duration) ||
    duration < bounds.min ||
    duration > bounds.max
  ) {
    throw new Error(`chat-media-authorization: invalid ${tool} duration`);
  }
  const expectedModel = tool === 'video_generate' ? CHAT_VIDEO_MODEL : CHAT_MUSIC_MODEL;
  if (rawArgs.model !== undefined && rawArgs.model !== expectedModel) {
    throw new Error(`chat-media-authorization: unsupported ${tool} model`);
  }
  const args: Record<string, unknown> = { prompt, duration };
  return quoteStudioGeneration(tool, args);
}

/** Exact args executed after the provider route has been authorized. */
export function canonicalChatMediaProviderArgs(
  tool: StudioToolName,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  // Validation and duration canonicalization are intentionally shared with
  // the quote path so the hook can never execute a different cost shape.
  quoteChatMediaTool(tool, rawArgs);
  if (tool === 'tts') {
    const text = String(rawArgs.text).trim();
    return { text };
  }
  const prompt = String(rawArgs.prompt).trim();
  if (tool === 'image_generate') {
    const model = imageModelKey(rawArgs.model);
    if (!model) throw new Error('chat-media-authorization: unsupported image model');
    return { prompt, model: IMAGE_MODEL_OPTIONS[model].openclawModel };
  }
  const durationSeconds = rawArgs.durationSeconds ?? rawArgs.duration ?? (tool === 'video_generate' ? 5 : 30);
  return {
    prompt,
    durationSeconds,
    model: tool === 'video_generate' ? CHAT_VIDEO_MODEL : CHAT_MUSIC_MODEL,
  };
}

function readMetadata(value: unknown): ChatMediaAuthorizationMetadata {
  if (!isRecord(value) || value.version !== 1 || typeof value.tool !== 'string') {
    throw new Error('chat-media-authorization: invalid metadata');
  }
  const quote = value.quote;
  const reservation = value.reservation;
  if (
    !isRecord(quote) ||
    typeof quote.provider !== 'string' ||
    typeof quote.model !== 'string' ||
    typeof quote.tableVersion !== 'string' ||
    !isRecord(quote.units) ||
    typeof quote.costUsd !== 'number' ||
    typeof quote.manna !== 'number' ||
    !isRecord(reservation) ||
    typeof reservation.idempotencyKey !== 'string' ||
    typeof reservation.transactionId !== 'string' ||
    typeof reservation.subscriptionManna !== 'number' ||
    typeof reservation.durableManna !== 'number' ||
    typeof value.runIdHash !== 'string' ||
    typeof value.toolCallIdHash !== 'string' ||
    !['image', 'video', 'audio'].includes(String(value.outputKind))
  ) {
    throw new Error('chat-media-authorization: incomplete metadata');
  }
  if (
    !isChatMediaTool(value.tool) ||
    !Number.isFinite(quote.manna) ||
    quote.manna <= 0 ||
    Number((reservation.subscriptionManna + reservation.durableManna).toFixed(4)) !== quote.manna
  ) {
    throw new Error('chat-media-authorization: invalid reservation metadata');
  }
  return value as unknown as ChatMediaAuthorizationMetadata;
}

async function assertReservationProvenance(
  tx: DbHandle,
  accountId: string,
  metadata: ChatMediaAuthorizationMetadata,
): Promise<void> {
  const [reservationTx] = await tx
    .select({ amount: mannaTransactions.amount, type: mannaTransactions.type })
    .from(mannaTransactions)
    .innerJoin(mannaAccounts, eq(mannaAccounts.id, mannaTransactions.mannaAccountId))
    .where(
      and(
        eq(mannaTransactions.id, metadata.reservation.transactionId),
        eq(mannaTransactions.idempotencyKey, metadata.reservation.idempotencyKey),
        eq(mannaAccounts.accountId, accountId),
      ),
    )
    .limit(1);
  if (
    !reservationTx ||
    numericToNumber(reservationTx.amount) !== -metadata.quote.manna ||
    reservationTx.type !== `spend:${metadata.action}`
  ) {
    throw new Error('chat-media-authorization: reservation transaction identity mismatch');
  }
}

export async function reserveChatMedia(options: {
  request: ChatMediaAuthorizationRequest;
  dailyCap: number;
  db?: DbHandle;
  now?: Date;
}): Promise<ChatMediaAuthorization> {
  const dbc = options.db ?? db;
  const request = options.request;
  const runId = safeHostIdentity(request.runId ?? '', 'runId');
  const toolCallId = safeHostIdentity(request.toolCallId ?? '', 'toolCallId');
  const sessionKey = plainSessionKey(safeHostIdentity(request.sessionKey, 'sessionKey'));
  const agentId = safeHostIdentity(request.agentId, 'agentId');
  if (!isChatMediaTool(request.tool)) throw new Error('chat-media-authorization: unsupported tool');
  const quote = quoteChatMediaTool(request.tool, request.args);
  if (request.tool === 'tts') {
    throw new Error('chat-media-authorization: in-chat tts is deferred');
  }
  const action = String(quote.action);
  const outputKind = outputKindForTool(request.tool);

  return await dbc.transaction(async (tx) => {
    const targets = (await tx.execute(sql`
      select s.id as session_id, s.owner_id as account_id, a.account_id as agent_account_id
      from sessions s
      join accounts owner_account on owner_account.id = s.owner_id
      join session_agents sa on sa.session_id = s.id
      join agents a on a.account_id = sa.agent_account_id
      join accounts agent_account on agent_account.id = a.account_id
      where s.gateway_session_key = ${sessionKey}
        and s.deleted = false
        and owner_account.deleted = false and owner_account.type = 'user'
        and agent_account.deleted = false and agent_account.type = 'agent'
        and s.session_type is distinct from 'channel' and s.channel_connection_id is null
        and a.openclaw_id = ${agentId}
      order by a.account_id
      limit 2
    `)) as unknown as Array<{ session_id: string; account_id: string; agent_account_id: string }>;
    if (targets.length !== 1) {
      throw new Error('chat-media-authorization: session/agent binding unavailable');
    }
    const target = targets[0]!;
    const authorizationId = uuidFromDigest(
      ['chat-media-auth-v1', target.session_id, runId, toolCallId, request.tool].join('\0'),
    );
    const reservationKey = `chat-media:${authorizationId}`;

    // There is no durable task→file identity in OpenClaw 2026.7.1. Serialize
    // one outstanding authorization per session+action so the watcher can
    // claim it exactly; a different-cost same-action call never reaches the
    // provider or lands a second debit.
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${'chat-media:' + target.session_id + ':' + outputKind}, 0))
    `);
    const active = (await tx.execute(sql`
      select turn_id from usage_events
      where event_type = ${CHAT_MEDIA_EVENT_TYPE}
        and session_id = ${target.session_id}
        and status in ('pending', 'provider_admitted', 'refund_pending')
        and metadata->>'outputKind' = ${outputKind}
      limit 1
    `)) as unknown as Array<{ turn_id: string }>;
    if (active[0] && active[0].turn_id !== authorizationId) {
      throw new Error('chat-media-authorization: media action already pending for session');
    }

    const debited = await debit({
      accountId: target.account_id,
      amount: quote.manna,
      type: `spend:${action}`,
      idempotencyKey: reservationKey,
      dailyCap: { limit: options.dailyCap },
      db: tx,
    });
    const now = options.now ?? new Date();
    if (debited.alreadyApplied) {
      throw new Error('chat-media-authorization: provider admission ticket already consumed');
    }

    const subscriptionManna = debited.subscriptionDrawn ?? 0;
    const metadata: ChatMediaAuthorizationMetadata = {
      version: 1,
      runIdHash: digestIdentity(runId),
      toolCallIdHash: digestIdentity(toolCallId),
      tool: request.tool,
      action,
      outputKind,
      quote: {
        provider: quote.provider,
        model: quote.model,
        tableVersion: quote.tableVersion,
        units: quote.units as Record<string, number>,
        costUsd: quote.costUsd,
        manna: quote.manna,
      },
      reservation: {
        idempotencyKey: reservationKey,
        transactionId: debited.transaction.id,
        subscriptionManna,
        durableManna: Number((quote.manna - subscriptionManna).toFixed(4)),
      },
      requestedAt: now.toISOString(),
      providerAdmittedAt: now.toISOString(),
    };
    const [inserted] = await tx
      .insert(usageEvents)
      .values({
        eventType: CHAT_MEDIA_EVENT_TYPE,
        status: 'provider_admitted',
        userId: target.account_id,
        agentId: target.agent_account_id,
        sessionId: target.session_id,
        turnId: authorizationId,
        provider: quote.provider,
        model: quote.model,
        pricingBasis: 'provider-api',
        tableVersion: quote.tableVersion,
        manna: quote.manna,
        metadata,
      })
      .onConflictDoNothing()
      .returning({ id: usageEvents.id });
    if (!inserted) throw new Error('chat-media-authorization: durable authorization refused');
    return {
      authorizationId,
      accountId: target.account_id,
      agentAccountId: target.agent_account_id,
      sessionId: target.session_id,
      tool: request.tool,
      action,
      quote,
      metadata,
    };
  });
}

export async function completePendingChatMedia(
  tx: DbHandle,
  options: {
    sessionId: string;
    action: string;
    messageId: string | null;
    creationId: string | null;
    observedTool: string | null;
    now?: Date;
  },
): Promise<{ accountId: string; authorizationId: string; balance: number } | null> {
  const outputKind = outputKindForAction(options.action);
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${'chat-media:' + options.sessionId + ':' + outputKind}, 0))
  `);
  const rows = (await tx.execute(sql`
    select turn_id, user_id, agent_id, created_at, metadata
    from usage_events
    where event_type = ${CHAT_MEDIA_EVENT_TYPE}
      and session_id = ${options.sessionId}
      and status in ('pending', 'provider_admitted')
      and metadata->>'action' = ${options.action}
    limit 2
    for update
  `)) as unknown as Array<{
    turn_id: string;
    user_id: string | null;
    agent_id: string | null;
    created_at: Date;
    metadata: unknown;
  }>;
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('chat-media-authorization: ambiguous pending authorization');
  const row = rows[0]!;
  if (!row.user_id) throw new Error('chat-media-authorization: pending authorization has no payer');
  const metadata = readMetadata(row.metadata);
  if (metadata.action !== options.action) throw new Error('chat-media-authorization: action mismatch');
  await assertReservationProvenance(tx, row.user_id, metadata);
  const leg = await settleReservation({
    reservationKey: metadata.reservation.idempotencyKey,
    chargeManna: metadata.quote.manna,
    reservedSubscriptionManna: metadata.reservation.subscriptionManna,
    type: `refund:${metadata.action}:settle`,
    db: tx,
  });
  const now = options.now ?? new Date();
  const [updated] = await tx
    .update(usageEvents)
    .set({
      status: 'completed',
      messageId: options.messageId,
      costUsd: metadata.quote.costUsd.toFixed(8),
      manna: metadata.quote.manna,
      latencyMs: Math.max(0, now.getTime() - new Date(row.created_at).getTime()),
      errorCode: null,
      errorMessage: null,
      metadata: {
        ...metadata,
        creationId: options.creationId,
        observedTool: options.observedTool,
        completedAt: now.toISOString(),
      },
    })
    .where(
      and(
        eq(usageEvents.eventType, CHAT_MEDIA_EVENT_TYPE),
        eq(usageEvents.turnId, row.turn_id),
        inArray(usageEvents.status, ['pending', 'provider_admitted']),
      ),
    )
    .returning({ id: usageEvents.id });
  if (!updated) throw new Error('chat-media-authorization: completion lost pending state');
  return { accountId: row.user_id, authorizationId: row.turn_id, balance: leg.balance.total };
}

export async function hasPendingChatMediaAuthorization(options: {
  sessionId: string;
  action: string;
  db?: DbHandle;
}): Promise<boolean> {
  const rows = (await (options.db ?? db).execute(sql`
    select 1 from usage_events
    where event_type = ${CHAT_MEDIA_EVENT_TYPE}
      and session_id = ${options.sessionId}
      and status in ('pending', 'provider_admitted')
      and metadata->>'action' = ${options.action}
    limit 1
  `)) as unknown as unknown[];
  return rows.length === 1;
}

export async function compensateChatMedia(options: {
  authorizationId: string;
  errorCode: string;
  errorMessage: string;
  db?: DbHandle;
  now?: Date;
}): Promise<'refunded' | 'refund_pending' | 'terminal'> {
  const dbc = options.db ?? db;
  const marked = await dbc.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      select status, metadata from usage_events
      where event_type = ${CHAT_MEDIA_EVENT_TYPE} and turn_id = ${options.authorizationId}
      for update
    `)) as unknown as Array<{ status: string; metadata: unknown }>;
    const row = rows[0];
    if (!row || row.status === 'completed' || row.status === 'error') return null;
    if (
      row.status !== 'pending' &&
      row.status !== 'provider_admitted' &&
      row.status !== 'refund_pending'
    ) {
      throw new Error(`chat-media-authorization: unexpected compensation state ${row.status}`);
    }
    const metadata = readMetadata(row.metadata);
    await tx
      .update(usageEvents)
      .set({
        status: 'refund_pending',
        errorCode: 'refund_pending',
        errorMessage: options.errorMessage.slice(0, 1_000),
        metadata: {
          ...metadata,
          failureCode: options.errorCode,
          failureLatencyMs: Math.max(
            0,
            (options.now ?? new Date()).getTime() - new Date(metadata.requestedAt).getTime(),
          ),
        },
      })
      .where(
        and(
          eq(usageEvents.eventType, CHAT_MEDIA_EVENT_TYPE),
          eq(usageEvents.turnId, options.authorizationId),
        ),
      );
    return metadata;
  });
  if (!marked) return 'terminal';
  try {
    return await dbc.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        select status, user_id, metadata from usage_events
        where event_type = ${CHAT_MEDIA_EVENT_TYPE} and turn_id = ${options.authorizationId}
        for update
      `)) as unknown as Array<{ status: string; user_id: string | null; metadata: unknown }>;
      const row = rows[0];
      if (!row || row.status === 'completed' || row.status === 'error') return 'terminal';
      if (row.status !== 'refund_pending' || !row.user_id) {
        throw new Error('chat-media-authorization: compensation lost durable state');
      }
      const metadata = readMetadata(row.metadata);
      await assertReservationProvenance(tx, row.user_id, metadata);
      await reverseReservation({
        reservationKey: metadata.reservation.idempotencyKey,
        reservedSubscriptionManna: metadata.reservation.subscriptionManna,
        type: `refund:${metadata.action}`,
        db: tx,
      });
      const [updated] = await tx
        .update(usageEvents)
        .set({
          status: 'error',
          manna: 0,
          costUsd: '0',
          errorCode: metadata.failureCode ?? options.errorCode,
          errorMessage: options.errorMessage.slice(0, 1_000),
          latencyMs: metadata.failureLatencyMs ?? null,
        })
        .where(
          and(
            eq(usageEvents.eventType, CHAT_MEDIA_EVENT_TYPE),
            eq(usageEvents.turnId, options.authorizationId),
            eq(usageEvents.status, 'refund_pending'),
          ),
        )
        .returning({ id: usageEvents.id });
      if (!updated) throw new Error('chat-media-authorization: terminal compensation lost race');
      return 'refunded';
    });
  } catch {
    return 'refund_pending';
  }
}

export class ChatMediaReservationReaper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly options: {
      ttlMs?: number;
      intervalMs?: number;
      db?: DbHandle;
      now?: () => Date;
      onError?: (err: unknown, context: string) => void;
    } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => this.options.onError?.(err, 'chat-media reaper tick'));
    }, this.options.intervalMs ?? CHAT_MEDIA_REAPER_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<{ scanned: number; reaped: number; pending: number }> {
    if (this.running) return { scanned: 0, reaped: 0, pending: 0 };
    this.running = true;
    try {
      const dbc = this.options.db ?? db;
      const now = this.options.now?.() ?? new Date();
      const cutoff = new Date(now.getTime() - (this.options.ttlMs ?? CHAT_MEDIA_RESERVATION_TTL_MS));
      const rows = await dbc
        .select({ turnId: usageEvents.turnId })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.eventType, CHAT_MEDIA_EVENT_TYPE),
            inArray(usageEvents.status, ['pending', 'provider_admitted', 'refund_pending']),
            lt(usageEvents.createdAt, cutoff),
          ),
        )
        .limit(100);
      let reaped = 0;
      let pending = 0;
      for (const row of rows) {
        if (!row.turnId) continue;
        const outcome = await compensateChatMedia({
          authorizationId: row.turnId,
          errorCode: 'media_generation_timeout',
          errorMessage: 'Media generation did not produce an attributable artifact before timeout',
          db: dbc,
          now,
        });
        if (outcome === 'refunded') reaped += 1;
        else if (outcome === 'refund_pending') pending += 1;
      }
      return { scanned: rows.length, reaped, pending };
    } finally {
      this.running = false;
    }
  }
}
