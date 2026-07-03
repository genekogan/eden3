import { Skeleton } from "@/components/skeleton";

/** /sessions/:id — thread skeleton: alternating bubbles + composer. */
export default function SessionLoading() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-6 py-10 md:px-10">
      <div className="flex items-center gap-3">
        <Skeleton className="size-8 rounded-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="mt-10 space-y-6">
        <Skeleton className="ml-auto h-10 w-3/5 rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-3/5" />
        </div>
        <Skeleton className="ml-auto h-10 w-2/5 rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
      </div>
      <div className="mt-auto pt-10">
        <Skeleton className="h-14 w-full rounded-xl" />
      </div>
    </div>
  );
}
