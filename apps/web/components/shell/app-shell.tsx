"use client";

import type { ReactNode } from "react";
import { CommandPalette } from "./command-palette";
import { SelectedAgentProvider } from "./selected-agent-context";
import { Sidebar } from "./sidebar";

/**
 * The cockpit shell: selected-agent context + domain-aware sidebar + ⌘K
 * palette around the routed page. Children stay server-rendered — this only
 * wraps them.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SelectedAgentProvider>
      <div className="flex min-h-dvh">
        <Sidebar />
        <main className="relative min-w-0 flex-1 pt-14 sm:pt-0">{children}</main>
      </div>
      <CommandPalette />
    </SelectedAgentProvider>
  );
}
