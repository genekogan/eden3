"use client";

/**
 * Recent conversations rail (GET /api/sessions?cursor) — rendered beside the
 * /sessions surfaces. Refetches on route change so a session started seconds
 * ago (via the /chat handoff) appears once you land on its permalink.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing, onMannaUpdate } from "@/lib/api";
import type { SessionDto } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { formatRelativeTime } from "@/lib/format";
import { Skeleton } from "@/components/skeleton";
import { sessionAgents, sessionTitle } from "./chat-api";

function NewChatIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-4"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM12 7.5v5M9.5 10h5" />
    </svg>
  );
}

function RailSkeleton() {
  return (
    <div className="space-y-1 px-2" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function isChannelSession(session: SessionDto): boolean {
  return session.sessionType === "channel" || session.channelConnectionId !== null;
}

type ChannelFilter = "all" | "direct" | "channels";

export function SessionRail({
  className,
  agent,
  basePath = "/sessions",
  newChatHref = "/chat",
}: {
  className?: string;
  /** Filter to one agent's sessions (username) — the agent-scoped chats rail. */
  agent?: string;
  /** Session permalink prefix (e.g. /agents/verdelis/chats). */
  basePath?: string;
  newChatHref?: string;
}) {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [note, setNote] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const { items, nextCursor } = await api.sessions.list(agent ? { agent } : {});
      if (!alive.current) return;
      setSessions(items);
      setCursor(nextCursor);
      setPhase("ready");
      setNote(null);
    } catch (error) {
      if (!alive.current) return;
      setPhase((prev) => (prev === "ready" ? prev : "error"));
      setNote(
        error instanceof ApiError && error.status === 401
          ? "Sign in — pick a dev user from the sidebar."
          : isEndpointMissing(error)
            ? "The sessions endpoint isn't live yet."
            : "Couldn't reach the API.",
      );
    }
  }, [agent]);

  // Initial load + refresh on navigation (new sessions appear immediately).
  useEffect(() => {
    void load();
  }, [load, pathname]);

  // The manna bus doubles as a session-activity signal: it fires on every
  // streamed turn and after dev-user impersonation — both good moments to
  // refresh the list (cheap GET, debounced).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onMannaUpdate(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { items, nextCursor } = await api.sessions.list(
        agent ? { cursor, agent } : { cursor },
      );
      if (!alive.current) return;
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...items.filter((s) => !seen.has(s.id))];
      });
      setCursor(nextCursor);
    } catch {
      /* keep what we have */
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  }, [cursor, loadingMore, agent]);

  const isActive = (session: SessionDto): boolean =>
    pathname === `${basePath}/${session.id}` ||
    (session.externalId !== null &&
      pathname === `${basePath}/${session.externalId}`);

  const hasChannelSessions = sessions.some(isChannelSession);
  const visibleSessions =
    channelFilter === "all"
      ? sessions
      : sessions.filter((session) =>
          channelFilter === "channels" ? isChannelSession(session) : !isChannelSession(session),
        );

  return (
    <aside className={`h-full min-h-0 flex-col ${className ?? ""}`}>
      <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
          Conversations
        </h2>
        <Link
          href={newChatHref}
          title="New chat"
          aria-label="New chat"
          className="flex size-7 items-center justify-center rounded-lg text-accent-soft transition-colors hover:bg-accent/10"
        >
          <NewChatIcon />
        </Link>
      </div>

      {/* External-channel mirrors (Discord/Telegram) mix in like OpenClaw; the
          filter lets you isolate intentional web sessions or channel traffic. */}
      {hasChannelSessions ? (
        <div
          role="group"
          aria-label="Conversation source filter"
          className="mx-4 mb-1 flex shrink-0 gap-1"
        >
          {(
            [
              ["all", "All"],
              ["direct", "Direct"],
              ["channels", "Channels"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={channelFilter === value}
              onClick={() => setChannelFilter(value)}
              className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                channelFilter === value
                  ? "bg-accent/15 text-accent-soft"
                  : "text-faint hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      <nav
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-1"
        aria-label="Recent conversations"
      >
        {phase === "loading" ? (
          <RailSkeleton />
        ) : phase === "error" ? (
          <div className="mx-2 mt-2 rounded-xl border border-dashed border-edge px-3 py-4 text-center">
            <p className="text-xs text-faint">{note}</p>
            <button
              type="button"
              onClick={() => {
                setPhase("loading");
                void load();
              }}
              className="mt-3 rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-foreground"
            >
              Try again
            </button>
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="mx-2 mt-2 rounded-xl border border-dashed border-edge px-3 py-5 text-center">
            <p className="text-xs text-muted">
              {sessions.length === 0
                ? "No conversations yet"
                : channelFilter === "channels"
                  ? "No channel conversations"
                  : "No direct conversations"}
            </p>
            {sessions.length === 0 ? (
              <Link
                href={newChatHref}
                className="mt-3 inline-block rounded-md border border-accent/40 px-2.5 py-1 text-[11px] text-accent-soft transition-colors hover:border-accent/70 hover:bg-accent/10"
              >
                Start one
              </Link>
            ) : null}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {visibleSessions.map((session) => {
              const active = isActive(session);
              const agents = sessionAgents(session);
              const when = session.lastMessageAt ?? session.updatedAt;
              return (
                <li key={session.id}>
                  <Link
                    href={`${basePath}/${session.id}`}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors ${
                      active
                        ? "bg-white/[0.06] text-foreground"
                        : "text-muted hover:bg-white/[0.03] hover:text-foreground"
                    }`}
                  >
                    {active ? (
                      <span
                        aria-hidden
                        className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent"
                      />
                    ) : null}
                    <AgentAvatar
                      account={agents[0]}
                      name={agents[0]?.username ?? sessionTitle(session)}
                      size={30}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] leading-snug">
                        {sessionTitle(session)}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-faint">
                        {isChannelSession(session) && session.platform
                          ? `${session.platform} · `
                          : ""}
                        {formatRelativeTime(when)}
                        {session.messageCount > 0
                          ? ` · ${session.messageCount} messages`
                          : ""}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {cursor && phase === "ready" ? (
          <div className="mt-2 px-2">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="w-full rounded-lg border border-edge px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </nav>
    </aside>
  );
}
