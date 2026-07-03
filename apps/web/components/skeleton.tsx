/**
 * Loading skeletons — small, quiet, consistent. Server-safe (no hooks).
 *
 *   <Skeleton className="h-4 w-32" />         one shimmering block
 *   <SkeletonText lines={3} />                paragraph placeholder
 *   <SkeletonMediaGrid count={12} />          feed/grid placeholder
 */

function cx(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" ");
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cx("animate-pulse rounded-md bg-white/[0.06]", className)}
    />
  );
}

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div aria-hidden className={cx("space-y-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cx("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}

/** Placeholder for media grids (feed, agent creations, collections). */
export function SkeletonMediaGrid({
  count = 12,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cx(
        "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4",
        className,
      )}
    >
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="aspect-square rounded-xl" />
      ))}
    </div>
  );
}

/** Row placeholder (sessions list, transactions, tasks). */
export function SkeletonRows({
  count = 5,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div aria-hidden className={cx("space-y-2", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-xl border border-edge/60 p-4"
        >
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
