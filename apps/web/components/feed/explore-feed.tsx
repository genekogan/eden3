"use client";

/**
 * /explore client surface: cursor-paginated masonry of public creations.
 *
 * - Pages come from GET /api/feed/creations (optionally narrowed to one
 *   agent/user via props from the route's searchParams). An
 *   IntersectionObserver sentinel pulls the next page ~two screens early;
 *   a "Load more" button is the keyboard/fallback path.
 * - All / Images / Video chips filter what's already loaded, client-side by
 *   extension/mime (v1 per contract). The sentinel keeps paging underneath
 *   a sparse filter so results keep arriving.
 * - Resilient while the api lands: masonry skeleton on first load, quiet
 *   EmptyStates for down/empty, inline retry when a page append fails.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { api, isApiUnavailable } from "@/lib/api";
import type { CreationDto } from "@/lib/types";
import { CreationCard } from "./creation-card";
import { isVideoCreation } from "./creation-fields";
import { FeedSkeleton, MASONRY_COLUMNS } from "./feed-skeleton";

const BUTTON =
  "rounded-md border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Video" },
] as const;
type MediaFilter = (typeof FILTERS)[number]["id"];

interface FeedState {
  items: CreationDto[];
  nextCursor: string | null;
  /** False until the first page lands (drives the skeleton). */
  initialized: boolean;
}

export function ExploreFeed({
  agent,
  user,
  favorites,
}: {
  agent?: string;
  user?: string;
  favorites?: "mine";
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [feed, setFeed] = useState<FeedState>({
    items: [],
    nextCursor: null,
    initialized: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<MediaFilter>("all");
  // Re-entrancy guard: one page in flight, ever (observer can re-fire, and
  // dev StrictMode replays the initial-load effect).
  const busyRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const q = debouncedQuery.trim() || undefined;
        const page = await api.feed.creations({ q, cursor, agent, user, favorites });
        setFeed((prev) => {
          // Keyset cursors can overlap when rows land mid-scroll — dedupe.
          const base = cursor ? prev.items : [];
          const seen = new Set(base.map((item) => item.id));
          return {
            items: [...base, ...page.items.filter((item) => !seen.has(item.id))],
            nextCursor: page.nextCursor,
            initialized: true,
          };
        });
      } catch (err) {
        setError(err);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [agent, debouncedQuery, favorites, user],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, query.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setFeed({ items: [], nextCursor: null, initialized: false });
    void load();
  }, [load]);

  // Pull the next page when the sentinel nears the viewport.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !feed.initialized || !feed.nextCursor || error) return;
    const cursor = feed.nextCursor;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void load(cursor);
      },
      { rootMargin: "1600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [feed.initialized, feed.nextCursor, error, load]);

  const visible = useMemo(() => {
    if (filter === "all") return feed.items;
    return feed.items.filter(
      (creation) => isVideoCreation(creation) === (filter === "video"),
    );
  }, [feed.items, filter]);

  // --- first page still outstanding ---------------------------------------

  if (!feed.initialized) {
    if (error) {
      const down = isApiUnavailable(error);
      return (
        <EmptyState
          title={down ? "The feed isn't connected yet" : "Couldn't load the feed"}
          hint={
            down
              ? "The api isn't reachable — it may still be starting. Try again in a moment."
              : error instanceof Error
                ? error.message
                : "Something unexpected went wrong."
          }
          action={
            <button type="button" onClick={() => void load()} className={BUTTON}>
              Try again
            </button>
          }
        />
      );
    }
    return <FeedSkeleton />;
  }

  if (feed.items.length === 0) {
    return (
      <EmptyState
        title={
          debouncedQuery
            ? `No creations match "${debouncedQuery}"`
            : favorites === "mine"
              ? "No favorites yet"
              : "Nothing here yet"
        }
        hint={
          debouncedQuery
            ? "Try another search or clear the query."
            : favorites === "mine"
              ? "Like a public creation and it will appear here."
              : "Public creations land here as agents make things."
        }
        action={
          debouncedQuery ? (
            <button type="button" onClick={() => setQuery("")} className={BUTTON}>
              Clear search
            </button>
          ) : favorites !== "mine" ? (
            <Link href="/chat" className={BUTTON}>
              Start a chat
            </Link>
          ) : undefined
        }
      />
    );
  }

  // --- the wall ------------------------------------------------------------

  return (
    <div>
      <div className="mb-4">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search creations…"
          aria-label="Search creations"
          className="w-full max-w-md rounded-lg border border-edge bg-raised px-3 py-2 text-sm placeholder:text-faint focus:border-accent/60 focus:outline-none"
        />
      </div>
      <div
        role="group"
        aria-label="Filter by media type"
        className="mb-5 flex items-center gap-1.5"
      >
        {FILTERS.map((option) => {
          const active = filter === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(option.id)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                active
                  ? "border-transparent bg-white/[0.08] text-foreground"
                  : "border-edge text-muted hover:border-white/20 hover:text-foreground"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={
            filter === "video"
              ? "No video in what's loaded so far"
              : "No images in what's loaded so far"
          }
          hint="More pages may bring some — or show everything again."
          action={
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={BUTTON}
            >
              Show all
            </button>
          }
        />
      ) : (
        <div className={MASONRY_COLUMNS}>
          {visible.map((creation) => (
            <CreationCard key={creation.id} creation={creation} />
          ))}
        </div>
      )}

      {/* Sentinel + pagination status. Lives outside the filter so paging
          continues while a sparse filter is active. */}
      <div
        ref={sentinelRef}
        className="flex items-center justify-center py-10"
        aria-live="polite"
      >
        {busy ? (
          <span className="text-xs text-faint">Loading more…</span>
        ) : error ? (
          <span className="flex items-center gap-3 text-xs text-muted">
            Couldn't load more.
            <button
              type="button"
              onClick={() => void load(feed.nextCursor ?? undefined)}
              className={BUTTON}
            >
              Retry
            </button>
          </span>
        ) : feed.nextCursor ? (
          <button
            type="button"
            onClick={() => feed.nextCursor && void load(feed.nextCursor)}
            className={BUTTON}
          >
            Load more
          </button>
        ) : (
          <>
            <span className="sr-only">End of the feed</span>
            <span aria-hidden className="size-1 rounded-full bg-edge" />
          </>
        )}
      </div>
    </div>
  );
}
