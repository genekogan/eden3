"use client";

/**
 * /collections — the current user's collections as cover cards.
 *
 * Identity comes from the dev impersonation cookie (GET /api/dev/me), then
 * GET /api/users/:username/collections lists the grid. Cards link to
 * /collections/:id; covers use the embedded coverCreations (see cover.tsx).
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type { CollectionDto, DevUser } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { formatDate } from "@/lib/format";
import { CollectionCover } from "./cover";

type Phase = "loading" | "ready" | "no-user" | "error";

function errorCopy(error: unknown): { title: string; hint: string } {
  if (isEndpointMissing(error)) {
    return {
      title: "Collections aren't wired up yet",
      hint: "GET /api/users/:username/collections is still landing in the backend workflow — this page lights up as soon as it ships.",
    };
  }
  if (error instanceof ApiError) {
    return { title: "Couldn't load collections", hint: error.message };
  }
  return { title: "API offline", hint: "Start @eden3/api on :4301 and retry." };
}

function SkeletonCards({ count = 6 }: { count?: number }) {
  return (
    <div
      aria-hidden
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-xl border border-edge/60"
        >
          <Skeleton className="aspect-[4/3] rounded-none" />
          <div className="space-y-2 p-4">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CollectionsClient() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [collections, setCollections] = useState<CollectionDto[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      let me: DevUser | null = null;
      try {
        me = await api.dev.me();
      } catch {
        // /dev/me may 501 or the api may be down — fall through to no-user.
      }
      if (!alive.current) return;
      if (!me) {
        setPhase("no-user");
        return;
      }
      const { items } = await api.users.collections(me.username);
      if (!alive.current) return;
      setCollections(items);
      setPhase("ready");
    } catch (error) {
      if (!alive.current) return;
      setLoadError(error);
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-14 md:px-10">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
          Library
        </p>
        <h1 className="mt-2 text-3xl font-light tracking-tight md:text-4xl">
          Collections
        </h1>
        <p className="mt-2 text-sm text-muted">
          Creations you&apos;ve grouped together.
        </p>
      </header>

      <div className="mt-10">
        {phase === "loading" ? (
          <SkeletonCards />
        ) : phase === "no-user" ? (
          <EmptyState
            title="No user selected"
            hint="Pick a dev user in the sidebar switcher to browse their collections."
          />
        ) : phase === "error" ? (
          <EmptyState
            {...errorCopy(loadError)}
            action={
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
              >
                Retry
              </button>
            }
          />
        ) : collections.length === 0 ? (
          <EmptyState
            title="No collections yet"
            hint="Collections group creations you want to keep together — save from the feed or a creation page."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {collections.map((collection) => (
              <Link
                key={collection.id}
                href={`/collections/${encodeURIComponent(collection.id)}`}
                className="group overflow-hidden rounded-xl border border-edge bg-surface transition-colors hover:border-accent/40"
              >
                <div className="aspect-[4/3] overflow-hidden bg-raised">
                  <CollectionCover collection={collection} />
                </div>
                <div className="p-4">
                  <div className="flex items-center gap-2">
                    <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {collection.name ?? "Untitled collection"}
                    </h2>
                    {!collection.public ? (
                      <span className="shrink-0 rounded-full border border-edge bg-white/[0.04] px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-faint">
                        private
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-faint">
                    {typeof collection.creationCount === "number"
                      ? `${collection.creationCount} creation${collection.creationCount === 1 ? "" : "s"}`
                      : "Collection"}
                    <span> · updated {formatDate(collection.updatedAt)}</span>
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
