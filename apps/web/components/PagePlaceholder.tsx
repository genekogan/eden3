import type { ReactNode } from "react";

interface PagePlaceholderProps {
  title: string;
  /** What will live on this page once its W3 surface agent builds it. */
  todo: string;
  /** Optional mono line under the title (permalink, route param, …). */
  meta?: string;
  children?: ReactNode;
}

/**
 * Skeleton-phase page body: title + a dashed "empty slot" carrying the TODO.
 * Every route renders through this so the whole app reads as a labeled
 * gallery wall awaiting its pieces, not as something broken.
 */
export function PagePlaceholder({
  title,
  todo,
  meta,
  children,
}: PagePlaceholderProps) {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-14 md:px-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        Eden3 / Skeleton
      </p>
      <h1 className="mt-3 text-3xl font-light tracking-tight md:text-4xl">
        {title}
      </h1>
      {meta ? (
        <p className="mt-3 break-all font-mono text-xs text-accent-soft">
          {meta}
        </p>
      ) : null}

      <div className="mt-10 rounded-xl border border-dashed border-edge p-6">
        <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-accent-soft">
          todo
        </span>
        <p className="mt-3 text-sm leading-relaxed text-muted">{todo}</p>
      </div>

      {children}
    </div>
  );
}
