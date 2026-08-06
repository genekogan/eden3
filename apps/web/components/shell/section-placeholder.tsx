"use client";

/**
 * Interim page body for agent sections whose dedicated surfaces are still
 * being carved out of the legacy pages (this refactor lands in phases). Each
 * placeholder names the section and links to the legacy surface that still
 * holds the functionality, so nothing is lost at any checkpoint.
 */

import Link from "next/link";
import { useSelectedAgent } from "./selected-agent-context";

export function SectionPlaceholder({
  title,
  description,
  legacyHref,
  legacyLabel,
}: {
  title: string;
  description: string;
  /** `{username}` is replaced with the selected agent's username. */
  legacyHref: string;
  legacyLabel: string;
}) {
  const { username } = useSelectedAgent();
  const href = legacyHref.replaceAll("{username}", encodeURIComponent(username ?? ""));
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-14 md:px-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        @{username}
      </p>
      <h1 className="mt-3 text-3xl font-light tracking-tight md:text-4xl">{title}</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">{description}</p>
      <div className="mt-8 rounded-xl border border-dashed border-edge px-5 py-6">
        <p className="text-sm text-muted">
          This section is being rebuilt as part of the cockpit refactor.
        </p>
        <Link
          href={href}
          className="mt-4 inline-block rounded-lg border border-accent/40 px-3.5 py-2 text-sm text-accent-soft transition-colors hover:bg-accent/10"
        >
          {legacyLabel} →
        </Link>
      </div>
    </div>
  );
}
