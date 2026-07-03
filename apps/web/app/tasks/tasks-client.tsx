"use client";

/**
 * /tasks — the current user's scheduled triggers.
 *
 * GET /api/tasks lists them; rows show name, agent, a human-readable
 * schedule, a status chip, and last/next run when the API includes them.
 * Pause/resume/delete all go through PATCH /api/tasks/:id {status}
 * (delete = status "finished", then the row leaves the list). "New task"
 * opens the modal (POST /api/tasks).
 *
 * TriggerDto only carries agentId, so agent identities resolve from
 * GET /api/agents pages (plus any `agent` summary the API embeds).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type {
  AccountSummary,
  AgentDto,
  TriggerDto,
  TriggerStatus,
} from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/skeleton";
import { formatRelativeTime } from "@/lib/format";
import { describeSchedule } from "./schedule";
import { NewTaskModal } from "./new-task-modal";

type AgentRef = Pick<AgentDto, "username" | "userImage"> & {
  name?: string | null;
};

// ---------------------------------------------------------------------------
// Loose readers — fields the API may embed beyond the shared DTO
// ---------------------------------------------------------------------------

function embeddedAgent(trigger: TriggerDto): AgentRef | null {
  const candidate = (trigger as unknown as Record<string, unknown>).agent;
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof (candidate as Record<string, unknown>).username === "string"
  ) {
    const summary = candidate as AccountSummary & { name?: string | null };
    return {
      username: summary.username,
      userImage: summary.userImage ?? null,
      name: summary.name ?? null,
    };
  }
  return null;
}

/** last/next run timestamps if the API provides them (not in the base DTO). */
function runTimes(trigger: TriggerDto): { last?: string; next?: string } {
  const obj = trigger as unknown as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === "string" && value !== "") return value;
    }
    return undefined;
  };
  const result: { last?: string; next?: string } = {};
  const last = pick("lastRunAt", "last_run_time", "lastRun");
  const next = pick("nextRunAt", "next_run_time", "nextRun", "nextRunTime");
  if (last) result.last = last;
  if (next) result.next = next;
  return result;
}

function errorCopy(error: unknown): { title: string; hint: string } {
  if (isEndpointMissing(error)) {
    return {
      title: "Tasks aren't wired up yet",
      hint: "GET /api/tasks is still landing in the backend workflow — this page lights up as soon as it ships.",
    };
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        title: "No user selected",
        hint: "Pick a dev user in the sidebar switcher to see their scheduled tasks.",
      };
    }
    return { title: "Couldn't load tasks", hint: error.message };
  }
  return {
    title: "API offline",
    hint: "Start @eden3/api on :4301 and retry.",
  };
}

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

const STATUS_TONES: Record<string, { chip: string; dot: string }> = {
  active: {
    chip: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
    dot: "bg-emerald-400",
  },
  running: {
    chip: "border-accent/40 bg-accent/10 text-accent-soft",
    dot: "animate-pulse bg-accent",
  },
  paused: {
    chip: "border-edge bg-white/[0.04] text-muted",
    dot: "bg-faint",
  },
  finished: {
    chip: "border-edge bg-white/[0.03] text-faint",
    dot: "bg-faint/60",
  },
};

