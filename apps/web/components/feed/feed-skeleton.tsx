/**
 * Masonry loading state for the explore feed. Server-safe (no hooks).
 *
 * The ratio sequence is deterministic — server HTML and client hydration
 * must paint identical columns, so no randomness.
 */

/** One masonry definition shared by the skeleton and the live grid. */
export const MASONRY_COLUMNS =
  "columns-2 gap-3 sm:columns-3 lg:columns-4 2xl:columns-5";

const RATIOS = [3 / 4, 1, 4 / 5, 16 / 10, 2 / 3, 1, 5 / 4, 3 / 4, 1, 2 / 3, 16 / 10, 4 / 5];

export function FeedSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div aria-hidden className={MASONRY_COLUMNS}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="mb-3 break-inside-avoid animate-pulse rounded-xl bg-white/[0.06]"
          style={{ aspectRatio: String(RATIOS[i % RATIOS.length]) }}
        />
      ))}
    </div>
  );
}
