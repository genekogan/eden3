import { Skeleton, SkeletonMediaGrid } from "@/components/skeleton";

/** /collections/:id — title block + the collection's media grid. */
export default function CollectionLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 md:px-10">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="mt-3 h-3.5 w-72" />
      <SkeletonMediaGrid count={12} className="mt-8" />
    </div>
  );
}
