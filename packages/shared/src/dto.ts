/**
 * @eden3/shared — zod DTOs for the web<->api contract.
 *
 * Conventions (JSON over the wire):
 * - ids are uuid strings (Postgres uuid PKs).
 * - `externalId` is the preserved Mongo hex id (nullable — eden3-native rows
 *   have none); used for permalinks (`/sessions/<hex>`, `/creations/<hex>`).
 * - timestamps are ISO-8601 strings (`Date#toISOString()` output).
 * - manna amounts are plain JS numbers (API converts Postgres numeric(20,4)).
 * - internal columns (gateway session keys, openclaw job ids, workspace
 *   paths, idempotency keys, soft-delete flags) are NOT part of the contract.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const uuidSchema = z.string().uuid();

/** Preserved Mongo id (24-char hex in practice; kept loose on purpose). */
export const externalIdSchema = z.string().min(1);

/** ISO-8601 timestamp with offset (`2026-07-02T12:34:56.789Z`). */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// Account summary — the embeddable "who" (users and agents share accounts)
// ---------------------------------------------------------------------------

export const accountTypeSchema = z.enum(['user', 'agent']);
export type AccountType = z.infer<typeof accountTypeSchema>;

export const accountSummaryDto = z.object({
  id: uuidSchema,
  type: accountTypeSchema,
  username: z.string().min(1),
  userImage: z.string().nullable(),
});
export type AccountSummary = z.infer<typeof accountSummaryDto>;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const PROVISION_STATUSES = ['pending', 'provisioning', 'ready', 'failed'] as const;
export const provisionStatusSchema = z.enum(PROVISION_STATUSES);
export type ProvisionStatus = z.infer<typeof provisionStatusSchema>;

export const AGENT_MODEL_OPTIONS = [
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-opus-4-6',
] as const;
export const DEFAULT_AGENT_MODEL = AGENT_MODEL_OPTIONS[0];
export const agentModelSchema = z.enum(AGENT_MODEL_OPTIONS);
export type AgentModel = z.infer<typeof agentModelSchema>;

/** OpenClaw 7.1 model-scoped execution backends supported by Eden3. */
export const AGENT_RUNTIME_OPTIONS = ['openclaw', 'claude-cli'] as const;
export const agentRuntimeSchema = z.enum(AGENT_RUNTIME_OPTIONS);
export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;

/**
 * Runtime defaults are model-scoped because OpenClaw stores `agentRuntime`
 * under `agents.defaults.models.<provider/model>`. Sonnet 4.6 is the explicit
 * subscription-backed lane; existing API-backed models remain API-backed
 * until an operator flips them.
 */
export const DEFAULT_AGENT_RUNTIME_BY_MODEL: Readonly<Record<AgentModel, AgentRuntime>> = {
  'anthropic/claude-haiku-4-5': 'openclaw',
  'anthropic/claude-sonnet-4-5': 'openclaw',
  'anthropic/claude-sonnet-4-6': 'claude-cli',
  'anthropic/claude-opus-4-6': 'openclaw',
};

export function defaultAgentRuntimeForModel(model: AgentModel): AgentRuntime {
  return DEFAULT_AGENT_RUNTIME_BY_MODEL[model];
}

export const modelRuntimeDto = z.object({
  model: agentModelSchema,
  agentRuntime: agentRuntimeSchema,
});
export type ModelRuntimeDto = z.infer<typeof modelRuntimeDto>;

export const AGENT_THINKING_LEVELS = ['fast', 'balanced', 'deep'] as const;
export const DEFAULT_AGENT_THINKING_LEVEL = 'balanced';
export const agentThinkingLevelSchema = z.enum(AGENT_THINKING_LEVELS);
export type AgentThinkingLevel = z.infer<typeof agentThinkingLevelSchema>;

export const AGENT_TOOL_GROUP_OPTIONS = [
  'group:runtime',
  'group:fs',
  'group:web',
  'group:sessions',
  'group:memory',
  'group:media',
  'group:ui',
  'group:automation',
  'group:agents',
  'group:plugins',
] as const;
export const DEFAULT_AGENT_TOOL_GROUPS = [...AGENT_TOOL_GROUP_OPTIONS];
export const agentToolGroupSchema = z.enum(AGENT_TOOL_GROUP_OPTIONS);
export type AgentToolGroup = z.infer<typeof agentToolGroupSchema>;
export const agentToolGroupsSchema = z.array(agentToolGroupSchema);

