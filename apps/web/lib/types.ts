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
  recentCreations: CreationDto[];
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

/** GET /api/manna */
export interface MannaSummary {
  balance: number;
  subscriptionBalance: number;
  accountId?: string;
  updatedAt?: string;
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
}

/** PATCH /api/agents/:username */
export type AgentUpdateInput = Partial<AgentCreateInput>;

/** Schedule accepted by POST /api/tasks (eden1 cron dict, snake_case). */
export interface TaskScheduleInput {
  hour: number;
  minute: number;
  day_of_week?: number | string;
  timezone: string;
}

/** POST /api/tasks */
export interface TaskCreateInput {
  agentUsername: string;
  name: string;
  prompt: string;
  schedule: TaskScheduleInput;
}

// ---------------------------------------------------------------------------
// Studio
// ---------------------------------------------------------------------------

/**
 * GET /api/studio/tools item. Only `name` is guaranteed; everything else is
 * best-effort (the tool registry is api-owned and still landing).
 */
export interface StudioTool {
  name: string;
  description?: string | null;
  /** e.g. "image" | "video" | "audio" — drives latency hints in the UI. */
  outputType?: string | null;
  costManna?: number | null;
  /** JSON-schema-ish parameter spec; shape not part of the contract. */
  parameters?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * POST /api/studio/generate response. The request is long-running (images
 * ~2min, video up to 10min) — callers should render a progress state and
 * pass an AbortSignal if they offer cancel.
 */
export interface StudioGeneration {
  creationId: string;
  url: string;
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
}
