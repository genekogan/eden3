import { describe, expect, it } from "vitest";
import { selectAuthMode } from "../lib/clerk";

describe("auth mode selection", () => {
  it("uses dev impersonation when explicitly enabled even with Clerk configured", () => {
    expect(selectAuthMode("1", "pk_test_configured")).toBe("dev-impersonation");
  });

  it("uses Clerk when configured without the dev override", () => {
    expect(selectAuthMode(undefined, "pk_test_configured")).toBe("clerk");
    expect(selectAuthMode("0", "pk_test_configured")).toBe("clerk");
  });

  it("falls back to dev impersonation when Clerk is not configured", () => {
    expect(selectAuthMode(undefined, "")).toBe("dev-impersonation");
  });
});
