import { Skeleton, SkeletonRows } from "@/components/skeleton";

/** /sessions — conversation list skeleton. */
export default function SessionsLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 md:px-10">
      <Skeleton className="h-8 w-44" />
      <SkeletonRows count={6} className="mt-8" />
    </div>
  );
}
