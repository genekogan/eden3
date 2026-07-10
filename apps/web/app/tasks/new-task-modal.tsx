"use client";

/**
 * "New task" modal — creates a scheduled trigger:
 *
 *   agent picker (debounced search over GET /api/agents?q=)
 *   name + prompt
 *   schedule builder: once/hourly/daily/weekly (see schedule-fields.tsx)
 *
 * Submits POST /api/tasks {agentUsername, name, prompt, schedule} with
 * day_of_week as a cron day name ("mon") for weekly cadences and {at} for
 * one-time runs. Dependency-free dialog: backdrop + Escape close, body
 * scroll lock while open.
 */

import { useEffect, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type { AgentDto, CronSchedule, TriggerDto } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { describeSchedule } from "./schedule";
import {
  defaultScheduleForm,
  ScheduleFields,
  scheduleFromForm,
  type ScheduleFormState,
} from "./schedule-fields";

const FIELD_LABEL =
  "font-mono text-[10px] uppercase tracking-[0.2em] text-faint";
const FIELD_INPUT =
  "w-full rounded-lg border border-edge bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint focus:border-accent/60 focus:outline-none";

/** "Weekly on Monday…" -> "weekly on Monday…" for the preview sentence. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function describeError(error: unknown): string {
  if (isEndpointMissing(error)) {
    return "The tasks endpoint isn't implemented yet — try again once the API lands.";
  }
  if (error instanceof ApiError) return error.message;
  return "API offline — start @eden3/api on :4301.";
}

export function NewTaskModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful POST with the created trigger + chosen agent. */
  onCreated: (created: TriggerDto | null, agent: AgentDto) => void;
}) {
  const [agentQuery, setAgentQuery] = useState("");
  const [agentResults, setAgentResults] = useState<AgentDto[]>([]);
  const [agentNote, setAgentNote] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentDto | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [form, setForm] = useState<ScheduleFormState>(defaultScheduleForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh form every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setAgentQuery("");
    setAgentResults([]);
    setAgentNote(null);
    setAgent(null);
    setName("");
    setPrompt("");
    setForm(defaultScheduleForm());
    setSubmitting(false);
    setError(null);
  }, [open]);

  // Escape closes; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  // Debounced agent search (runs with an empty query too, to seed the list).
  useEffect(() => {
    if (!open || agent) return;
    let alive = true;
    const timer = window.setTimeout(async () => {
      try {
        const { items } = await api.agents.list(
          agentQuery.trim() === "" ? {} : { q: agentQuery.trim() },
        );
        if (!alive) return;
        setAgentResults(items);
        setAgentNote(items.length === 0 ? "No matching agents" : null);
      } catch (searchError) {
        if (!alive) return;
        setAgentResults([]);
        setAgentNote(describeError(searchError));
      }
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, agent, agentQuery]);

  if (!open) return null;

  const schedule = scheduleFromForm(form);
  const canSubmit =
    !submitting &&
    agent !== null &&
    name.trim() !== "" &&
    prompt.trim() !== "" &&
    schedule !== null;

  const submit = async () => {
    if (!canSubmit || !agent || !schedule) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.tasks.create({
        agentUsername: agent.username,
        name: name.trim(),
        prompt: prompt.trim(),
        schedule,
      });
      onCreated(
        created && typeof created === "object" && typeof created.id === "string"
          ? created
          : null,
        agent,
      );
      onClose();
    } catch (submitError) {
      setError(describeError(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[7vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        onMouseDown={(event) => event.stopPropagation()}
        className="w-full max-w-lg rounded-xl border border-edge bg-surface shadow-2xl shadow-black/60"
      >
        <header className="flex items-center justify-between border-b border-edge px-5 py-4">
          <h2 id="new-task-title" className="text-sm font-medium">
            New task
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-faint transition-colors hover:bg-white/[0.05] hover:text-foreground"
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
            void submit();
          }}
        >
          {/* Agent picker */}
          <div>
            <label htmlFor="task-agent" className={FIELD_LABEL}>
              Agent
            </label>
            {agent ? (
              <div className="mt-1.5 flex items-center gap-2.5 rounded-lg border border-edge bg-background px-3 py-2">
                <AgentAvatar account={agent} size={24} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {agent.name ?? agent.username}
                  <span className="text-faint"> · @{agent.username}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setAgent(null);
                    setAgentQuery("");
                  }}
                  className="shrink-0 text-xs text-muted transition-colors hover:text-foreground"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="mt-1.5">
                <input
                  id="task-agent"
                  value={agentQuery}
                  onChange={(event) => setAgentQuery(event.target.value)}
                  placeholder="Search agents…"
                  autoFocus
                  autoComplete="off"
                  className={FIELD_INPUT}
                />
                {agentResults.length > 0 ? (
                  <ul
                    role="listbox"
                    aria-label="Agents"
                    className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-edge bg-background p-1"
                  >
                    {agentResults.map((candidate) => (
                      <li key={candidate.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          onClick={() => setAgent(candidate)}
                          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-muted transition-colors hover:bg-accent/10 hover:text-foreground"
                        >
                          <AgentAvatar account={candidate} size={22} />
                          <span className="min-w-0 flex-1 truncate">
                            {candidate.name ?? candidate.username}
                            <span className="text-faint">
                              {" "}
                              · @{candidate.username}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {agentNote ? (
                  <p className="mt-1.5 text-xs text-faint">{agentNote}</p>
                ) : null}
              </div>
            )}
          </div>

          {/* Name */}
          <div>
            <label htmlFor="task-name" className={FIELD_LABEL}>
              Name
            </label>
            <input
              id="task-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Morning sketch"
              maxLength={120}
              className={`${FIELD_INPUT} mt-1.5`}
            />
          </div>

          {/* Prompt */}
          <div>
            <label htmlFor="task-prompt" className={FIELD_LABEL}>
              Prompt
            </label>
            <textarea
              id="task-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="What should the agent do each run?"
              rows={4}
              className={`${FIELD_INPUT} mt-1.5 resize-y leading-relaxed`}
            />
          </div>

          {/* Schedule builder */}
          <fieldset>
            <legend className={FIELD_LABEL}>Schedule</legend>
            <div className="mt-1.5 space-y-2.5">
              <ScheduleFields form={form} onChange={setForm} />
              <p className="text-xs text-faint">
                {schedule
                  ? `Runs ${lowerFirst(describeSchedule(schedule as CronSchedule))}`
                  : form.cadence === "once"
                    ? "Pick a future time."
                    : "Pick a valid time."}
              </p>
            </div>
          </fieldset>

          {error ? (
            <p className="rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-300">
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
              disabled={!canSubmit}
              className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "Creating…" : "Create task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
