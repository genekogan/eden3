"use client";

/**
 * /collections/[id] — one collection: name, description, owner, and the
 * member creations in the position order the API returns them.
 *
 * GET /api/collections/:id (uuid or legacy 24-hex permalink id). Owner is
 * best-effort: an embedded owner/user summary when the API joins one in,
 * otherwise the impersonated dev user when the userId matches.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type { CollectionDetail, DevUser } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { EmptyState } from "@/components/empty-state";
import { MediaThumb } from "@/components/media";
import { Skeleton, SkeletonMediaGrid } from "@/components/skeleton";
import { formatDate } from "@/lib/format";

interface OwnerRef {
  username: string;
  userImage: string | null;
}

function resolveOwner(
  detail: CollectionDetail,
  me: DevUser | null,
): OwnerRef | null {
  const record = detail.collection as unknown as Record<string, unknown>;
  for (const key of ["owner", "user", "creator"]) {
    const candidate = record[key];
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as Record<string, unknown>).username === "string"
    ) {
      const summary = candidate as { username: string; userImage?: unknown };
      return {
        username: summary.username,
        userImage:
          typeof summary.userImage === "string" ? summary.userImage : null,
      };
    }
  }
  if (me && detail.collection.userId && me.id === detail.collection.userId) {
    return { username: me.username, userImage: me.userImage ?? null };
  }
  return null;
}

function errorCopy(error: unknown): { title: string; hint: string } {
  if (error instanceof ApiError && error.status === 404) {
    return {
      title: "Collection not found",
      hint: "It may be private, deleted, or the link may be wrong.",
    };
  }
  if (isEndpointMissing(error)) {
    return {
      title: "Collections aren't wired up yet",
      hint: "GET /api/collections/:id is still landing in the backend workflow — this page lights up as soon as it ships.",
    };
  }
  if (error instanceof ApiError) {
    return { title: "Couldn't load this collection", hint: error.message };
  }
  return { title: "API offline", hint: "Start @eden3/api on :4301 and retry." };
}

type Phase = "loading" | "ready" | "error";

export function CollectionClient({ id }: { id: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [detail, setDetail] = useState<CollectionDetail | null>(null);
  const [owner, setOwner] = useState<OwnerRef | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const [result, me] = await Promise.all([
        api.collections.get(id),
        api.dev.me().catch(() => null),
      ]);
      if (!alive.current) return;
      setDetail(result);
      setOwner(resolveOwner(result, me));
      setPhase("ready");
    } catch (error) {
      if (!alive.current) return;
      setLoadError(error);
      setPhase("error");
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const collection = detail?.collection;
  const creations = detail?.creations ?? [];
  const count =
    phase === "ready" ? (creations.length || collection?.creationCount) ?? 0 : 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-14 md:px-10">
      <Link
        href="/collections"
        className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint transition-colors hover:text-muted"
      >
        ← Collections
      </Link>

      {phase === "loading" ? (
        <div className="mt-4">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="mt-3 h-4 w-96 max-w-full" />
          <SkeletonMediaGrid className="mt-10" count={8} />
        </div>
      ) : phase === "error" ? (
        <EmptyState
          className="mt-10"
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
      ) : collection ? (
        <>
          <header className="mt-4">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-light tracking-tight md:text-4xl">
                {collection.name ?? "Untitled collection"}
              </h1>
              {!collection.public ? (
                <span className="rounded-full border border-edge bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-faint">
                  private
                </span>
              ) : null}
            </div>
            {collection.description ? (
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
                {collection.description}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-faint">
              {owner ? (
                <span className="inline-flex items-center gap-1.5 text-muted">
                  <AgentAvatar
                    src={owner.userImage}
                    name={owner.username}
                    size={18}
                  />
                  @{owner.username}
                </span>
              ) : null}
              {owner ? <span aria-hidden>·</span> : null}
              <span>
                {count} creation{count === 1 ? "" : "s"}
              </span>
              <span aria-hidden>·</span>
              <span>updated {formatDate(collection.updatedAt)}</span>
            </div>
          </header>

          <div className="mt-10">
            {creations.length === 0 ? (
              <EmptyState
                title="This collection is empty"
                hint="Creations added to it will show up here in order."
              />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {creations.map((creation) => (
                  <Link
                    key={creation.id}
                    href={`/creations/${encodeURIComponent(creation.id)}`}
                    className="group relative"
                  >
                    <MediaThumb
                      creation={creation}
                      className="aspect-square transition-opacity group-hover:opacity-90"
                    />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
