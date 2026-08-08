"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type {
  AgentModel,
  AgentRuntime,
  ModelRuntimeDto,
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
      ? "bg-success"
      : tone === "warn"
        ? "bg-warning"
        : tone === "bad"
          ? "bg-danger"
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
  // "models" here is the /v1/models count (~1 endpoint per registered agent),
  // not a menu of distinct base models — label it "routable endpoints" and
  // tag the round-trip time as a probe so neither reads as something it isn't.
  const gatewayLine = !gateway.configured
    ? "not configured"
    : gateway.reachable
      ? `reachable · ${gateway.registeredAgents ?? 0} agents · ${gateway.routableModels ?? 0} routable endpoints${gateway.latencyMs != null ? ` · ${gateway.latencyMs}ms probe` : ""}`
      : `unreachable${gateway.error ? ` · ${gateway.error}` : ""}`;

  const egress = health.egressProxy;
  const egressTone: "ok" | "warn" | "muted" =
    egress.reachable === true ? "ok" : egress.reachable === false ? "warn" : "muted";
  const egressLine =
    egress.reachable === true
      ? `${egress.mode === "open" ? "public web allowed · internals sealed" : egress.mode}`
      : egress.reachable === false
        ? "unreachable"
        : "not mapped to host";

  const rows: Array<{
    label: string;
    tone: "ok" | "warn" | "bad" | "muted";
    line: string;
    hint?: string;
  }> = [
    {
      label: "Gateway",
      tone: gatewayTone,
      line: gatewayLine,
      hint: "OpenClaw gateway. Routable endpoints = the /v1/models list (roughly one per registered agent, plus a couple of base models); probe = round-trip time of a single reachability fetch.",
    },
    {
      label: "Egress proxy",
      tone: egressTone,
      line: egressLine,
      hint: "Sandboxed agents can reach the public web but are blocked from platform internals (the sealed interior).",
    },
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
            <p
              className="mt-1 truncate font-mono text-[11px] text-muted"
              title={row.hint ? `${row.line}\n\n${row.hint}` : row.line}
            >
              {row.line}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ModelRuntimePanel({
  models,
  updating,
  error,
  onChange,
}: {
  models: ModelRuntimeDto[];
  updating: AgentModel | null;
  error: string | null;
  onChange: (model: AgentModel, agentRuntime: AgentRuntime) => void;
}) {
  return (
    <section
      aria-label="Model runtimes"
      className="rounded-xl border border-edge bg-surface p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
            Model runtimes
          </p>
          <p className="mt-1 max-w-2xl text-xs text-muted">
            Applies to every agent using the model. Subscription turns still use
            notional token pricing for manna, but are excluded from provider invoice
            reconciliation.
          </p>
        </div>
        {error ? <p className="text-xs text-danger-soft">{error}</p> : null}
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {models.map((row) => {
          // Runtime updates are read/modify/write operations on one shared
          // OpenClaw config. Keep the whole catalog single-flight so two quick
          // operator changes cannot race and silently lose one model's toggle.
          const busy = updating !== null;
          return (
            <label
              key={row.model}
              className="flex min-w-0 items-center justify-between gap-4 rounded-lg border border-edge/60 bg-raised/40 p-3"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-foreground">
                  {row.model.replace("anthropic/", "")}
                </span>
                <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.15em] text-faint">
                  {row.agentRuntime === "claude-cli"
                    ? "notional subscription"
                    : "provider API"}
                </span>
              </span>
              <select
                aria-label={`${row.model} runtime`}
                value={row.agentRuntime}
                disabled={busy}
                onChange={(event) =>
                  onChange(row.model, event.target.value as AgentRuntime)
                }
                className="rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs text-foreground disabled:opacity-50"
              >
                <option value="openclaw">Provider API</option>
                <option value="claude-cli">Claude subscription</option>
              </select>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  hint?: string;
}) {
  return (
    <div
      className="min-w-0 rounded-lg border border-edge bg-surface px-4 py-3"
      title={hint}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
        {label}
        {hint ? <span aria-hidden className="ml-1 text-faint/70">ⓘ</span> : null}
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
            error ? "bg-danger" : "bg-success"
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
        // Relaxed min-width + Model/Latency hidden below lg keeps the money
        // columns (Cost, Manna) on-screen on narrow viewports; the right-edge
        // fade and caption make the remaining horizontal scroll discoverable
        // so nothing silently clips.
        <div className="relative">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-edge font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
              <tr>
                <th className="px-4 py-2.5 font-medium">Time</th>
                <th className="px-4 py-2.5 font-medium">Event</th>
                <th className="px-4 py-2.5 font-medium">User</th>
                <th className="px-4 py-2.5 font-medium">Agent</th>
                <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Model</th>
                <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                <th className="px-4 py-2.5 text-right font-medium">Manna</th>
                <th className="hidden px-4 py-2.5 text-right font-medium lg:table-cell">
                  Latency
                </th>
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
                            errored ? "bg-danger" : "bg-success"
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
                    <td className="hidden px-4 py-3 lg:table-cell">
                      <div className="truncate">{row.model ?? "unknown"}</div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-faint">
                        {row.provider ?? "no provider"} · {row.pricingBasis}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs tabular-nums text-muted">
                      {usd.format(row.costUsd)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs tabular-nums text-muted">
                      {formatMannaExact(row.manna)}
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-3 text-right font-mono text-xs tabular-nums text-muted lg:table-cell">
                      {row.latencyMs == null ? "n/a" : `${integer.format(row.latencyMs)} ms`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-surface to-transparent lg:hidden"
          />
          <p className="border-t border-edge px-4 py-2 text-[11px] text-faint lg:hidden">
            Scroll sideways for cost &amp; manna →
          </p>
        </div>
      )}
    </section>
  );
}

export function OperatorClient() {
  const [summary, setSummary] = useState<OperatorUsageSummary | null>(null);
  const [health, setHealth] = useState<OperatorHealth | null>(null);
  const [modelRuntimes, setModelRuntimes] = useState<ModelRuntimeDto[] | null>(null);
  const [runtimeUpdating, setRuntimeUpdating] = useState<AgentModel | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<unknown>(null);
  const [days, setDays] = useState(7);
  const alive = useRef(true);

  const load = useCallback(
    async (soft = false) => {
      if (!soft) setPhase("loading");
      try {
        const [data, healthData, runtimeData] = await Promise.all([
          api.operator.usageSummary({ days, limit: 25 }),
          api.operator.health().catch(() => null),
          api.operator.modelRuntimes().catch(() => null),
        ]);
        if (!alive.current) return;
        setSummary(data);
        setHealth(healthData);
        setModelRuntimes(runtimeData?.models ?? null);
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

  const updateModelRuntime = useCallback(
    async (model: AgentModel, agentRuntime: AgentRuntime) => {
      setRuntimeUpdating(model);
      setRuntimeError(null);
      try {
        const updated = await api.operator.setModelRuntime({ model, agentRuntime });
        if (!alive.current) return;
        setModelRuntimes((rows) =>
          rows?.map((row) =>
            row.model === updated.model
              ? { model: updated.model, agentRuntime: updated.agentRuntime }
              : row,
          ) ?? null,
        );
      } catch (err) {
        if (!alive.current) return;
        setRuntimeError(err instanceof Error ? err.message : "Runtime update failed");
      } finally {
        if (alive.current) setRuntimeUpdating(null);
      }
    },
    [],
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-10 md:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
            Operator
          </p>
          <h1 className="mt-2 text-3xl font-light tracking-tight md:text-4xl">
            Platform usage
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted">
            Admin view across all tenants — runtime health, spend, and metered
            activity. Users see only their own data on{" "}
            <a href="/usage" className="text-accent-soft hover:underline">
              Usage
            </a>
            .
          </p>
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
          {modelRuntimes ? (
            <ModelRuntimePanel
              models={modelRuntimes}
              updating={runtimeUpdating}
              error={runtimeError}
              onChange={(model, agentRuntime) =>
                void updateModelRuntime(model, agentRuntime)
              }
            />
          ) : null}
          <section
            aria-label="Usage totals"
            className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
          >
            <Metric
              label="Metered cost basis"
              value={usd.format(summary.totals.costUsd)}
              sub={`${formatMannaExact(summary.totals.manna)} manna billed`}
              hint="Provider-API rows use observed provider cost; subscription rows use notional token pricing. Manna is what users were billed. Admin-only — never shown to users."
            />
            <Metric
              label="Metered calls"
              value={integer.format(summary.totals.events)}
              sub={`${integer.format(summary.totals.errors)} errors`}
              hint="One event = one metered provider call (a chat turn or a generation). 'Errors' are calls that failed."
            />
            <Metric
              label="Avg call latency"
              value={
                summary.totals.avgLatencyMs == null
                  ? "n/a"
                  : `${decimal.format(summary.totals.avgLatencyMs)} ms`
              }
              sub={`chat + media · ${summary.window.days}-day window`}
              hint="Unweighted mean across every call, chat and media alike. Long video/image generations pull this up, so it reads far higher than a typical chat turn."
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
              <p className="mt-0.5 text-xs text-faint">
                Metered calls bucketed by outcome — one row per status
                (completed, error, …).
              </p>
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
