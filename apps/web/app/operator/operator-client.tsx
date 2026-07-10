"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type {
  OperatorHealth,
  OperatorRecentUsageEvent,
  OperatorStatusBreakdown,
  OperatorUsageBreakdown,
  OperatorUsageSummary,
} from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { Skeleton, SkeletonRows } from "@/components/skeleton";
import { formatMannaExact } from "@/lib/format";

type Phase = "loading" | "ready" | "error";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function errorCopy(error: unknown): { title: string; hint: string } {
  if (isEndpointMissing(error)) {
    return {
      title: "Operator data isn't wired up yet",
      hint: "The usage summary endpoint is unavailable in the current API process.",
    };
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        title: "No user selected",
        hint: "Pick an admin dev user in the sidebar switcher.",
      };
    }
    if (error.status === 403) {
      return {
        title: "Admin access required",
        hint: "Set ADMIN_USERNAMES and impersonate one of those accounts.",
      };
    }
    return { title: "Couldn't load operator data", hint: error.message };
  }
  return { title: "API offline", hint: "Start @eden3/api on :4301 and retry." };
}

function HealthDot({ tone }: { tone: "ok" | "warn" | "bad" | "muted" }) {
  const color =
    tone === "ok"
      ? "bg-emerald-400"
      : tone === "warn"
        ? "bg-amber-400"
        : tone === "bad"
          ? "bg-rose-400"
          : "bg-faint";
  return <span aria-hidden className={`inline-block size-2 rounded-full ${color}`} />;
}

