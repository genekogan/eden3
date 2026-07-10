/**
 * Web-side seam over @eden3/shared — the single import point for wire types.
 *
 * Everything on the web<->api contract (zod DTOs, the SessionEvent union,
 * SSE + feed-cursor codecs) re-exports from @eden3/shared. Web-local shapes
 * that are part of the REST contract but not the shared package (response
 * envelopes, request inputs, dev impersonation) live here.
 */

export * from "@eden3/shared";

import type {
  AccountType,
  AgentDto,
  CollectionDto,
  CreationDto,
  MessageDto,
  SessionDto,
  TriggerStatus,
} from "@eden3/shared";

/**
 * Generic page envelope, matching @eden3/shared's `paginated(item)` output:
 * `{ items, nextCursor }` with `nextCursor: null` on the last page.
 * List endpoints name their arrays (`{sessions}`, `{agents}`, `{creations}`);
 * lib/api.ts normalizes them all into this shape.
 */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Response envelopes (GET detail endpoints)
// ---------------------------------------------------------------------------

/** GET /api/agents/:username */
export interface AgentProfile {
  agent: AgentDto;
  memory: AgentMemoryStatus | null;
  recentCreations: CreationDto[];
}

export interface AgentMemoryStatus {
    status: "pending" | "running" | "done" | "skipped" | "error";
    sessionsSampled: number;
    messagesSampled: number;
    memoryChars: number | null;
    model: string | null;
    error: string | null;
    updatedAt: string | null;
    completedAt: string | null;
    summary: string | null;
}

export interface AgentMemorySnapshot extends AgentMemoryStatus {
  collective: {
    filename: "MEMORY.md";
    chars: number;
    content: string | null;
  };
  userFiles: Array<{
    filename: string;
    username: string;
    chars: number;
    summary: string | null;
  }>;
}

export interface AgentMemoryResponse {
  memory: AgentMemorySnapshot;
}

export interface AgentMemoryRebuildResponse {
  queued: boolean;
  memory: AgentMemoryStatus | null;
}

export interface AgentExportBundle {
  kind: "eden3.agent.bundle";
  version: 1;
  exportedAt?: string;
  source?: {
    platform?: string;
    accountId?: string;
    externalId?: string | null;
    username?: string;
  };
  agent: {
    username?: string;
    name: string;
    description?: string | null;
    persona?: string | null;
    greeting?: string | null;
    voice?: string | null;
    public?: boolean;
    model?: string;
    thinkingLevel?: string;
    toolGroups?: string[];
  };
  memory: {
    summary?: string | null;
    items: unknown[];
  };
  skills: unknown[];
  workspaceFiles?: unknown;
}

export interface AgentExportResponse {
  bundle: AgentExportBundle;
}

export interface AgentImportInput {
  username?: string;
  name?: string;
  bundle: AgentExportBundle;
}

export interface AgentImportResult {
  agent: AgentDto;
  imported: {
    bundleVersion: number;
    sourceUsername: string | null;
    skills: number;
    memoryItems: number;
  };
}

// ---------------------------------------------------------------------------
// Workspace browser (GET/PUT /api/agents/:username/workspace*)
// ---------------------------------------------------------------------------

export interface WorkspaceFileEntry {
  path: string;
  kind: "file" | "dir";
  sizeBytes: number;
  /** ISO-8601 mtime. */
  mtime: string;
  /** Present for files ≤ 1MB — the conflict-detection base for saves. */
  sha256?: string;
}

/** GET /api/agents/:username/workspace */
export interface WorkspaceTreeResponse {
  entries: WorkspaceFileEntry[];
  /** True when the listing hit the 2,000-entry server cap. */
  truncated: boolean;
}

export type WorkspaceFileContent =
  | {
      path: string;
      kind: "text";
      content: string;
      sizeBytes: number;
      mtime: string;
      sha256: string;
    }
  | { path: string; kind: "binary"; sizeBytes: number; mtime: string };

/** GET /api/agents/:username/workspace/file?path= */
export interface WorkspaceFileResponse {
  file: WorkspaceFileContent;
}

/** PUT /api/agents/:username/workspace/file — baseSha256 "new" creates. */
export interface WorkspaceSaveInput {
  path: string;
  content: string;
  baseSha256: string;
}

export interface WorkspaceSaveResponse {
  file: {
    path: string;
    kind: "text";
    sizeBytes: number;
    mtime: string;
    sha256: string;
  };
}

/** 409 body of a conflicted save (the agent wrote meanwhile). */
export interface WorkspaceWriteConflict {
  currentSha256: string | null;
  currentMtime: string | null;
}

/** GET /api/sessions/:id — messages ascending; permalinks accept 24-hex ids. */
export interface SessionDetail {
  session: SessionDto;
  messages: MessageDto[];
  /** Cursor for older messages; null when the whole history is present. */
  nextCursor: string | null;
}

