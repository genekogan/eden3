import type { Metadata } from "next";
import { UsageClient } from "@/app/usage/usage-client";

export const metadata: Metadata = { title: "Log" };

/**
 * /agents/[username]/log — the agent's activity + metered spend, with a
 * toggle to widen to all agents. Balance/billing stay in the user area.
 */
export default async function AgentLogPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 md:px-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        @{decoded}
      </p>
      <h1 className="mt-3 text-3xl font-light tracking-tight md:text-4xl">Log</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        What this agent has been doing, and what it cost.
      </p>
      <div className="mt-8">
        <UsageClient fixedAgent={decoded} />
      </div>
    </div>
  );
}
