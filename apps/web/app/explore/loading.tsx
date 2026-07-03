import { Skeleton } from "@/components/skeleton";
import { FeedSkeleton } from "@/components/feed/feed-skeleton";

/** /explore — mirrors the page frame so content lands without a jump. */
export default function ExploreLoading() {
  return (
    <div className="mx-auto w-full max-w-[1720px] px-4 py-8 md:px-8 md:py-10">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>
      <FeedSkeleton />
    </div>
  );
}
