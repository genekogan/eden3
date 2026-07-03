import { Skeleton } from "@/components/skeleton";

/** /collections — cover-tile grid skeleton. */
export default function CollectionsLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
      <Skeleton className="h-8 w-40" />
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="aspect-[4/3] w-full rounded-xl" />
            <Skeleton className="h-3.5 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}
