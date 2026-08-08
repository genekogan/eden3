"use client";

/**
 * The agent selector at the top of the Agents-domain sidebar: shows the
 * selected agent (avatar + name), opens a popover of the viewer's agents.
 * Switching preserves the current sub-path (…/settings stays …/settings on
 * the new agent); "All agents" goes to the selector page.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import {
  agentSectionHref,
  agentSubpathForUsername,
  isEveUsername,
} from "@/lib/eve";
import {
  agentSubPathFromPathname,
  useMyAgents,
  useSelectedAgent,
} from "./selected-agent-context";

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function AgentSelector({ collapsed = false }: { collapsed?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { username, agent, phase } = useSelectedAgent();
  const { agents } = useMyAgents();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape / navigation.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const subPath = agentSubPathFromPathname(pathname);
  const hrefFor = (agentUsername: string) =>
    agentSectionHref(
      agentUsername,
      agentSubpathForUsername(agentUsername, subPath),
    );

  const displayName = agent?.name?.trim() || agent?.username || username;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={displayName ? `Agent: ${displayName}` : "Select agent"}
        data-testid="agent-selector"
        className={`flex w-full items-center rounded-xl border border-edge bg-raised text-left transition-colors hover:border-accent/50 ${
          collapsed ? "justify-center p-1.5" : "gap-2.5 px-2.5 py-2"
        }`}
      >
        {agent || username ? (
          <>
            <AgentAvatar
              account={agent ?? { username: username ?? "?", userImage: null }}
              name={displayName ?? undefined}
              size={collapsed ? 28 : 30}
            />
            {collapsed ? null : (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium leading-tight text-foreground">
                    {phase === "loading" && !agent ? "Loading…" : displayName}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-faint">
                    @{username}
                  </span>
                </span>
                <ChevronIcon open={open} />
              </>
            )}
          </>
        ) : (
          <>
            <span
              aria-hidden
              className={`flex items-center justify-center rounded-full border border-dashed border-edge text-faint ${
                collapsed ? "size-7" : "size-[30px]"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                aria-hidden
                className="size-3.5"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8" />
              </svg>
            </span>
            {collapsed ? null : (
              <>
                <span className="min-w-0 flex-1 text-[13px] text-muted">Select agent</span>
                <ChevronIcon open={open} />
              </>
            )}
          </>
        )}
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Your agents"
          className="absolute inset-x-0 top-full z-50 mt-1.5 max-h-80 min-w-52 overflow-y-auto rounded-xl border border-edge bg-raised p-1.5 shadow-xl shadow-black/30"
        >
          <button
            type="button"
            role="option"
            aria-selected={isEveUsername(username)}
            onClick={() => {
              setOpen(false);
              if (!isEveUsername(username)) router.push(hrefFor("eve"));
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
              isEveUsername(username)
                ? "bg-accent/10 text-foreground"
                : "text-muted hover:bg-foreground/[0.04] hover:text-foreground"
            }`}
          >
            <span
              aria-hidden
              className="grid size-[26px] shrink-0 place-items-center rounded-full bg-accent/12 font-mono text-xs text-accent-soft"
            >
              e
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-tight">eve</span>
              <span className="block truncate font-mono text-[10px] text-faint">
                @eve · Eden guide
              </span>
            </span>
            {isEveUsername(username) ? (
              <span aria-hidden className="size-1.5 rounded-full bg-accent" />
            ) : null}
          </button>
          <div className="my-1 border-t border-edge" />
          {agents === null ? (
            <p className="px-2.5 py-2 text-xs text-faint">Loading your agents…</p>
          ) : agents.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-faint">No agents of your own yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {agents
                .filter((candidate) => !isEveUsername(candidate.username))
                .map((candidate) => {
                  const active = candidate.username === username;
                  return (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => {
                          setOpen(false);
                          if (!active) router.push(hrefFor(candidate.username));
                        }}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                          active
                            ? "bg-accent/10 text-foreground"
                            : "text-muted hover:bg-foreground/[0.04] hover:text-foreground"
                        }`}
                      >
                        <AgentAvatar account={candidate} size={26} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] leading-tight">
                            {candidate.name?.trim() || candidate.username}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-faint">
                            @{candidate.username}
                          </span>
                        </span>
                        {active ? (
                          <span aria-hidden className="size-1.5 rounded-full bg-accent" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
            </ul>
          )}
          <div className="mt-1 border-t border-edge pt-1">
            <Link
              href="/agents"
              className="block rounded-lg px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
            >
              All agents →
            </Link>
            <Link
              href="/agents/new"
              className="block rounded-lg px-2 py-1.5 text-[13px] text-accent-soft transition-colors hover:bg-accent/10"
            >
              + New agent
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
