import { Skeleton } from "@/components/skeleton";

/** /agents/:username/edit — persona editor skeleton. */
export default function EditAgentLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10 md:px-10">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <Skeleton className="h-6 w-48" />
      </div>
      <div className="mt-8 space-y-5">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-10 w-32 rounded-lg" />
      </div>
    </div>
  );
}
