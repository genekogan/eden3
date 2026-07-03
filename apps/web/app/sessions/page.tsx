import type { Metadata } from "next";
import Link from "next/link";
import { SessionRail } from "@/components/chat/session-rail";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Conversations" };

/**
 * /sessions — on desktop the layout's rail carries the list, so the index
 * pane is a quiet "pick one" slot; on mobile the list IS the page.
 */
export default function SessionsIndexPage() {
  return (
    <>
      <SessionRail className="flex w-full md:hidden" />
      <div className="hidden h-full items-center justify-center px-6 md:flex">
        <EmptyState
          title="Select a conversation"
          hint="Pick a recent conversation from the list, or start a new one."
          action={
            <Link
              href="/chat"
              className="rounded-lg border border-accent/40 px-3.5 py-2 text-sm text-accent-soft transition-colors hover:border-accent/70 hover:bg-accent/10"
            >
              New chat
            </Link>
          }
          className="w-full max-w-md"
        />
      </div>
    </>
  );
}
