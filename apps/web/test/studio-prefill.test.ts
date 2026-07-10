import { describe, expect, it } from "vitest";

import {
  studioPrefillFromSearch,
  studioRemixHref,
} from "../components/studio/prefill";

describe("studio prefill links", () => {
  it("builds remix links from creation prompts", () => {
    expect(
      studioRemixHref({
        tool: "image_generate",
        prompt: "  glass city at dawn  ",
      }),
    ).toBe("/studio?tool=image_generate&prompt=glass+city+at+dawn");
  });

  it("falls back to image generation for legacy creation tools", () => {
    expect(studioRemixHref({ tool: "create", prompt: "old eden prompt" })).toBe(
      "/studio?tool=image_generate&prompt=old+eden+prompt",
    );
    expect(studioRemixHref({ tool: "image_generate", prompt: " " })).toBeNull();
  });

  it("parses prompt, text, tool, and duration params for the Studio view", () => {
    expect(
      studioPrefillFromSearch("?tool=video_generate&prompt=wave&duration=8"),
    ).toEqual({ tool: "video_generate", prompt: "wave", duration: "8" });
    expect(studioPrefillFromSearch("?tool=unknown&text=hello")).toEqual({
      tool: null,
      prompt: "hello",
      duration: "",
    });
  });
});
