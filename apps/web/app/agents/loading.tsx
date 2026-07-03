import { Skeleton } from "@/components/skeleton";

/** /agents — directory skeleton: search bar + avatar cards. */
export default function AgentsLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
      <Skeleton className="h-8 w-36" />
      <Skeleton className="mt-6 h-10 w-full max-w-md rounded-lg" />
      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 9 }, (_, i) => (
          <div
            key={i}
            className="flex items-start gap-3 rounded-xl border border-edge/60 p-4"
          >
            <Skeleton className="size-10 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2 pt-0.5">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
