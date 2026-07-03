import { Skeleton } from "@/components/skeleton";

/** /studio — header, tool cards, prompt panel (matches StudioView). */
export default function StudioLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-14 md:px-10">
      <Skeleton className="h-9 w-32" />
      <Skeleton className="mt-3 h-4 w-72" />
      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
      <Skeleton className="mt-4 h-52 rounded-xl" />
    </div>
  );
}
