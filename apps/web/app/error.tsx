"use client";

/**
 * Global route error boundary (App Router). Catches render/data errors from
 * any page segment and degrades to a quiet card instead of a dead screen.
 * `reset()` re-renders the segment; the home link is the escape hatch.
 */

import { useEffect } from "react";
import Link from "next/link";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[eden3/web] route error:", error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-16 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        Error
      </p>
      <h1 className="mt-4 text-3xl font-light tracking-tight text-foreground md:text-4xl">
        Something went wrong
      </h1>
      <p className="mt-3 max-w-sm break-words font-mono text-xs leading-relaxed text-faint">
        {error.message || "Unexpected error"}
        {error.digest ? ` · ${error.digest}` : ""}
      </p>
      <div className="mt-8 flex items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-lg border border-edge px-4 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
