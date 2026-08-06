"use client";

/**
 * /chat — start a conversation.
 *
 * Without ?agent= it's an agent picker (GET /api/agents?q). With
 * ?agent=<username> it shows the agent hero (avatar, description, greeting,
 * a strip of recent creations) over a composer. The first send POSTs
 * /api/sessions/new/messages, learns the session id from the first
 * turn.started event (falling back to the x-session-id header), parks the
 * still-streaming response in the stream-handoff module, and
 * router.replace()s to /sessions/<id> — the reply keeps streaming there.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { AgentDto, CreationDto } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { EmptyState } from "@/components/empty-state";
import { MediaThumb } from "@/components/media";
import { Skeleton } from "@/components/skeleton";
import {
  describeSendError,
  isAbortError,
  isInsufficientManna,
} from "./chat-api";
import { startNewSessionTurn } from "./turn-pump";
import type { TurnPump } from "./turn-pump";
import { Composer, ComposerNotice } from "./composer";
import { Markdown } from "./markdown";

interface SendNotice {
  message: string;
  retryContent: string | null;
  manna: boolean;
}

// ---------------------------------------------------------------------------
// Agent picker (no ?agent= param)
// ---------------------------------------------------------------------------

function AgentPicker() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { items } = await api.agents.list(query ? { q: query } : {});
        if (cancelled) return;
        setAgents(items);
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        setError(describeSendError(err));
        setPhase("error");
      }
    }, query ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, reloadNonce]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-14 md:px-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        New chat
      </p>
      <h1 className="mt-3 text-3xl font-light tracking-tight md:text-4xl">
        Start a conversation
      </h1>
      <p className="mt-2 text-sm text-muted">
        Pick an agent to chat with — it replies in its own voice and can create
        images, video, and sound mid-conversation.
      </p>

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search agents…"
        aria-label="Search agents"
        className="mt-8 w-full rounded-xl border border-edge bg-raised px-4 py-2.5 text-sm placeholder:text-faint focus:border-accent/60 focus:outline-none"
      />

      <div className="mt-6">
        {phase === "loading" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-xl border border-edge/60 p-4"
              >
                <Skeleton className="size-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : phase === "error" ? (
          <EmptyState
            title="Couldn't load agents"
            hint={error ?? undefined}
            action={
              <button
                type="button"
                onClick={() => {
                  setPhase("loading");
                  setError(null);
                  setReloadNonce((n) => n + 1);
                }}
                className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
              >
                Try again
              </button>
            }
          />
        ) : agents.length === 0 ? (
          <EmptyState
            title={query ? `No agents match “${query}”` : "No agents yet"}
            hint="Agents appear here once the directory has members."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {agents.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  onClick={() =>
                    router.push(
                      `/chat?agent=${encodeURIComponent(agent.username)}`,
                    )
                  }
                  className="flex w-full items-start gap-3 rounded-xl border border-edge bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-accent/[0.04]"
                >
                  <AgentAvatar account={agent} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {agent.name ?? agent.username}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-faint">
                      @{agent.username}
                    </span>
                    {agent.description ? (
                      <span className="mt-1.5 line-clamp-2 block text-xs leading-relaxed text-muted">
                        {agent.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer mode (?agent=<username>)
// ---------------------------------------------------------------------------

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-pulse rounded-full bg-muted"
          style={{ animationDelay: `${i * 220}ms` }}
        />
      ))}
    </span>
  );
}

function NewSessionComposer({
  username,
  sessionHref = (id) => `/sessions/${encodeURIComponent(id)}`,
}: {
  username: string;
  /** Where the streaming handoff lands once the session id is known. */
  sessionHref?: (id: string) => string;
}) {
  const router = useRouter();
  const [agent, setAgent] = useState<AgentDto | null>(null);
  const [recent, setRecent] = useState<CreationDto[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "missing" | "error">(
    "loading",
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [starting, setStarting] = useState(false);
  const [pendingContent, setPendingContent] = useState<string | null>(null);
  const [notice, setNotice] = useState<SendNotice | null>(null);
  const pendingPumpRef = useRef<TurnPump | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setLoadError(null);
    void (async () => {
      try {
        const profile = await api.agents.get(username);
        if (cancelled) return;
        setAgent(profile.agent);
        setRecent(profile.recentCreations.filter((c) => c.url ?? c.thumbnailUrl));
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        const status =
          err && typeof err === "object" && "status" in err
            ? Number((err as { status: unknown }).status)
            : null;
        if (status === 404) {
          setPhase("missing");
        } else {
          setLoadError(describeSendError(err));
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [username, reloadNonce]);

  const send = useCallback(
    async (content: string) => {
      if (!agent || pendingPumpRef.current) return;
      setNotice(null);
      setPendingContent(content);
      setStarting(true);
      // The pump owns the stream at module scope: once the session id is
      // known we navigate, and /sessions/[id] attaches to the same pump —
      // the reply keeps streaming straight through the route change.
      const { pump, ready } = startNewSessionTurn({
        content,
        agentUsername: agent.username,
        agent,
      });
      pendingPumpRef.current = pump;
      try {
        const sessionId = await ready;
        pendingPumpRef.current = null;
        router.replace(sessionHref(sessionId));
      } catch (error) {
        pendingPumpRef.current = null;
        setStarting(false);
        setPendingContent(null);
        if (isAbortError(error)) return;
        setNotice({
          message: describeSendError(error),
          retryContent: content,
          manna: isInsufficientManna(error),
        });
      }
    },
    [agent, router, sessionHref],
  );

  const stop = useCallback(() => {
    pendingPumpRef.current?.stop();
  }, []);

  if (phase === "missing") {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <EmptyState
          title={`No agent called “${username}”`}
          hint="It may have been renamed or made private."
          action={
            <Link
              href="/chat"
              className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
            >
              Pick another agent
            </Link>
          }
          className="w-full max-w-md"
        />
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <EmptyState
          title="Couldn't load this agent"
          hint={loadError ?? undefined}
          action={
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
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

  const noticeNode = notice ? (
    <ComposerNotice tone="warn">
      <span className="min-w-0">{notice.message}</span>
      {notice.retryContent ? (
        <button
          type="button"
          onClick={() => {
            const content = notice.retryContent ?? "";
            setNotice(null);
            void send(content);
          }}
          className="rounded-md border border-amber-400/30 px-2 py-0.5 transition-colors hover:border-amber-300/60 hover:text-amber-100"
        >
          Retry
        </button>
      ) : null}
      {notice.manna ? (
        <Link
          href="/manna"
          className="text-accent-soft underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          Get manna →
        </Link>
      ) : null}
    </ComposerNotice>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col px-6 pb-8 pt-14 md:pt-20">
          {phase === "loading" ? (
            <div className="flex flex-col items-center" aria-hidden>
              <Skeleton className="size-[72px] rounded-full" />
              <Skeleton className="mt-4 h-6 w-40" />
              <Skeleton className="mt-3 h-3.5 w-64" />
              <Skeleton className="mt-2 h-3.5 w-52" />
            </div>
          ) : agent ? (
            <>
              {/* Agent hero */}
              <div className="flex flex-col items-center text-center">
                <Link href={`/agents/${encodeURIComponent(agent.username)}`}>
                  <AgentAvatar account={agent} size={72} />
                </Link>
                <h1 className="mt-4 text-2xl font-light tracking-tight">
                  {agent.name ?? agent.username}
                </h1>
                <Link
                  href={`/agents/${encodeURIComponent(agent.username)}`}
                  className="mt-1 font-mono text-[11px] text-faint transition-colors hover:text-accent-soft"
                >
                  @{agent.username}
                </Link>
                {agent.description ? (
                  <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
                    {agent.description}
                  </p>
                ) : null}
                {recent.length > 0 ? (
                  <div className="mt-6 flex gap-2">
                    {recent.slice(0, 5).map((creation) => (
                      <Link
                        key={creation.id}
                        href={`/creations/${creation.externalId ?? creation.id}`}
                        className="w-16 transition-opacity hover:opacity-80"
                      >
                        <MediaThumb creation={creation} />
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>

              {/* Greeting + (while starting) the echoed first message */}
              <div className="mt-10 space-y-6">
                {agent.greeting ? (
                  <div className="flex gap-3">
                    <AgentAvatar account={agent} size={28} className="mt-0.5" />
                    <div className="min-w-0 flex-1 pt-0.5">
                      <Markdown text={agent.greeting} />
                    </div>
                  </div>
                ) : null}
                {pendingContent !== null ? (
                  <>
                    <div className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-accent/20 bg-accent/[0.13] px-4 py-2.5 opacity-80 sm:max-w-[70%]">
                        <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
                          {pendingContent}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <AgentAvatar account={agent} size={28} className="mt-0.5" />
                      <div className="flex items-center gap-2 pt-0.5">
                        <TypingDots />
                        <span className="text-xs text-faint">
                          starting session…
                        </span>
                      </div>
                    </div>
                  </>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-6 pt-2">
        <div className="mx-auto w-full max-w-2xl">
          <Composer
            onSend={(content) => void send(content)}
            onStop={stop}
            streaming={starting}
            disabled={phase !== "ready"}
            notice={noticeNode}
            placeholder={
              agent ? `Message ${agent.name ?? agent.username}…` : "Message…"
            }
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry — /agents/[username]/chats (the agent-scoped composer)
// ---------------------------------------------------------------------------

export function AgentChatComposer({ username }: { username: string }) {
  return (
    <div className="h-full">
      <NewSessionComposer
        key={username}
        username={username}
        sessionHref={(id) =>
          `/agents/${encodeURIComponent(username)}/chats/${encodeURIComponent(id)}`
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legacy entry — /chat?agent=<username> (route now redirects; kept for P4 cleanup)
// ---------------------------------------------------------------------------

export function NewChatScreen() {
  const searchParams = useSearchParams();
  const agentParam = searchParams.get("agent");

  if (!agentParam) {
    return (
      <div className="h-dvh overflow-y-auto">
        <AgentPicker />
      </div>
    );
  }
  return (
    <div className="h-dvh">
      <NewSessionComposer key={agentParam} username={agentParam} />
    </div>
  );
}
