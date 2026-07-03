import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import type { StudioTool } from "../lib/types";
import {
  FALLBACK_TOOLS,
  buildArgs,
  categorizeTool,
  describeFailure,
  durationSpec,
  isAudioResult,
  promptKey,
  sortTools,
  toolLabel,
} from "../components/studio/catalog";

const tool = (overrides: Partial<StudioTool> & { name: string }): StudioTool =>
  ({ ...overrides }) as StudioTool;

describe("studio catalog", () => {
  it("categorizes the canonical toolkit by name", () => {
    expect(categorizeTool(tool({ name: "image_generate" }))).toBe("image");
    expect(categorizeTool(tool({ name: "video_generate" }))).toBe("video");
    expect(categorizeTool(tool({ name: "music_generate" }))).toBe("music");
    expect(categorizeTool(tool({ name: "tts" }))).toBe("speech");
  });

  it("falls back to outputType, then other", () => {
    expect(
      categorizeTool(tool({ name: "flux", outputType: "image" })),
    ).toBe("image");
    expect(
      categorizeTool(tool({ name: "banger", outputType: "audio" })),
    ).toBe("music");
    expect(categorizeTool(tool({ name: "mystery" }))).toBe("other");
  });

  it("sorts tools into the display order image/video/music/speech", () => {
    const shuffled = [
      tool({ name: "tts" }),
      tool({ name: "music_generate" }),
      tool({ name: "image_generate" }),
      tool({ name: "video_generate" }),
    ];
    expect(sortTools(shuffled).map((t) => t.name)).toEqual([
      "image_generate",
      "video_generate",
      "music_generate",
      "tts",
    ]);
  });

  it("labels canonical tools and tidies unknown names", () => {
    expect(toolLabel(tool({ name: "image_generate" }))).toBe("Image");
    expect(toolLabel(tool({ name: "tts" }))).toBe("Speech");
    expect(toolLabel(tool({ name: "pixel_art_generate" }))).toBe("Pixel Art");
  });

  it("ships a 4-tool fallback catalog with PLAN.md pricing", () => {
    expect(FALLBACK_TOOLS.map((t) => [t.name, t.costManna])).toEqual([
      ["image_generate", 5],
      ["video_generate", 25],
      ["music_generate", 10],
      ["tts", 2],
    ]);
  });

  it("picks the prompt key from the schema, defaulting speech to text", () => {
    expect(promptKey(tool({ name: "image_generate" }))).toBe("prompt");
    expect(promptKey(tool({ name: "tts" }))).toBe("text");
    expect(
      promptKey(
        tool({
          name: "tts",
          parameters: { properties: { prompt: { type: "string" } } },
        }),
      ),
    ).toBe("prompt");
  });

  it("exposes a duration spec only when the schema has one", () => {
    expect(durationSpec(tool({ name: "image_generate" }))).toBeNull();
    const video = tool({
      name: "video_generate",
      parameters: {
        properties: {
          prompt: { type: "string" },
          duration: { type: "number", minimum: 2, maximum: 30, default: 5 },
        },
      },
    });
    expect(durationSpec(video)).toEqual({ min: 2, max: 30, defaultValue: 5 });
  });

  it("builds args with trimmed prompt and optional duration", () => {
    const video = tool({
      name: "video_generate",
      parameters: { properties: { duration: { type: "number" } } },
    });
    expect(buildArgs(video, "  a slow tide  ", "12")).toEqual({
      prompt: "a slow tide",
      duration: 12,
    });
    expect(buildArgs(video, "a slow tide", "")).toEqual({
      prompt: "a slow tide",
    });
    // No duration in the schema -> never sent, even if typed.
    expect(buildArgs(tool({ name: "image_generate" }), "a rose", "9")).toEqual({
      prompt: "a rose",
    });
  });

  it("detects audio results by extension, then by category", () => {
    expect(isAudioResult("/media/ab/cd.mp3", "image")).toBe(true);
    expect(isAudioResult("https://cdn.example.com/x.png?sig=1", "music")).toBe(
      false,
    );
    expect(isAudioResult("/media/ab/cd", "music")).toBe(true);
    expect(isAudioResult("/media/ab/cd", "image")).toBe(false);
  });

  it("maps failures to user-facing copy", () => {
    const missing = describeFailure(new ApiError(501, "501 /studio/generate"));
    expect(missing.missing).toBe(true);
    expect(missing.refunded).toBe(false);

    const broke = describeFailure(
      new ApiError(402, "402 /studio/generate", { message: "insufficient manna" }),
    );
    expect(broke.insufficient).toBe(true);
    expect(broke.detail).toBe("insufficient manna");

    const failed = describeFailure(
      new ApiError(500, "500 /studio/generate", { message: "tool exploded" }),
    );
    expect(failed.refunded).toBe(true);
    expect(failed.detail).toBe("tool exploded");

    const network = describeFailure(new TypeError("fetch failed"));
    expect(network.title).toBe("Connection lost");
  });
});
