/**
 * Module-owned turn streams ("pumps") — the POST SSE response outlives any
 * one React mount.
 *
 * Why: components can't own the stream read loop. Strict-mode double-fires
 * effects (setup -> cleanup -> setup), /chat hands a live first turn to
 * /sessions/[id] across a route change, and a user can leave a session
 * mid-turn and come back. Breaking out of a `for await` cancels the HTTP
 * reader, so a component-scoped loop dies with its mount.
 *
 * A pump consumes the whole SSE stream at module scope into an append-only
 * entry log (each entry has a monotonically increasing `seq`). Views attach
 * with the last seq they've applied: everything newer replays synchronously,
 * then live entries follow. Detaching never aborts — only `stop()` (the
 * user's stop button) does. The turn itself always continues server-side.
 *
 * Registry: one pump per session id, kept until ~30s after the stream ends,
 * so a remounting view (strict mode, back-navigation) can re-adopt it.
 */

import type { AgentDto, SessionEvent } from "@/lib/types";
import {
  describeSendError,
  isAbortError,
  isInsufficientManna,
  startNewSessionStream,
} from "./chat-api";
import { api, ApiError } from "@/lib/api";

export type PumpEntry =
  | { seq: number; kind: "event"; event: SessionEvent }
  /** The POST was rejected before any event (402, endpoint missing, api down). */
  | { seq: number; kind: "rejected"; message: string; manna: boolean }
  /** The stream broke after it had started. */
  | { seq: number; kind: "failed"; code: string; message: string }
  /** stop() — client-side abort; the server finishes the turn regardless. */
  | { seq: number; kind: "aborted" }
  /** Always the last entry. */
  | { seq: number; kind: "finished" };

export interface TurnPump {
  /** Stable client id — reducer items for this turn key off it. */
  readonly clientId: string;
  /** The user message that started the turn (echo + retry payload). */
  readonly content: string;
  /** Agent context for avatar/title before the session record loads. */
  readonly agent: AgentDto | null;
  /** Session the turn belongs to; null until turn.started/header on a new session. */
  readonly sessionId: string | null;
  readonly done: boolean;
  /**
   * Replay entries with seq > fromSeq synchronously, then deliver live ones.
   * Returns a detach function (never aborts the underlying request).
   */
  attach(fromSeq: number, sink: (entry: PumpEntry) => void): () => void;
  /** Client-side abort (the composer's stop button). */
  stop(): void;
}

const UNREGISTER_AFTER_MS = 30_000;

/** Omit that distributes over a union (plain Omit collapses PumpEntry). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

class Pump implements TurnPump {
  readonly clientId = crypto.randomUUID();
  readonly content: string;
  readonly agent: AgentDto | null;
  sessionId: string | null;
  done = false;

  private seq = 0;
  private log: PumpEntry[] = [];
  private listeners = new Set<(entry: PumpEntry) => void>();
  readonly controller = new AbortController();

  constructor(content: string, agent: AgentDto | null, sessionId: string | null) {
    this.content = content;
    this.agent = agent;
    this.sessionId = sessionId;
  }

  push(entry: DistributiveOmit<PumpEntry, "seq">): void {
    this.seq += 1;
    const sequenced = { ...entry, seq: this.seq } as PumpEntry;
    this.log.push(sequenced);
    for (const listener of this.listeners) listener(sequenced);
  }

  attach(fromSeq: number, sink: (entry: PumpEntry) => void): () => void {
    let live = true;
    for (const entry of this.log) {
      if (!live) return () => {};
      if (entry.seq > fromSeq) sink(entry);
    }
    const listener = (entry: PumpEntry) => {
      if (live) sink(entry);
    };
    this.listeners.add(listener);
    return () => {
      live = false;
      this.listeners.delete(listener);
    };
  }

  stop(): void {
    try {
      this.controller.abort();
    } catch {
      /* already aborted */
    }
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, Pump>();

function register(pump: Pump): void {
  if (pump.sessionId) registry.set(pump.sessionId, pump);
}

