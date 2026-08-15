import type { Metadata } from "next";
import { SectionHeader } from "@/components/shell/section-header";
import { LibraryClient } from "./library-client";

export const metadata: Metadata = { title: "Library" };

export default async function AgentLibraryPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <div className="flex min-h-dvh flex-col">
      <SectionHeader
        title="Library"
        help="Browse media created by this agent, or switch to media created by all of your agents."
      />
      <div className="mx-auto w-full max-w-6xl flex-1 px-5 py-6 md:px-8">
        <LibraryClient username={decoded} />
      </div>
    </div>
  );
}
