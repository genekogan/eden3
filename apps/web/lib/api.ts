/**
 * Typed fetch client for the eden3 api (@eden3/api, Fastify on :4301) —
 * the FULL web<->api contract in one place.
 *
 * In the browser ordinary JSON calls go same-origin through the Next rewrite
 * (/api/* -> :4301/*, cookies flow by default). Long-running Studio and chat
 * streaming calls use NEXT_PUBLIC_API_ORIGIN when configured so a framework
 * proxy timeout cannot terminate them. On the server (RSC/route handlers) the
 * client targets the api origin directly. Wire shapes are the
 * @eden3/shared DTOs plus the envelope types in lib/types.ts.
 *
 * Streaming:
 *   - `sseStream(path, body)`   POSTs, then parses the SSE response body
 *                               (chat turns: POST /sessions/(new|:id)/messages).
 *   - `subscribeSession(id)`    EventSource on GET /sessions/:id/events —
 *                               keep open while viewing a session to catch
 *                               async media.attached / manna.updated.
 *   Both broadcast `manna.updated` onto a window event so the sidebar
 *   MannaBadge stays live (see onMannaUpdate/emitMannaUpdate).
 *
 * The api is being built in parallel: some routes may 501/404 while the
 * backend workflow lands — callers should branch on isEndpointMissing /
 * isApiUnavailable instead of blocking on live data.
 */

import {
  decodeSessionEventData,
  streamSseBody,
  subscribeSessionEvents,
} from "./sse";
import type { SessionEventStreamOptions, StreamSseOptions } from "./sse";
import { getClerkToken } from "./clerk";
import type {
  AgentActivityEvent,
  AgentAvatarUploadInput,
  AgentCreateInput,
  AgentDto,
  AgentExportResponse,
  AgentImportInput,
  AgentImportResult,
  AgentMemoryRebuildResponse,
  AgentMemoryResponse,
  AgentProfile,
  AgentModel,
  AgentRuntime,
  AgentUpdateInput,
  AuthMeResponse,
  BillingCheckoutSession,
  BillingSubscriptionResponse,
  BillingSubscriptionSummary,
  ChannelConnectionCreateInput,
  ChannelConnectionDto,
  ChannelDestinationDto,
  ChannelMockMessageResult,
  ChannelPairingRequestDto,
  CollectionDetail,
  CollectionCreateInput,
  CollectionDto,
  ConceptCreateInput,
  ConceptDto,
  ConceptImageUploadInput,
  ConceptUpdateInput,
  ContentReportDto,
  CreationDto,
  DevUser,
  MannaSummary,
  MannaTransactionDto,
  MessageDto,
  ModelRuntimeDto,
  Paginated,
  OperatorHealth,
  OperatorUsageSummary,
  OwnedSearchResponseDto,
  PublicSessionShareDto,
  SessionShareCreateInputDto,
  SessionShareCreateResponseDto,
  SessionShareListResponseDto,
  SessionShareSummaryDto,
  UserUsageSummary,
  AgentSkillsResponse,
  AppNotificationsResponseDto,
  SessionDetail,
  SessionDto,
  SessionEvent,
  SkillCreateInput,
  SkillDefinitionDto,
  SkillReviewInput,
  StudioGeneration,
  StudioGenerationQuote,
  StudioTool,
  TaskCreateInput,
  TaskRunInput,
  TaskRunResult,
  TaskUpdateInput,
  TelegramManagedBotOnboardingStart,
  TelegramManagedBotOnboardingStatus,
  TriggerDto,
  VoucherRedeemResult,
  WorkspaceFileResponse,
  WorkspaceSaveInput,
  WorkspaceSaveResponse,
  WorkspaceTreeResponse,
  XConnectionCreateInput,
  XConnectionDto,
} from "./types";

// ---------------------------------------------------------------------------
// Base fetch
// ---------------------------------------------------------------------------

function publicApiOrigin(): string | null {
  const origin = process.env.NEXT_PUBLIC_API_ORIGIN?.trim();
  return origin ? origin.replace(/\/+$/, "") : null;
}

function apiBase(opts: { direct?: boolean } = {}): string {
  if (typeof window !== "undefined") {
    return opts.direct ? (publicApiOrigin() ?? "/api") : "/api";
  }
  return (
    process.env.API_INTERNAL_URL ??
    `http://127.0.0.1:${process.env.API_PORT ?? "4301"}`
  );
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** Route not implemented (501) or not registered yet (404). */
export function isEndpointMissing(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 501 || error.status === 404)
  );
}

/** Network failure (api process not running) or missing endpoint. */
export function isApiUnavailable(error: unknown): boolean {
  return isEndpointMissing(error) || !(error instanceof ApiError);
}

