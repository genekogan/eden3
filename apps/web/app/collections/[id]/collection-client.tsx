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
import type { FormEvent } from "react";
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
  const [canEdit, setCanEdit] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [creationRef, setCreationRef] = useState("");
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationNote, setMutationNote] = useState<string | null>(null);
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
      setCanEdit(Boolean(me && (me.isAdmin || me.id === result.collection.userId)));
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

  const addCreation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ref = creationRef.trim();
    if (!ref || mutationBusy) return;
    setMutationBusy(true);
    setMutationError(null);
    setMutationNote(null);
    try {
      await api.collections.addCreation(id, { creationId: ref });
      setCreationRef("");
      setMutationNote("Creation added.");
      await load();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Couldn't add creation.");
    } finally {
      if (alive.current) setMutationBusy(false);
    }
  };

  const removeCreation = async (creationId: string) => {
    if (mutationBusy) return;
    setMutationBusy(true);
    setMutationError(null);
    setMutationNote(null);
    try {
      await api.collections.removeCreation(id, creationId);
      setMutationNote("Creation removed.");
      await load();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Couldn't remove creation.");
    } finally {
      if (alive.current) setMutationBusy(false);
    }
  };

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
            {canEdit ? (
              <form
                onSubmit={(event) => void addCreation(event)}
                className="mt-5 flex flex-col gap-2 rounded-xl border border-edge bg-surface p-3 sm:flex-row sm:items-center"
              >
                <input
                  value={creationRef}
                  onChange={(event) => setCreationRef(event.target.value)}
                  placeholder="Creation id or legacy id"
                  aria-label="Creation id"
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-background px-3 py-2 text-sm placeholder:text-faint focus:border-accent/60 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={mutationBusy || creationRef.trim().length === 0}
                  className="rounded-lg border border-edge px-3 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {mutationBusy ? "Saving…" : "Add"}
                </button>
              </form>
            ) : null}
            {mutationNote ? <p className="mt-2 text-xs text-emerald-300">{mutationNote}</p> : null}
            {mutationError ? <p className="mt-2 text-xs text-rose-300">{mutationError}</p> : null}
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
                  <div key={creation.id} className="group relative">
                    <Link
                      href={`/creations/${encodeURIComponent(creation.id)}`}
                      className="block"
                    >
                      <MediaThumb
                        creation={creation}
                        className="aspect-square transition-opacity group-hover:opacity-90"
                      />
                    </Link>
                    {canEdit ? (
                      <button
                        type="button"
                        disabled={mutationBusy}
                        onClick={() => void removeCreation(creation.id)}
                        className="absolute right-2 top-2 rounded-md border border-edge bg-background/90 px-2 py-1 text-[11px] text-muted opacity-0 shadow-lg shadow-black/30 transition-opacity hover:border-rose-300/50 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
