"use client";

/**
 * Recent conversations rail (GET /api/sessions?cursor) — rendered beside the
 * /sessions surfaces. Refetches on route change so a session started seconds
 * ago (via the /chat handoff) appears once you land on its permalink.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing, onMannaUpdate } from "@/lib/api";
import type { SessionDto } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";
import { Skeleton } from "@/components/skeleton";
import { sessionTitle } from "./chat-api";
import { SessionShareDialog } from "./session-share-dialog";

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
        <div key={i} className="space-y-1.5 rounded-lg px-2.5 py-2">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-2.5 w-1/3" />
        </div>
      ))}
    </div>
  );
}

function PendingTitleDots() {
  return (
    <span
      aria-label="Generating conversation title"
      className="inline-flex h-4 items-center gap-1"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          aria-hidden
          className="size-1 animate-pulse rounded-full bg-muted"
          style={{ animationDelay: `${index * 180}ms` }}
        />
      ))}
    </span>
  );
}

function isChannelSession(session: SessionDto): boolean {
  return session.sessionType === "channel" || session.channelConnectionId !== null;
}

export function sessionArchiveAction(
  session: SessionDto,
  archivedView: boolean,
): "archive" | "unarchive" | null {
  if (isChannelSession(session)) return archivedView ? "unarchive" : null;
  return archivedView ? "unarchive" : "archive";
}

type ChannelFilter = "all" | "direct" | "channels";
const SESSION_TITLE_POLL_LIMIT = 20;

/**
 * One conversation row. The surrounding rail is already scoped to the
 * selected agent, so repeating that same agent avatar on every row adds no
 * information and steals space from the conversation title.
 */
