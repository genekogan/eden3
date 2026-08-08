import type { Metadata } from "next";
import { WorkspaceClient } from "./workspace-client";

export const metadata: Metadata = { title: "Workspace" };

/**
 * /agents/[username]/workspace — the agent's raw file tree: persona doctrine,
 * memory files, notes. Conflict-checked editing (the agent may write too).
 */
export default async function AgentWorkspacePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        @{decoded}
      </p>
      <h1 className="mt-3 text-3xl font-light tracking-tight md:text-4xl">Workspace</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Everything the agent works with, as files — the persona doctrine, memory,
        and anything it writes for itself.
      </p>
      <div className="mt-8">
        <WorkspaceClient username={decoded} />
      </div>
    </div>
  );
}
