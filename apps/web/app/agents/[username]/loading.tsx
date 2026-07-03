import { Skeleton, SkeletonMediaGrid, SkeletonText } from "@/components/skeleton";

/** /agents/:username — profile skeleton: identity block + recent creations. */
export default function AgentProfileLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
      <div className="flex items-start gap-5">
        <Skeleton className="size-16 rounded-full md:size-20" />
        <div className="min-w-0 flex-1 space-y-3 pt-1">
          <Skeleton className="h-6 w-48" />
          <SkeletonText lines={2} className="max-w-xl" />
        </div>
      </div>
      <div className="mt-6 flex gap-3">
        <Skeleton className="h-9 w-28 rounded-lg" />
        <Skeleton className="h-9 w-24 rounded-lg" />
      </div>
      <Skeleton className="mt-12 h-4 w-32" />
      <SkeletonMediaGrid count={8} className="mt-4" />
    </div>
  );
}
