"use client";

/**
 * ⌘K command palette — global fuzzy navigation. Hand-rolled (no cmdk):
 * fixed overlay + scored-subsequence matching (lib/fuzzy). Sources:
 *
 *   - the selected agent's sections (Chats, Schedule, …, each Settings page)
 *   - agent switching ("Switch to @x" — preserves the current sub-path)
 *   - Studio tools (live registry)
 *   - create actions (new chat / new agent / builder) + user-area surfaces
 */

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { StudioTool } from "@/lib/types";
import { fuzzyFilter } from "@/lib/fuzzy";
import {
  agentSectionHref,
  isEveConcealedSubpath,
  isEveUsername,
} from "@/lib/eve";
import { AgentAvatar } from "@/components/agent-avatar";
import { sortTools, toolLabel, FALLBACK_TOOLS } from "@/components/studio/catalog";
import {
  agentSubPathFromPathname,
  useMyAgents,
  useSelectedAgent,
} from "./selected-agent-context";

interface Command {
  id: string;
  label: string;
  /** Extra text the fuzzy matcher also sees (e.g. @handle, synonyms). */
  keywords?: string;
  hint?: string;
  href: string;
  avatar?: { username: string; userImage?: string | null };
}

const AGENT_SECTIONS = [
  ["chats", "Chats"],
  ["chats/new", "New Chat"],
  ["schedule", "Schedule"],
  ["workspace", "Workspace"],
  ["library", "Library"],
  ["gateway", "Gateway"],
  ["log", "Log"],
  ["settings/identity", "Settings · Identity"],
  ["settings/persona", "Settings · Persona"],
  ["settings/tools", "Settings · Tools"],
  ["settings/skills", "Settings · Skills"],
  ["settings/memory", "Settings · Memory"],
  ["settings/concepts", "Settings · Concepts"],
] as const;

export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const { username, viewer } = useSelectedAgent();
  const { agents } = useMyAgents();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [tools, setTools] = useState<StudioTool[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // ⌘K / Ctrl-K toggles; Escape closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((o) => !o);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 10);
    // Tools load lazily, once per open (cheap; registry rarely changes).
    void api.studio
      .tools()
      .then((items) => setTools(items.length > 0 ? sortTools(items) : [...FALLBACK_TOOLS]))
      .catch(() => setTools([...FALLBACK_TOOLS]));
    return () => window.clearTimeout(timer);
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    const subPath = agentSubPathFromPathname(pathname);

    if (username) {
      const base = `/agents/${encodeURIComponent(username)}`;
      for (const [sub, label] of AGENT_SECTIONS) {
        if (isEveUsername(username) && isEveConcealedSubpath(sub)) continue;
        out.push({
          id: `section:${sub}`,
          label,
          keywords: `@${username} ${sub}`,
          hint: `@${username}`,
          href: `${base}/${sub}`,
        });
      }
    }

    for (const agent of agents ?? []) {
      if (agent.username === username) continue;
      out.push({
        id: `agent:${agent.username}`,
        label: `Switch to ${agent.name?.trim() || agent.username}`,
        keywords: `@${agent.username} agent switch`,
        hint: `@${agent.username}`,
        href: agentSectionHref(agent.username, subPath ?? "chats"),
        avatar: agent,
      });
    }

    for (const tool of tools) {
      out.push({
        id: `tool:${tool.name}`,
        label: `Studio · ${toolLabel(tool)}`,
        keywords: `${tool.name} generate create studio`,
        href: `/studio/${encodeURIComponent(tool.name)}`,
      });
    }

    out.push(
      { id: "agents", label: "All agents", keywords: "directory list", href: "/agents" },
      { id: "new-agent", label: "New agent", keywords: "create agent template", href: "/agents/new" },
      { id: "builder", label: "Agent builder", keywords: "conversational create", href: "/agents/builder" },
      { id: "account", label: "Account settings", keywords: "user profile billing export", href: "/account" },
      { id: "manna", label: "Manna", keywords: "balance credits billing top up", href: "/account/manna" },
    );
    if (viewer?.isAdmin) {
      out.push({
        id: "operator",
        label: "Operator",
        keywords: "admin health runtime",
        href: "/operator",
      });
    }
    return out;
  }, [pathname, username, agents, tools, viewer]);

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return commands.map((item) => ({ item, score: 0 }));
    return fuzzyFilter(trimmed, commands, (c) => `${c.label} ${c.keywords ?? ""}`);
  }, [query, commands]);

  const clamped = Math.min(activeIndex, Math.max(0, results.length - 1));

  const run = useCallback(
    (command: Command) => {
      setOpen(false);
      router.push(command.href);
    },
    [router],
  );

  const onInputKey = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" || event.key === "Return") {
      event.preventDefault();
      const chosen = results[clamped]?.item;
      if (chosen) run(chosen);
    }
  };

  // Keep the active row in view.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${clamped}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [clamped]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-background/70 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-edge bg-raised shadow-2xl shadow-black/40"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onInputKey}
          placeholder="Type a command or search…"
          aria-label="Command palette search"
          role="combobox"
          aria-expanded
          aria-controls="command-palette-list"
          aria-activedescendant={
            results[clamped] ? `command-${results[clamped].item.id}` : undefined
          }
          className="w-full border-b border-edge bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-faint focus:outline-none"
        />
        <ul
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          className="max-h-[50vh] overflow-y-auto p-1.5"
        >
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-faint">No matches</li>
          ) : (
            results.map(({ item }, index) => (
              <li key={item.id} role="presentation">
                <button
                  type="button"
                  id={`command-${item.id}`}
                  role="option"
                  aria-selected={index === clamped}
                  data-index={index}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => run(item)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    index === clamped
                      ? "bg-accent/12 text-foreground"
                      : "text-muted"
                  }`}
                >
                  {item.avatar ? (
                    <AgentAvatar account={item.avatar} size={20} />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint ? (
                    <span className="shrink-0 font-mono text-[10px] text-faint">
                      {item.hint}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
        <p className="border-t border-edge px-4 py-2 text-[10px] text-faint">
          ↑↓ navigate · ↵ open · esc close
        </p>
      </div>
    </div>
  );
}
