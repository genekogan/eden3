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
    <nav aria-label="Agent settings sections" className="shrink-0 md:w-44">
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
    <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        @{username} · settings
      </p>
      <div className="mt-6 flex flex-col gap-6 md:flex-row md:gap-10">
        <SettingsNav username={username} />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-light tracking-tight md:text-3xl">{title}</h1>
          {hint ? (
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">{hint}</p>
          ) : null}
          <div className="mt-6">
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
        </div>
      </div>
    </div>
  );
}