function HealthPanel({ health }: { health: OperatorHealth }) {
  const gateway = health.gateway;
  const gatewayTone: "ok" | "warn" | "bad" = !gateway.configured
    ? "warn"
    : gateway.reachable
      ? "ok"
      : "bad";
  const gatewayLine = !gateway.configured
    ? "not configured"
    : gateway.reachable
      ? `reachable · ${gateway.routableModels ?? 0} models · ${gateway.registeredAgents ?? 0} agents${gateway.latencyMs != null ? ` · ${gateway.latencyMs}ms` : ""}`
      : `unreachable${gateway.error ? ` · ${gateway.error}` : ""}`;

  const egress = health.egressProxy;
  const egressTone: "ok" | "warn" | "muted" =
    egress.reachable === true ? "ok" : egress.reachable === false ? "warn" : "muted";
  const egressLine =
    egress.reachable === true
      ? `${egress.mode === "open" ? "open exterior / sealed interior" : egress.mode}`
      : egress.reachable === false
        ? "unreachable"
        : "not mapped to host";

  const rows: Array<{ label: string; tone: "ok" | "warn" | "bad" | "muted"; line: string }> = [
    { label: "Gateway", tone: gatewayTone, line: gatewayLine },
    { label: "Egress proxy", tone: egressTone, line: egressLine },
    {
      label: "Scheduler",
      tone: health.scheduler.running ? "ok" : "warn",
      line: health.scheduler.running ? "running" : "stopped",
    },
    {
      label: "Database",
      tone: health.database === "eden3" ? "ok" : "warn",
      line: health.database ?? "unknown",
    },
  ];

  return (
    <section
      aria-label="Runtime health"
      className="rounded-xl border border-edge bg-surface p-5"
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
        Runtime health
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((row) => (
          <div key={row.label} className="rounded-lg border border-edge/60 bg-raised/40 p-3">
            <div className="flex items-center gap-2">
              <HealthDot tone={row.tone} />
              <span className="text-sm text-foreground">{row.label}</span>
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-muted" title={row.line}>
              {row.line}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-edge bg-surface px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
        {label}
      </div>
      <div className="mt-2 truncate text-2xl font-light tabular-nums">{value}</div>
      {sub ? <div className="mt-1 truncate text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

function StatusRow({ row }: { row: OperatorStatusBreakdown }) {
  const error = row.status === "error";
  return (
    <li className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-4 py-2.5 text-sm">
      <span className="min-w-0 truncate">
        <span
          className={`mr-2 inline-block size-1.5 rounded-full ${
            error ? "bg-rose-400" : "bg-emerald-400"
          }`}
        />
        {row.status}
      </span>
      <span className="font-mono text-xs tabular-nums text-muted">
        {integer.format(row.events)}
      </span>
      <span className="font-mono text-xs tabular-nums text-muted">
        {usd.format(row.costUsd)}
      </span>
      <span className="font-mono text-xs tabular-nums text-muted">
        {formatMannaExact(row.manna)}
      </span>
    </li>
  );
}

function BreakdownTable({
  title,
  rows,
  idKey,
}: {
  title: string;
  rows: OperatorUsageBreakdown[];
  idKey: "userId" | "agentId";
}) {
  return (
    <section className="min-w-0 rounded-lg border border-edge bg-surface">
      <div className="flex items-center justify-between border-b border-edge px-4 py-3">
        <h2 className="text-sm font-medium">{title}</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
          cost
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-sm text-muted">No rows</div>
      ) : (
        <ul className="divide-y divide-edge">
          {rows.map((row) => (
            <li
              key={`${row[idKey] ?? "unknown"}-${row.username ?? "unknown"}`}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="truncate text-sm">{row.username ?? "unknown"}</div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-faint">
                  {row[idKey] ?? "no id"}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm tabular-nums">{usd.format(row.costUsd)}</div>
                <div className="mt-0.5 font-mono text-[11px] text-faint">
                  {integer.format(row.events)} events
                </div>
              </div>
              <div className="w-24 text-right font-mono text-sm tabular-nums text-muted">
                {formatMannaExact(row.manna)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentActivity({ rows }: { rows: OperatorRecentUsageEvent[] }) {
  return (
    <section className="min-w-0 rounded-lg border border-edge bg-surface">
      <div className="flex items-center justify-between border-b border-edge px-4 py-3">
        <h2 className="text-sm font-medium">Recent Activity</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
          latest
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-sm text-muted">No rows</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-edge font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
              <tr>
                <th className="px-4 py-2.5 font-medium">Time</th>
                <th className="px-4 py-2.5 font-medium">Event</th>
                <th className="px-4 py-2.5 font-medium">User</th>
                <th className="px-4 py-2.5 font-medium">Agent</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                <th className="px-4 py-2.5 text-right font-medium">Manna</th>
                <th className="px-4 py-2.5 text-right font-medium">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {rows.map((row) => {
                const errored = row.status === "error";
                return (
                  <tr key={row.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">
                      {time.format(new Date(row.createdAt))}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={`inline-block size-1.5 rounded-full ${
                            errored ? "bg-rose-400" : "bg-emerald-400"
                          }`}
                        />
                        <span className="truncate">{row.eventType}</span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-faint">
                        {errored
                          ? row.errorCode ?? row.errorMessage ?? "error"
                          : row.status}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="truncate">{row.userUsername ?? "unknown"}</div>
                      <div className="mt-0.5 max-w-40 truncate font-mono text-[11px] text-faint">
                        {row.userId ?? "no id"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="truncate">{row.agentUsername ?? "unknown"}</div>
                      <div className="mt-0.5 max-w-40 truncate font-mono text-[11px] text-faint">
                        {row.agentId ?? "no id"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="truncate">{row.model ?? "unknown"}</div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-faint">
                        {row.provider ?? "no provider"}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs tabular-nums text-muted">
                      {usd.format(row.costUsd)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs tabular-nums text-muted">
                      {formatMannaExact(row.manna)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs tabular-nums text-muted">
                      {row.latencyMs == null ? "n/a" : `${integer.format(row.latencyMs)} ms`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function OperatorClient() {
  const [summary, setSummary] = useState<OperatorUsageSummary | null>(null);
  const [health, setHealth] = useState<OperatorHealth | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<unknown>(null);
  const [days, setDays] = useState(7);
  const alive = useRef(true);

  const load = useCallback(
    async (soft = false) => {
      if (!soft) setPhase("loading");
      try {
        const [data, healthData] = await Promise.all([
          api.operator.usageSummary({ days, limit: 25 }),
          api.operator.health().catch(() => null),
        ]);
        if (!alive.current) return;
        setSummary(data);
        setHealth(healthData);
        setPhase("ready");
        setError(null);
      } catch (err) {
        if (!alive.current) return;
        setError(err);
        setPhase("error");
      }
    },
    [days],
  );

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-10 md:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
            Operator
          </p>
          <h1 className="mt-2 text-3xl font-light tracking-tight md:text-4xl">
            Usage
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {[7, 30, 90].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setDays(value)}
              className={`rounded-lg border px-3 py-1.5 font-mono text-xs tabular-nums transition-colors ${
                days === value
                  ? "border-accent/60 bg-accent/15 text-accent-soft"
                  : "border-edge text-muted hover:border-accent/40 hover:text-foreground"
              }`}
            >
              {value}d
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load(true)}
            className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/40 hover:text-foreground"
          >
            Refresh
          </button>
        </div>
      </header>

      {phase === "loading" ? (
        <div className="mt-8 space-y-6">
          <div className="grid gap-3 md:grid-cols-4">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
          <SkeletonRows count={8} />
        </div>
      ) : phase === "error" ? (
        <div className="mt-8">
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
        <main className="mt-8 space-y-6">
          {health ? <HealthPanel health={health} /> : null}
          <section
            aria-label="Usage totals"
            className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
          >
            <Metric
              label="Cost"
              value={usd.format(summary.totals.costUsd)}
              sub={`${formatMannaExact(summary.totals.manna)} manna`}
            />
            <Metric
              label="Events"
              value={integer.format(summary.totals.events)}
              sub={`${integer.format(summary.totals.errors)} errors`}
            />
            <Metric
              label="Latency"
              value={
                summary.totals.avgLatencyMs == null
                  ? "n/a"
                  : `${decimal.format(summary.totals.avgLatencyMs)} ms`
              }
              sub={`${summary.window.days} day window`}
            />
            <Metric
              label="Rows"
              value={integer.format(summary.byUser.length + summary.byAgent.length)}
              sub="users + agents"
            />
          </section>

          <section className="rounded-lg border border-edge bg-surface">
            <div className="border-b border-edge px-4 py-3">
              <h2 className="text-sm font-medium">Status</h2>
            </div>
            {summary.byStatus.length === 0 ? (
              <div className="px-4 py-8 text-sm text-muted">No rows</div>
            ) : (
              <ul className="divide-y divide-edge">
                {summary.byStatus.map((row) => (
                  <StatusRow key={row.status} row={row} />
                ))}
              </ul>
            )}
          </section>

          <RecentActivity rows={summary.recent} />

          <div className="grid gap-6 xl:grid-cols-2">
            <BreakdownTable title="Users" rows={summary.byUser} idKey="userId" />
            <BreakdownTable title="Agents" rows={summary.byAgent} idKey="agentId" />
          </div>
        </main>
      ) : null}
    </div>
  );
}
