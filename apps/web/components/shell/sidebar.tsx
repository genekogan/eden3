"use client";

/**
 * The cockpit sidebar — two domains, toggled at the top:
 *
 *   Agents — everything scoped to the SELECTED agent (in the URL). The
 *            selector widget sits at the top; every nav item below routes to
 *            /agents/[username]/<sub>. No agents → a create invitation.
 *   Studio — the direct creation tools (registry-driven list).
 *
 * The user's own corner (account, manna, operator) is the UserArea pinned at
 * the bottom. Mobile keeps the header + full-screen sheet pattern.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { StudioTool } from "@/lib/types";
import { getLastAgent } from "@/lib/last-agent";
import { isEveConcealedSubpath, isEveUsername } from "@/lib/eve";
import {
  categorizeTool,
  sortTools,
  toolLabel,
  FALLBACK_TOOLS,
  type StudioCategory,
} from "@/components/studio/catalog";
import { AgentSelector } from "./agent-selector";
import { EveSidebarEntry } from "@/components/eve/eve-empty-state";
import { EnvChip } from "./env-chip";
import { UserArea } from "./user-area";
import { useMyAgents, useSelectedAgent } from "./selected-agent-context";

/** Minimal 24px stroke icons (multi-subpath `d` strings, lucide-derived). */
export const ICONS = {
  newChat:
    "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM12 7.5v5M9.5 10h5",
  chats:
    "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2zM18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1",
  schedule: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M12 6v6l4 2",
  workspace:
    "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z",
  library:
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M9 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
  gateway:
    "M6 11h12M6 13h12M8 20a4 4 0 0 1-4-4v-3a4 4 0 0 1 4-4h1V6a3 3 0 1 1 6 0v3h1a4 4 0 0 1 4 4v3a4 4 0 0 1-4 4M12 3v6",
  log: "M3 3v18h18M7 16v-5M12 16V7M17 16v-8",
  settings:
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M19.4 15a1.7 1.7 0 0 0 .34 1.87l.04.05a2 2 0 1 1-2.83 2.83l-.05-.04a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.05.04a2 2 0 1 1-2.83-2.83l.04-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.04-.05a2 2 0 1 1 2.83-2.83l.05.04A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.05-.04a2 2 0 1 1 2.83 2.83l-.04.05A1.7 1.7 0 0 0 19.4 9c.14.6.64 1 1.55 1H21a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-1.52 1",
  agents:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  studio:
    "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",
  image:
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M9 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
  video:
    "M4 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2M17 10l5-3v10l-5-3",
  music:
    "M9 18V5l12-2v13M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  speech:
    "M12 2a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8",
} as const;

export function NavIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-4 shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

const AGENT_NAV = [
  { sub: "chats", label: "Chats", icon: ICONS.chats },
  { sub: "schedule", label: "Schedule", icon: ICONS.schedule },
  { sub: "workspace", label: "Workspace", icon: ICONS.workspace },
  { sub: "library", label: "Library", icon: ICONS.library },
  { sub: "gateway", label: "Gateway", icon: ICONS.gateway },
  { sub: "log", label: "Log", icon: ICONS.log },
  { sub: "settings", label: "Settings", icon: ICONS.settings },
] as const;

const CATEGORY_ICON: Record<StudioCategory, string> = {
  image: ICONS.image,
  video: ICONS.video,
  music: ICONS.music,
  speech: ICONS.speech,
  other: ICONS.studio,
};

type Domain = "agents" | "studio";

function domainFromPathname(pathname: string): Domain {
  return pathname === "/studio" || pathname.startsWith("/studio/") ? "studio" : "agents";
}

// ---------------------------------------------------------------------------
// Domain toggle — minimal segmented control at the very top.
// ---------------------------------------------------------------------------

