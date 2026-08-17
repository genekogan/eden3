import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

const WEB_SECURITY_SOURCE = "/((?!api(?:/|$)|media(?:/|$)).*)";

function sourceMatchesPath(source: string, path: string): boolean {
  return new RegExp(`^${source}$`).test(path);
}

describe("cockpit browser security headers", () => {
  it("applies the exact fail-closed browser boundary to web routes only", async () => {
    const rules = await nextConfig.headers?.();
    const webRule = rules?.[0];

    expect(webRule?.source).toBe(WEB_SECURITY_SOURCE);
    for (const path of [
      "/",
      "/agents",
      "/agents/alice/chats",
      "/account",
      "/share/capability-token",
      "/apiary",
      "/media-library",
    ]) {
      expect(sourceMatchesPath(WEB_SECURITY_SOURCE, path), path).toBe(true);
    }
    for (const path of ["/api", "/api/health", "/media", "/media/object-id"]) {
      expect(sourceMatchesPath(WEB_SECURITY_SOURCE, path), path).toBe(false);
    }

    expect(
      Object.fromEntries(webRule?.headers.map(({ key, value }) => [key, value]) ?? []),
    ).toEqual({
      "Content-Security-Policy":
        "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
      "Permissions-Policy":
        "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
  });

  it("keeps capability routes later and strictly overrides their referrer policy", async () => {
    const rules = await nextConfig.headers?.();

    expect(rules?.map(({ source }) => source)).toEqual([
      WEB_SECURITY_SOURCE,
      "/share/:token/:path*",
      "/_next/data/:buildId/share/:token.json",
    ]);

    const baselineHeaders = Object.fromEntries(
      rules?.[0]?.headers.map(({ key, value }) => [key, value]) ?? [],
    );
    for (const rule of rules?.slice(1) ?? []) {
      const effectiveHeaders = {
        ...baselineHeaders,
        ...Object.fromEntries(rule.headers.map(({ key, value }) => [key, value])),
      };
      expect(effectiveHeaders["Referrer-Policy"]).toBe("no-referrer");
      expect(effectiveHeaders["Cache-Control"]).toBe(
        "private, no-store, no-cache, max-age=0, must-revalidate",
      );
      expect(effectiveHeaders["Content-Security-Policy"]).toBe(
        "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
      );
    }
  });
});