export const agentDto = z.object({
  /** accounts.id of the agent account (agents are 1:1 extensions of accounts). */
  id: uuidSchema,
  externalId: externalIdSchema.nullable(),
  username: z.string().min(1),
  name: z.string().nullable(),
  description: z.string().nullable(),
  persona: z.string().nullable(),
  greeting: z.string().nullable(),
  voice: z.string().nullable(),
  model: agentModelSchema,
  /** Effective model-scoped OpenClaw runtime; never a per-agent override. */
  agentRuntime: agentRuntimeSchema,
  thinkingLevel: agentThinkingLevelSchema,
  toolGroups: agentToolGroupsSchema,
  userImage: z.string().nullable(),
  public: z.boolean(),
  ownerId: uuidSchema.nullable(),
  isPilot: z.boolean(),
  isSynthetic: z.boolean(),
  /** Optional social fields when a route includes interaction state. */
  likeCount: z.number().int().nonnegative().optional(),
  viewerHasLiked: z.boolean().optional(),
  provisionStatus: provisionStatusSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AgentDto = z.infer<typeof agentDto>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const sessionDto = z.object({
  id: uuidSchema,
  externalId: externalIdSchema.nullable(),
  ownerId: uuidSchema.nullable(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  sessionType: z.string().nullable(),
  platform: z.string().nullable(),
  /** Hosted channel mirror; null for normal webchat sessions. */
  channelConnectionId: uuidSchema.nullable(),
  /** Channel mirrors are observable in Eden but cannot be injected into. */
  readOnly: z.boolean(),
  /** Agent accounts.id members (session_agents). */
  agentIds: z.array(uuidSchema),
  /** User accounts.id members (session_users). */
  userIds: z.array(uuidSchema),
  /** Optional embedded member summaries (when the API joins them in). */
  agents: z.array(accountSummaryDto).optional(),
  lastMessageAt: isoDateTimeSchema.nullable(),
  messageCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type SessionDto = z.infer<typeof sessionDto>;

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/** Canonical roles; migrated rows may carry other historical strings. */
export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const messageAttachmentDto = z.object({
  url: z.string().min(1),
  mime: z.string().nullish(),
  /** Set when the attachment is a first-class creation. */
  creationId: uuidSchema.nullish(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
});
export type MessageAttachment = z.infer<typeof messageAttachmentDto>;

export const messageDto = z.object({
  id: uuidSchema,
  externalId: externalIdSchema.nullable(),
  sessionId: uuidSchema,
  senderId: uuidSchema.nullable(),
  /** Compare against MESSAGE_ROLES; kept loose for migrated data. */
  role: z.string().nullable(),
  content: z.string().nullable(),
  attachments: z.array(messageAttachmentDto),
  toolCalls: z.array(z.record(z.string(), z.unknown())).nullable(),
  reactions: z.record(z.string(), z.unknown()).nullable(),
  replyToExternalId: externalIdSchema.nullable(),
  /** Optional embedded sender summary (when the API joins it in). */
  sender: accountSummaryDto.optional(),
  createdAt: isoDateTimeSchema,
});
export type MessageDto = z.infer<typeof messageDto>;

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export const creationDto = z.object({
  id: uuidSchema,
  externalId: externalIdSchema.nullable(),
  userId: uuidSchema.nullable(),
  agentId: uuidSchema.nullable(),
  tool: z.string().nullable(),
  filename: z.string().nullable(),
  /** Legacy rows: CloudFront/S3 URL. New rows: local media URL. */
  url: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  mediaAttributes: z.record(z.string(), z.unknown()).nullable(),
  likeCount: z.number().int().nonnegative(),
  /** Present when the viewer is authenticated or the route computes it. */
  viewerHasLiked: z.boolean().optional(),
  public: z.boolean(),
  /** Optional embedded creator summaries (when the API joins them in). */
  creator: accountSummaryDto.optional(),
  agent: accountSummaryDto.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type CreationDto = z.infer<typeof creationDto>;

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export const collectionDto = z.object({
  id: uuidSchema,
  externalId: externalIdSchema.nullable(),
  userId: uuidSchema.nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  public: z.boolean(),
  /** Number of member creations (list views). */
  creationCount: z.number().int().nonnegative().optional(),
  /** Optional cover thumbnails (first few member creations). */
  coverCreations: z.array(creationDto).optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type CollectionDto = z.infer<typeof collectionDto>;

// ---------------------------------------------------------------------------
// Manna
// ---------------------------------------------------------------------------

export const mannaBalanceDto = z.object({
  accountId: uuidSchema,
  balance: z.number().finite(),
  subscriptionBalance: z.number().finite(),
  updatedAt: isoDateTimeSchema,
});
export type MannaBalanceDto = z.infer<typeof mannaBalanceDto>;

export const mannaTransactionDto = z.object({
  id: uuidSchema,
  mannaAccountId: uuidSchema,
  /** Negative = debit, positive = credit/refund. */
  amount: z.number().finite(),
  type: z.string().min(1),
  taskExternalId: externalIdSchema.nullable(),
  refundsTransactionId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type MannaTransactionDto = z.infer<typeof mannaTransactionDto>;

// ---------------------------------------------------------------------------
// Trigger (scheduled prompt, synced to OpenClaw cron)
// ---------------------------------------------------------------------------

/**
 * eden1 schedule dict (APScheduler-style), stored as-is in triggers.schedule
 * jsonb — snake_case keys preserved from the source system. One-time tasks
 * store `{at: <ISO-8601 instant>}` instead of the recurring fields.
 */
export const cronScheduleDto = z.object({
  /** One-time schedule: fire once at this ISO-8601 instant. */
  at: z.string().optional(),
  year: z.union([z.number().int(), z.string()]).optional(),
  month: z.union([z.number().int(), z.string()]).optional(),
  day: z.union([z.number().int(), z.string()]).optional(),
  week: z.union([z.number().int(), z.string()]).optional(),
  day_of_week: z.union([z.number().int(), z.string()]).optional(),
  hour: z.union([z.number().int(), z.string()]).optional(),
  minute: z.union([z.number().int(), z.string()]).optional(),
  second: z.union([z.number().int(), z.string()]).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  timezone: z.string().optional(),
});
export type CronSchedule = z.infer<typeof cronScheduleDto>;

export const TRIGGER_STATUSES = ['active', 'paused', 'finished', 'running'] as const;
export const triggerStatusSchema = z.enum(TRIGGER_STATUSES);
export type TriggerStatus = z.infer<typeof triggerStatusSchema>;

export const triggerDto = z.object({
  id: uuidSchema,
  externalId: externalIdSchema.nullable(),
  userId: uuidSchema.nullable(),
  agentId: uuidSchema.nullable(),
  name: z.string().nullable(),
  prompt: z.string().nullable(),
  schedule: cronScheduleDto.nullable(),
  status: z.string().nullable(),
  lastRunTime: isoDateTimeSchema.nullable(),
  nextScheduledRun: isoDateTimeSchema.nullable(),
  /**
   * Session the most recent run wrote its transcript into (resolved from the
   * run's usage event; null until a metered run happens).
   */
  lastRunSessionId: uuidSchema.nullable(),
  lastError: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type TriggerDto = z.infer<typeof triggerDto>;

// ---------------------------------------------------------------------------
// Chat (the web -> api seam that starts a streamed turn)
// ---------------------------------------------------------------------------

export const chatRequestDto = z.object({
  agentId: uuidSchema,
  /** Omit to start a new session with the agent. */
  sessionId: uuidSchema.optional(),
  content: z.string().min(1),
});
export type ChatRequestDto = z.infer<typeof chatRequestDto>;

export const chatResponseDto = z.object({
  sessionId: uuidSchema,
  turnId: uuidSchema,
  /** The persisted user message. */
  messageId: uuidSchema,
});
export type ChatResponseDto = z.infer<typeof chatResponseDto>;

// ---------------------------------------------------------------------------
// Feed pagination — opaque keyset cursor over (createdAt desc, id desc)
// ---------------------------------------------------------------------------

export const feedCursorSchema = z.object({
  createdAt: isoDateTimeSchema,
  id: uuidSchema,
});
export type FeedCursor = z.infer<typeof feedCursorSchema>;

export const FEED_DEFAULT_LIMIT = 24;
export const FEED_MAX_LIMIT = 100;

/** Query params accepted by paginated feed endpoints (`?cursor=&limit=`). */
export const feedQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(FEED_MAX_LIMIT).default(FEED_DEFAULT_LIMIT),
});
export type FeedQuery = z.infer<typeof feedQuerySchema>;

/** Build a page schema around any item DTO: `{ items, nextCursor }`. */
export function paginated<Item extends z.ZodTypeAny>(item: Item) {
  return z.object({
    items: z.array(item),
    /** Opaque cursor for the next page; null = no more pages. */
    nextCursor: z.string().nullable(),
  });
}

export const feedPageDto = paginated(creationDto);
export type FeedPageDto = z.infer<typeof feedPageDto>;

// --- opaque cursor codec (base64url JSON; btoa/atob exist in Node >= 16 and
// --- browsers, TextEncoder/TextDecoder keep it unicode-safe) ---------------

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Encode a keyset cursor into the opaque string handed to clients. */
export function encodeFeedCursor(cursor: FeedCursor): string {
  return toBase64Url(JSON.stringify(feedCursorSchema.parse(cursor)));
}

/** Decode an opaque cursor; throws on malformed input (API should 400). */
export function decodeFeedCursor(encoded: string): FeedCursor {
  const cursor = tryDecodeFeedCursor(encoded);
  if (cursor === null) throw new Error('Invalid feed cursor');
  return cursor;
}

/** Decode an opaque cursor; returns null on malformed input. */
export function tryDecodeFeedCursor(encoded: string): FeedCursor | null {
  let json: unknown;
  try {
    json = JSON.parse(fromBase64Url(encoded));
  } catch {
    return null;
  }
  const parsed = feedCursorSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