function DomainToggle({
  domain,
  agentsHref,
  labels = "responsive",
}: {
  domain: Domain;
  agentsHref: string;
  labels?: "responsive" | "always";
}) {
  const options: Array<{ value: Domain; label: string; href: string; icon: string }> = [
    { value: "agents", label: "Agents", href: agentsHref, icon: ICONS.agents },
    { value: "studio", label: "Studio", href: "/studio", icon: ICONS.studio },
  ];
  return (
    <div
      role="group"
      aria-label="App domain"
      className={`flex overflow-hidden rounded-lg border border-edge bg-raised ${
        labels === "responsive" ? "flex-col lg:flex-row" : ""
      }`}
    >
      {options.map((option) => {
        const active = domain === option.value;
        return (
          <Link
            key={option.value}
            href={option.href}
            aria-current={active ? "page" : undefined}
            title={option.label}
            className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-1.5 text-xs transition-colors ${
              active
                ? "bg-accent/15 text-accent-soft"
                : "text-muted hover:text-foreground"
            }`}
          >
            <NavIcon d={option.icon} />
            <span className={labels === "responsive" ? "hidden lg:inline" : ""}>
              {option.label}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agents-domain nav
// ---------------------------------------------------------------------------

/** labels: "responsive" hides them below lg (desktop rail); "always" shows them (mobile sheet). */
type LabelMode = "responsive" | "always";
const labelClass = (mode: LabelMode) => (mode === "responsive" ? "hidden lg:inline" : "");
const rowClass = (mode: LabelMode) =>
  mode === "responsive"
    ? "justify-center gap-0 px-0 lg:justify-start lg:gap-2.5 lg:px-3"
    : "justify-start gap-2.5 px-3";

function AgentNav({
  labels = "responsive",
  onNavigate,
}: {
  labels?: LabelMode;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { username } = useSelectedAgent();
  const { agents, phase } = useMyAgents();

  if (
    phase === "ready" &&
    agents !== null &&
    agents.length === 0 &&
    !isEveUsername(username)
  ) {
    return (
      <EveSidebarEntry
        onNavigate={onNavigate}
        labelsAlways={labels === "always"}
      />
    );
  }

  if (!username) {
    return (
      <p
        className={`mt-4 px-1 text-xs leading-relaxed text-faint ${
          labels === "responsive" ? "hidden lg:block" : ""
        }`}
      >
        Select an agent to see its chats, schedule, workspace, and settings.
      </p>
    );
  }

  const base = `/agents/${encodeURIComponent(username)}`;
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const newChatHref = `${base}/chats/new`;

  return (
    <>
      <Link
        href={newChatHref}
        onClick={onNavigate}
        aria-current={pathname === newChatHref ? "page" : undefined}
        title="New Chat"
        className={`mb-4 mt-4 flex items-center rounded-lg border py-2 text-sm transition-colors ${rowClass(labels)} ${
          pathname === newChatHref
            ? "border-accent/60 bg-accent/15 text-accent-soft"
            : "border-accent/30 text-accent-soft hover:border-accent/60 hover:bg-accent/10"
        }`}
      >
        <NavIcon d={ICONS.newChat} />
        <span className={labelClass(labels)}>New Chat</span>
      </Link>
      <ul className="space-y-0.5">
        {AGENT_NAV.filter(
          (item) =>
            !isEveUsername(username) || !isEveConcealedSubpath(item.sub),
        ).map((item) => {
          const href = `${base}/${item.sub}`;
          // "New Chat" owns …/chats/new; everything else under chats lights Chats.
          const active =
            item.sub === "chats" ? isActive(href) && pathname !== newChatHref : isActive(href);
          return (
            <li key={item.sub}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                title={item.label}
                className={`relative flex items-center rounded-lg py-2 text-sm transition-colors ${rowClass(labels)} ${
                  active
                    ? "bg-foreground/[0.05] text-foreground"
                    : "text-muted hover:bg-foreground/[0.03] hover:text-foreground"
                }`}
              >
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent"
                  />
                ) : null}
                <span className={active ? "text-accent-soft" : "text-faint"}>
                  <NavIcon d={item.icon} />
                </span>
                <span className={labelClass(labels)}>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------
// Studio-domain nav — the tool registry
// ---------------------------------------------------------------------------

function StudioNav({
  labels = "responsive",
  onNavigate,
}: {
  labels?: LabelMode;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const [tools, setTools] = useState<StudioTool[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.studio
      .tools()
      .then((items) => {
        if (!cancelled) {
          setTools(items.length > 0 ? sortTools(items) : sortTools([...FALLBACK_TOOLS]));
        }
      })
      .catch(() => {
        if (!cancelled) setTools(sortTools([...FALLBACK_TOOLS]));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ul className="mt-4 space-y-0.5">
      {(tools ?? []).map((tool) => {
        const href = `/studio/${encodeURIComponent(tool.name)}`;
        const active = pathname === href;
        return (
          <li key={tool.name}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              title={toolLabel(tool)}
              className={`relative flex items-center rounded-lg py-2 text-sm transition-colors ${rowClass(labels)} ${
                active
                  ? "bg-foreground/[0.05] text-foreground"
                  : "text-muted hover:bg-foreground/[0.03] hover:text-foreground"
              }`}
            >
              {active ? (
                <span
                  aria-hidden
                  className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent"
                />
              ) : null}
              <span className={active ? "text-accent-soft" : "text-faint"}>
                <NavIcon d={CATEGORY_ICON[categorizeTool(tool)]} />
              </span>
              <span className={labelClass(labels)}>{toolLabel(tool)}</span>
            </Link>
          </li>
        );
      })}
      {tools === null ? (
        <li aria-hidden className="px-1 py-2 text-xs text-faint">
          <span className={labelClass(labels)}>Loading tools…</span>
        </li>
      ) : null}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The sidebar
// ---------------------------------------------------------------------------

export function Sidebar() {
  const pathname = usePathname();
  const { username } = useSelectedAgent();
  const [mobileOpen, setMobileOpen] = useState(false);
  const domain = domainFromPathname(pathname);

  useEffect(() => setMobileOpen(false), [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mobileOpen]);

  // The Agents toggle target: current agent > remembered agent > selector.
  // Remembered agent is read post-hydration (localStorage) to keep SSR stable.
  const [lastAgentHref, setLastAgentHref] = useState("/agents");
  useEffect(() => {
    const last = getLastAgent();
    setLastAgentHref(last ? `/agents/${encodeURIComponent(last)}/chats` : "/agents");
  }, [pathname]);
  const agentsHref = username
    ? `/agents/${encodeURIComponent(username)}/chats`
    : lastAgentHref;

  const mobileNewChatHref = username
    ? `/agents/${encodeURIComponent(username)}/chats/new`
    : "/agents";

  return (
    <>
      {/* Phones get the full viewport: navigation lives in a top bar + sheet. */}
      <header className="fixed inset-x-0 top-0 z-50 flex h-14 items-center justify-between border-b border-edge bg-surface/95 px-3 backdrop-blur sm:hidden">
        <Link
          href="/"
          aria-label="Eden home"
          className="font-mono text-sm tracking-[0.35em] text-foreground"
        >
          EDEN<span className="text-accent">3</span>
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={mobileNewChatHref}
            aria-label="New Chat"
            className="flex size-9 items-center justify-center rounded-lg border border-edge text-muted transition-colors"
          >
            <NavIcon d={ICONS.newChat} />
          </Link>
          <button
            type="button"
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={mobileOpen}
            aria-controls="mobile-navigation-sheet"
            onClick={() => setMobileOpen((open) => !open)}
            className="flex size-9 items-center justify-center rounded-lg border border-edge text-muted transition-colors hover:border-accent/50 hover:text-foreground"
          >
            <span aria-hidden className="relative block h-3.5 w-4">
              <span
                className={`absolute left-0 top-0 h-px w-4 bg-current transition-transform ${
                  mobileOpen ? "translate-y-[6px] rotate-45" : ""
                }`}
              />
              <span
                className={`absolute left-0 top-[6px] h-px w-4 bg-current transition-opacity ${
                  mobileOpen ? "opacity-0" : ""
                }`}
              />
              <span
                className={`absolute bottom-0 left-0 h-px w-4 bg-current transition-transform ${
                  mobileOpen ? "-translate-y-[7px] -rotate-45" : ""
                }`}
              />
            </span>
          </button>
        </div>
      </header>

      {mobileOpen ? (
        <div
          id="mobile-navigation-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          className="fixed inset-x-0 bottom-0 top-14 z-40 overflow-y-auto bg-background/98 px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 backdrop-blur sm:hidden"
        >
          <DomainToggle domain={domain} agentsHref={agentsHref} labels="always" />
          {domain === "agents" ? (
            <div className="mt-3">
              <AgentSelector />
              <AgentNav labels="always" onNavigate={() => setMobileOpen(false)} />
            </div>
          ) : (
            <StudioNav labels="always" onNavigate={() => setMobileOpen(false)} />
          )}
          <div className="mt-4 rounded-xl border border-edge bg-surface">
            <UserArea />
          </div>
        </div>
      ) : null}

      {/* Tablet/desktop rail; labels return at lg+. */}
      <aside
        data-testid="desktop-sidebar"
        className="sticky top-0 hidden h-dvh w-14 shrink-0 flex-col border-r border-edge bg-surface sm:flex lg:w-60"
      >
        <div className="flex items-center justify-center gap-2 pb-3 pt-4 lg:justify-between lg:px-4">
          <Link
            href="/"
            aria-label="Eden home"
            title="Eden"
            className="font-mono text-sm tracking-[0.35em] text-foreground"
          >
            <span className="hidden lg:inline">
              EDEN<span className="text-accent">3</span>
            </span>
            <span aria-hidden className="block size-2.5 rounded-full bg-accent lg:hidden" />
          </Link>
          <span className="hidden lg:inline-flex lg:items-center">
            <EnvChip />
          </span>
        </div>

        <div className="px-2 lg:px-3">
          <DomainToggle domain={domain} agentsHref={agentsHref} />
          {domain === "agents" ? (
            <div className="mt-3">
              <div className="lg:hidden">
                <AgentSelector collapsed />
              </div>
              <div className="hidden lg:block">
                <AgentSelector />
              </div>
            </div>
          ) : null}
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-4 lg:px-3" aria-label="Primary">
          {domain === "agents" ? <AgentNav /> : <StudioNav />}
        </nav>

        <div className="lg:hidden">
          <UserArea collapsed />
        </div>
        <div className="hidden lg:block">
          <UserArea />
        </div>
      </aside>
    </>
  );
}
