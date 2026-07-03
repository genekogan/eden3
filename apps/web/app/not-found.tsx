import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found" };

/**
 * Global 404 — also what notFound() renders (dead permalinks, unknown
 * agents/creations). Quiet, art-gallery tone: the piece isn't here.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-16 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        404
      </p>
      <h1 className="mt-4 text-3xl font-light tracking-tight text-foreground md:text-4xl">
        Nothing hangs here
      </h1>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted">
        This page doesn&apos;t exist — the link may be stale, or the piece was
        never made.
      </p>
      <div className="mt-8 flex items-center gap-3">
        <Link
          href="/explore"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Explore creations
        </Link>
        <Link
          href="/agents"
          className="rounded-lg border border-edge px-4 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
        >
          Browse agents
        </Link>
      </div>
    </div>
  );
}
