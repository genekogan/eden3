import { Skeleton, SkeletonRows } from "@/components/skeleton";

/** /manna — balance cards + transaction ledger skeleton. */
export default function MannaLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 md:px-10">
      <Skeleton className="h-8 w-28" />
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
      <Skeleton className="mt-10 h-4 w-32" />
      <SkeletonRows count={6} className="mt-4" />
    </div>
  );
}
