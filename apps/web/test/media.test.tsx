import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaFull, isAudioMedia, isVideoMedia } from "../components/media";

describe("media rendering", () => {
  it("classifies video and audio media by mime or extension", () => {
    expect(isVideoMedia("/media/a/movie.mp4?sig=1")).toBe(true);
    expect(isVideoMedia("/media/a/file.bin", "video/webm")).toBe(true);
    expect(isVideoMedia("/media/a/sound.mp3")).toBe(false);

    expect(isAudioMedia("/media/a/sound.mp3#t=1")).toBe(true);
    expect(isAudioMedia("/media/a/file.bin", "audio/mpeg")).toBe(true);
    expect(isAudioMedia("/media/a/movie.mp4")).toBe(false);
  });

  it("renders full media with the correct native element", () => {
    expect(renderToStaticMarkup(<MediaFull url="/media/a/image.png" alt="image" />)).toContain(
      "<img",
    );
    expect(
      renderToStaticMarkup(
        <MediaFull url="/media/a/video.bin" mime="video/mp4" alt="video" />,
      ),
    ).toContain("<video");
    expect(
      renderToStaticMarkup(
        <MediaFull url="/media/a/audio.bin" mime="audio/mpeg" alt="audio" />,
      ),
    ).toContain("<audio");
  });
});
