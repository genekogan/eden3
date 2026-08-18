import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { forwardedApiAuthCookieHeader } from "../lib/server-api-auth";

describe("creation permalink server authentication", () => {
  it("forwards only the local or Clerk authentication cookies", () => {
    const cookies = new Map([
      ["eden3_dev_user", "alex"],
      ["__session", "header.payload.signature"],
      ["eden3_last_agent", "rocket"],
      ["unrelated", "must-not-cross"],
    ]);

    expect(forwardedApiAuthCookieHeader((name) => cookies.get(name))).toBe(
      "eden3_dev_user=alex; __session=header.payload.signature",
    );
    expect(forwardedApiAuthCookieHeader(() => undefined)).toBeNull();
  });

  it("encodes cookie delimiters instead of creating a second forwarded cookie", () => {
    expect(
      forwardedApiAuthCookieHeader((name) =>
        name === "eden3_dev_user" ? "alex; admin=true" : undefined,
      ),
    ).toBe("eden3_dev_user=alex%3B%20admin%3Dtrue");
  });

  it("binds the authenticated header to both metadata and page loads", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../app/creations/[id]/page.tsx"),
      "utf8",
    );
    expect(source.match(/await requestAuthCookieHeader\(\)/g)).toHaveLength(2);
    expect(source).toContain("authCookieHeader ? { headers: { cookie: authCookieHeader } } : {}");
    expect(source).toContain("forwardedApiAuthCookieHeader");
  });
});
