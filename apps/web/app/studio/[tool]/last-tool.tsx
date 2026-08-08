"use client";

import { useEffect } from "react";

/** Remembers the visited tool so /studio can land back on it. */
export function RememberLastTool({ tool }: { tool: string }) {
  useEffect(() => {
    document.cookie = `eden3_last_tool=${encodeURIComponent(tool)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  }, [tool]);
  return null;
}
