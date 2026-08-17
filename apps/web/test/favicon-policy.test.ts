import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

describe("favicon compatibility route", () => {
  it("redirects the legacy favicon request to the real SVG icon", async () => {
    const redirects = await nextConfig.redirects?.();
    expect(redirects).toContainEqual({
      source: "/favicon.ico",
      destination: "/icon.svg",
      permanent: true,
    });
    const icon = await readFile(new URL("../app/icon.svg", import.meta.url), "utf8");
    expect(icon).toMatch(/^<svg[\s>]/);
  });
});
