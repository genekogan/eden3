"use client";

/**
 * Agent Settings chrome: the sub-nav (desktop secondary rail / mobile tab
 * row) plus the owner gate every settings page shares. Sections:
 *
 *   Identity — name, description, avatar, greeting, voice
 *   Persona  — SOUL.md (the workspace file IS the source of truth)
 *   Tools    — tool groups + Advanced (model tier, thinking level)
 *   Skills   — per-agent allowlist over the skill catalog
 *   Memory   — MEMORY.md browser, corrections, rebuild
 *   Concepts — reference-image concepts
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/shell/section-header";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";

const SECTIONS = [
  { sub: "identity", label: "Identity" },
  { sub: "persona", label: "Persona" },
  { sub: "tools", label: "Tools" },
  { sub: "skills", label: "Skills" },
  { sub: "memory", label: "Memory" },
  { sub: "concepts", label: "Concepts" },
] as const;

export function SettingsNav({ username }: { username: string }) {
  const pathname = usePathname();
  const base = `/agents/${encodeURIComponent(username)}/settings`;
  return (
    <nav aria-label="Agent settings sections" className="min-w-0 px-3 py-3 md:px-3">
      <ul className="flex gap-1 overflow-x-auto md:flex-col md:gap-0.5">
        {SECTIONS.map((section) => {
          const href = `${base}/${section.sub}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={section.sub} className="shrink-0">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`relative block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-foreground/[0.05] text-foreground"
                    : "text-muted hover:bg-foreground/[0.03] hover:text-foreground"
                }`}
              >
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-y-1.5 left-0 hidden w-0.5 rounded-full bg-accent md:block"
                  />
                ) : null}
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Shared shell: header + sub-nav + owner gate. Settings are owner-only; a
 * non-owner (or signed-out viewer) gets a quiet gate, not the forms.
 */
export function SettingsShell({
  username,
  title,
  hint,
  children,
}: {
  username: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  const { canManage, viewer, phase } = useSelectedAgent();

  return (
    <div className="flex min-h-dvh min-w-0 flex-col md:flex-row">
      <aside className="shrink-0 border-b border-edge bg-surface/60 md:w-56 md:border-b-0 md:border-r">
        <SectionHeader
          title="Settings"
          help="Configure this agent's identity, persona, tools, skills, memory, and reusable visual concepts."
        />
        <SettingsNav username={username} />
      </aside>
      <section className="min-w-0 flex-1">
        <SectionHeader title={title} help={hint ?? `Configure this agent's ${title.toLowerCase()}.`} />
        <div className="mx-auto w-full max-w-4xl px-5 py-6 md:px-8">
            {phase === "ready" && !canManage ? (
              <EmptyState
                title={viewer ? `You don't manage @${username}` : "Sign in first"}
                hint={
                  viewer
                    ? "Only the agent's owner can change its settings."
                    : "Settings are owner-only. Sign in (or pick a dev user), then come back."
                }
              />
            ) : (
              children
            )}
        </div>
      </section>
    </div>
  );
}
