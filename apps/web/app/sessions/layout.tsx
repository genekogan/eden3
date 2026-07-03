import type { ReactNode } from "react";
import { SessionRail } from "@/components/chat/session-rail";

/**
 * /sessions shell — recent-conversations rail beside the conversation. The
 * rail collapses on small screens (the /sessions index renders the list as
 * its main content there instead).
 */
export default function SessionsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh min-w-0">
      <SessionRail className="hidden w-72 shrink-0 border-r border-edge bg-surface/60 md:flex" />
      <div className="h-full min-w-0 flex-1">{children}</div>
    </div>
  );
}
