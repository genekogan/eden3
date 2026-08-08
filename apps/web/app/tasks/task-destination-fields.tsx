"use client";

import React, { useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { SessionDto, TaskSessionTargetInput } from "@/lib/types";

export function TaskDestinationFields({
  agentUsername,
  value,
  onChange,
}: {
  agentUsername: string | null;
  value: TaskSessionTargetInput;
  onChange: (value: TaskSessionTargetInput) => void;
}) {
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentUsername || value.kind !== "existing") return;
    let alive = true;
    setLoading(true);
    setError(null);
    void api.sessions
      .list({ agent: agentUsername })
      .then(({ items }) => {
        if (!alive) return;
        setSessions(items.filter((session) => !session.readOnly));
      })
      .catch(() => {
        if (alive) setError("Couldn’t load this agent’s sessions.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [agentUsername, value.kind]);

  return (
    <fieldset className="space-y-2">
      <legend className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
        Output
      </legend>
      <label className="flex items-start gap-2 text-sm text-muted">
        <input
          type="radio"
          name="task-output"
          checked={value.kind === "new"}
          onChange={() => onChange({ kind: "new" })}
          className="mt-0.5"
        />
        <span>
          New session
          <span className="block text-xs text-faint">Create a separate session for each run.</span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm text-muted">
        <input
          type="radio"
          name="task-output"
          checked={value.kind === "existing"}
          disabled={!agentUsername}
          onChange={() =>
            onChange({ kind: "existing", sessionId: sessions[0]?.id ?? "" })
          }
          className="mt-0.5"
        />
        <span>Existing session</span>
      </label>
      {value.kind === "existing" ? (
        <div className="pl-6">
          <select
            aria-label="Output session"
            value={value.sessionId}
            disabled={loading || sessions.length === 0}
            onChange={(event) =>
              onChange({ kind: "existing", sessionId: event.target.value })
            }
            className="w-full rounded-lg border border-edge bg-background px-3 py-2 text-sm text-foreground focus:border-accent/60 focus:outline-none"
          >
            <option value="">{loading ? "Loading sessions…" : "Select a session"}</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title?.trim() || "Untitled session"}
              </option>
            ))}
          </select>
          {error ? <p className="mt-1 text-xs text-danger-soft">{error}</p> : null}
          {!loading && !error && sessions.length === 0 ? (
            <p className="mt-1 text-xs text-faint">No writable sessions for this agent yet.</p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
