"use client";

/**
 * /agents — the directory. Debounced search over GET /api/agents?q, cursor
 * "load more", create entry point top-right. Resilient to the api being
 * mid-build (501/404/offline -> quiet dashed card, retryable).
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, isEndpointMissing } from "@/lib/api";
import type { AgentDto } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { AgentCard } from "@/components/agents/agent-card";
import {
  dedupeById,
  describeApiFailure,
} from "@/components/agents/agent-utils";
import {
  primaryButtonClass,
  quietButtonClass,
} from "@/components/agents/form-fields";

const SEARCH_DEBOUNCE_MS = 250;

function SearchIcon() {
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
      <path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.35-4.35" />
    </svg>
  );
}

function CardSkeleton() {
  return (
    <div aria-hidden className="rounded-xl border border-edge/60 bg-surface p-4">
      <div className="flex items-start gap-3">
        <Skeleton className="size-11 rounded-full" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
      <div className="mt-4 flex justify-end">
        <Skeleton className="h-7 w-16 rounded-lg" />
      </div>
    </div>
  );
}

type DirectoryState = "loading" | "ready" | "error";

export function AgentsDirectory() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<AgentDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<DirectoryState>("loading");
  const [endpointMissing, setEndpointMissing] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);

  // Page 1 — debounced on query, re-armed by "Try again".
  useEffect(() => {
    setState("loading");
    setMoreError(null);
    const timer = window.setTimeout(async () => {
      const id = ++seq.current;
      try {
        const page = await api.agents.list({ q: query.trim() || undefined });
        if (seq.current !== id) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setState("ready");
      } catch (error) {
        if (seq.current !== id) return;
        setEndpointMissing(isEndpointMissing(error));
        setErrorText(describeApiFailure(error));
        setState("error");
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, reloadKey]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.agents.list({
        q: query.trim() || undefined,
        cursor,
      });
      setItems((prev) => dedupeById([...prev, ...page.items]));
      setCursor(page.nextCursor);
    } catch (error) {
      setMoreError(describeApiFailure(error));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, query]);

  const trimmedQuery = query.trim();

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-light tracking-tight md:text-4xl">
            Agents
          </h1>
          <p className="mt-2 text-sm text-muted">
            Chat with creative agents — or make your own.
          </p>
        </div>
        <Link href="/agents/new" className={primaryButtonClass}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            aria-hidden
            className="size-4"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          Create agent
        </Link>
      </div>

      <div className="relative mt-8 max-w-sm">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-faint">
          <SearchIcon />
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents…"
          aria-label="Search agents"
          className="w-full rounded-lg border border-edge bg-raised py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-faint transition-colors focus:border-accent/60 focus:outline-none"
        />
      </div>

      {state === "loading" ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : state === "error" ? (
        <EmptyState
          className="mt-6"
          title={
            endpointMissing
              ? "The agent directory isn't wired up yet"
              : "Couldn't load agents"
          }
          hint={errorText}
          action={
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className={quietButtonClass}
            >
              Try again
            </button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          className="mt-6"
          title={
            trimmedQuery
              ? `No agents match “${trimmedQuery}”`
              : "No agents yet"
          }
          hint={
            trimmedQuery
              ? "Try a different name or handle."
              : "Be the first — create an agent and give it a persona."
          }
          action={
            trimmedQuery ? undefined : (
              <Link href="/agents/new" className={quietButtonClass}>
                Create agent
              </Link>
            )
          }
        />
      ) : (
        <>
          <p className="mt-6 font-mono text-xs text-faint">
            {items.length.toLocaleString("en-US")}
            {cursor ? "+" : ""} {items.length === 1 ? "agent" : "agents"}
            {trimmedQuery ? ` matching “${trimmedQuery}”` : ""}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
          {cursor ? (
            <div className="mt-8 flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className={quietButtonClass}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
              {moreError ? (
                <p className="text-xs text-faint">{moreError}</p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
