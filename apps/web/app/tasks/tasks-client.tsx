"use client";

/**
 * /tasks — the current user's scheduled triggers.
 *
 * GET /api/tasks lists them; rows show name, agent, a human-readable
 * schedule (once/hourly/daily/weekly), a status chip, real "last run /
 * next run" stamps, the last error when present, a link to the latest
 * run's output session, and a Run-now button (POST /api/tasks/:id/runs).
 * Pause/resume/edit/delete go through PATCH /api/tasks/:id. "New task"
 * opens the modal (POST /api/tasks).
 *
 * TriggerDto only carries agentId, so agent identities resolve from
 * GET /api/agents pages (plus any `agent` summary the API embeds).
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type {
  AccountSummary,
  AgentDto,
  TaskSessionTargetInput,
  TaskRunHistoryDto,
  TaskRunHistoryItemDto,
  TriggerDto,
  TriggerStatus,
} from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/skeleton";
import { formatRelativeTime } from "@/lib/format";
import { describeSchedule } from "./schedule";
import {
  formFromSchedule,
  ScheduleFields,
  scheduleFromForm,
  type ScheduleFormState,
} from "./schedule-fields";
import { NewTaskModal } from "./new-task-modal";
import { TaskDestinationFields } from "./task-destination-fields";
import { friendlyTaskIssue, runStatusLabel } from "./task-presentation";

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
    chip: "border-success/25 bg-success/10 text-success-soft",
    dot: "bg-success",
  },
  running: {
    chip: "border-accent/40 bg-accent/10 text-accent-soft",
    dot: "animate-pulse bg-accent",
  },
  paused: {
    chip: "border-edge bg-foreground/[0.04] text-muted",
    dot: "bg-faint",
  },
  finished: {
    chip: "border-edge bg-foreground/[0.03] text-faint",
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

function EditTaskModal({
  task,
  agentUsername,
  onClose,
  onSaved,
}: {
  task: TriggerDto;
  agentUsername: string;
  onClose: () => void;
  onSaved: (task: TriggerDto) => void;
}) {
  const [name, setName] = useState(task.name ?? "");
  const [prompt, setPrompt] = useState(task.prompt ?? "");
  const [form, setForm] = useState<ScheduleFormState>(() =>
    formFromSchedule(task.schedule),
  );
  const [sessionTarget, setSessionTarget] = useState<TaskSessionTargetInput>(() =>
    task.sessionTarget === "existing"
      ? { kind: "existing", sessionId: task.sessionExternalId ?? "" }
      : { kind: "new" },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schedule = scheduleFromForm(form);
  const canSave =
    !saving &&
    name.trim() !== "" &&
    prompt.trim() !== "" &&
    schedule !== null &&
    (sessionTarget.kind === "new" || sessionTarget.sessionId !== "");

  const save = async () => {
    if (!canSave || !schedule) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.tasks.update(task.id, {
        name: name.trim(),
        prompt: prompt.trim(),
        schedule,
        sessionTarget,
      });
      onSaved(updated);
      onClose();
    } catch (saveError) {
      setError(errorCopy(saveError).hint);
    } finally {
      setSaving(false);
    }
  };

  const fieldLabel =
    "font-mono text-[10px] uppercase tracking-[0.2em] text-faint";
  const fieldInput =
    "w-full rounded-lg border border-edge bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint focus:border-accent/60 focus:outline-none";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[7vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-task-title"
        onMouseDown={(event) => event.stopPropagation()}
        className="w-full max-w-lg rounded-xl border border-edge bg-surface shadow-2xl shadow-black/60"
      >
        <header className="flex items-center justify-between border-b border-edge px-5 py-4">
          <h2 id="edit-task-title" className="text-sm font-medium">
            Edit task
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-faint transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              aria-hidden
              className="size-4"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <form
          className="space-y-5 px-5 py-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div>
            <label htmlFor="edit-task-name" className={fieldLabel}>
              Name
            </label>
            <input
              id="edit-task-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              className={`${fieldInput} mt-1.5`}
            />
          </div>
          <div>
            <label htmlFor="edit-task-prompt" className={fieldLabel}>
              Prompt
            </label>
            <textarea
              id="edit-task-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              className={`${fieldInput} mt-1.5 resize-y leading-relaxed`}
            />
          </div>
          <fieldset>
            <legend className={fieldLabel}>Schedule</legend>
            <div className="mt-1.5">
              <ScheduleFields form={form} onChange={setForm} />
            </div>
          </fieldset>

          <TaskDestinationFields
            agentUsername={agentUsername}
            value={sessionTarget}
            onChange={setSessionTarget}
          />

          {error ? (
            <p className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger-soft">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Phase = "loading" | "ready" | "error";
type TaskFilter = "all" | "active" | "paused";

function conversationHref(task: TriggerDto, agent: AgentRef | null): string | null {
  const sessionId = task.lastRunSessionId ??
    (task.sessionTarget === "existing" ? task.sessionExternalId : null);
  if (!sessionId) return null;
  return agent?.username
    ? `/agents/${encodeURIComponent(agent.username)}/chats/${sessionId}`
    : `/sessions/${sessionId}`;
}

function formatRunTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function TasksClient({
  fixedAgent,
}: {
  /**
   * Pin to one agent (the agent-scoped Schedule page): server-filters the
   * list, preselects the agent in the New-task modal, and drops the
   * standalone-page header.
   */
  fixedAgent?: AgentDto | null;
} = {}) {
  const [tasks, setTasks] = useState<TriggerDto[]>([]);
  const [agents, setAgents] = useState<Map<string, AgentRef>>(new Map());
  const [phase, setPhase] = useState<Phase>("loading");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [history, setHistory] = useState<TaskRunHistoryDto | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<{
    task: TriggerDto;
    agentUsername: string;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "error" | "success"; text: string } | null>(
    null,
  );
  const alive = useRef(true);
  const confirmTimer = useRef<number | null>(null);
  const runRequestIds = useRef(new Map<string, string>());

  const load = useCallback(async (soft = false) => {
    if (!soft) setPhase("loading");
    try {
      const { items } = await api.tasks.list(
        fixedAgent ? { agent: fixedAgent.username } : {},
      );
      if (!alive.current) return;
      setTasks(items);
      setSelectedTaskId((current) =>
        current && items.some((task) => task.id === current)
          ? current
          : (items[0]?.id ?? null),
      );
      setPhase("ready");
      setLoadError(null);

      if (fixedAgent) {
        // Single known agent — no identity resolution needed.
        setAgents(new Map(items.map((task) => [task.agentId ?? "", fixedAgent])));
        return;
      }

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
        setNote({ kind: "error", text: errorCopy(error).hint });
      } else {
        setLoadError(error);
        setPhase("error");
      }
    }
  }, [fixedAgent]);

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

  const loadHistory = useCallback(async (taskId: string) => {
    setHistory(null);
    setHistoryLoading(true);
    setHistoryError(false);
    try {
      const result = await api.tasks.runs(taskId);
      if (!alive.current) return;
      setHistory(result);
    } catch {
      if (!alive.current) return;
      setHistory(null);
      setHistoryError(true);
    } finally {
      if (alive.current) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      setHistory(null);
      return;
    }
    void loadHistory(selectedTaskId);
  }, [loadHistory, selectedTaskId]);

  // Transient error note fades after a few seconds.
  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 6000);
    return () => window.clearTimeout(timer);
  }, [note]);

  const setStatus = async (
    task: TriggerDto,
    status: Extract<TriggerStatus, "active" | "paused">,
  ) => {
    setBusyId(task.id);
    try {
      const updated = await api.tasks.update(task.id, { status });
      if (!alive.current) return;
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? updated : t)),
      );
    } catch (error) {
      if (alive.current) setNote({ kind: "error", text: errorCopy(error).hint });
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  const runNow = async (task: TriggerDto) => {
    setBusyId(task.id);
    const requestId = runRequestIds.current.get(task.id) ?? crypto.randomUUID();
    runRequestIds.current.set(task.id, requestId);
    try {
      const run = await api.tasks.runNow(task.id, { requestId });
      runRequestIds.current.delete(task.id);
      if (!alive.current) return;
      setNote(
        run.outcome.errorCode
          ? { kind: "error", text: `Run finished with an error: ${run.outcome.errorCode}` }
          : { kind: "success", text: `"${task.name ?? "Task"}" ran — output is in its session.` },
      );
      // Authoritative refresh: lastRunTime/lastRunSessionId/status changed.
      void load(true);
      void loadHistory(task.id);
    } catch (error) {
      // A server response is a definitive outcome. A network failure is
      // ambiguous, so the next click reuses the same request id after restart.
      if (error instanceof ApiError) runRequestIds.current.delete(task.id);
      if (alive.current) setNote({ kind: "error", text: errorCopy(error).hint });
      if (alive.current) void load(true);
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
      await api.tasks.update(task.id, { deleted: true });
      if (!alive.current) return;
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      setSelectedTaskId((current) => (current === task.id ? null : current));
    } catch (error) {
      if (alive.current) setNote({ kind: "error", text: errorCopy(error).hint });
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

  const visibleTasks = tasks.filter((task) => {
    const status = (task.status ?? "").toLowerCase();
    if (filter === "active") return status === "active" || status === "running";
    if (filter === "paused") return status === "paused";
    return true;
  });
  const selectedTask =
    visibleTasks.find((task) => task.id === selectedTaskId) ?? visibleTasks[0] ?? null;
  const selectedAgent = selectedTask
    ? selectedTask.agentId
      ? (agents.get(selectedTask.agentId) ?? embeddedAgent(selectedTask))
      : embeddedAgent(selectedTask)
    : null;
  const selectedIssue = friendlyTaskIssue(selectedTask?.lastError);
  const selectedConversationHref = selectedTask
    ? conversationHref(selectedTask, selectedAgent)
    : null;
  const allowance = history?.automationBudget ?? null;
  const allowancePercent = allowance
    ? Math.min(100, Math.round((allowance.spent / allowance.cap) * 100))
    : 0;

  return (
    <div className={fixedAgent ? "w-full" : "mx-auto w-full max-w-6xl px-6 py-14 md:px-10"}>
      {fixedAgent ? (
        <div className="flex justify-end">{newTaskButton}</div>
      ) : (
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
      )}

      {note ? (
        <p
          role="status"
          className={`mt-6 rounded-lg border px-3 py-2 text-xs ${
            note.kind === "success"
              ? "border-success/25 bg-success/10 text-success-soft"
              : "border-danger/25 bg-danger/10 text-danger-soft"
          }`}
        >
          {note.text}
        </p>
      ) : null}

      <div className="mt-8">
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
          <div className="grid min-h-[560px] overflow-hidden rounded-xl border border-edge bg-surface lg:grid-cols-[minmax(260px,0.82fr)_minmax(420px,1.35fr)]">
            <section className="border-b border-edge lg:border-b-0 lg:border-r" aria-label="Scheduled tasks">
              <div className="flex items-center gap-1 border-b border-edge px-3 py-3">
                {(["all", "active", "paused"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={filter === option}
                    onClick={() => setFilter(option)}
                    className={`rounded-md px-2.5 py-1.5 text-xs capitalize transition-colors ${
                      filter === option
                        ? "bg-foreground/[0.07] text-foreground"
                        : "text-muted hover:text-foreground"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <ul className="divide-y divide-edge">
            {visibleTasks.map((task) => {
              const agent = task.agentId
                ? (agents.get(task.agentId) ?? embeddedAgent(task))
                : embeddedAgent(task);
              const status = (task.status ?? "").toLowerCase();
              return (
                <li
                  key={task.id}
                  className={selectedTask?.id === task.id ? "bg-accent/[0.055]" : ""}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedTaskId(task.id)}
                    className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-foreground/[0.025]"
                  >
                    <span
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${
                        status === "active"
                          ? "bg-success"
                          : status === "running"
                            ? "animate-pulse bg-accent"
                            : "border border-faint"
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {task.name ?? "Untitled task"}
                        </span>
                        {task.lastError ? <span className="size-1.5 shrink-0 rounded-full bg-danger" aria-label="Needs attention" /> : null}
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted">
                        {describeSchedule(task.schedule)}
                      </span>
                      <span className="mt-1 block truncate text-[11px] text-faint">
                        {agent ? `@${agent.username}` : "Unknown agent"}
                        {task.nextScheduledRun && status === "active"
                          ? ` · Next ${formatRelativeTime(task.nextScheduledRun)}`
                          : task.lastRunTime
                            ? ` · Last ${formatRelativeTime(task.lastRunTime)}`
                            : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
              </ul>
              {visibleTasks.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-faint">No {filter} tasks.</p>
              ) : null}
            </section>

            <section className="min-w-0 p-5 md:p-6" aria-label="Task details">
              {selectedTask ? (() => {
                const status = (selectedTask.status ?? "").toLowerCase();
                const busy = busyId === selectedTask.id;
                const pausable = status === "active" || status === "running";
                const resumable = status === "paused";
                return (
                  <div>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <h2 className="truncate text-xl font-medium">{selectedTask.name ?? "Untitled task"}</h2>
                          <StatusChip status={selectedTask.status} />
                        </div>
                        <p className="mt-1.5 text-sm text-muted">
                          {selectedAgent ? `@${selectedAgent.username} · ` : ""}{describeSchedule(selectedTask.schedule)}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {status === "active" ? (
                          <button type="button" disabled={busy} onClick={() => void runNow(selectedTask)} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/85 disabled:opacity-40">
                            {busy ? "Running…" : "Run now"}
                          </button>
                        ) : null}
                        {pausable || resumable ? (
                          <button type="button" disabled={busy} onClick={() => void setStatus(selectedTask, pausable ? "paused" : "active")} className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:text-foreground disabled:opacity-40">
                            {busy ? "…" : pausable ? "Pause" : "Resume"}
                          </button>
                        ) : null}
                        <button type="button" disabled={busy} onClick={() => {
                          const username = selectedAgent?.username ?? fixedAgent?.username;
                          if (username) setEditingTask({ task: selectedTask, agentUsername: username });
                        }} className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:text-foreground disabled:opacity-40">Edit</button>
                        <button type="button" disabled={busy} onClick={() => void remove(selectedTask)} className={`rounded-lg border px-3 py-1.5 text-xs ${confirmingId === selectedTask.id ? "border-danger/50 bg-danger/10 text-danger-soft" : "border-edge text-muted hover:text-danger-soft"}`}>
                          {confirmingId === selectedTask.id ? "Confirm delete" : "Delete"}
                        </button>
                      </div>
                    </div>

                    {selectedIssue ? (
                      <div className={`mt-5 rounded-lg border px-4 py-3 ${selectedIssue.kind === "budget" ? "border-warning/25 bg-warning/5" : "border-danger/25 bg-danger/5"}`}>
                        <p className="text-sm font-medium">{selectedIssue.title}</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted">{selectedIssue.detail}</p>
                      </div>
                    ) : null}

                    <div className="mt-5 rounded-lg border border-edge bg-background/40 p-4">
                      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">Instructions</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{selectedTask.prompt || "No instructions."}</p>
                    </div>

                    <dl className="mt-5 grid gap-4 border-y border-edge py-4 text-sm sm:grid-cols-3">
                      <div><dt className="text-xs text-faint">Next run</dt><dd className="mt-1">{selectedTask.nextScheduledRun && status === "active" ? formatRunTime(selectedTask.nextScheduledRun) : "Not scheduled"}</dd></div>
                      <div><dt className="text-xs text-faint">Last run</dt><dd className="mt-1">{selectedTask.lastRunTime ? formatRunTime(selectedTask.lastRunTime) : "No runs yet"}</dd></div>
                      <div><dt className="text-xs text-faint">Output</dt><dd className="mt-1">{selectedTask.sessionTarget === "new" ? "New conversation each run" : "Existing conversation"}</dd></div>
                    </dl>

                    <div className="mt-5">
                      <div className="flex items-end justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-medium">Automation allowance</h3>
                          <p className="mt-0.5 text-xs text-faint">Shared by this agent’s schedules and heartbeat over a rolling hour.</p>
                        </div>
                        {allowance ? <p className="shrink-0 text-xs text-muted"><span className="font-medium text-foreground">{allowance.spent}</span> / {allowance.cap} manna</p> : null}
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]" aria-label={allowance ? `${allowance.spent} of ${allowance.cap} manna used` : "Allowance unavailable"}>
                        <div className={`h-full rounded-full transition-[width] ${allowancePercent >= 80 ? "bg-warning" : "bg-accent"}`} style={{ width: `${allowancePercent}%` }} />
                      </div>
                      <p className="mt-1.5 text-[11px] text-faint">{allowance ? `${allowance.remaining} available now. Capacity returns gradually as earlier runs age out.` : historyLoading ? "Checking allowance…" : "Allowance unavailable."}</p>
                    </div>

                    <div className="mt-6">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-medium">Run history</h3>
                        {selectedConversationHref ? <Link href={selectedConversationHref} className="text-xs text-accent-soft hover:underline">Open latest conversation →</Link> : null}
                      </div>
                      {historyLoading ? <div className="mt-3"><SkeletonRows count={3} /></div> : historyError ? (
                        <button type="button" onClick={() => void loadHistory(selectedTask.id)} className="mt-3 text-xs text-danger-soft hover:underline">Couldn’t load run history. Retry</button>
                      ) : history && history.items.length > 0 ? (
                        <ul className="mt-3 divide-y divide-edge rounded-lg border border-edge">
                          {history.items.map((run: TaskRunHistoryItemDto) => {
                            const href = run.sessionId && selectedAgent?.username ? `/agents/${encodeURIComponent(selectedAgent.username)}/chats/${run.sessionId}` : run.sessionId ? `/sessions/${run.sessionId}` : null;
                            const failed = Boolean(run.errorCode) || /error|failed/i.test(run.status);
                            return <li key={run.id} className="flex items-center gap-3 px-3 py-2.5">
                              <span className={`size-2 rounded-full ${failed ? "bg-danger" : "bg-success"}`} />
                              <div className="min-w-0 flex-1"><p className="text-xs font-medium">{runStatusLabel(run)}</p><p className="mt-0.5 text-[11px] text-faint">{formatRunTime(run.occurredAt)}{run.manna !== null ? ` · ${run.manna} manna` : ""}{formatDuration(run.latencyMs) ? ` · ${formatDuration(run.latencyMs)}` : ""}</p></div>
                              {href ? <Link href={href} className="shrink-0 text-xs text-accent-soft hover:underline">View output</Link> : null}
                            </li>;
                          })}
                        </ul>
                      ) : <p className="mt-3 rounded-lg border border-dashed border-edge px-4 py-6 text-center text-xs text-faint">No recorded runs yet.</p>}
                    </div>
                  </div>
                );
              })() : <p className="py-20 text-center text-sm text-faint">Choose a task to see its details.</p>}
            </section>
          </div>
        )}
      </div>

      <NewTaskModal
        open={modalOpen}
        initialAgent={fixedAgent ?? null}
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
      {editingTask ? (
        <EditTaskModal
          task={editingTask.task}
          agentUsername={editingTask.agentUsername}
          onClose={() => setEditingTask(null)}
          onSaved={(updated) => {
            setTasks((prev) => prev.map((task) => (task.id === updated.id ? updated : task)));
            void load(true);
          }}
        />
      ) : null}
    </div>
  );
}