function StatusChip({ status }: { status: string | null }) {
  const key = (status ?? "").toLowerCase();
  const tone = STATUS_TONES[key] ?? STATUS_TONES.paused!;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone.chip}`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${tone.dot}`} />
      {status ?? "unknown"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Phase = "loading" | "ready" | "error";

export function TasksClient() {
  const [tasks, setTasks] = useState<TriggerDto[]>([]);
  const [agents, setAgents] = useState<Map<string, AgentRef>>(new Map());
  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  const confirmTimer = useRef<number | null>(null);

  const load = useCallback(async (soft = false) => {
    if (!soft) setPhase("loading");
    try {
      const { items } = await api.tasks.list();
      if (!alive.current) return;
      setTasks(items);
      setPhase("ready");
      setLoadError(null);

      // Resolve agent identities: embedded summaries first, then pages of
      // GET /api/agents until every referenced agentId is covered (capped).
      const map = new Map<string, AgentRef>();
      for (const task of items) {
        const embedded = embeddedAgent(task);
        if (embedded && task.agentId) map.set(task.agentId, embedded);
      }
      const missing = new Set(
        items
          .map((task) => task.agentId)
          .filter((id): id is string => !!id && !map.has(id)),
      );
      let cursor: string | undefined;
      for (let page = 0; page < 5 && missing.size > 0; page += 1) {
        const result = await api.agents.list(cursor ? { cursor } : {});
        for (const agent of result.items) {
          if (missing.has(agent.id)) {
            map.set(agent.id, agent);
            missing.delete(agent.id);
          }
        }
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      if (alive.current) setAgents(map);
    } catch (error) {
      if (!alive.current) return;
      if (soft) {
        setNote(errorCopy(error).hint);
      } else {
        setLoadError(error);
        setPhase("error");
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      if (confirmTimer.current != null) {
        window.clearTimeout(confirmTimer.current);
      }
    };
  }, [load]);

  // Transient error note fades after a few seconds.
  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 6000);
    return () => window.clearTimeout(timer);
  }, [note]);

  const setStatus = async (task: TriggerDto, status: TriggerStatus) => {
    setBusyId(task.id);
    try {
      await api.tasks.update(task.id, { status });
      if (!alive.current) return;
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, status } : t)),
      );
    } catch (error) {
      if (alive.current) setNote(errorCopy(error).hint);
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  const remove = async (task: TriggerDto) => {
    if (confirmingId !== task.id) {
      setConfirmingId(task.id);
      if (confirmTimer.current != null) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(
        () => setConfirmingId(null),
        4000,
      );
      return;
    }
    setConfirmingId(null);
    setBusyId(task.id);
    try {
      await api.tasks.update(task.id, { status: "finished" });
      if (!alive.current) return;
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
    } catch (error) {
      if (alive.current) setNote(errorCopy(error).hint);
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  const newTaskButton = (
    <button
      type="button"
      onClick={() => setModalOpen(true)}
      className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/85"
    >
      New task
    </button>
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-14 md:px-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
            Automation
          </p>
          <h1 className="mt-2 text-3xl font-light tracking-tight md:text-4xl">
            Tasks
          </h1>
          <p className="mt-2 text-sm text-muted">
            Prompts your agents run on a schedule.
          </p>
        </div>
        {newTaskButton}
      </header>

      {note ? (
        <p
          role="status"
          className="mt-6 rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-300"
        >
          {note}
        </p>
      ) : null}

      <div className="mt-10">
        {phase === "loading" ? (
          <SkeletonRows count={4} />
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
        ) : tasks.length === 0 ? (
          <EmptyState
            title="No scheduled tasks yet"
            hint="Give an agent a prompt and a cadence — it runs on its own and the results land in your sessions."
            action={newTaskButton}
          />
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => {
              const agent = task.agentId
                ? (agents.get(task.agentId) ?? embeddedAgent(task))
                : embeddedAgent(task);
              const runs = runTimes(task);
              const status = (task.status ?? "").toLowerCase();
              const busy = busyId === task.id;
              const pausable = status === "active" || status === "running";
              const resumable = status === "paused";
              return (
                <li
                  key={task.id}
                  className="rounded-xl border border-edge bg-surface p-4 transition-colors hover:border-edge"
                >
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                    <AgentAvatar
                      account={agent ?? undefined}
                      name={agent?.username ?? "?"}
                      size={36}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h3 className="truncate text-sm font-medium">
                          {task.name ?? "Untitled task"}
                        </h3>
                        <StatusChip status={task.status} />
                      </div>
                      <p className="mt-1 truncate text-xs text-muted">
                        {agent ? `@${agent.username}` : "unknown agent"}
                        <span className="text-faint"> · </span>
                        {describeSchedule(task.schedule)}
                      </p>
                      {task.prompt ? (
                        <p
                          className="mt-1.5 line-clamp-1 text-xs text-faint"
                          title={task.prompt}
                        >
                          {task.prompt}
                        </p>
                      ) : null}
                      {runs.last || runs.next ? (
                        <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-faint">
                          {runs.last
                            ? `last run ${formatRelativeTime(runs.last)}`
                            : null}
                          {runs.last && runs.next ? " · " : null}
                          {runs.next
                            ? `next ${formatRelativeTime(runs.next)}`
                            : null}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {pausable || resumable ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void setStatus(task, pausable ? "paused" : "active")
                          }
                          className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {busy ? "…" : pausable ? "Pause" : "Resume"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(task)}
                        className={`rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          confirmingId === task.id
                            ? "border-rose-400/50 bg-rose-400/10 text-rose-300"
                            : "border-edge text-muted hover:border-rose-400/50 hover:text-rose-300"
                        }`}
                      >
                        {confirmingId === task.id ? "Confirm" : "Delete"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <NewTaskModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(created, agent) => {
          if (created) {
            setTasks((prev) => [created, ...prev]);
            if (created.agentId) {
              setAgents((prev) =>
                new Map(prev).set(created.agentId as string, agent),
              );
            }
          }
          // Authoritative refresh either way (server normalizes the schedule).
          void load(true);
        }}
      />
    </div>
  );
}
