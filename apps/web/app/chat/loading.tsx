import { Skeleton } from "@/components/skeleton";

/** /chat — new-chat skeleton: agent picker + composer. */
export default function ChatLoading() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-6 py-10 md:px-10">
      <Skeleton className="h-8 w-40" />
      <div className="mt-8 flex flex-wrap gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-28 rounded-full" />
        ))}
      </div>
      <div className="mt-auto pt-10">
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  );
}
