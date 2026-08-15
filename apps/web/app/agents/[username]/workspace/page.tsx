import type { Metadata } from "next";
import { SectionHeader } from "@/components/shell/section-header";
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
    <div className="flex min-h-dvh flex-col">
      <SectionHeader
        title="Workspace"
        help="Browse and edit the files this agent works with: its persona doctrine, memory, skills, and files it writes for itself."
      />
      <div className="mx-auto w-full max-w-5xl flex-1 px-5 py-6 md:px-8">
        <WorkspaceClient username={decoded} />
      </div>
    </div>
  );
}
