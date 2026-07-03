import { Skeleton, SkeletonRows } from "@/components/skeleton";

/** /tasks — scheduled-task list skeleton. */
export default function TasksLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 md:px-10">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>
      <SkeletonRows count={5} className="mt-8" />
    </div>
  );
}
