import type { ReactNode } from "react";

/**
 * Quiet empty/error slot used by every surface: a dashed card with a title,
 * an optional hint line, and an optional action (button/link). Also renders
 * "endpoint not ready" states while the api lands — pass the right copy.
 */
export function EmptyState({
  title,
  hint,
  action,
  className,
  children,
}: {
  title: string;
  hint?: string;
  /** A <Link> or <button> rendered under the text. */
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col items-center rounded-xl border border-dashed border-edge px-6 py-12 text-center ${className ?? ""}`}
    >
      <p className="text-sm text-muted">{title}</p>
      {hint ? (
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-faint">
          {hint}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
      {children}
    </div>
  );
}
