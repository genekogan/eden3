import { SkeletonRows } from "@/components/skeleton";

/** /channels — connection form + channel rows skeleton. */
export default function ChannelsLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-14 md:px-10">
      <div className="h-4 w-24 rounded bg-white/10" />
      <div className="mt-3 h-9 w-48 rounded bg-white/10" />
      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="h-96 rounded-xl border border-edge bg-surface" />
        <SkeletonRows count={4} />
      </div>
    </div>
  );
}
