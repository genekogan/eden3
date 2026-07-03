import { describe, expect, it } from "vitest";
import type { CreationDto } from "@eden3/shared";
import {
  argsOf,
  dimensionsOf,
  feedAspectRatio,
  FEED_RATIO_MAX,
  FEED_RATIO_MIN,
  isVideoAsset,
  isVideoCreation,
  mimeOf,
  promptOf,
  sessionRefOf,
} from "../components/feed/creation-fields";

function creation(overrides: Partial<CreationDto> = {}): CreationDto {
  return {
    id: "3f6f4a1e-9d2b-4c5a-8e7f-0a1b2c3d4e5f",
    externalId: null,
    userId: null,
    agentId: null,
    tool: "create",
    filename: null,
    url: "https://cdn.example.com/x.png",
    thumbnailUrl: null,
    mediaAttributes: null,
    likeCount: 0,
    public: true,
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: "2026-07-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("creation-fields media shape", () => {
  it("reads dimensions and mime from mediaAttributes", () => {
    const c = creation({
      mediaAttributes: { width: 1024, height: 768, mimeType: "image/png" },
    });
    expect(dimensionsOf(c)).toEqual({ width: 1024, height: 768 });
    expect(mimeOf(c)).toBe("image/png");
    expect(feedAspectRatio(c)).toBeCloseTo(1024 / 768);
  });

  it("clamps extreme ratios and squares the unknown", () => {
    const tall = creation({ mediaAttributes: { width: 100, height: 1000 } });
    const wide = creation({ mediaAttributes: { width: 5000, height: 100 } });
    expect(feedAspectRatio(tall)).toBe(FEED_RATIO_MIN);
    expect(feedAspectRatio(wide)).toBe(FEED_RATIO_MAX);
    expect(feedAspectRatio(creation())).toBe(1);
    expect(
      feedAspectRatio(creation({ mediaAttributes: { width: -3, height: 0 } })),
    ).toBe(1);
  });

  it("detects video by extension (query-safe) and by mime override", () => {
    expect(isVideoAsset("https://cdn.example.com/a.mp4?sig=1")).toBe(true);
    expect(isVideoAsset("/media/ab/cd.webm#t=2")).toBe(true);
    expect(isVideoAsset("/media/ab/cd.png")).toBe(false);
    expect(isVideoAsset(null)).toBe(false);
    expect(isVideoAsset("no-extension")).toBe(false);
    expect(isVideoAsset("x.png", "video/mp4")).toBe(true);
    expect(
      isVideoCreation(
        creation({ url: "x.bin", mediaAttributes: { mimeType: "video/webm" } }),
      ),
    ).toBe(true);
    expect(isVideoCreation(creation({ url: "x.mp4" }))).toBe(true);
  });
});

describe("creation-fields provenance", () => {
  it("finds the prompt in args before mediaAttributes, and by fallback key", () => {
    const inArgs = creation({
      mediaAttributes: { prompt: "attr prompt" },
      ...({ args: { prompt: "args prompt" } } as Partial<CreationDto>),
    });
    expect(promptOf(inArgs)).toBe("args prompt");

    const inAttrs = creation({ mediaAttributes: { text_input: "typed text" } });
    expect(promptOf(inAttrs)).toBe("typed text");

    expect(promptOf(creation())).toBeNull();
    expect(promptOf(creation({ mediaAttributes: { prompt: "  " } }))).toBeNull();
  });

  it("returns args only when they are a non-empty object", () => {
    expect(argsOf(creation())).toBeNull();
    expect(argsOf(creation({ mediaAttributes: { args: {} } }))).toBeNull();
    expect(
      argsOf(creation({ mediaAttributes: { args: { seed: 7 } } })),
    ).toEqual({ seed: 7 });
    const topLevel = creation({
      ...({ args: { prompt: "p" } } as Partial<CreationDto>),
    });
    expect(argsOf(topLevel)).toEqual({ prompt: "p" });
  });

  it("finds a session ref in any of the tolerated spots", () => {
    expect(sessionRefOf(creation())).toBeNull();
    expect(
      sessionRefOf(
        creation({ ...({ sessionId: "abc123" } as Partial<CreationDto>) }),
      ),
    ).toBe("abc123");
    expect(
      sessionRefOf(
        creation({
          ...({ session: { id: "5f0c" } } as Partial<CreationDto>),
        }),
      ),
    ).toBe("5f0c");
    expect(
      sessionRefOf(creation({ mediaAttributes: { session_id: "hex24" } })),
    ).toBe("hex24");
  });
});
