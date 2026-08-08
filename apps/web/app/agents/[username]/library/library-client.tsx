"use client";

/**
 * /agents/[username]/library — the agent's creations, newest first, with a
 * scope toggle: "This agent" (GET /feed/creations?agent=) or "All mine"
 * (user=me — every creation you own, including agent-less Studio output and
 * non-public rows).
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { CreationDto } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { MediaThumb } from "@/components/media";
import { Skeleton } from "@/components/skeleton";
import { describeApiFailure } from "@/components/agents/agent-utils";
import { UploadPanel } from "@/components/uploads/upload-panel";

type Scope = "agent" | "mine";

function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="aspect-square w-full rounded-xl" />
      ))}
    </div>
  );
}

export function LibraryClient({ username }: { username: string }) {
  const [scope, setScope] = useState<Scope>("agent");
  const [items, setItems] = useState<CreationDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);

  const params = useCallback(
    (cursorArg?: string) =>
      scope === "agent"
        ? { agent: username, ...(cursorArg ? { cursor: cursorArg } : {}) }
        : { user: "me", ...(cursorArg ? { cursor: cursorArg } : {}) },
    [scope, username],
  );

  useEffect(() => {
    const id = ++seq.current;
    setPhase("loading");
    void (async () => {
      try {
        const page = await api.feed.creations(params());
        if (seq.current !== id) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setPhase("ready");
      } catch (error) {
        if (seq.current !== id) return;
        setErrorText(describeApiFailure(error));
        setPhase("error");
      }
    })();
  }, [params, reloadKey]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.feed.creations(params(cursor));
      setItems((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...page.items.filter((c) => !seen.has(c.id))];
      });
      setCursor(page.nextCursor);
    } catch {
      /* keep what we have */
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div>
      <UploadPanel />

      <div
        role="group"
        aria-label="Library scope"
        className="mt-8 flex w-fit overflow-hidden rounded-lg border border-edge"
      >
        {(
          [
            ["agent", "This agent"],
            ["mine", "All mine"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={scope === value}
            onClick={() => setScope(value)}
            className={`px-3 py-2 text-sm transition-colors ${
              scope === value
                ? "bg-accent/15 text-accent-soft"
                : "bg-raised text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {phase === "loading" ? (
          <GridSkeleton />
        ) : phase === "error" ? (
          <EmptyState
            title="Couldn't load creations"
            hint={errorText}
            action={
              <button
                type="button"
                onClick={() => setReloadKey((k) => k + 1)}
                className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
              >
                Try again
              </button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={scope === "agent" ? "Nothing created yet" : "No creations yet"}
            hint={
              scope === "agent"
                ? "This agent hasn't made anything — start a chat and ask for an image."
                : "Creations from chats and the Studio land here."
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {items.map((creation) => (
                <Link
                  key={creation.id}
                  href={`/creations/${creation.externalId ?? creation.id}`}
                  className="transition-opacity hover:opacity-85"
                >
                  <MediaThumb creation={creation} />
                </Link>
              ))}
            </div>
            {cursor ? (
              <div className="mt-8 flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
