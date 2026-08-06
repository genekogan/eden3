import type { Metadata } from "next";
import { StudioView } from "@/components/studio/studio-view";

export const metadata: Metadata = { title: "Studio" };

/**
 * /studio/[tool] — one creation tool, preselected from the registry-driven
 * sidebar. (The full per-tool surface split lands later in the refactor; for
 * now this is StudioView with the tool preselected.)
 */
export default async function StudioToolPage({
  params,
}: {
  params: Promise<{ tool: string }>;
}) {
  const { tool } = await params;
  const decoded = decodeURIComponent(tool);
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-14 md:px-10">
      <StudioView key={decoded} initialTool={decoded} />
    </div>
  );
}
