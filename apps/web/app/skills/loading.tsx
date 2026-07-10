import { SkeletonRows } from "@/components/skeleton";

export default function SkillsLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-14 md:px-10">
      <div className="h-4 w-20 rounded bg-white/10" />
      <div className="mt-3 h-9 w-44 rounded bg-white/10" />
      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="h-[34rem] rounded-xl border border-edge bg-surface" />
        <SkeletonRows count={6} />
      </div>
    </div>
  );
}