/** GET /api/collections/:id */
export interface CollectionDetail {
  collection: CollectionDto;
  creations: CreationDto[];
}

// ---------------------------------------------------------------------------
// Concepts — per-agent reference-image aesthetics
// ---------------------------------------------------------------------------

export interface ConceptImageDto {
  id: string;
  /** Servable /media/<sha256><ext> URL. */
  url: string;
  mime: string;
  width: number | null;
  height: number | null;
  filename: string | null;
  position: number;
  createdAt: string;
}

/** GET /api/agents/:username/concepts item. */
export interface ConceptDto {
  id: string;
  agentId: string;
  name: string;
  slug: string;
  description: string | null;
  instructions: string | null;
  images: ConceptImageDto[];
  createdAt: string;
  updatedAt: string;
}

/** POST /api/agents/:username/concepts */
export interface ConceptCreateInput {
  name: string;
  description?: string;
  instructions?: string;
}

/** PATCH /api/agents/:username/concepts/:slug */
export type ConceptUpdateInput = Partial<ConceptCreateInput>;

/** POST /api/agents/:username/concepts/:slug/images (base64-JSON upload). */
export interface ConceptImageUploadInput {
  filename?: string;
  /** png / jpeg / webp only; the api validates decoded size (≤ 8MB). */
  mime: string;
  dataBase64: string;
}

