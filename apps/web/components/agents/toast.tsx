"use client";

/**
 * Minimal auto-dismissing toast (agents surface). Render conditionally:
 *
 *   {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
 */

import { useEffect } from "react";

export function Toast({
  message,
  onDismiss,
  durationMs = 5000,
}: {
  message: string;
  onDismiss: () => void;
  durationMs?: number;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(timer);
  }, [onDismiss, durationMs, message]);

  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-50 flex max-w-[90vw] -translate-x-1/2 items-center gap-2.5 rounded-lg border border-edge bg-raised px-4 py-2.5 text-sm text-foreground shadow-xl shadow-black/40"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />
      <span className="min-w-0">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="ml-1 shrink-0 text-faint transition-colors hover:text-foreground"
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
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
