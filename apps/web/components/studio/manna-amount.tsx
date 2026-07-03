/**
 * Inline manna price/balance chip — the same diamond glyph as the sidebar
 * badge, sized for cards and buttons. Inherits color from its parent
 * (glyph strokes currentColor) unless a className overrides it.
 * Server-safe: no hooks.
 */

import { formatManna } from "@/lib/format";

export function MannaGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className ?? "size-3 shrink-0"}
    >
      <path d="M6 3h12l4 6-10 13L2 9z" />
      <path d="M11 3 8 9l4 13 4-13-3-6M2 9h20" />
    </svg>
  );
}

export function MannaAmount({
  amount,
  className,
}: {
  amount: number | null | undefined;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${className ?? "text-muted"}`}
      title={amount != null ? `${formatManna(amount)} manna` : undefined}
    >
      <MannaGlyph />
      <span className="tabular-nums">{formatManna(amount)}</span>
    </span>
  );
}
