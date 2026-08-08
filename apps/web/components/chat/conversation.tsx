"use client";

/**
 * /sessions/[id] — the full conversation surface.
 *
 * Data flow:
 *   - history: GET /api/sessions/:id (ascending; `nextCursor` loads OLDER
 *     pages via the affordance pinned to the top of the transcript),
 *   - live turn: a module-owned turn pump (components/chat/turn-pump.ts)
 *     consumes the POST SSE stream; this view just attaches to it — so the
 *     stream survives strict-mode effect cycles, the /chat -> /sessions
 *     handoff, and navigating away and back mid-turn,
 *   - session channel: GET /api/sessions/:id/events subscribed for the whole
 *     visit — async media (media.pending shimmer -> media.attached), balance
 *     changes, and turns started elsewhere all land live,
 *
 * Permalinks accept legacy 24-hex ids; once history loads, sends/subscribes
 * switch to the canonical uuid.
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { api, ApiError } from "@/lib/api";
import type { AccountSummary, MessageDto, SessionDto } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import {
  describeSendError,
  fetchSessionPage,
  sessionAgents,
  sessionTitle,
} from "./chat-api";
import { getTurnPump, startSessionTurn } from "./turn-pump";
import type { PumpEntry, TurnPump } from "./turn-pump";
import {
  conversationReducer,
  initialConversationState,
} from "./conversation-state";
import type { LocalItem } from "./conversation-state";
import { Composer, ComposerNotice } from "./composer";
import { SessionShareDialog } from "./session-share-dialog";
import {
  InlineError,
  MediaBubble,
  MediaPendingBubble,
  MessageRow,
  StreamBubble,
  UserEchoBubble,
} from "./message-bubble";

type LoadPhase = "loading" | "ready" | "missing" | "error";

interface SendNotice {
  message: string;
  retryContent: string | null;
  manna: boolean;
}

const GROUP_WINDOW_MS = 5 * 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

function TranscriptSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="flex gap-3">
        <Skeleton className="size-7 rounded-full" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3.5 w-2/5" />
        </div>
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-16 w-1/2 rounded-2xl" />
      </div>
      <div className="flex gap-3">
        <Skeleton className="size-7 rounded-full" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3.5 w-1/3" />
        </div>
      </div>
    </div>
  );
}

export function SessionConversation({
  routeId,
  backHref = "/sessions",
}: {
  routeId: string;
  /** Mobile back-arrow target (the surrounding conversations list). */
  backHref?: string;
}) {
  const [state, dispatch] = useReducer(
    conversationReducer,
    initialConversationState,
  );
  const [session, setSession] = useState<SessionDto | null>(null);
  const [loadPhase, setLoadPhase] = useState<LoadPhase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [notice, setNotice] = useState<SendNotice | null>(null);
  const [channelUp, setChannelUp] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [fallbackAgent, setFallbackAgent] = useState<AccountSummary | null>(
    null,
  );

  // The uuid to talk to the API with (route may carry a legacy 24-hex id).
  const canonicalIdRef = useRef(routeId);
  const [canonicalId, setCanonicalId] = useState(routeId);
  const adoptCanonical = useCallback((id: string | undefined) => {
    if (id && canonicalIdRef.current !== id) {
      canonicalIdRef.current = id;
      setCanonicalId(id);
    }
  }, []);

  // Turn-pump wiring. Refs survive strict-mode effect cycles, so replay
  // resumes from the last applied seq instead of double-applying.
  const activePumpRef = useRef<TurnPump | null>(null);
  const pumpCursorRef = useRef<{ clientId: string; seq: number }>({
    clientId: "",
    seq: 0,
  });
  const detachRef = useRef<(() => void) | null>(null);
  const adoptedPumpRef = useRef<string | null>(null);
  const localTurnsRef = useRef<Set<string>>(new Set());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Scroll management (used inside callbacks defined below).
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const scrollAdjustRef = useRef<{ height: number; top: number } | null>(null);

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  const refreshHistory = useCallback(async () => {
    try {
      const detail = await fetchSessionPage(canonicalIdRef.current);
      setSession(detail.session ?? null);
      adoptCanonical(detail.session?.id);
      dispatch({
        type: "history/merge",
        messages: detail.messages,
        position: "refresh",
      });
      setLoadPhase("ready");
    } catch {
      /* quiet — the live tail already rendered everything we streamed */
    }
  }, [adoptCanonical]);

  const loadHistory = useCallback(async () => {
    setLoadPhase((phase) => (phase === "ready" ? phase : "loading"));
    setLoadError(null);
    try {
      const detail = await fetchSessionPage(canonicalIdRef.current);
      setSession(detail.session ?? null);
      adoptCanonical(detail.session?.id);
      dispatch({
        type: "history/merge",
        messages: detail.messages,
        olderCursor: detail.nextCursor,
        position: "init",
      });
      setLoadPhase("ready");
    } catch (error) {
      if (adoptedPumpRef.current !== null) {
        // A live first turn renders from the pump; history reconciles once
        // the rows persist.
        setLoadPhase("ready");
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        setLoadPhase("missing");
        return;
      }
      setLoadError(describeSendError(error));
      setLoadPhase("error");
    }
  }, [adoptCanonical]);

  const loadOlder = useCallback(async () => {
    const cursor = state.olderCursor;
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    scrollAdjustRef.current = el
      ? { height: el.scrollHeight, top: el.scrollTop }
      : null;
    try {
      const detail = await fetchSessionPage(canonicalIdRef.current, cursor);
      dispatch({
        type: "history/merge",
        messages: detail.messages,
        olderCursor: detail.nextCursor,
        position: "older",
      });
    } catch {
      scrollAdjustRef.current = null;
    } finally {
      setLoadingOlder(false);
    }
  }, [state.olderCursor, loadingOlder]);

  // -------------------------------------------------------------------------
  // Turn pump attachment
  // -------------------------------------------------------------------------

  const attachPump = useCallback(
    (pump: TurnPump) => {
      detachRef.current?.();
      activePumpRef.current = pump;
      if (pumpCursorRef.current.clientId !== pump.clientId) {
        pumpCursorRef.current = { clientId: pump.clientId, seq: 0 };
      }
      if (!pump.done) setStreaming(true);

      const sink = (entry: PumpEntry) => {
        pumpCursorRef.current.seq = entry.seq;
        switch (entry.kind) {
          case "event": {
            const { event } = entry;
            if (event.type === "turn.started") {
              localTurnsRef.current.add(event.turnId);
              adoptCanonical(event.sessionId);
            }
            dispatch({
              type: "stream/event",
              clientId: pump.clientId,
              event,
              retryContent: pump.content,
              at: nowIso(),
            });
            break;
          }
          case "rejected":
            dispatch({ type: "send/rejected", clientId: pump.clientId });
            setNotice({
              message: entry.message,
              retryContent: pump.content,
              manna: entry.manna,
            });
            break;
          case "failed":
            dispatch({
              type: "stream/failed",
              clientId: pump.clientId,
              code: entry.code,
              message: entry.message,
              retryContent: pump.content,
              at: nowIso(),
            });
            break;
          case "aborted":
            dispatch({ type: "stream/aborted", clientId: pump.clientId });
            break;
          case "finished":
            dispatch({ type: "stream/finished", clientId: pump.clientId });
            setStreaming(false);
            if (activePumpRef.current === pump) activePumpRef.current = null;
            // Swap the streamed tail for its persisted rows (self-healing).
            void refreshHistory();
            break;
        }
      };

      detachRef.current = pump.attach(pumpCursorRef.current.seq, sink);
    },
    [adoptCanonical, refreshHistory],
  );

  const send = useCallback(
    (content: string) => {
      const active = activePumpRef.current;
      if (active && !active.done) return; // one live turn at a time
      setNotice(null);
      stickRef.current = true;
      const pump = startSessionTurn(canonicalIdRef.current, content);
      // The optimistic echo + bubble are seeded here; mark the pump adopted
      // so the adoption effect below doesn't seed them a second time.
      adoptedPumpRef.current = pump.clientId;
      dispatch({
        type: "send",
        clientId: pump.clientId,
        content,
        at: nowIso(),
      });
      attachPump(pump);
    },
    [attachPump],
  );

  const stop = useCallback(() => {
    activePumpRef.current?.stop();
  }, []);

  const retryFromError = useCallback(
    (item: { clientId: string }, content: string) => {
      dispatch({ type: "error/dismiss", clientId: item.clientId });
      send(content);
    },
    [send],
  );

  // -------------------------------------------------------------------------
  // Mount: load history; adopt a live pump (/chat handoff, strict-mode
  // remount, or coming back to a session mid-turn)
  // -------------------------------------------------------------------------

  useEffect(() => {
    void loadHistory();
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [loadHistory]);

  // Keyed on canonicalId: a legacy-hex route registers pumps under the uuid,
  // which is only known after history loads — re-check then too.
  useEffect(() => {
    const pump = getTurnPump(canonicalId) ?? getTurnPump(routeId);
    if (pump) {
      if (adoptedPumpRef.current !== pump.clientId) {
        // First sight of this pump in this view — seed the optimistic echo
        // + stream bubble; replay rebuilds text/turn state from seq 0.
        adoptedPumpRef.current = pump.clientId;
        if (pump.agent) {
          setFallbackAgent({
            id: pump.agent.id,
            type: "agent",
            username: pump.agent.username,
            userImage: pump.agent.userImage,
          });
        }
        dispatch({
          type: "adopt",
          clientId: pump.clientId,
          content: pump.content,
          text: "",
          turnId: null,
          at: nowIso(),
        });
      }
      attachPump(pump);
    }
    return () => {
      // Detach only — never abort. The pump (and the turn) keeps running;
      // the next attach replays from the seq cursor, so nothing double-applies.
      detachRef.current?.();
      detachRef.current = null;
    };
  }, [canonicalId, routeId, attachPump]);

  // -------------------------------------------------------------------------
  // Session events channel (async media, remote turns, manna)
  // -------------------------------------------------------------------------

  const channelReady = loadPhase === "ready";
  useEffect(() => {
    if (!channelReady) return;
    const unsubscribe = api.sessions.subscribe(
      canonicalId,
      (event) => {
        dispatch({ type: "channel/event", event, at: nowIso() });
        if (
          event.type === "turn.completed" &&
          !localTurnsRef.current.has(event.turnId)
        ) {
          // A turn from another tab/trigger finished — swap in its rows.
          if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = setTimeout(
            () => void refreshHistory(),
            700,
          );
        }
      },
      {
        onOpen: () => setChannelUp(true),
        onConnectionError: () => setChannelUp(false),
      },
    );
    return unsubscribe;
  }, [channelReady, canonicalId, refreshHistory]);

  // -------------------------------------------------------------------------
  // Scroll behavior
  // -------------------------------------------------------------------------

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const stick = fromBottom < 120;
    stickRef.current = stick;
    setShowJump((prev) => (prev === !stick ? prev : !stick));
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const adjust = scrollAdjustRef.current;
    if (adjust) {
      // Older page prepended — keep the viewport anchored where it was.
      el.scrollTop = el.scrollHeight - adjust.height + adjust.top;
      scrollAdjustRef.current = null;
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  });

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  const agents = useMemo(() => {
    const list = sessionAgents(session);
    if (list.length === 0 && fallbackAgent) return [fallbackAgent];
    return list;
  }, [session, fallbackAgent]);

  const agentsById = useMemo(() => {
    const map = new Map<string, AccountSummary>();
    for (const agent of agents) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const primaryAgent = agents[0] ?? null;

  const senderFor = useCallback(
    (message: MessageDto): AccountSummary | null => {
      if (message.sender) return message.sender;
      if (message.senderId) {
        const known = agentsById.get(message.senderId);
        if (known) return known;
      }
      return primaryAgent;
    },
    [agentsById, primaryAgent],
  );

  const title = session
    ? sessionTitle(session)
    : (primaryAgent?.username ?? "Conversation");

  const noticeNode: ReactNode = notice ? (
    <ComposerNotice tone="warn">
      <span className="min-w-0">{notice.message}</span>
      {notice.retryContent ? (
        <button
          type="button"
          onClick={() => {
            const content = notice.retryContent ?? "";
            setNotice(null);
            send(content);
          }}
          className="rounded-md border border-warning/30 px-2 py-0.5 transition-colors hover:border-warning-soft/60 hover:text-warning-soft"
        >
          Retry
        </button>
      ) : null}
      {notice.manna ? (
        <Link
          href="/account/manna"
          className="text-accent-soft underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          Get manna →
        </Link>
      ) : null}
      <button
        type="button"
        onClick={() => setNotice(null)}
        aria-label="Dismiss"
        className="ml-auto px-1 text-warning-soft/60 transition-colors hover:text-warning-soft"
      >
        ✕
      </button>
    </ComposerNotice>
  ) : null;

  if (loadPhase === "missing") {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <EmptyState
          title="Session not found"
          hint="This conversation doesn't exist (or isn't yours). Legacy permalinks keep their old ids — check the URL."
          action={
            <Link
              href="/chat"
              className="rounded-lg border border-accent/40 px-3.5 py-2 text-sm text-accent-soft transition-colors hover:border-accent/70 hover:bg-accent/10"
            >
              Start a new chat
            </Link>
          }
          className="w-full max-w-md"
        />
      </div>
    );
  }

  if (loadPhase === "error") {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <EmptyState
          title="Couldn't load this conversation"
          hint={loadError ?? undefined}
          action={
            <button
              type="button"
              onClick={() => void loadHistory()}
              className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
            >
              Try again
            </button>
          }
          className="w-full max-w-md"
        />
      </div>
    );
  }

  const items: Array<{ kind: "message"; message: MessageDto } | LocalItem> = [
    ...state.serverMessages.map((message) => ({
      kind: "message" as const,
      message,
    })),
    ...state.local,
  ];
  const readOnlyChannel = session?.readOnly === true;
  const channelLabel = session?.platform
    ? `${session.platform.charAt(0).toUpperCase()}${session.platform.slice(1)}`
    : "external channel";

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-edge px-4 md:px-6">
        <Link
          href={backHref}
          aria-label="All conversations"
          className="-ml-1 flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/[0.04] hover:text-foreground md:hidden"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="size-4"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        {primaryAgent ? (
          <Link
            href={`/agents/${encodeURIComponent(primaryAgent.username)}`}
            className="shrink-0"
          >
            <AgentAvatar account={primaryAgent} size={30} />
          </Link>
        ) : (
          <div className="size-[30px] shrink-0 rounded-full border border-edge bg-raised" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium text-foreground">
            {title}
          </h1>
          {primaryAgent ? (
            <p className="truncate text-[11px] text-faint">
              with{" "}
              {agents.map((agent, i) => (
                <span key={agent.id}>
                  {i > 0 ? ", " : ""}
                  <Link
                    href={`/agents/${encodeURIComponent(agent.username)}`}
                    className="transition-colors hover:text-accent-soft"
                  >
                    {agent.username}
                  </Link>
                </span>
              ))}
            </p>
          ) : null}
        </div>
        <span
          title={channelUp ? "Live — receiving session events" : "Connecting…"}
          className={`size-1.5 shrink-0 rounded-full transition-colors ${
            channelUp ? "bg-accent" : "bg-edge"
          }`}
        />
        {readOnlyChannel ? (
          <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-accent-soft">
            {channelLabel} · read-only
          </span>
        ) : null}
        {session ? (
          <SessionShareDialog
            sessionId={session.id}
            boundaryMessageId={state.serverMessages.at(-1)?.id ?? null}
          />
        ) : null}
      </header>

      {/* Transcript */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 md:px-6">
          {state.olderCursor ? (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="rounded-full border border-edge px-3.5 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:opacity-50"
              >
                {loadingOlder ? "Loading…" : "Load earlier messages"}
              </button>
            </div>
          ) : null}

          {loadPhase === "loading" && items.length === 0 ? (
            <TranscriptSkeleton />
          ) : null}

          {loadPhase === "ready" && items.length === 0 ? (
            <EmptyState
              title="No messages yet"
              hint={
                readOnlyChannel
                  ? `Messages from ${channelLabel} will appear here.`
                  : "Say something below to get this conversation going."
              }
            />
          ) : null}

          {items.map((item, index) => {
            if (item.kind === "message") {
              const prev = index > 0 ? items[index - 1] : undefined;
              const message = item.message;
              // Collapse the avatar/name header for rapid same-sender runs.
              const grouped =
                prev !== undefined &&
                prev.kind === "message" &&
                prev.message.role === message.role &&
                prev.message.senderId === message.senderId &&
                message.role !== "user" &&
                Date.parse(message.createdAt) -
                  Date.parse(prev.message.createdAt) <
                  GROUP_WINDOW_MS;
              return (
                <MessageRow
                  key={message.id}
                  message={message}
                  sender={senderFor(message)}
                  showAvatar={!grouped}
                />
              );
            }
            switch (item.kind) {
              case "user-echo":
                return <UserEchoBubble key={item.clientId} item={item} />;
              case "assistant-stream":
                return (
                  <StreamBubble
                    key={item.clientId}
                    item={item}
                    sender={primaryAgent}
                  />
                );
              case "media-pending":
                return (
                  <MediaPendingBubble
                    key={item.clientId}
                    item={item}
                    sender={primaryAgent}
                  />
                );
              case "media":
                return (
                  <MediaBubble
                    key={item.clientId}
                    item={item}
                    sender={primaryAgent}
                  />
                );
              case "error":
                return (
                  <InlineError
                    key={item.clientId}
                    item={item}
                    onRetry={(content) => retryFromError(item, content)}
                    onDismiss={() =>
                      dispatch({
                        type: "error/dismiss",
                        clientId: item.clientId,
                      })
                    }
                  />
                );
              default:
                return null;
            }
          })}
        </div>
      </div>

      {/* Jump to latest */}
      {showJump ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 flex justify-center">
          <button
            type="button"
            onClick={jumpToLatest}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-edge bg-raised px-3.5 py-1.5 text-xs text-muted shadow-lg shadow-black/30 transition-colors hover:border-accent/50 hover:text-foreground"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="size-3"
            >
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
            Latest
          </button>
        </div>
      ) : null}

      {/* Composer */}
      <div className="shrink-0 border-t border-edge bg-background px-4 pb-4 pt-3 md:px-6">
        <div className="mx-auto w-full max-w-3xl">
          {readOnlyChannel ? (
            <p className="rounded-xl border border-edge bg-surface px-4 py-3 text-center text-xs text-muted">
              This is a read-only mirror of the {channelLabel} conversation. Reply from the
              channel itself.
            </p>
          ) : (
            <Composer
              onSend={send}
              onStop={stop}
              streaming={streaming}
              notice={noticeNode}
              placeholder={
                primaryAgent ? `Message ${primaryAgent.username}…` : "Message…"
              }
              autoFocus
            />
          )}
        </div>
      </div>
    </div>
  );
}