function scheduleUnregister(pump: Pump): void {
  setTimeout(() => {
    if (pump.sessionId && registry.get(pump.sessionId) === pump) {
      registry.delete(pump.sessionId);
    }
  }, UNREGISTER_AFTER_MS);
}

/** The live (or just-finished) turn pump for a session, if any. */
export function getTurnPump(sessionId: string): TurnPump | null {
  return registry.get(sessionId) ?? null;
}

// ---------------------------------------------------------------------------
// Stream consumption
// ---------------------------------------------------------------------------

async function consume(
  pump: Pump,
  events: AsyncGenerator<SessionEvent, void, undefined>,
  onTurnStarted?: (sessionId: string) => void,
): Promise<void> {
  let sawEvent = false;
  try {
    for await (const event of events) {
      sawEvent = true;
      if (event.type === "turn.started") {
        if (!pump.sessionId) {
          pump.sessionId = event.sessionId;
          register(pump);
        }
        onTurnStarted?.(event.sessionId);
      }
      pump.push({ kind: "event", event });
    }
  } catch (error) {
    if (isAbortError(error) || pump.controller.signal.aborted) {
      pump.push({ kind: "aborted" });
    } else if (!sawEvent) {
      pump.push({
        kind: "rejected",
        message: describeSendError(error),
        manna: isInsufficientManna(error),
      });
    } else {
      pump.push({
        kind: "failed",
        code: error instanceof ApiError ? String(error.status) : "stream_error",
        message: describeSendError(error),
      });
    }
  } finally {
    pump.done = true;
    pump.push({ kind: "finished" });
    scheduleUnregister(pump);
  }
}

/**
 * POST /api/sessions/:id/messages — start a turn in an existing session.
 * The pump is registered immediately; attach to render it.
 */
export function startSessionTurn(sessionId: string, content: string): TurnPump {
  const pump = new Pump(content, null, sessionId);
  register(pump);
  const events = api.sessions.send(sessionId, content, {
    signal: pump.controller.signal,
  });
  void consume(pump, events);
  return pump;
}

export interface NewSessionTurn {
  pump: TurnPump;
  /**
   * Resolves with the new session id (turn.started, or the x-session-id
   * header) — navigate to /sessions/<id> and attach there. Rejects when the
   * POST is refused (402…), the stream errors before an id is known, or the
   * user aborts.
   */
  ready: Promise<string>;
}

/** POST /api/sessions/new/messages — start a session with its first turn. */
export function startNewSessionTurn(body: {
  content: string;
  agentUsername: string;
  agent: AgentDto | null;
}): NewSessionTurn {
  const pump = new Pump(body.content, body.agent, null);

  const ready = new Promise<string>((resolve, reject) => {
    void (async () => {
      let settled = false;
      const settle = (id: string) => {
        if (!settled) {
          settled = true;
          resolve(id);
        }
      };
      try {
        const { sessionIdHint, events } = await startNewSessionStream(
          { content: body.content, agentUsername: body.agentUsername },
          pump.controller.signal,
        );
        if (sessionIdHint && !pump.sessionId) {
          pump.sessionId = sessionIdHint;
          register(pump);
          settle(sessionIdHint);
        }
        // Record why the stream died in case no session id ever arrives.
        let failure: string | null = null;
        let aborted = false;
        const detach = pump.attach(0, (entry) => {
          if (entry.kind === "event" && entry.event.type === "error") {
            failure ??= entry.event.message;
          } else if (entry.kind === "rejected" || entry.kind === "failed") {
            failure ??= entry.message;
          } else if (entry.kind === "aborted") {
            aborted = true;
          }
        });
        await consume(pump, events, settle);
        detach();
        if (!settled) {
          settled = true;
          if (aborted) {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          } else {
            reject(
              new Error(
                failure ??
                  "The API didn't return a session id for the new chat.",
              ),
            );
          }
        }
      } catch (error) {
        // consume() never throws — this is the pre-stream POST failing.
        pump.done = true;
        pump.push({
          kind: "rejected",
          message: describeSendError(error),
          manna: isInsufficientManna(error),
        });
        pump.push({ kind: "finished" });
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    })();
  });

  return { pump, ready };
}
