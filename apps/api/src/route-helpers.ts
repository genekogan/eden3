import { numericToNumber } from '@eden3/core';
import type { Account, Agent, Creation, Trigger } from '@eden3/db';
import {
  PROVISION_STATUSES,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_THINKING_LEVEL,
  DEFAULT_AGENT_TOOL_GROUPS,
  defaultAgentRuntimeForModel,
  agentToolGroupsSchema,
  agentModelSchema,
  agentThinkingLevelSchema,
  encodeFeedCursor,
  tryDecodeFeedCursor,
  type AccountSummary,
  type AgentDto,
  type AgentRuntime,
  type CollectionDto,
  type CreationDto,
  type CronSchedule,
  type FeedCursor,
  type MannaTransactionDto,
  type ProvisionStatus,
  type TriggerDto,
  type VoiceAssignmentDto,
} from '@eden3/shared';

import { ApiError } from './errors';

/**
 * Shared plumbing for the resource routes: timestamp/cursor codecs for raw
 * postgres.js rows, row -> DTO mappers (snake_case list rows AND drizzle
 * entities), and small SQL utilities.
 *
 * Timestamps: the shared `pg` client is wrapped by drizzle, which strips the
 * timestamptz parsers — raw queries return strings like
 * `2026-07-03 12:34:56.123456+00`. {@link pgToIso} converts them to ISO-8601
 * WITHOUT losing the microsecond precision (Date would truncate to ms, which
 * can skip/duplicate rows at keyset-page boundaries).
 */

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/** Postgres text timestamptz (or a Date) -> ISO-8601 string with offset. */
export function pgToIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  let out = value.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(out)) out = `${out}:00`;
  else if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(out)) out = `${out}Z`;
  return out;
}

// ---------------------------------------------------------------------------
// Keyset cursors (createdAt desc, id desc) — shared codec from @eden3/shared
// ---------------------------------------------------------------------------

/** Parse `?cursor=`; throws a 400 ApiError on malformed input. */
export function parseCursorParam(cursor: string | undefined): FeedCursor | null {
  if (cursor === undefined) return null;
  const decoded = tryDecodeFeedCursor(cursor);
  if (decoded === null) throw new ApiError(400, 'invalid_cursor', 'Malformed cursor');
  return decoded;
}

/**
 * Build the opaque next-page cursor. `rows` is the raw result fetched with
 * `limit + 1`; when it overflows, the cursor points at the LAST row of the
 * returned page. Rows must expose `id` + `created_at` (raw) or `createdAt`.
 */
export function nextCursorFrom(
  rows: readonly { id: string; created_at?: string | Date; createdAt?: string | Date }[],
  limit: number,
): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  if (!last) return null;
  const createdAt = last.created_at ?? last.createdAt;
  if (createdAt === undefined) return null;
  return encodeFeedCursor({ createdAt: pgToIso(createdAt), id: last.id });
}

// ---------------------------------------------------------------------------
// Offset cursors (collection membership pages — position-ordered)
// ---------------------------------------------------------------------------

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

/** Parse an offset cursor; throws a 400 ApiError on malformed input. */
export function parseOffsetCursorParam(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const offset = (parsed as { offset?: unknown }).offset;
    if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) return offset;
  } catch {
    /* fall through */
  }
  throw new ApiError(400, 'invalid_cursor', 'Malformed cursor');
}

// ---------------------------------------------------------------------------
// SQL utilities
// ---------------------------------------------------------------------------

/** Escape LIKE metacharacters so user input matches literally inside %…%. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** True when `err` (or a cause up the chain) is a Postgres unique violation. */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Account summaries
// ---------------------------------------------------------------------------

export interface AccountSummaryRow {
  id: string;
  type: 'user' | 'agent';
  username: string;
  user_image: string | null;
}

export function toAccountSummary(row: AccountSummaryRow): AccountSummary {
  return { id: row.id, type: row.type, username: row.username, userImage: row.user_image };
}

