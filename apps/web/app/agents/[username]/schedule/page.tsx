import type { Metadata } from "next";
import { ScheduleClient } from "./schedule-client";

export const metadata: Metadata = { title: "Schedule" };

/**
 * /agents/[username]/schedule — the agent's recurring tasks and routines:
 * active (green), paused (gray), running (pulsing), with run-now / pause /
 * edit / delete inline.
 */
export default async function AgentSchedulePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10 md:px-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        @{decoded}
      </p>
      <h1 className="mt-3 text-3xl font-light tracking-tight md:text-4xl">Schedule</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Prompts this agent runs on its own — recurring routines and one-time
        tasks.
      </p>
      <div className="mt-8">
        <ScheduleClient />
      </div>
    </div>
  );
}
