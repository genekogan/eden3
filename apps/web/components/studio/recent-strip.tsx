"use client";

/**
 * "Recent creations" strip at the bottom of /studio — the current user's
 * latest work from GET /api/feed/creations?user=me, merged with anything
 * generated in this session (so fresh results appear instantly even before
 * the feed catches up). Hidden entirely while loading, on error, or when
 * empty — the endpoint may 501 while the api lands.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { MediaThumb } from "@/components/media";
import { api } from "@/lib/api";

export interface StripItem {
  id: string;
  url: string | null;
  thumbnailUrl?: string | null;
  tool?: string | null;
}

export function RecentStrip({
  sessionItems,
  refreshSignal,
}: {
  /** Results generated in this session, newest first. */
  sessionItems: StripItem[];
  /** Bump to refetch (e.g. after a generation completes). */
  refreshSignal: number;
}) {
  const [fetched, setFetched] = useState<StripItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await api.feed.creations({ user: "me" });
        if (cancelled) return;
        setFetched(
          page.items
            .filter((creation) => creation.url || creation.thumbnailUrl)
            .slice(0, 12)
            .map((creation) => ({
              id: creation.id,
              url: creation.url,
              thumbnailUrl: creation.thumbnailUrl,
              tool: creation.tool,
            })),
        );
      } catch {
        // Unsupported/501/down — hide gracefully, keep session items.
        if (!cancelled) setFetched([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);

  const seen = new Set(sessionItems.map((item) => item.id));
  const items = [
    ...sessionItems,
    ...fetched.filter((item) => !seen.has(item.id)),
  ].slice(0, 16);

  if (items.length === 0) return null;

  return (
    <section className="mt-14">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        Recent creations
      </h2>
      <div className="mt-4 flex gap-3 overflow-x-auto pb-2">
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/creations/${encodeURIComponent(item.id)}`}
            className="shrink-0"
          >
            <MediaThumb
              url={item.url}
              thumbnailUrl={item.thumbnailUrl ?? null}
              alt={`${item.tool ?? "studio"} creation`}
              className="aspect-square w-28 sm:w-32"
            />
          </Link>
        ))}
      </div>
    </section>
  );
}
