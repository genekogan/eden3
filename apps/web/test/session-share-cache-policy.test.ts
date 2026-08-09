import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

describe("public session share cache and metadata boundary", () => {
  it("keeps every HTML/RSC render dynamic and token-referrer-safe", async () => {
    const source = await readFile(
      new URL("../app/share/[token]/page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('export const dynamic = "force-dynamic"');
    expect(source).toContain('export const fetchCache = "force-no-store"');
    expect(source).toContain("export const revalidate = 0");
    expect(source).toContain("unstable_noStore()");
    expect(source).not.toContain('import { cache } from "react"');
    expect(source).toContain('referrer: "no-referrer"');
    expect(source).not.toMatch(/canonical\s*:/);
    expect(source).not.toMatch(/openGraph:\s*\{[^}]*url\s*:/s);
  });

  it("adds fail-closed response headers to exact and nested token-bearing routes", async () => {
    const rules = await nextConfig.headers?.();
    expect(rules).toBeDefined();
    expect(rules?.map((rule) => rule.source)).toEqual([
      "/((?!api(?:/|$)|media(?:/|$)).*)",
      "/share/:token/:path*",
      "/_next/data/:buildId/share/:token.json",
    ]);
    for (const rule of rules?.slice(1) ?? []) {
      expect(Object.fromEntries(rule.headers.map(({ key, value }) => [key, value]))).toEqual({
        "Cache-Control": "private, no-store, no-cache, max-age=0, must-revalidate",
        "CDN-Cache-Control": "no-store",
        "Surrogate-Control": "no-store",
        Pragma: "no-cache",
        Expires: "0",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      });
    }
  });
});
