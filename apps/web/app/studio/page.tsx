import type { Metadata } from "next";
import { StudioView } from "@/components/studio/studio-view";

export const metadata: Metadata = {
  title: "Studio",
  description:
    "Generate images, video, music, and speech directly with Eden's tools.",
};

export default function StudioPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-14 md:px-10">
      <header>
        <h1 className="text-3xl font-light tracking-tight md:text-4xl">
          Studio
        </h1>
        <p className="mt-2 text-sm text-muted">
          Generate images, video, music, and speech — straight to your
          creations.
        </p>
      </header>
      <StudioView />
    </div>
  );
}
