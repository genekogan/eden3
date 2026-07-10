import { describe, expect, it } from "vitest";

import { conceptImageFileError } from "@/components/agents/agent-concepts";

describe("conceptImageFileError (client-side upload pre-check)", () => {
  it("accepts png/jpeg/webp up to 8MB", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(conceptImageFileError({ type, size: 8 * 1024 * 1024 })).toBeNull();
    }
  });

  it("rejects unsupported types", () => {
    expect(conceptImageFileError({ type: "image/gif", size: 10 })).toMatch(/png, jpeg, or webp/);
    expect(conceptImageFileError({ type: "application/pdf", size: 10 })).toMatch(
      /png, jpeg, or webp/,
    );
  });

  it("rejects files over 8MB (mirrors the api's decoded-size limit)", () => {
    expect(
      conceptImageFileError({ type: "image/png", size: 8 * 1024 * 1024 + 1 }),
    ).toMatch(/8MB/);
  });
});