export function accountSummaryFromEntity(account: Account): AccountSummary {
  return {
    id: account.id,
    type: account.type,
    username: account.username,
    userImage: account.userImage,
  };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Legacy provisioner vocabulary → canonical DTO status. */
const PROVISION_ALIASES: Record<string, ProvisionStatus> = {
  provisioned: 'ready',
  error: 'failed',
};

function coerceProvisionStatus(value: string): ProvisionStatus {
  if ((PROVISION_STATUSES as readonly string[]).includes(value)) {
    return value as ProvisionStatus;
  }
  return PROVISION_ALIASES[value] ?? 'pending';
}

/** Raw `accounts JOIN agents` row (snake_case, text timestamps). */
export interface AgentRow {
  id: string;
  external_id: string | null;
  username: string;
  user_image: string | null;
  created_at: string;
  updated_at: string;
  name: string | null;
  description: string | null;
  persona: string | null;
  is_persona_public: boolean;
  greeting: string | null;
  voice: string | null;
  model: string | null;
  thinking_level: string | null;
  tool_groups: unknown | null;
  public: boolean;
  owner_id: string | null;
  is_pilot: boolean;
  is_synthetic: boolean;
  provision_status: string;
  voice_id?: string | null;
  voice_chat_mode?: 'off' | 'on_demand' | 'always' | null;
  voice_discord_mode?: 'off' | 'on_demand' | 'always' | null;
  voice_telegram_mode?: 'off' | 'on_demand' | 'always' | null;
  voice_assignment_updated_at?: string | null;
  like_count?: number;
  viewer_has_liked?: boolean;
}

export interface AgentDtoOptions {
  /** Persona text is owner-gated (agents.is_persona_public); false -> null. */
  includePersona: boolean;
  likeCount?: number;
  viewerHasLiked?: boolean;
  /** Effective config-derived runtime; defaults to the static catalog value. */
  agentRuntime?: AgentRuntime;
  /** Canonical stable voice assignment; null means deliberately unassigned. */
  voiceAssignment?: VoiceAssignmentDto | null;
}

function coerceAgentModel(value: string | null | undefined): AgentDto['model'] {
  const parsed = agentModelSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_AGENT_MODEL;
}

function coerceThinkingLevel(value: string | null | undefined): AgentDto['thinkingLevel'] {
  const parsed = agentThinkingLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_AGENT_THINKING_LEVEL;
}

function coerceToolGroups(value: unknown): AgentDto['toolGroups'] {
  const parsed = agentToolGroupsSchema.safeParse(value ?? DEFAULT_AGENT_TOOL_GROUPS);
  return parsed.success ? parsed.data : [...DEFAULT_AGENT_TOOL_GROUPS];
}

export function agentDtoFromRow(row: AgentRow, opts: AgentDtoOptions): AgentDto {
  const model = coerceAgentModel(row.model);
  return {
    id: row.id,
    externalId: row.external_id,
    username: row.username,
    name: row.name,
    description: row.description,
    persona: opts.includePersona ? row.persona : null,
    greeting: row.greeting,
    voice: row.voice,
    ...(row.voice_id !== undefined
      ? {
          voiceId: row.voice_id,
          voiceAssignment:
            row.voice_id && row.voice_chat_mode && row.voice_discord_mode && row.voice_telegram_mode && row.voice_assignment_updated_at
              ? {
                  voiceId: row.voice_id,
                  delivery: {
                    chat: row.voice_chat_mode,
                    discord: row.voice_discord_mode === 'always' ? 'always' : 'off',
                    telegram: row.voice_telegram_mode === 'always' ? 'always' : 'off',
                  },
                  updatedAt: pgToIso(row.voice_assignment_updated_at),
                }
              : null,
        }
      : {}),
    model,
    agentRuntime: opts.agentRuntime ?? defaultAgentRuntimeForModel(model),
    thinkingLevel: coerceThinkingLevel(row.thinking_level),
    toolGroups: coerceToolGroups(row.tool_groups),
    userImage: row.user_image,
    public: row.public,
    ownerId: row.owner_id,
    isPilot: row.is_pilot,
    isSynthetic: row.is_synthetic,
    ...(row.like_count !== undefined ? { likeCount: row.like_count } : {}),
    ...(row.viewer_has_liked !== undefined ? { viewerHasLiked: row.viewer_has_liked } : {}),
    provisionStatus: coerceProvisionStatus(row.provision_status),
    createdAt: pgToIso(row.created_at),
    updatedAt: pgToIso(row.updated_at),
  };
}

export function agentDtoFromEntities(
  account: Account,
  agent: Agent,
  opts: AgentDtoOptions,
): AgentDto {
  const model = coerceAgentModel(agent.model);
  return {
    id: account.id,
    externalId: account.externalId,
    username: account.username,
    name: agent.name,
    description: agent.description,
    persona: opts.includePersona ? agent.persona : null,
    greeting: agent.greeting,
    voice: agent.voice,
    ...(opts.voiceAssignment !== undefined
      ? { voiceId: opts.voiceAssignment?.voiceId ?? null, voiceAssignment: opts.voiceAssignment }
      : {}),
    model,
    agentRuntime: opts.agentRuntime ?? defaultAgentRuntimeForModel(model),
    thinkingLevel: coerceThinkingLevel(agent.thinkingLevel),
    toolGroups: coerceToolGroups(agent.toolGroups),
    userImage: account.userImage,
    public: agent.public,
    ownerId: agent.ownerId,
    isPilot: agent.isPilot,
    isSynthetic: agent.isSynthetic,
    ...(opts.likeCount !== undefined ? { likeCount: opts.likeCount } : {}),
    ...(opts.viewerHasLiked !== undefined ? { viewerHasLiked: opts.viewerHasLiked } : {}),
    provisionStatus: coerceProvisionStatus(agent.provisionStatus),
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Creations
// ---------------------------------------------------------------------------

/**
 * Raw creations row, optionally carrying `creator_*` / `agent_*` columns from
 * LEFT JOINs on accounts (see {@link CREATION_EMBED_COLUMNS}).
 */
export interface CreationRow {
  id: string;
  external_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  tool: string | null;
  filename: string | null;
  url: string | null;
  thumbnail_url: string | null;
  media_attributes: unknown;
  like_count: number;
  viewer_has_liked?: boolean;
  public: boolean;
  created_at: string;
  updated_at: string;
  creator_id?: string | null;
  creator_type?: 'user' | 'agent' | null;
  creator_username?: string | null;
  creator_user_image?: string | null;
  agent_acct_id?: string | null;
  agent_acct_type?: 'user' | 'agent' | null;
  agent_acct_username?: string | null;
  agent_acct_user_image?: string | null;
}

export function creationDtoFromRow(row: CreationRow): CreationDto {
  const creator: AccountSummary | undefined =
    typeof row.creator_id === 'string' && typeof row.creator_username === 'string'
      ? {
          id: row.creator_id,
          type: row.creator_type ?? 'user',
          username: row.creator_username,
          userImage: row.creator_user_image ?? null,
        }
      : undefined;
  const agent: AccountSummary | undefined =
    typeof row.agent_acct_id === 'string' && typeof row.agent_acct_username === 'string'
      ? {
          id: row.agent_acct_id,
          type: row.agent_acct_type ?? 'agent',
          username: row.agent_acct_username,
          userImage: row.agent_acct_user_image ?? null,
        }
      : undefined;
  return {
    id: row.id,
    externalId: row.external_id,
    userId: row.user_id,
    agentId: row.agent_id,
    tool: row.tool,
    filename: row.filename,
    // Stored URLs are served VERBATIM — legacy CloudFront links pass through.
    url: row.url,
    thumbnailUrl: row.thumbnail_url,
    mediaAttributes: (row.media_attributes as Record<string, unknown> | null) ?? null,
    likeCount: row.like_count,
    ...(row.viewer_has_liked !== undefined ? { viewerHasLiked: row.viewer_has_liked } : {}),
    public: row.public,
    ...(creator !== undefined ? { creator } : {}),
    ...(agent !== undefined ? { agent } : {}),
    createdAt: pgToIso(row.created_at),
    updatedAt: pgToIso(row.updated_at),
  };
}

export function creationDtoFromEntity(
  creation: Creation,
  embeds: {
    creator?: AccountSummary;
    agent?: AccountSummary;
    viewerHasLiked?: boolean;
    reportable?: boolean;
  } = {},
): CreationDto {
  return {
    id: creation.id,
    externalId: creation.externalId,
    userId: creation.userId,
    agentId: creation.agentId,
    tool: creation.tool,
    filename: creation.filename,
    url: creation.url,
    thumbnailUrl: creation.thumbnailUrl,
    mediaAttributes: (creation.mediaAttributes as Record<string, unknown> | null) ?? null,
    likeCount: creation.likeCount,
    ...(embeds.viewerHasLiked !== undefined ? { viewerHasLiked: embeds.viewerHasLiked } : {}),
    public: creation.public,
    ...(embeds.reportable !== undefined ? { reportable: embeds.reportable } : {}),
    ...(embeds.creator !== undefined ? { creator: embeds.creator } : {}),
    ...(embeds.agent !== undefined ? { agent: embeds.agent } : {}),
    createdAt: creation.createdAt.toISOString(),
    updatedAt: creation.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export interface CollectionRow {
  id: string;
  external_id: string | null;
  user_id: string | null;
  name: string | null;
  description: string | null;
  public: boolean;
  created_at: string;
  updated_at: string;
}

export function collectionDtoFromRow(
  row: CollectionRow,
  extras: { creationCount?: number; coverCreations?: CreationDto[] } = {},
): CollectionDto {
  return {
    id: row.id,
    externalId: row.external_id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    public: row.public,
    ...(extras.creationCount !== undefined ? { creationCount: extras.creationCount } : {}),
    ...(extras.coverCreations !== undefined ? { coverCreations: extras.coverCreations } : {}),
    createdAt: pgToIso(row.created_at),
    updatedAt: pgToIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Manna transactions
// ---------------------------------------------------------------------------

export interface MannaTransactionRow {
  id: string;
  manna_account_id: string;
  amount: string;
  /** Nullable in migrated data — old eden1 ledger rows predate the field. */
  type: string | null;
  task_external_id: string | null;
  refunds_transaction_id: string | null;
  created_at: string;
}

export function mannaTransactionDtoFromRow(row: MannaTransactionRow): MannaTransactionDto {
  return {
    id: row.id,
    mannaAccountId: row.manna_account_id,
    amount: numericToNumber(row.amount),
    // The wire contract promises a non-empty string; ~600k migrated rows
    // predate the field, so they surface as "legacy" rather than null.
    type: row.type ?? 'legacy',
    taskExternalId: row.task_external_id,
    refundsTransactionId: row.refunds_transaction_id,
    createdAt: pgToIso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export function triggerDtoFromEntity(
  trigger: Trigger,
  extras: { lastRunSessionId?: string | null } = {},
): TriggerDto {
  return {
    id: trigger.id,
    externalId: trigger.externalId,
    userId: trigger.userId,
    agentId: trigger.agentId,
    name: trigger.name,
    prompt: trigger.prompt,
    schedule: (trigger.schedule as CronSchedule | null) ?? null,
    status: trigger.status,
    sessionTarget: trigger.sessionTarget === 'existing' ? 'existing' : 'new',
    sessionExternalId:
      trigger.sessionTarget === 'existing' ? trigger.sessionExternalId : null,
    lastRunTime: trigger.lastRunTime ? trigger.lastRunTime.toISOString() : null,
    nextScheduledRun: trigger.nextScheduledRun ? trigger.nextScheduledRun.toISOString() : null,
    // Not a column: resolved from the latest run's usage event (see
    // routes/triggers.ts lastRunSessionIds) when the caller provides it.
    lastRunSessionId: extras.lastRunSessionId ?? null,
    lastError: trigger.lastError,
    createdAt: trigger.createdAt.toISOString(),
    updatedAt: trigger.updatedAt.toISOString(),
  };
}
