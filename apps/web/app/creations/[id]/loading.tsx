import { Skeleton, SkeletonText } from "@/components/skeleton";

/** /creations/:id — mirrors the permalink frame: hero media + placard. */
export default function CreationLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8 md:py-10">
      <Skeleton className="h-4 w-16" />
      <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-10">
        <Skeleton className="aspect-square w-full rounded-xl lg:aspect-[4/3]" />
        <div className="space-y-5">
          <Skeleton className="h-3 w-20" />
          <SkeletonText lines={3} />
          <div className="space-y-2.5 border-t border-edge pt-5">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-12" />
              <div className="flex items-center gap-2">
                <Skeleton className="size-[22px] rounded-full" />
                <Skeleton className="h-3.5 w-24" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-12" />
              <div className="flex items-center gap-2">
                <Skeleton className="size-[22px] rounded-full" />
                <Skeleton className="h-3.5 w-24" />
              </div>
            </div>
          </div>
          <Skeleton className="h-9 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
