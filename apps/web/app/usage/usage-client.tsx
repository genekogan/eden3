"use client";

/**
 * /usage — the tenant (own-data) usage view.
 *
 * Plain-language answer to "how much have I spent and what have my agents been
 * doing?". Shows ONLY the signed-in viewer's data (GET /api/usage/summary,
 * scoped to user_id = viewer): manna balance, this-week / this-month spend,
 * and a friendly-labelled activity feed. Deliberately hides provider cost_usd
 * and the events/status/latency jargon of the admin /operator view.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing, onMannaUpdate } from "@/lib/api";
import type { UsageActivityEvent, UserUsageSummary } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { Skeleton, SkeletonRows } from "@/components/skeleton";
import {
  formatMannaExact,
  formatRelativeTime,
  formatUsdApprox,
} from "@/lib/format";

type Phase = "loading" | "ready" | "error";

function errorCopy(error: unknown): { title: string; hint: string } {
  if (isEndpointMissing(error)) {
    return {
      title: "Usage isn't wired up yet",
      hint: "The usage endpoint is still landing in the backend — this page lights up as soon as it ships.",
    };
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        title: "No user selected",
        hint: "Pick a dev user in the sidebar switcher to see their usage.",
      };
    }
    return { title: "Couldn't load usage", hint: error.message };
  }
  return { title: "API offline", hint: "Start @eden3/api on :4301 and retry." };
}

// ---------------------------------------------------------------------------
// Friendly labelling — turn opaque event rows into plain English.
// ---------------------------------------------------------------------------

/** "Generated an image", "Chatted with @abraham", … — never raw event_type. */
function friendlyAction(event: UsageActivityEvent): string {
  if (event.eventType === "studio_generation") {
    switch (event.tool) {
      case "image_generate":
        return "Generated an image";
      case "video_generate":
        return "Generated a video";
      case "music_generate":
        return "Generated music";
      case "tts":
        return "Generated speech";
      default:
        return "Made a creation";
    }
  }
  if (event.eventType === "chat_turn") {
    return event.agentUsername
      ? `Chatted with @${event.agentUsername}`
      : "Sent a chat message";
  }
  // Unknown type — humanize the identifier rather than leak snake_case.
  return event.eventType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function ActivityRow({ event }: { event: UsageActivityEvent }) {
  const errored = event.status === "error";
  const manna = event.manna ?? 0;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3.5 sm:px-5">
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${
          errored ? "bg-danger" : "bg-success"
        }`}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{friendlyAction(event)}</p>
        {errored ? (
          <p className="mt-0.5 text-xs text-danger-soft/90">
            {manna > 0 ? "failed" : "failed — refunded"}
          </p>
        ) : event.model ? (
          <p className="mt-0.5 truncate text-xs text-faint">{event.model}</p>
        ) : null}
      </div>
      <time
        dateTime={event.createdAt}
        title={event.createdAt}
        className="shrink-0 text-xs text-faint"
      >
        {formatRelativeTime(event.createdAt)}
      </time>
      <span className="w-24 shrink-0 text-right font-mono text-sm tabular-nums text-muted">
        {errored ? "—" : `${formatMannaExact(manna)}`}
        {!errored ? (
          <span className="ml-1 text-[11px] text-faint">manna</span>
        ) : null}
      </span>
    </li>
  );
}

function SpendCard({
  label,
  manna,
  events,
}: {
  label: string;
  manna: number;
  events: number;
}) {
  return (
    <div className="rounded-xl border border-edge bg-surface p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
        {label}
      </p>
      <p className="mt-3 text-2xl font-light tabular-nums">
        {formatMannaExact(manna)}
        <span className="ml-1.5 text-sm text-faint">manna</span>
      </p>
      <p className="mt-1 text-xs text-muted">
        {`≈ ${formatUsdApprox(manna)}`}
        <span className="text-faint">
          {" · "}
          {events === 1 ? "1 action" : `${events} actions`}
        </span>
      </p>
    </div>
  );
}

export function UsageClient({
  fixedAgent,
}: {
  /**
   * Agent-scoped "Log" mode (username): hides the account header + balance,
   * scopes spend/activity to the agent, and adds a This-agent/All toggle.
   */
  fixedAgent?: string;
} = {}) {
  const [summary, setSummary] = useState<UserUsageSummary | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<unknown>(null);
  const [scope, setScope] = useState<"agent" | "all">(fixedAgent ? "agent" : "all");
  const alive = useRef(true);

  const agentParam = fixedAgent && scope === "agent" ? fixedAgent : undefined;

  const load = useCallback(
    async (soft = false) => {
      if (!soft) setPhase("loading");
      try {
        const data = await api.usage.summary({
          limit: 25,
          ...(agentParam ? { agent: agentParam } : {}),
        });
        if (!alive.current) return;
        setSummary(data);
        setPhase("ready");
        setError(null);
      } catch (err) {
        if (!alive.current) return;
        setError(err);
        setPhase("error");
      }
    },
    [agentParam],
  );

  useEffect(() => {
    alive.current = true;
    void load();
    // A spend or top-up anywhere in the app changes the balance — refetch.
    const unsubscribe = onMannaUpdate(() => void load(true));
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [load]);

  const total = summary?.balance.total ?? null;

  return (
    <div className={fixedAgent ? "w-full" : "mx-auto w-full max-w-3xl px-6 py-14 md:px-10"}>
      {fixedAgent ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="group"
            aria-label="Log scope"
            className="flex w-fit overflow-hidden rounded-lg border border-edge"
          >
            {(
              [
                ["agent", "This agent"],
                ["all", "All agents"],
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
          {phase === "ready" ? (
            <button
              type="button"
              onClick={() => void load(true)}
              className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/40 hover:text-foreground"
            >
              Refresh
            </button>
          ) : null}
        </div>
      ) : (
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
              Account
            </p>
            <h1 className="mt-2 text-3xl font-light tracking-tight md:text-4xl">
              Usage &amp; billing
            </h1>
          </div>
          {phase === "ready" ? (
            <button
              type="button"
              onClick={() => void load(true)}
              className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/40 hover:text-foreground"
            >
              Refresh
            </button>
          ) : null}
        </header>
      )}

      {phase === "loading" ? (
        <div className="mt-10 space-y-6">
          <Skeleton className="h-28" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
          <SkeletonRows count={6} />
        </div>
      ) : phase === "error" ? (
        <div className="mt-10">
          <EmptyState
            {...errorCopy(error)}
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
        </div>
      ) : summary ? (
        <main className={`space-y-10 ${fixedAgent ? "mt-6" : "mt-10"}`}>
          {/* Balance — user-level, hidden in agent-scoped Log mode. */}
          <section
            aria-label="Balance"
            className={`rounded-xl border border-edge bg-surface p-6 md:p-8 ${fixedAgent ? "hidden" : ""}`}
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
              Manna balance
            </p>
            <p
              className="mt-3 text-4xl font-light tabular-nums tracking-tight md:text-5xl"
              title={total != null ? `${formatMannaExact(total)} manna` : undefined}
            >
              {formatMannaExact(total)}
              <span className="ml-2 text-base text-faint">manna</span>
            </p>
            <p className="mt-1.5 text-sm text-muted">
              ≈ {formatUsdApprox(total)} of credit remaining
            </p>
            <p className="mt-4 border-t border-edge pt-4 text-xs text-faint">
              Manna is Eden&apos;s usage credit — 1,000 manna ≈ $1. Every chat
              turn and generation spends a little.{" "}
              <a href="/account/manna" className="text-accent-soft hover:underline">
                Top up or manage billing
              </a>
              .
            </p>
          </section>

          {/* Spend summary */}
          <section aria-label="Spend">
            <h2 className="text-sm font-medium text-foreground">Recent spend</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <SpendCard
                label="This week"
                manna={summary.spend.week.manna}
                events={summary.spend.week.events}
              />
              <SpendCard
                label="This month"
                manna={summary.spend.month.manna}
                events={summary.spend.month.events}
              />
            </div>
          </section>

          {/* Activity */}
          <section aria-label="Activity">
            <h2 className="text-sm font-medium text-foreground">Recent activity</h2>
            <div className="mt-4">
              {summary.recent.length === 0 ? (
                <EmptyState
                  title="Nothing yet"
                  hint="Chats and generations you run will show up here."
                />
              ) : (
                <ul className="divide-y divide-edge/60 overflow-hidden rounded-xl border border-edge bg-surface">
                  {summary.recent.map((event) => (
                    <ActivityRow key={event.id} event={event} />
                  ))}
                </ul>
              )}
            </div>
          </section>
        </main>
      ) : null}
    </div>
  );
}
