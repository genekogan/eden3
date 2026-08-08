import type { Metadata } from "next";
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
    <div className="mx-auto w-full max-w-6xl px-6 py-10 md:px-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        @{decoded}
      </p>
      <h1 className="mt-3 text-3xl font-light tracking-tight md:text-4xl">Library</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Upload private files, browse what this agent has created, or switch to all
        of your creations, Studio output included.
      </p>
      <div className="mt-8">
        <LibraryClient username={decoded} />
      </div>
    </div>
  );
}
