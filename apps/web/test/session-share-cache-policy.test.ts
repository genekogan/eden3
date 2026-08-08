import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

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
    const source = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
    expect(source).toContain('/share/:token/:path*');
    expect(source).toContain('/_next/data/:buildId/share/:token.json');
    expect(source).toContain('private, no-store, no-cache, max-age=0, must-revalidate');
    expect(source).toContain('Referrer-Policy');
    expect(source).toContain('no-referrer');
    expect(source).toContain('X-Robots-Tag');
    expect(source).toContain('noindex, nofollow, noarchive');
  });
});
