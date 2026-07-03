"use client";

/**
 * Live manna balance chip (sidebar). Fetches GET /api/manna on mount, then:
 *   - applies balances broadcast from any active SSE stream instantly
 *     (manna.updated events pass through lib/api's manna bus), and
 *   - refetches for authority (subscriptionBalance isn't on the event).
 * DevUserSwitcher emits a bare refetch signal after impersonation.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, onMannaUpdate } from "@/lib/api";
import { formatManna, formatMannaExact } from "@/lib/format";

function MannaGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-3.5 shrink-0 text-accent-soft"
    >
      <path d="M6 3h12l4 6-10 13L2 9z" />
      <path d="M11 3 8 9l4 13 4-13-3-6M2 9h20" />
    </svg>
  );
}

export function MannaBadge({ className }: { className?: string }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [subscriptionBalance, setSubscriptionBalance] = useState<number | null>(
    null,
  );
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
    "loading",
  );
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const summary = await api.manna.get();
      if (!alive.current) return;
      setBalance(summary.balance);
      setSubscriptionBalance(summary.subscriptionBalance);
      setStatus("ready");
    } catch {
      // Endpoint may 501 / api may be down — show a quiet placeholder.
      if (!alive.current) return;
      setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const unsubscribe = onMannaUpdate((eventBalance) => {
      // Instant optimistic paint from the stream, then authoritative refetch.
      if (eventBalance !== undefined) {
        setBalance(eventBalance);
        setStatus("ready");
      }
      void refresh();
    });
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [refresh]);

  const title =
    status === "ready" && balance != null
      ? `${formatMannaExact(balance)} manna${
          subscriptionBalance ? ` · ${formatMannaExact(subscriptionBalance)} subscription` : ""
        }`
      : "Manna balance unavailable";

  return (
    <Link
      href="/manna"
      title={title}
      className={`flex items-center gap-1.5 rounded-full border border-edge bg-raised px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground ${className ?? ""}`}
    >
      <MannaGlyph />
      {status === "loading" ? (
        <span className="inline-block h-3 w-8 animate-pulse rounded bg-white/[0.08]" />
      ) : (
        <span className="tabular-nums">
          {status === "ready" ? formatManna(balance) : "—"}
        </span>
      )}
    </Link>
  );
}
