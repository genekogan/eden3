"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";

export function ReportCreation({ creationId }: { creationId: string }) {
  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPhase("sending");
    setError(null);
    try {
      await api.creations.report(creationId, reason.trim() ? { reason: reason.trim() } : {});
      setPhase("sent");
    } catch (cause) {
      setPhase("idle");
      setError(
        cause instanceof ApiError && cause.status === 401
          ? "Sign in to report this creation."
          : "The report could not be sent. Please try again.",
      );
    }
  }

  if (phase === "sent") {
    return (
      <p role="status" className="rounded-lg border border-edge px-3.5 py-3 text-xs text-muted">
        Report received. An operator can now review it.
      </p>
    );
  }

  return (
    <details className="group rounded-lg border border-edge">
      <summary className="flex min-h-11 cursor-pointer select-none items-center justify-between px-3.5 py-2.5 text-xs text-muted transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        Report this creation
        <span aria-hidden className="transition-transform group-open:rotate-90">→</span>
      </summary>
      <div className="space-y-3 border-t border-edge px-3.5 py-3">
        <label className="block text-xs text-muted">
          Reason (optional)
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value.slice(0, 1_000))}
            maxLength={1_000}
            rows={3}
            className="mt-2 w-full resize-y rounded-md border border-edge bg-raised px-3 py-2 text-sm text-foreground outline-none focus:border-accent/60"
          />
        </label>
        {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
        <button
          type="button"
          disabled={phase === "sending"}
          onClick={() => void submit()}
          className="min-h-11 rounded-md border border-edge px-3.5 py-2 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:opacity-50"
        >
          {phase === "sending" ? "Sending…" : "Send report"}
        </button>
      </div>
    </details>
  );
}
