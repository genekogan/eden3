import type { Metadata } from "next";
import { StudioView } from "@/components/studio/studio-view";
import { RememberLastTool } from "./last-tool";

export const metadata: Metadata = { title: "Studio" };

/**
 * /studio/[tool] — one creation tool. The tool list lives in the Studio
 * sidebar; this page is just the selected tool's surface.
 */
export default async function StudioToolPage({
  params,
}: {
  params: Promise<{ tool: string }>;
}) {
  const { tool } = await params;
  const decoded = decodeURIComponent(tool);
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10 md:px-10">
      <RememberLastTool tool={decoded} />
      <StudioView key={decoded} initialTool={decoded} hidePicker />
    </div>
  );
}