async function toApiError(res: Response, path: string): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const tokenBearingShareRequest = /^\/shares\/[^/?#]+/.test(path);
  const detail =
    body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : body &&
          typeof body === "object" &&
          "error" in body &&
          (body as { error?: unknown }).error &&
          typeof (body as { error: unknown }).error === "object" &&
          "message" in ((body as { error: object }).error)
        ? String(((body as { error: { message: unknown } }).error).message)
      : res.statusText;
  const safePath = path.replace(/^\/shares\/[^/?#]+/, "/shares/[redacted]");
  return new ApiError(
    res.status,
    tokenBearingShareRequest
      ? `${res.status} ${safePath}: share lookup failed`
      : `${res.status} ${safePath}: ${detail}`,
    tokenBearingShareRequest ? undefined : body,
  );
}

async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  opts: { direct?: boolean } = {},
): Promise<T> {
  const clerkToken = await getClerkToken();
  const res = await fetch(`${apiBase(opts)}${path}`, {
    cache: "no-store",
    credentials:
      init.credentials ?? (typeof window !== "undefined" ? "include" : undefined),
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...(clerkToken ? { authorization: `Bearer ${clerkToken}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw await toApiError(res, path);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function get<T>(path: string, init: RequestInit = {}): Promise<T> {
  return apiFetch<T>(path, init);
}

/** Fetch a raw (non-JSON) response body — file downloads / zip exports. */
async function apiBlob(path: string): Promise<Blob> {
  const clerkToken = await getClerkToken();
  const res = await fetch(`${apiBase()}${path}`, {
    cache: "no-store",
    credentials: typeof window !== "undefined" ? "include" : undefined,
    headers: clerkToken ? { authorization: `Bearer ${clerkToken}` } : undefined,
  });
  if (!res.ok) throw await toApiError(res, path);
  return res.blob();
}

function post<T>(
  path: string,
  body?: unknown,
  init: RequestInit = {},
  opts: { direct?: boolean } = {},
): Promise<T> {
  return apiFetch<T>(
    path,
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    },
    opts,
  );
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Envelope normalization
// ---------------------------------------------------------------------------

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * Normalize a list response into `{items, nextCursor}`. List endpoints name
 * their arrays (`{sessions}`, `{agents}`, `{creations}`, …) — pass those
 * names as `keys`; canonical `{items}` and bare arrays are always accepted.
 * Exported for tests.
 */
export function toPaginated<T>(data: unknown, ...keys: string[]): Paginated<T> {
  if (Array.isArray(data)) return { items: data as T[], nextCursor: null };
  const obj = asRecord(data);
  for (const key of [...keys, "items", "docs", "results"]) {
    const items = obj[key];
    if (Array.isArray(items)) {
      return {
        items: items as T[],
        nextCursor: typeof obj.nextCursor === "string" ? obj.nextCursor : null,
      };
    }
  }
  return { items: [], nextCursor: null };
}

/** Unwrap `{agent: {...}}`-style single-entity envelopes (or pass through). */
function unwrap<T>(data: unknown, key: string): T {
  const inner = asRecord(data)[key];
  if (inner && typeof inner === "object") return inner as T;
  return data as T;
}

// ---------------------------------------------------------------------------
// Live manna broadcast (sidebar badge <- any active stream)
// ---------------------------------------------------------------------------

export const MANNA_EVENT = "eden3:manna.updated";

/**
 * Announce a balance change app-wide (streams do this automatically for
 * manna.updated events; call with no argument to request a refetch, e.g.
 * after impersonating a different user).
 */
export function emitMannaUpdate(balance?: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MANNA_EVENT, { detail: { balance } }));
}

/** Listen for manna changes; returns an unsubscribe function. */
export function onMannaUpdate(
  listener: (balance: number | undefined) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ balance?: number }>).detail;
    listener(typeof detail?.balance === "number" ? detail.balance : undefined);
  };
  window.addEventListener(MANNA_EVENT, handler);
  return () => window.removeEventListener(MANNA_EVENT, handler);
}

function withMannaBroadcast(event: SessionEvent): SessionEvent {
  if (event.type === "manna.updated") emitMannaUpdate(event.balance);
  return event;
}

// ---------------------------------------------------------------------------
// Dev-user broadcast (impersonation switch -> DevUserGate / any listener)
// ---------------------------------------------------------------------------

export const DEV_USER_EVENT = "eden3:dev-user.changed";

/** Announce that the impersonated user changed (DevUserSwitcher emits this). */
export function emitDevUserChange(user: DevUser | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DEV_USER_EVENT, { detail: { user } }));
}

/** Listen for impersonation changes; returns an unsubscribe function. */
export function onDevUserChange(
  listener: (user: DevUser | null) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ user?: DevUser | null }>).detail;
    listener(detail?.user ?? null);
  };
  window.addEventListener(DEV_USER_EVENT, handler);
  return () => window.removeEventListener(DEV_USER_EVENT, handler);
}

// ---------------------------------------------------------------------------
// Agent-inventory broadcast (create/import/profile/avatar -> shell selector)
// ---------------------------------------------------------------------------

export const AGENT_INVENTORY_EVENT = "eden3:agent-inventory.changed";

/** Invalidate the shell's owned-agent inventory after a successful mutation. */
export function emitAgentInventoryChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AGENT_INVENTORY_EVENT));
}

/** Listen for owned-agent mutations; returns an unsubscribe function. */
export function onAgentInventoryChange(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(AGENT_INVENTORY_EVENT, listener);
  return () => window.removeEventListener(AGENT_INVENTORY_EVENT, listener);
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface SseStreamOptions extends StreamSseOptions {
  /** Abort to cancel the turn stream (closes the HTTP request). */
  signal?: AbortSignal;
}

/**
 * Open a long-running POST SSE response through the direct API origin when
 * one is configured. Kept as one transport seam so the generic client and the
 * new-chat raw-response path share Clerk auth, cookies, cancellation, and the
 * proxy-timeout bypass.
 */
export async function openSseResponse(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const clerkToken = await getClerkToken();
  return fetch(`${apiBase({ direct: true })}${path}`, {
    method: "POST",
    cache: "no-store",
    credentials: typeof window !== "undefined" ? "include" : undefined,
    ...(signal ? { signal } : {}),
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      ...(clerkToken ? { authorization: `Bearer ${clerkToken}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}

/**
 * POST `body` to an SSE endpoint and iterate the typed @eden3/shared events
 * from the response body:
 *
 *   for await (const ev of sseStream("/sessions/new/messages", {...})) { … }
 *
 * Lifecycle: turn.started -> token* -> turn.completed, with media.pending /
 * media.attached / manna.updated interleaved and error possibly replacing
 * any of them. Throws ApiError on a non-2xx response (e.g. 402 insufficient
 * manna) before any event is yielded.
 */
export async function* sseStream(
  path: string,
  body: unknown,
  options: SseStreamOptions = {},
): AsyncGenerator<SessionEvent, void, undefined> {
  const res = await openSseResponse(path, body, options.signal);
  if (!res.ok) throw await toApiError(res, path);
  if (!res.body) {
    throw new ApiError(res.status, `${res.status} ${path}: empty stream body`);
  }
  for await (const event of streamSseBody(res.body, options)) {
    yield withMannaBroadcast(event);
  }
}

/**
 * Long-lived EventSource on GET /api/sessions/:id/events. Subscribe while a
 * session is on screen so async media (media.attached) and balance changes
 * land without a refresh. Returns an unsubscribe function; browser-only.
 */
export function subscribeSession(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
  options: SessionEventStreamOptions = {},
): () => void {
  return subscribeSessionEvents(
    sessionId,
    (event) => onEvent(withMannaBroadcast(event)),
    options,
  );
}

/** Account-scoped notification SSE. Initial/history authority stays in GET. */
export function subscribeNotifications(
  onCreated: () => void,
  options: { url?: string; onConnectionError?: (event: Event) => void } = {},
): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource(options.url ?? "/api/notifications/events");
  // Re-read durable authority after every initial connect/reconnect. This
  // closes the process-death window between DB commit and best-effort publish
  // without introducing polling.
  source.onopen = () => onCreated();
  source.onmessage = (message: MessageEvent<string>) => {
    const event = decodeSessionEventData(message.data);
    if (event?.type === "notification.created" || event?.type === "notification.changed") {
      onCreated();
    }
  };
  if (options.onConnectionError) source.onerror = options.onConnectionError;
  return () => source.close();
}

// ---------------------------------------------------------------------------
// Detail-envelope normalizers (tolerant of a bare DTO while the api lands)
// ---------------------------------------------------------------------------

function toAgentProfile(data: unknown): AgentProfile {
  const obj = asRecord(data);
  return {
    agent: (obj.agent ?? data) as AgentDto,
    memory:
      obj.memory && typeof obj.memory === "object"
        ? (obj.memory as AgentProfile["memory"])
        : null,
    recentCreations: Array.isArray(obj.recentCreations)
      ? (obj.recentCreations as CreationDto[])
      : [],
  };
}

function toSessionDetail(data: unknown): SessionDetail {
  const obj = asRecord(data);
  return {
    session: (obj.session ?? data) as SessionDto,
    messages: Array.isArray(obj.messages) ? (obj.messages as MessageDto[]) : [],
    nextCursor: typeof obj.nextCursor === "string" ? obj.nextCursor : null,
  };
}

function toCollectionDetail(data: unknown): CollectionDetail {
  const obj = asRecord(data);
  return {
    collection: (obj.collection ?? data) as CollectionDto,
    creations: Array.isArray(obj.creations)
      ? (obj.creations as CreationDto[])
      : [],
  };
}

function toMannaSummary(data: unknown): MannaSummary {
  const obj = asRecord(data);
  return {
    balance: typeof obj.balance === "number" ? obj.balance : 0,
    subscriptionBalance:
      typeof obj.subscriptionBalance === "number" ? obj.subscriptionBalance : 0,
    ...(typeof obj.accountId === "string" ? { accountId: obj.accountId } : {}),
    ...(typeof obj.updatedAt === "string" ? { updatedAt: obj.updatedAt } : {}),
  };
}

function toAuthMe(data: unknown): AuthMeResponse {
  const obj = asRecord(data);
  const rawUser = obj.user;
  const rawManna = obj.manna;
  return {
    user:
      rawUser && typeof rawUser === "object"
        ? (rawUser as DevUser)
        : null,
    manna:
      rawManna && typeof rawManna === "object"
        ? toMannaSummary(rawManna)
        : null,
    accessGated: obj.accessGated === true,
  };
}

function toBillingSubscription(data: unknown): BillingSubscriptionResponse {
  const obj = asRecord(data);
  const raw = obj.subscription;
  if (!raw || typeof raw !== "object") return { subscription: null };
  const sub = raw as Record<string, unknown>;
  return {
    subscription: {
      status: typeof sub.status === "string" ? sub.status : "unknown",
      tier: typeof sub.tier === "string" ? sub.tier : null,
      monthlyManna:
        typeof sub.monthlyManna === "number" ? sub.monthlyManna : 0,
      currentPeriodEnd:
        typeof sub.currentPeriodEnd === "string" ? sub.currentPeriodEnd : null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
      updatedAt: typeof sub.updatedAt === "string" ? sub.updatedAt : "",
    },
  };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export const api = {
  auth: {
    /** GET /api/auth/me — current signed-in or impersonated account plus manna. */
    async me(): Promise<AuthMeResponse> {
      return toAuthMe(await get<unknown>("/auth/me"));
    },
  },

  account: {
    /** GET /api/account/export — complete owner-scoped account ZIP. */
    exportBundle(): Promise<Blob> {
      return apiBlob("/account/export");
    },
  },

  notifications: {
    list(limit = 30): Promise<AppNotificationsResponseDto> {
      return get<AppNotificationsResponseDto>(`/notifications${qs({ limit })}`);
    },
    markRead(id: string): Promise<{ ok: true }> {
      return post<{ ok: true }>(`/notifications/${enc(id)}/read`);
    },
    markAllRead(): Promise<{ ok: true; updated: number }> {
      return post<{ ok: true; updated: number }>("/notifications/read-all");
    },
    dismiss(id: string): Promise<void> {
      return apiFetch<void>(`/notifications/${enc(id)}`, { method: "DELETE" });
    },
    subscribe(onCreated: () => void): () => void {
      return subscribeNotifications(onCreated);
    },
  },

  search: {
    /** GET /api/search?q= — committed content owned by the current viewer. */
    owned(
      q: string,
      options: { signal?: AbortSignal; limit?: number } = {},
    ): Promise<OwnedSearchResponseDto> {
      return apiFetch<OwnedSearchResponseDto>(
        `/search${qs({ q, limit: options.limit })}`,
        { signal: options.signal },
      );
    },
  },

  shares: {
    list(sessionId: string): Promise<SessionShareListResponseDto> {
      return get<SessionShareListResponseDto>(`/sessions/${enc(sessionId)}/shares`);
    },

    create(
      sessionId: string,
      input: SessionShareCreateInputDto,
    ): Promise<SessionShareCreateResponseDto> {
      return post<SessionShareCreateResponseDto>(`/sessions/${enc(sessionId)}/shares`, input);
    },

    async revoke(sessionId: string, shareId: string): Promise<SessionShareSummaryDto> {
      return unwrap<SessionShareSummaryDto>(
        await apiFetch<unknown>(`/sessions/${enc(sessionId)}/shares/${enc(shareId)}`, {
          method: "DELETE",
        }),
        "share",
      );
    },

    /** Unauthenticated, unlisted token lookup used by the public SSR page. */
    public(token: string): Promise<PublicSessionShareDto> {
      return get<PublicSessionShareDto>(`/shares/${enc(token)}`);
    },
  },

  sessions: {
    /** GET /api/sessions?cursor&agent — agent filters to that agent's sessions. */
    async list(
      params: { cursor?: string; agent?: string; archived?: "active" | "archived" } = {},
    ): Promise<Paginated<SessionDto>> {
      return toPaginated<SessionDto>(
        await get<unknown>(`/sessions${qs(params)}`),
        "sessions",
      );
    },

    /** GET /api/sessions/:id — accepts uuid or legacy 24-hex permalink ids. */
    async get(id: string): Promise<SessionDetail> {
      return toSessionDetail(await get<unknown>(`/sessions/${enc(id)}`));
    },

    /** Rename, pin/unpin, or archive/unarchive one owned conversation. */
    async update(
      id: string,
      body: { title?: string; pinned?: boolean; archived?: boolean },
    ): Promise<SessionDto> {
      return unwrap<SessionDto>(
        await apiFetch<unknown>(`/sessions/${enc(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        "session",
      );
    },

    /** Soft-delete one owned conversation. */
    async remove(id: string): Promise<void> {
      await apiFetch<unknown>(`/sessions/${enc(id)}`, { method: "DELETE" });
    },

    /**
     * POST /api/sessions/new/messages — start a session with an agent and
     * stream the first turn. The new session's id arrives on `turn.started`.
     */
    sendNew(
      body: { content: string; agentUsername: string },
      options?: SseStreamOptions,
    ): AsyncGenerator<SessionEvent, void, undefined> {
      return sseStream("/sessions/new/messages", body, options);
    },

    /** POST /api/sessions/:id/messages — send into an existing session. */
    send(
      id: string,
      content: string,
      options?: SseStreamOptions,
    ): AsyncGenerator<SessionEvent, void, undefined> {
      return sseStream(`/sessions/${enc(id)}/messages`, { content }, options);
    },

    /** GET /api/sessions/:id/events — see subscribeSession. */
    subscribe(
      id: string,
      onEvent: (event: SessionEvent) => void,
      options?: SessionEventStreamOptions,
    ): () => void {
      return subscribeSession(id, onEvent, options);
    },
  },

  agents: {
    /**
     * GET /api/agents?q&cursor&scope — the cockpit only ever lists the
     * viewer's own agents (scope "mine"; the public directory is out of
     * scope for this app — cross-user browsing returns as a separate app).
     */
    async list(
      params: { q?: string; cursor?: string; scope?: "mine" } = {},
    ): Promise<Paginated<AgentDto>> {
      return toPaginated<AgentDto>(
        await get<unknown>(`/agents${qs(params)}`),
        "agents",
      );
    },

    /** GET /api/agents/:username -> {agent, recentCreations[]} */
    async get(username: string): Promise<AgentProfile> {
      return toAgentProfile(await get<unknown>(`/agents/${enc(username)}`));
    },

    /** POST /api/agents */
    async create(input: AgentCreateInput): Promise<AgentDto> {
      const agent = unwrap<AgentDto>(await post<unknown>("/agents", input), "agent");
      emitAgentInventoryChange();
      return agent;
    },

    /** GET /api/agents/:username/export -> portable JSON bundle. */
    exportBundle(username: string): Promise<AgentExportResponse> {
      return get<AgentExportResponse>(`/agents/${enc(username)}/export`);
    },

    /** GET /api/agents/:username/memory -> owner/admin runtime memory files. */
    memory(username: string): Promise<AgentMemoryResponse> {
      return get<AgentMemoryResponse>(`/agents/${enc(username)}/memory`);
    },

    /** PUT /api/agents/:username/memory -> replace collective MEMORY.md. */
    saveMemory(username: string, memory: string): Promise<AgentMemoryResponse> {
      return apiFetch<AgentMemoryResponse>(`/agents/${enc(username)}/memory`, {
        method: "PUT",
        body: JSON.stringify({ memory }),
      });
    },

    /** Explicit owner reseed; this is the only path allowed to replace native/dream-owned memory. */
    rebuildMemory(username: string): Promise<AgentMemoryRebuildResponse> {
      return post<AgentMemoryRebuildResponse>(`/agents/${enc(username)}/memory/rebuild`, {
        confirm: "reseed",
      });
    },

    /** POST /api/agents/:username/repair -> owner re-asserts the runtime (restart). */
    repair(username: string): Promise<{ ok: boolean; repaired: string }> {
      return post(`/agents/${enc(username)}/repair`);
    },

    /** POST /api/agents/:username/retry-provision -> owner retries a failed first build. */
    retryProvision(username: string): Promise<{ ok: boolean; status: "provisioning" }> {
      return post(`/agents/${enc(username)}/retry-provision`);
    },

    /** GET /api/agents/:username/activity -> owner logs peek (recent usage events). */
    activity(username: string): Promise<{ items: AgentActivityEvent[] }> {
      return get<{ items: AgentActivityEvent[] }>(`/agents/${enc(username)}/activity`);
    },

    /** POST /api/agents/import -> create/provision from portable bundle. */
    async importBundle(input: AgentImportInput): Promise<AgentImportResult> {
      const result = await post<AgentImportResult>("/agents/import", input);
      emitAgentInventoryChange();
      return result;
    },

    /** PATCH /api/agents/:username */
    async update(username: string, patchBody: AgentUpdateInput): Promise<AgentDto> {
      const agent = unwrap<AgentDto>(
        await patch<unknown>(`/agents/${enc(username)}`, patchBody),
        "agent",
      );
      emitAgentInventoryChange();
      return agent;
    },

    /** GET /api/agents/:username/workspace — owner/admin recursive file tree. */
    workspaceTree(username: string): Promise<WorkspaceTreeResponse> {
      return get<WorkspaceTreeResponse>(`/agents/${enc(username)}/workspace`);
    },

    /** GET /api/agents/:username/workspace/file?path= — text content or binary meta. */
    workspaceFile(username: string, path: string): Promise<WorkspaceFileResponse> {
      return get<WorkspaceFileResponse>(
        `/agents/${enc(username)}/workspace/file?path=${enc(path)}`,
      );
    },

    /**
     * PUT /api/agents/:username/workspace/file — conflict-checked save.
     * Throws ApiError(409, body: {currentSha256, currentMtime}) when the agent
     * changed the file since it was loaded — callers must surface that, never
     * silently overwrite.
     */
    workspaceSave(
      username: string,
      input: WorkspaceSaveInput,
    ): Promise<WorkspaceSaveResponse> {
      return apiFetch<WorkspaceSaveResponse>(`/agents/${enc(username)}/workspace/file`, {
        method: "PUT",
        body: JSON.stringify(input),
      });
    },

    /** Same-origin raw-bytes URL (inline <img> rendering in the file viewer). */
    workspaceDownloadUrl(username: string, path: string): string {
      return `/api/agents/${enc(username)}/workspace/download?path=${enc(path)}`;
    },

    /** GET /api/agents/:username/workspace/download?path= as a Blob. */
    workspaceDownload(username: string, path: string): Promise<Blob> {
      return apiBlob(`/agents/${enc(username)}/workspace/download?path=${enc(path)}`);
    },

    /** GET /api/agents/:username/workspace/export — whole workspace zip (SPEC Q11). */
    workspaceExport(username: string): Promise<Blob> {
      return apiBlob(`/agents/${enc(username)}/workspace/export`);
    },

    /** POST /api/agents/:username/avatar — owner avatar upload (png/jpeg/webp ≤ 8MB). */
    async uploadAvatar(
      username: string,
      input: AgentAvatarUploadInput,
    ): Promise<AgentDto> {
      const agent = unwrap<AgentDto>(
        await post<unknown>(`/agents/${enc(username)}/avatar`, input),
        "agent",
      );
      emitAgentInventoryChange();
      return agent;
    },

    /** DELETE /api/agents/:username/avatar — clears the avatar. */
    async removeAvatar(username: string): Promise<AgentDto> {
      const agent = unwrap<AgentDto>(
        await apiFetch<unknown>(`/agents/${enc(username)}/avatar`, { method: "DELETE" }),
        "agent",
      );
      emitAgentInventoryChange();
      return agent;
    },

  },

  feed: {
    /**
     * GET /api/feed/creations?cursor&agent&user -> {creations[], nextCursor}.
     * `user: "me"` = the signed-in viewer's own creations incl. non-public rows.
     */
    async creations(
      params: {
        q?: string;
        cursor?: string;
        agent?: string;
        user?: string;
      } = {},
    ): Promise<Paginated<CreationDto>> {
      return toPaginated<CreationDto>(
        await get<unknown>(`/feed/creations${qs(params)}`),
        "creations",
      );
    },
  },

  creations: {
    /** GET /api/creations/:id — accepts uuid or legacy 24-hex ids. */
    async get(id: string, init: RequestInit = {}): Promise<CreationDto> {
      return unwrap<CreationDto>(
        await get<unknown>(`/creations/${enc(id)}`, init),
        "creation",
      );
    },

    /** POST /api/creations/:id/report — idempotent while a report is open. */
    report(
      id: string,
      input: { reason?: string } = {},
    ): Promise<{ report: Pick<ContentReportDto, "id" | "targetId" | "reason" | "status" | "createdAt"> }> {
      return post(`/creations/${enc(id)}/report`, input);
    },

  },

  collections: {
    /** GET /api/collections/:id */
    async get(id: string): Promise<CollectionDetail> {
      return toCollectionDetail(await get<unknown>(`/collections/${enc(id)}`));
    },

    /** POST /api/collections */
    async create(input: CollectionCreateInput): Promise<CollectionDto> {
      return unwrap<CollectionDto>(await post<unknown>("/collections", input), "collection");
    },

    /** POST /api/collections/:id/creations */
    addCreation(
      id: string,
      body: { creationId: string; position?: number },
    ): Promise<{ ok: true; collectionId: string; creationId: string; position: number }> {
      return post<{ ok: true; collectionId: string; creationId: string; position: number }>(
        `/collections/${enc(id)}/creations`,
        body,
      );
    },

    /** DELETE /api/collections/:id/creations/:creationId */
    removeCreation(id: string, creationId: string): Promise<{ ok: true }> {
      return apiFetch<{ ok: true }>(`/collections/${enc(id)}/creations/${enc(creationId)}`, {
        method: "DELETE",
      });
    },
  },

  users: {
    /** GET /api/users/:username/collections */
    async collections(username: string): Promise<Paginated<CollectionDto>> {
      return toPaginated<CollectionDto>(
        await get<unknown>(`/users/${enc(username)}/collections`),
        "collections",
      );
    },
  },

  concepts: {
    /** GET /api/agents/:username/concepts — visible to anyone who can see the agent. */
    async list(username: string): Promise<ConceptDto[]> {
      return toPaginated<ConceptDto>(
        await get<unknown>(`/agents/${enc(username)}/concepts`),
        "concepts",
      ).items;
    },

    /** POST /api/agents/:username/concepts (owner; 20-per-agent cap → 429). */
    async create(username: string, input: ConceptCreateInput): Promise<ConceptDto> {
      return unwrap<ConceptDto>(
        await post<unknown>(`/agents/${enc(username)}/concepts`, input),
        "concept",
      );
    },

    /** PATCH /api/agents/:username/concepts/:slug */
    async update(
      username: string,
      slug: string,
      input: ConceptUpdateInput,
    ): Promise<ConceptDto> {
      return unwrap<ConceptDto>(
        await patch<unknown>(`/agents/${enc(username)}/concepts/${enc(slug)}`, input),
        "concept",
      );
    },

    /** DELETE /api/agents/:username/concepts/:slug (soft-delete). */
    remove(username: string, slug: string): Promise<{ ok: true }> {
      return apiFetch<{ ok: true }>(`/agents/${enc(username)}/concepts/${enc(slug)}`, {
        method: "DELETE",
      });
    },

    /** POST /api/agents/:username/concepts/:slug/images (png/jpeg/webp ≤ 8MB, max 8). */
    async uploadImage(
      username: string,
      slug: string,
      input: ConceptImageUploadInput,
    ): Promise<ConceptDto> {
      return unwrap<ConceptDto>(
        await post<unknown>(
          `/agents/${enc(username)}/concepts/${enc(slug)}/images`,
          input,
        ),
        "concept",
      );
    },

    /** PATCH .../images {imageIds} — reorder (exact permutation of current ids). */
    async reorderImages(
      username: string,
      slug: string,
      imageIds: string[],
    ): Promise<ConceptDto> {
      return unwrap<ConceptDto>(
        await patch<unknown>(`/agents/${enc(username)}/concepts/${enc(slug)}/images`, {
          imageIds,
        }),
        "concept",
      );
    },

    /** DELETE .../images/:imageId */
    async removeImage(
      username: string,
      slug: string,
      imageId: string,
    ): Promise<ConceptDto> {
      return unwrap<ConceptDto>(
        await apiFetch<unknown>(
          `/agents/${enc(username)}/concepts/${enc(slug)}/images/${enc(imageId)}`,
          { method: "DELETE" },
        ),
        "concept",
      );
    },
  },

  manna: {
    /** GET /api/manna -> {balance, subscriptionBalance} */
    async get(): Promise<MannaSummary> {
      return toMannaSummary(await get<unknown>("/manna"));
    },

    /** GET /api/manna/transactions?cursor */
    async transactions(cursor?: string): Promise<Paginated<MannaTransactionDto>> {
      return toPaginated<MannaTransactionDto>(
        await get<unknown>(`/manna/transactions${qs({ cursor })}`),
        "transactions",
      );
    },
  },

  billing: {
    /** GET /api/billing/subscription -> safe current subscription summary. */
    async subscription(): Promise<BillingSubscriptionSummary | null> {
      return toBillingSubscription(
        await get<unknown>("/billing/subscription"),
      ).subscription;
    },

    /** POST /api/billing/checkout -> Stripe Checkout session. */
    async checkout(
      body:
        | { kind: "manna_topup" }
        | { kind: "subscription"; tier: "basic" | "pro" | "believer" },
    ): Promise<BillingCheckoutSession> {
      return unwrap<BillingCheckoutSession>(
        await post<unknown>("/billing/checkout", body),
        "session",
      );
    },

    /** POST /api/billing/vouchers/redeem {code}. */
    redeemVoucher(code: string): Promise<VoucherRedeemResult> {
      return post<VoucherRedeemResult>("/billing/vouchers/redeem", { code });
    },
  },

  channels: {
    /** GET /api/channels/connections — safe metadata only, never plaintext tokens. */
    async list(): Promise<Paginated<ChannelConnectionDto>> {
      return toPaginated<ChannelConnectionDto>(
        await get<unknown>("/channels/connections"),
        "connections",
      );
    },

    /** POST /api/channels/connections — stores an encrypted channel token. */
    async create(input: ChannelConnectionCreateInput): Promise<ChannelConnectionDto> {
      return unwrap<ChannelConnectionDto>(
        await post<unknown>("/channels/connections", input),
        "connection",
      );
    },

    /** Start owner binding without accepting or returning a raw Telegram bot token. */
    startManagedTelegram(input: {
      suggestedBotUsername?: string;
    }): Promise<TelegramManagedBotOnboardingStart> {
      return post<TelegramManagedBotOnboardingStart>(
        "/channels/telegram/managed-bots/onboarding",
        input,
      );
    },

    /** Poll safe onboarding state; provider ids and SecretRefs are never returned. */
    managedTelegramStatus(intentId: string): Promise<TelegramManagedBotOnboardingStatus> {
      return get<TelegramManagedBotOnboardingStatus>(
        `/channels/telegram/managed-bots/onboarding/${enc(intentId)}`,
      );
    },

    cancelManagedTelegram(intentId: string): Promise<{ ok?: true }> {
      return post<{ ok?: true }>(
        `/channels/telegram/managed-bots/onboarding/${enc(intentId)}/cancel`,
      );
    },

    /** Attach the stored managed credential to an owned agent. */
    async attachManagedTelegram(
      intentId: string,
      input: { agentUsername: string; label?: string },
    ): Promise<ChannelConnectionDto> {
      return unwrap<ChannelConnectionDto>(
        await post<unknown>(
          `/channels/telegram/managed-bots/onboarding/${enc(intentId)}/attach`,
          input,
        ),
        "connection",
      );
    },

    /** GET /api/channels/x/connections — safe metadata; never raw app credentials. */
    async listX(): Promise<Paginated<XConnectionDto>> {
      return toPaginated<XConnectionDto>(
        await get<unknown>("/channels/x/connections"),
        "connections",
      );
    },

    /** Validate a user-owned X app, then hand its four secrets to channel custody. */
    async connectX(input: XConnectionCreateInput): Promise<XConnectionDto> {
      return unwrap<XConnectionDto>(
        await post<unknown>("/channels/x/connections", input),
        "connection",
      );
    },

    /** Revoke Eden access; provider-side app/token revocation remains user-owned. */
    revokeX(id: string): Promise<{ ok: true }> {
      return post<{ ok: true }>(`/channels/x/connections/${enc(id)}/revoke`, {});
    },

    /** POST /api/channels/connections/:id/mock-message — sandbox route test. */
    mockMessage(id: string, message: string): Promise<ChannelMockMessageResult> {
      return post<ChannelMockMessageResult>(
        `/channels/connections/${enc(id)}/mock-message`,
        { message },
      );
    },

    /** Validate the stored token again, optionally rotating it first. */
    retry(id: string, token?: string): Promise<{ ok: boolean; connection: ChannelConnectionDto }> {
      return post(`/channels/connections/${enc(id)}/retry`, token ? { token } : {});
    },

    destinations(id: string): Promise<{ items: ChannelDestinationDto[] }> {
      return get(`/channels/connections/${enc(id)}/destinations`);
    },

    /** Project a named Discord/Telegram account backed by a vault SecretRef. */
    activate(
      id: string,
      input: {
        dmPolicy: "pairing" | "allowlist";
        allowFrom: string[];
        discordGuilds?: Array<{ guildId: string; channelIds: string[] }>;
        telegramGroups?: Array<{ groupId: string }>;
      },
    ): Promise<{
      ok: boolean;
      connection: ChannelConnectionDto;
      runtime: { boundAgent: string; runtimeAccountId: string };
    }> {
      return post(`/channels/connections/${enc(id)}/activate`, input);
    },

    deactivate(id: string): Promise<{ ok: boolean; connection: ChannelConnectionDto }> {
      return post(`/channels/connections/${enc(id)}/deactivate`, {});
    },

    pairing(id: string): Promise<{ items: ChannelPairingRequestDto[] }> {
      return get(`/channels/connections/${enc(id)}/pairing`);
    },

    decidePairing(
      id: string,
      requestId: string,
      decision: "approve" | "deny",
      input: { linkToMyAccount?: boolean; pairingCode?: string } = {},
    ): Promise<{ ok: true; linkedToMyAccount?: boolean }> {
      return post(
        `/channels/connections/${enc(id)}/pairing/${enc(requestId)}/${decision}`,
        decision === "approve" ? input : {},
      );
    },

    /** DELETE /api/channels/connections/:id. */
    delete(id: string): Promise<{ ok: true }> {
      return apiFetch<{ ok: true }>(`/channels/connections/${enc(id)}`, {
        method: "DELETE",
      });
    },
  },

  skills: {
    /** GET /api/skills — approved skills plus viewer-owned pending/rejected rows. */
    async list(): Promise<Paginated<SkillDefinitionDto>> {
      return toPaginated<SkillDefinitionDto>(
        await get<unknown>("/skills"),
        "skills",
      );
    },

    /** POST /api/skills/user — submit a pending user-created skill. */
    async createUser(input: SkillCreateInput): Promise<SkillDefinitionDto> {
      return unwrap<SkillDefinitionDto>(
        await post<unknown>("/skills/user", input),
        "skill",
      );
    },

    /** POST /api/skills/:slug/review — admin moderation. */
    async review(slug: string, input: SkillReviewInput): Promise<SkillDefinitionDto> {
      return unwrap<SkillDefinitionDto>(
        await post<unknown>(`/skills/${enc(slug)}/review`, input),
        "skill",
      );
    },

    /** GET /api/agents/:username/skills. */
    agent(username: string): Promise<AgentSkillsResponse> {
      return get<AgentSkillsResponse>(`/agents/${enc(username)}/skills`);
    },

    /** POST /api/agents/:username/skills — replace final OpenClaw allowlist. */
    setAgent(username: string, slugs: string[]): Promise<AgentSkillsResponse> {
      return post<AgentSkillsResponse>(`/agents/${enc(username)}/skills`, { slugs });
    },
  },

  usage: {
    /**
     * GET /api/usage/summary — the signed-in viewer's OWN balance, spend, and
     * recent activity. Never admin-gated and never carries provider cost_usd.
     * `agent` filters spend + recent to one agent (balance stays global).
     */
    async summary(
      params: { limit?: number; agent?: string } = {},
    ): Promise<UserUsageSummary> {
      return get<UserUsageSummary>(`/usage/summary${qs(params)}`);
    },
  },

  operator: {
    /** GET /api/operator/content-reports — admin-only moderation queue. */
    contentReports(
      params: { status?: ContentReportDto["status"]; limit?: number } = {},
    ): Promise<{ reports: ContentReportDto[] }> {
      return get(`/operator/content-reports${qs(params)}`);
    },

    /** POST /api/operator/content-reports/:id/resolve — admin-only decision. */
    resolveContentReport(
      id: string,
      decision: "takedown" | "dismiss",
    ): Promise<{ report: ContentReportDto }> {
      return post(`/operator/content-reports/${enc(id)}/resolve`, { decision });
    },

    /** GET /api/operator/usage/summary — admin-only usage/spend aggregate. */
    async usageSummary(
      params: { days?: number; limit?: number; userId?: string; agentId?: string } = {},
    ): Promise<OperatorUsageSummary> {
      return get<OperatorUsageSummary>(`/operator/usage/summary${qs(params)}`);
    },

    /** GET /api/operator/health — admin-only runtime health panel. */
    async health(): Promise<OperatorHealth> {
      return get<OperatorHealth>("/operator/health");
    },

    /** GET /api/operator/model-runtimes — effective model-scoped runtime catalog. */
    async modelRuntimes(): Promise<{ models: ModelRuntimeDto[] }> {
      return get<{ models: ModelRuntimeDto[] }>("/operator/model-runtimes");
    },

    /** POST /api/operator/model-runtimes — hot-toggle one model's runtime. */
    async setModelRuntime(input: {
      model: AgentModel;
      agentRuntime: AgentRuntime;
    }): Promise<ModelRuntimeDto & { changed: boolean }> {
      return post<ModelRuntimeDto & { changed: boolean }>(
        "/operator/model-runtimes",
        input,
      );
    },
  },

  tasks: {
    /** GET /api/tasks?agent — scheduled prompts (triggers) for the current user. */
    async list(params: { agent?: string } = {}): Promise<Paginated<TriggerDto>> {
      return toPaginated<TriggerDto>(
        await get<unknown>(`/tasks${qs(params)}`),
        "tasks",
        "triggers",
      );
    },

    /** POST /api/tasks {agentUsername, name, prompt, schedule{...}} */
    async create(input: TaskCreateInput): Promise<TriggerDto> {
      return unwrap<TriggerDto>(await post<unknown>("/tasks", input), "task");
    },

    /** PATCH /api/tasks/:id — pause/resume/edit/delete. */
    async update(id: string, body: TaskUpdateInput): Promise<TriggerDto> {
      return unwrap<TriggerDto>(
        await patch<unknown>(`/tasks/${enc(id)}`, body),
        "task",
      );
    },

    /** POST /api/tasks/:id/runs — fire the task now (metered run). */
    async runNow(id: string, input: TaskRunInput): Promise<TaskRunResult> {
      return unwrap<TaskRunResult>(
        await post<unknown>(`/tasks/${enc(id)}/runs`, input),
        "run",
      );
    },
  },

  studio: {
    /** GET /api/studio/tools */
    async tools(): Promise<StudioTool[]> {
      return toPaginated<StudioTool>(
        await get<unknown>("/studio/tools"),
        "tools",
      ).items;
    },

    /** POST /api/studio/quote {tool,args} -> {quote}. */
    async quote(body: {
      tool: string;
      args: Record<string, unknown>;
    }): Promise<StudioGenerationQuote> {
      return unwrap<StudioGenerationQuote>(
        await post<unknown>("/studio/quote", body),
        "quote",
      );
    },

    /**
     * POST /api/studio/generate {tool, args} -> {creationId, url}.
     * Long-running (image ~2min, video up to 10min) — keep a progress state
     * on screen and pass a signal if the surface offers cancel.
     */
    async generate(
      body: { tool: string; args: Record<string, unknown> },
      options: { signal?: AbortSignal } = {},
    ): Promise<StudioGeneration> {
      return unwrap<StudioGeneration>(
        await post<unknown>(
          "/studio/generate",
          body,
          { signal: options.signal },
          { direct: true },
        ),
        "generation",
      );
    },
  },

  /** Current auth session + dev impersonation helpers. */
  dev: {
    /** GET /api/auth/me — current signed-in or impersonated user, or null. */
    async me(): Promise<DevUser | null> {
      return (await api.auth.me()).user;
    },

    /** GET /api/dev/users?q= — search accounts to impersonate. */
    async users(q = ""): Promise<Paginated<DevUser>> {
      return toPaginated<DevUser>(
        await get<unknown>(`/dev/users${qs({ q })}`),
        "users",
        "accounts",
      );
    },

    /** POST /api/dev/impersonate {accountId} — sets the auth cookie. */
    impersonate(accountId: string): Promise<unknown> {
      return post<unknown>("/dev/impersonate", { accountId });
    },
  },
};
