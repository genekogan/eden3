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
import { createOntologyRegistry, resolveOntologyRegistry } from "@/lib/ontology";
import { AgentAvatar } from "@/components/agent-avatar";
import { sortTools, toolLabel, FALLBACK_TOOLS } from "@/components/studio/catalog";
import { useTheme, type ThemePreference } from "@/components/theme-provider";
import {
  buildPaletteCommands,
  clampPaletteIndex,
  dispatchPaletteCommand,
  filterPaletteCommands,
  movePaletteIndex,
  type PaletteCommand,
  type PaletteMoveKey,
} from "./command-palette-model";
import {
  agentSubPathFromPathname,
  useMyAgents,
  useSelectedAgent,
} from "./selected-agent-context";

const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const { username, viewer, canManage } = useSelectedAgent();
  const { agents } = useMyAgents();
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
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

  const commands = useMemo<PaletteCommand[]>(() => {
    const registry = createOntologyRegistry({
      tools: tools.map((tool) => ({
        name: tool.name,
        label: toolLabel(tool),
        description: tool.description ?? undefined,
      })),
    });
    const ontology = resolveOntologyRegistry(
      {
        authenticated: viewer !== null,
        isAdmin: viewer?.isAdmin === true,
        isAgentOwner: canManage,
        agentUsername: username,
      },
      registry,
    );
    return buildPaletteCommands({
      ontology,
      agents: agents ?? [],
      selectedUsername: username,
      selectedSubPath: agentSubPathFromPathname(pathname),
    });
  }, [pathname, username, agents, tools, viewer, canManage]);

  const results = useMemo(() => {
    return filterPaletteCommands(commands, query);
  }, [query, commands]);

  const clamped = clampPaletteIndex(activeIndex, results.length);

  const run = useCallback(
    (command: PaletteCommand) => {
      setOpen(false);
      dispatchPaletteCommand(command, {
        navigate: (href) => router.push(href),
        execute: (action) => {
          if (action === "theme.toggle") {
            setThemePreference(NEXT_THEME[themePreference]);
            return;
          }
          if (action === "account.export" && viewer) {
            void api.account
              .exportBundle()
              .then((blob) => {
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `${viewer.username}-eden3-account.zip`;
                link.click();
                URL.revokeObjectURL(url);
              })
              // The account page owns retry/error UX for this existing action.
              .catch(() => router.push("/account"));
          }
        },
      });
    },
    [router, setThemePreference, themePreference, viewer],
  );

  const onInputKey = (event: React.KeyboardEvent) => {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      setActiveIndex((index) =>
        movePaletteIndex(index, event.key as PaletteMoveKey, results.length),
      );
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
