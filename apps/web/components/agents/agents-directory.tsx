"use client";

/**
 * /agents — YOUR agents (the cockpit is single-user: no public directory,
 * no cross-user browsing — that returns later as a separate app). Debounced
 * search over GET /api/agents?q&scope=mine, cursor "load more", create entry
 * points top-right. Resilient to the api being mid-build (501/404/offline ->
 * quiet dashed card, retryable).
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type { AgentDto } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { AgentCard } from "@/components/agents/agent-card";
import { EveEmptyState } from "@/components/eve/eve-empty-state";
import {
  dedupeById,
  describeApiFailure,
} from "@/components/agents/agent-utils";
import {
  primaryButtonClass,
  quietButtonClass,
} from "@/components/agents/form-fields";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";
import {
  directoryAuthorityMatches,
  directoryAuthorityToken,
  directoryRowsVisible,
} from "@/lib/agent-directory-authority";

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
  const { viewer, viewerPhase } = useSelectedAgent();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<AgentDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<DirectoryState>("loading");
  const [endpointMissing, setEndpointMissing] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [itemsViewerId, setItemsViewerId] = useState<string | null>(null);
  const [refusedViewerId, setRefusedViewerId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);
  const authorityGeneration = useRef(0);
  const authorityViewerId = useRef<string | null>(null);
  const authorityPhase = useRef(viewerPhase);

  // Invalidate every admitted request and retire stored rows at the auth
  // handoff. The render-time authority check below hides them synchronously;
  // a delayed response for viewer A can never land for signed-out or viewer B.
  useEffect(() => {
    authorityGeneration.current += 1;
    authorityViewerId.current = viewer?.id ?? null;
    authorityPhase.current = viewerPhase;
    seq.current += 1;
    setItems([]);
    setItemsViewerId(null);
    setRefusedViewerId(null);
    setCursor(null);
    setMoreError(null);
    setLoadingMore(false);
  }, [viewer?.id, viewerPhase]);

  // Page 1 — debounced on query, re-armed by "Try again".
  useEffect(() => {
    const token = refusedViewerId === viewer?.id ? null : directoryAuthorityToken(
      viewer?.id ?? null,
      viewerPhase,
      authorityGeneration.current,
    );
    if (!token) {
      setItems([]);
      setItemsViewerId(null);
      setCursor(null);
      setEndpointMissing(false);
      setMoreError(null);
      if (viewerPhase === "loading") {
        setState("loading");
        setErrorText("");
      } else if (viewerPhase === "error" || refusedViewerId === viewer?.id) {
        setState("error");
        setErrorText("We couldn’t verify your sign-in. Reload to try again.");
      } else {
        setState("error");
        setErrorText("Sign in to see your agents.");
      }
      return;
    }
    setState("loading");
    setItemsViewerId(token.viewerId);
    setMoreError(null);
    setLoadingMore(false);
    const id = ++seq.current;
    const timer = window.setTimeout(async () => {
      try {
        const page = await api.agents.list({ q: query.trim() || undefined, scope: "mine" });
        if (
          seq.current !== id ||
          !directoryAuthorityMatches(
            token,
            authorityViewerId.current,
            authorityPhase.current,
            authorityGeneration.current,
          )
        ) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setState("ready");
      } catch (error) {
        if (
          seq.current !== id ||
          !directoryAuthorityMatches(
            token,
            authorityViewerId.current,
            authorityPhase.current,
            authorityGeneration.current,
          )
        ) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          setItems([]);
          setItemsViewerId(null);
          setCursor(null);
          setRefusedViewerId(token.viewerId);
          setErrorText("We couldn’t verify your sign-in. Reload to try again.");
          setEndpointMissing(false);
          setState("error");
          return;
        }
        setEndpointMissing(isEndpointMissing(error));
        setErrorText(describeApiFailure(error));
        setState("error");
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, reloadKey, refusedViewerId, viewer?.id, viewerPhase]);

  const loadMore = useCallback(async () => {
    const token = refusedViewerId === viewer?.id ? null : directoryAuthorityToken(
      viewer?.id ?? null,
      viewerPhase,
      authorityGeneration.current,
    );
    if (!cursor || loadingMore || !token) return;
    const id = ++seq.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.agents.list({
        q: query.trim() || undefined,
        scope: "mine",
        cursor,
      });
      if (!directoryAuthorityMatches(
        token,
        authorityViewerId.current,
        authorityPhase.current,
        authorityGeneration.current,
      ) || seq.current !== id) return;
      setItems((prev) => dedupeById([...prev, ...page.items]));
      setCursor(page.nextCursor);
    } catch (error) {
      if (!directoryAuthorityMatches(
        token,
        authorityViewerId.current,
        authorityPhase.current,
        authorityGeneration.current,
      ) || seq.current !== id) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setItems([]);
        setItemsViewerId(null);
        setCursor(null);
        setMoreError(null);
        setRefusedViewerId(token.viewerId);
        setErrorText("We couldn’t verify your sign-in. Reload to try again.");
        setEndpointMissing(false);
        setState("error");
        return;
      }
      setMoreError(describeApiFailure(error));
    } finally {
      if (directoryAuthorityMatches(
        token,
        authorityViewerId.current,
        authorityPhase.current,
        authorityGeneration.current,
      ) && seq.current === id) setLoadingMore(false);
    }
  }, [cursor, loadingMore, query, refusedViewerId, viewer?.id, viewerPhase]);

  const trimmedQuery = query.trim();
  const viewerId = viewer?.id ?? null;
  const locallyRefused = viewerId !== null && refusedViewerId === viewerId;
  const rowsVisible = directoryRowsVisible(
    itemsViewerId,
    viewerId,
    viewerPhase,
    locallyRefused,
  );
  const visibleItems = rowsVisible ? items : [];
  const visibleCursor = rowsVisible ? cursor : null;
  const visibleState: DirectoryState = viewerPhase === "loading"
    ? "loading"
    : viewerPhase !== "ready" || viewerId === null || locallyRefused
      ? "error"
      : itemsViewerId !== viewerId
        ? "loading"
        : state;
  const visibleErrorText = viewerPhase === "error" || locallyRefused
    ? "We couldn’t verify your sign-in. Reload to try again."
    : viewerPhase === "signed_out" || viewerId === null
      ? "Sign in to see your agents."
      : errorText;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-light tracking-tight md:text-4xl">
            Your agents
          </h1>
          <p className="mt-2 text-sm text-muted">
            Pick an agent to work with — or make a new one.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/agents/builder" className={quietButtonClass}>
            Builder
          </Link>
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
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-faint">
            <SearchIcon />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your agents…"
            aria-label="Search agents"
            className="w-full rounded-lg border border-edge bg-raised py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-faint transition-colors focus:border-accent/60 focus:outline-none"
          />
        </div>
      </div>

      {visibleState === "loading" ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : visibleState === "error" ? (
        <EmptyState
          className="mt-6"
          title={
            viewerPhase === "error" || locallyRefused
              ? "Couldn’t verify sign-in"
              : endpointMissing
              ? "The agent directory isn't wired up yet"
              : "Couldn't load agents"
          }
          hint={visibleErrorText}
          action={viewerPhase === "error" || locallyRefused || viewer !== null ? (
            <button
              type="button"
              onClick={() => {
                if (viewerPhase === "error" || locallyRefused) window.location.reload();
                else setReloadKey((k) => k + 1);
              }}
              className={quietButtonClass}
            >
              {viewerPhase === "error" || locallyRefused ? "Reload" : "Try again"}
            </button>
          ) : undefined}
        />
      ) : visibleItems.length === 0 && !trimmedQuery ? (
        <EveEmptyState />
      ) : visibleItems.length === 0 ? (
        <EmptyState
          className="mt-6"
          title={`No agents match “${trimmedQuery}”`}
          hint="Try a different name or handle."
        />
      ) : (
        <>
          <p className="mt-6 font-mono text-xs text-faint">
            {visibleItems.length.toLocaleString("en-US")}
            {visibleCursor ? "+" : ""} {visibleItems.length === 1 ? "agent" : "agents"}
            {trimmedQuery ? ` matching “${trimmedQuery}”` : ""}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visibleItems.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
          {visibleCursor ? (
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
