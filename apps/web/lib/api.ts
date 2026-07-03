/**
 * Typed fetch client for the eden3 api (@eden3/api, Fastify on :4301) —
 * the FULL web<->api contract in one place.
 *
 * In the browser everything goes same-origin through the Next rewrite
 * (/api/* -> :4301/*, cookies flow by default); on the server (RSC/route
 * handlers) it targets the api origin directly. Wire shapes are the
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

import { streamSseBody, subscribeSessionEvents } from "./sse";
import type { SessionEventStreamOptions, StreamSseOptions } from "./sse";
import type {
  AgentCreateInput,
  AgentDto,
  AgentProfile,
  AgentUpdateInput,
  CollectionDetail,
  CollectionDto,
  CreationDto,
  DevUser,
  MannaSummary,
  MannaTransactionDto,
  MessageDto,
  Paginated,
  SessionDetail,
  SessionDto,
  SessionEvent,
  StudioGeneration,
  StudioTool,
  TaskCreateInput,
  TriggerDto,
  TriggerStatus,
} from "./types";

// ---------------------------------------------------------------------------
// Base fetch
// ---------------------------------------------------------------------------

function apiBase(): string {
  if (typeof window !== "undefined") return "/api";
  return (
    process.env.API_INTERNAL_URL ??
    `http://localhost:${process.env.API_PORT ?? "4301"}`
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
  const detail =
    body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : res.statusText;
  return new ApiError(res.status, `${res.status} ${path}: ${detail}`, body);
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    cache: "no-store",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw await toApiError(res, path);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function get<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}

function post<T>(path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
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
// Streaming
// ---------------------------------------------------------------------------

export interface SseStreamOptions extends StreamSseOptions {
  /** Abort to cancel the turn stream (closes the HTTP request). */
  signal?: AbortSignal;
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
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    cache: "no-store",
    signal: options.signal,
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
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

// ---------------------------------------------------------------------------
// Detail-envelope normalizers (tolerant of a bare DTO while the api lands)
// ---------------------------------------------------------------------------

function toAgentProfile(data: unknown): AgentProfile {
  const obj = asRecord(data);
  return {
    agent: (obj.agent ?? data) as AgentDto,
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

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export const api = {
  sessions: {
    /** GET /api/sessions?cursor */
    async list(params: { cursor?: string } = {}): Promise<Paginated<SessionDto>> {
      return toPaginated<SessionDto>(
        await get<unknown>(`/sessions${qs(params)}`),
        "sessions",
      );
    },

    /** GET /api/sessions/:id — accepts uuid or legacy 24-hex permalink ids. */
    async get(id: string): Promise<SessionDetail> {
      return toSessionDetail(await get<unknown>(`/sessions/${enc(id)}`));
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
    /** GET /api/agents?q&cursor */
    async list(
      params: { q?: string; cursor?: string } = {},
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
      return unwrap<AgentDto>(await post<unknown>("/agents", input), "agent");
    },

    /** PATCH /api/agents/:username */
    async update(username: string, patchBody: AgentUpdateInput): Promise<AgentDto> {
      return unwrap<AgentDto>(
        await patch<unknown>(`/agents/${enc(username)}`, patchBody),
        "agent",
      );
    },
  },

  feed: {
    /** GET /api/feed/creations?cursor&agent&user -> {creations[], nextCursor} */
    async creations(
      params: { cursor?: string; agent?: string; user?: string } = {},
    ): Promise<Paginated<CreationDto>> {
      return toPaginated<CreationDto>(
        await get<unknown>(`/feed/creations${qs(params)}`),
        "creations",
      );
    },
  },

  creations: {
    /** GET /api/creations/:id — accepts uuid or legacy 24-hex ids. */
    async get(id: string): Promise<CreationDto> {
      return unwrap<CreationDto>(
        await get<unknown>(`/creations/${enc(id)}`),
        "creation",
      );
    },
  },

  collections: {
    /** GET /api/collections/:id */
    async get(id: string): Promise<CollectionDetail> {
      return toCollectionDetail(await get<unknown>(`/collections/${enc(id)}`));
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

  tasks: {
    /** GET /api/tasks — scheduled prompts (triggers) for the current user. */
    async list(): Promise<Paginated<TriggerDto>> {
      return toPaginated<TriggerDto>(
        await get<unknown>("/tasks"),
        "tasks",
        "triggers",
      );
    },

    /** POST /api/tasks {agentUsername, name, prompt, schedule{...}} */
    async create(input: TaskCreateInput): Promise<TriggerDto> {
      return unwrap<TriggerDto>(await post<unknown>("/tasks", input), "task");
    },

    /** PATCH /api/tasks/:id {status} — pause/resume. */
    async update(
      id: string,
      body: { status: TriggerStatus },
    ): Promise<TriggerDto> {
      return unwrap<TriggerDto>(
        await patch<unknown>(`/tasks/${enc(id)}`, body),
        "task",
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
        await post<unknown>("/studio/generate", body, {
          signal: options.signal,
        }),
        "generation",
      );
    },
  },

  /** Dev impersonation auth (Clerk later) — see DevUserSwitcher. */
  dev: {
    /** GET /api/dev/me — current impersonated user, or null. Tolerate 501. */
    async me(): Promise<DevUser | null> {
      const data = await get<unknown>("/dev/me");
      if (!data || typeof data !== "object") return null;
      const obj = data as Record<string, unknown>;
      if ("user" in obj) return (obj.user as DevUser | null) ?? null;
      if (typeof obj.id === "string" && typeof obj.username === "string") {
        return obj as unknown as DevUser;
      }
      return null;
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
