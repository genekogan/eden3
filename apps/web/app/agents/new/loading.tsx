import { Skeleton } from "@/components/skeleton";

/** /agents/new — create-agent form skeleton. */
export default function NewAgentLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10 md:px-10">
      <Skeleton className="h-8 w-48" />
      <div className="mt-8 space-y-5">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-10 w-32 rounded-lg" />
      </div>
    </div>
  );
}