/** GET /api/agents/:username/activity item — owner logs peek. */
export interface AgentActivityEvent {
  id: string;
  eventType: string;
  status: string;
  sessionId: string | null;
  model: string | null;
  manna: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

/** GET /api/manna */
export interface MannaSummary {
  balance: number;
  subscriptionBalance: number;
  accountId?: string;
  updatedAt?: string;
}

export interface AuthMeResponse {
  user: DevUser | null;
  manna: MannaSummary | null;
}

export interface BillingCheckoutSession {
  id: string;
  url: string | null;
}

export interface BillingSubscriptionSummary {
  status: string;
  tier: string | null;
  monthlyManna: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  updatedAt: string;
}

export interface BillingSubscriptionResponse {
  subscription: BillingSubscriptionSummary | null;
}

export interface VoucherRedeemResult {
  alreadyApplied: boolean;
  amount: number;
  balance: {
    balance: number;
    subscriptionBalance: number;
    total: number;
  };
}

export type ChannelKind =
  | "discord"
  | "telegram"
  | "whatsapp"
  | "slack"
  | "voice";

export interface ChannelConnectionDto {
  id: string;
  accountId: string;
  agentId: string | null;
  channel: ChannelKind;
  label: string | null;
  status: string;
  tokenPreview: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelConnectionCreateInput {
  channel: ChannelKind;
  token: string;
  label?: string;
  agentUsername?: string;
}

export interface ChannelMockMessageResult {
  ok: true;
  channel: ChannelKind;
  routed: true;
  messageLength: number;
}

export type SkillSource = "curated" | "user";
export type SkillStatus = "pending" | "approved" | "rejected";

export interface SkillDefinitionDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  body: string;
  source: SkillSource;
  status: SkillStatus;
  ownerId: string | null;
  reviewerId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkillDto extends SkillDefinitionDto {
  enabled: boolean;
}

export interface AgentSkillsResponse {
  agent: {
    id: string;
    username: string;
    ownerId: string | null;
    public?: boolean;
    openclawId?: string | null;
  };
  attached: AgentSkillDto[];
  skills?: AgentSkillDto[];
  available?: SkillDefinitionDto[];
}

export interface SkillCreateInput {
  slug: string;
  name: string;
  description?: string;
  body: string;
}

export interface SkillReviewInput {
  status: "approved" | "rejected";
}

/** GET /api/operator/usage/summary */
export interface OperatorUsageBreakdown {
  userId?: string | null;
  agentId?: string | null;
  username: string | null;
  events: number;
  costUsd: number;
  manna: number;
}

export interface OperatorStatusBreakdown {
  status: string;
  events: number;
  costUsd: number;
  manna: number;
}

export interface OperatorRecentUsageEvent {
  id: string;
  eventType: string;
  status: string;
  userId: string | null;
  userUsername: string | null;
  agentId: string | null;
  agentUsername: string | null;
  sessionId: string | null;
  messageId: string | null;
  turnId: string | null;
  provider: string | null;
  model: string | null;
  costUsd: number;
  manna: number;
  latencyMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

/** GET /api/operator/health — runtime health panel. */
export interface OperatorHealth {
  ok: boolean;
  gateway:
    | { configured: false }
    | {
        configured: true;
        reachable: boolean;
        latencyMs?: number;
        registeredAgents?: number;
        routableModels?: number;
        error?: string;
      };
  egressProxy:
    | { reachable: true; mode: string }
    | { reachable: false }
    | { reachable: null };
  database: string | null;
  scheduler: { running: boolean };
}

export interface OperatorUsageSummary {
  window: {
    days: number;
    userId: string | null;
    agentId: string | null;
  };
  totals: {
    events: number;
    costUsd: number;
    manna: number;
    avgLatencyMs: number | null;
    errors: number;
  };
  byUser: OperatorUsageBreakdown[];
  byAgent: OperatorUsageBreakdown[];
  byStatus: OperatorStatusBreakdown[];
  recent: OperatorRecentUsageEvent[];
}

// ---------------------------------------------------------------------------
// Request inputs
// ---------------------------------------------------------------------------

/** POST /api/agents */
export interface AgentCreateInput {
  username: string;
  name: string;
  description: string;
  persona: string;
  greeting: string;
  voice?: string;
  model?: string;
  thinkingLevel?: string;
  toolGroups?: string[];
}

/** PATCH /api/agents/:username — create fields plus owner-only visibility. */
export type AgentUpdateInput = Partial<AgentCreateInput> & { public?: boolean };

export interface CollectionCreateInput {
  name: string;
  description?: string;
  public?: boolean;
}

/**
 * Schedule accepted by POST /api/tasks: the eden1 cron dict (snake_case;
 * hour "*" = hourly) or a one-time {at: ISO-8601 instant}.
 */
export type TaskScheduleInput =
  | { at: string }
  | {
      hour: number | string;
      minute: number | string;
      day_of_week?: number | string;
      timezone: string;
    };

/** POST /api/tasks */
export interface TaskCreateInput {
  agentUsername: string;
  name: string;
  prompt: string;
  schedule: TaskScheduleInput;
}

/** PATCH /api/tasks/:id */
export interface TaskUpdateInput {
  status?: Extract<TriggerStatus, "active" | "paused">;
  name?: string;
  prompt?: string;
  schedule?: TaskScheduleInput;
  deleted?: true;
}

/** POST /api/tasks/:id/runs response (`{run}` unwrapped). */
export interface TaskRunResult {
  triggerId: string;
  sessionId: string;
  outcome: {
    turnId: string;
    userMessageId: string;
    assistantMessageId: string | null;
    errorCode: string | null;
  };
  lastRunTime: string;
}

// ---------------------------------------------------------------------------
// Studio
// ---------------------------------------------------------------------------

/**
 * GET /api/studio/tools item. Only `name` is guaranteed; everything else is
 * best-effort (the tool registry is api-owned and still landing).
 */
export interface StudioToolModelOption {
  key: string;
  label: string;
  description?: string | null;
  costManna: number;
  default?: boolean;
}

export interface StudioTool {
  name: string;
  description?: string | null;
  /** e.g. "image" | "video" | "audio" — drives latency hints in the UI. */
  outputType?: string | null;
  costManna?: number | null;
  /** Default quote metadata for the canonical/default args, when available. */
  metering?: StudioGenerationQuote | null;
  /** Model tiers with real prices (cheap default + premium opt-ins). */
  models?: StudioToolModelOption[] | null;
  /** JSON-schema-ish parameter spec; shape not part of the contract. */
  parameters?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface StudioGenerationQuote {
  tool: string;
  action: string;
  provider: string;
  model: string;
  tableVersion: string;
  units: Record<string, number>;
  costUsd: number;
  manna: number;
  estimated: boolean;
  lineItems: Array<{
    unit: string;
    quantity: number;
    usdPerUnit: number;
    costUsd: number;
    estimated?: true;
  }>;
}

export interface StudioGenerationSettlement {
  status: "settled" | "failed";
  reservedManna: number;
  meteredManna: number;
  adjustmentManna: number;
  chargedManna: number;
  transactionId: string | null;
  alreadyApplied: boolean;
  error?: string;
}

/**
 * POST /api/studio/generate response. The request is long-running (images
 * ~2min, video up to 10min) — callers should render a progress state and
 * pass an AbortSignal if they offer cancel.
 */
export interface StudioGeneration {
  creationId: string;
  url: string;
  mime?: string;
  metering?: StudioGenerationQuote;
  settlement?: StudioGenerationSettlement;
}

// ---------------------------------------------------------------------------
// Dev impersonation (Clerk replaces this seam later)
// ---------------------------------------------------------------------------

/**
 * Account row returned by the dev-only impersonation endpoints
 * (`GET /dev/users`, `GET /dev/me`). Deliberately loose — only `id` +
 * `username` are relied upon; `id` is the accounts.id passed back to
 * POST /dev/impersonate as `accountId`.
 */
export interface DevUser {
  id: string;
  username: string;
  type?: AccountType;
  name?: string | null;
  userImage?: string | null;
  isAdmin?: boolean;
}
