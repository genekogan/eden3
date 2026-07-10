/**
 * Small status chips for agent cards and profiles. Server-safe (no hooks).
 */

import {
  isProvisionFailed,
  isProvisionWarming,
  provisionLabel,
} from "@/components/agents/agent-utils";

/** "pilot" chip — the hand-picked flagship agents. */
export function PilotBadge({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-accent-soft ${className ?? ""}`}
    >
      pilot
    </span>
  );
}

/**
 * Provisioning indicator — renders only while an agent is pending/failed
 * (nothing for ready agents, which is almost all of them).
 */
export function ProvisionBadge({
  status,
  className,
}: {
  status: string | null | undefined;
  className?: string;
}) {
  const label = provisionLabel(status);
  if (!label) return null;
  const failed = isProvisionFailed(status);
  // The pulse implies live activity — only show it while a warm-up is
  // actually running, not for dormant wake-on-chat agents.
  const pulsing = isProvisionWarming(status);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] ${
        failed
          ? "border-red-400/30 bg-red-400/10 text-red-400"
          : "border-accent/30 bg-accent/10 text-accent-soft"
      } ${className ?? ""}`}
    >
      {failed ? null : (
        <span
          aria-hidden
          className={`size-1.5 rounded-full bg-accent ${pulsing ? "animate-pulse" : ""}`}
        />
      )}
      {label}
    </span>
  );
}