export function SessionRailItem({
  session,
  href,
  active,
  archivedView = false,
  titlePending = false,
  onChanged,
  onRemoved,
}: {
  session: SessionDto;
  href: string;
  active: boolean;
  archivedView?: boolean;
  titlePending?: boolean;
  onChanged?: (session: SessionDto) => void;
  onRemoved?: () => void;
}) {
  const when = session.lastMessageAt ?? session.updatedAt;
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(sessionTitle(session));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  }, [menuOpen]);

  const update = async (
    action: string,
    body: { title?: string; pinned?: boolean; archived?: boolean },
  ) => {
    setBusy(action);
    setError(null);
    try {
      const updated = await api.sessions.update(session.id, body);
      onChanged?.(updated);
      setMenuOpen(false);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Conversation update failed");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const menuItem =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-foreground/[0.06] disabled:opacity-50";
  const archiveAction = sessionArchiveAction(session, archivedView);

  return (
    <div ref={menuRef} className="group relative">
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={`relative block rounded-lg py-2 pl-3 pr-9 transition-colors ${
          active
            ? "bg-foreground/[0.06] text-foreground"
            : "text-muted hover:bg-foreground/[0.03] hover:text-foreground"
        }`}
      >
        {active ? (
          <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />
        ) : null}
        <span className="flex min-w-0 items-center gap-1.5">
          {session.pinned ? <span aria-label="Pinned conversation" title="Pinned">⌖</span> : null}
          <span className="block min-w-0 truncate text-[13px] leading-snug">
            {titlePending ? <PendingTitleDots /> : sessionTitle(session)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-faint">
          {isChannelSession(session) && session.platform ? `${session.platform} · ` : ""}
          {formatRelativeTime(when)}
          {session.messageCount > 0 ? ` · ${session.messageCount} messages` : ""}
        </span>
      </Link>

      <button
        type="button"
        aria-label={`Conversation menu for ${sessionTitle(session)}`}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
        className={`absolute right-1 top-1.5 flex size-7 items-center justify-center rounded-md text-base tracking-widest text-muted hover:bg-foreground/[0.07] hover:text-foreground ${
          menuOpen ? "bg-foreground/[0.07] opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
        }`}
      >
        ···
      </button>

      {menuOpen ? (
        <div
          role="menu"
          className="absolute right-1 top-9 z-40 w-44 rounded-xl border border-edge bg-raised p-1.5 shadow-2xl shadow-black/25"
        >
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            onClick={() => {
              setMenuOpen(false);
              setShareOpen(true);
            }}
          >
            <span aria-hidden>↗</span> Share
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            onClick={() => {
              setDraftTitle(sessionTitle(session));
              setError(null);
              setMenuOpen(false);
              setRenameOpen(true);
            }}
          >
            <span aria-hidden>✎</span> Rename
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy !== null}
            className={menuItem}
            onClick={() => void update("pin", { pinned: !session.pinned })}
          >
            <span aria-hidden>⌖</span> {session.pinned ? "Unpin" : "Pin conversation"}
          </button>
          {archiveAction ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy !== null}
              className={menuItem}
              onClick={() =>
                void update(archiveAction, { archived: archiveAction === "archive" })
              }
            >
              <span aria-hidden>▣</span>{" "}
              {archiveAction === "unarchive" ? "Unarchive" : "Archive"}
            </button>
          ) : null}
          <div className="my-1 border-t border-edge" />
          {error ? <p role="alert" className="px-2.5 py-1 text-[11px] text-danger-soft">{error}</p> : null}
          <button
            type="button"
            role="menuitem"
            className={`${menuItem} text-danger-soft hover:bg-danger/10`}
            onClick={() => {
              setError(null);
              setMenuOpen(false);
              setDeleteOpen(true);
            }}
          >
            <span aria-hidden>⌫</span> Delete
          </button>
        </div>
      ) : null}

      <SessionShareDialog
        sessionId={session.id}
        boundaryMessageId={null}
        renderTrigger={null}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />

      {renameOpen ? (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-background/75 px-4 backdrop-blur-sm">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby={`rename-${session.id}`}
            className="w-full max-w-sm rounded-xl border border-edge bg-raised p-5 shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              const title = draftTitle.trim();
              if (!title) return;
              void update("rename", { title }).then((ok) => ok && setRenameOpen(false));
            }}
          >
            <h2 id={`rename-${session.id}`} className="text-base font-medium">Rename conversation</h2>
            <input
              autoFocus
              value={draftTitle}
              maxLength={120}
              onChange={(event) => setDraftTitle(event.target.value)}
              className="mt-4 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent/60"
            />
            {error ? <p role="alert" className="mt-2 text-xs text-danger-soft">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setRenameOpen(false)} className="rounded-lg border border-edge px-3 py-1.5 text-sm text-muted">Cancel</button>
              <button type="submit" disabled={!draftTitle.trim() || busy !== null} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">{busy === "rename" ? "Saving…" : "Save"}</button>
            </div>
          </form>
        </div>
      ) : null}

      {deleteOpen ? (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-background/75 px-4 backdrop-blur-sm">
          <section role="alertdialog" aria-modal="true" aria-labelledby={`delete-${session.id}`} className="w-full max-w-sm rounded-xl border border-edge bg-raised p-5 shadow-2xl">
            <h2 id={`delete-${session.id}`} className="text-base font-medium">Delete conversation?</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">It will disappear from your conversation history. Existing share links will stop working.</p>
            {error ? <p role="alert" className="mt-2 text-xs text-danger-soft">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteOpen(false)} className="rounded-lg border border-edge px-3 py-1.5 text-sm text-muted">Cancel</button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setBusy("delete");
                  setError(null);
                  void api.sessions.remove(session.id).then(() => onRemoved?.()).catch((cause) => {
                    setError(cause instanceof Error ? cause.message : "Conversation deletion failed");
                  }).finally(() => setBusy(null));
                }}
                className="rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy === "delete" ? "Deleting…" : "Delete"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

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
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [note, setNote] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [archivedView, setArchivedView] = useState(false);
  const alive = useRef(true);
  const titlePolls = useRef(new Map<string, number>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const archived = archivedView ? "archived" : "active";
      const { items, nextCursor } = await api.sessions.list(agent ? { agent, archived } : { archived });
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
  }, [agent, archivedView]);

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

  // A new conversation is inserted before its tiny title turn finishes.
  // Re-read a bounded number of times so the generated title appears without
  // a manual reload; failures stop quietly and settle on New Chat.
  useEffect(() => {
    if (phase !== "ready") return;
    const pending = sessions.filter((session) => {
      if (session.title?.trim()) {
        titlePolls.current.delete(session.id);
        return false;
      }
      return (titlePolls.current.get(session.id) ?? 0) < SESSION_TITLE_POLL_LIMIT;
    });
    if (pending.length === 0) return;
    for (const session of pending) {
      titlePolls.current.set(session.id, (titlePolls.current.get(session.id) ?? 0) + 1);
    }
    const timer = window.setTimeout(() => void load(), 1_000);
    return () => window.clearTimeout(timer);
  }, [load, phase, sessions]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { items, nextCursor } = await api.sessions.list(
        agent
          ? { cursor, agent, archived: archivedView ? "archived" : "active" }
          : { cursor, archived: archivedView ? "archived" : "active" },
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
  }, [cursor, loadingMore, agent, archivedView]);

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

  const replaceSession = (updated: SessionDto) => {
    const belongsHere = archivedView ? updated.archivedAt !== null : updated.archivedAt === null;
    setSessions((previous) => {
      const next = belongsHere
        ? previous.map((session) => (session.id === updated.id ? updated : session))
        : previous.filter((session) => session.id !== updated.id);
      return next.sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        const leftTime = Date.parse(left.lastMessageAt ?? left.updatedAt);
        const rightTime = Date.parse(right.lastMessageAt ?? right.updatedAt);
        return rightTime - leftTime;
      });
    });
    if (!belongsHere && isActive(updated)) router.push(newChatHref);
  };

  const removeSession = (session: SessionDto) => {
    setSessions((previous) => previous.filter((item) => item.id !== session.id));
    if (isActive(session)) router.push(newChatHref);
  };

  return (
    <aside className={`h-full min-h-0 flex-col ${className ?? ""}`}>
      <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
          {archivedView ? "Archived" : "Conversations"}
        </h2>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title={archivedView ? "Back to conversations" : "Archived conversations"}
            aria-label={archivedView ? "Back to conversations" : "Archived conversations"}
            onClick={() => {
              setArchivedView((value) => !value);
              setSessions([]);
              setCursor(null);
              setPhase("loading");
            }}
            className="flex size-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            {archivedView ? "←" : "▣"}
          </button>
          {!archivedView ? (
            <Link
              href={newChatHref}
              title="New chat"
              aria-label="New chat"
              className="flex size-7 items-center justify-center rounded-lg text-accent-soft transition-colors hover:bg-accent/10"
            >
              <NewChatIcon />
            </Link>
          ) : null}
        </div>
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
                ? archivedView
                  ? "No archived conversations"
                  : "No conversations yet"
                : channelFilter === "channels"
                  ? "No channel conversations"
                  : "No direct conversations"}
            </p>
            {sessions.length === 0 && !archivedView ? (
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
              return (
                <li key={session.id}>
                  <SessionRailItem
                    session={session}
                    href={`${basePath}/${session.id}`}
                    active={active}
                    archivedView={archivedView}
                    titlePending={
                      !session.title?.trim() &&
                      (titlePolls.current.get(session.id) ?? 0) < SESSION_TITLE_POLL_LIMIT
                    }
                    onChanged={replaceSession}
                    onRemoved={() => removeSession(session)}
                  />
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
