import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaFull, isAudioMedia, isVideoMedia } from "../components/media";
import { AttachmentLightbox, MessageRow } from "../components/chat/message-bubble";
import type { MessageDto } from "../lib/types";

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

  it("reserves the persisted attachment dimensions before the image loads", () => {
    const html = renderToStaticMarkup(
      <MediaFull
        url="/media/dog.png"
        mime="image/png"
        alt="dog eating cheese"
        width={1024}
        height={768}
      />,
    );
    expect(html).toContain("aspect-ratio:1024 / 768");
    expect(html).toContain('src="/media/dog.png"');
  });

  it("renders a persisted chat creation as an image, not a link-only zero-height row", () => {
    const message: MessageDto = {
      id: "00000000-0000-4000-8000-000000000001",
      externalId: null,
      sessionId: "00000000-0000-4000-8000-000000000002",
      senderId: "00000000-0000-4000-8000-000000000003",
      role: "assistant",
      content: "Done.",
      attachments: [{
        url: "/media/dog.png",
        mime: "image/png",
        creationId: "00000000-0000-4000-8000-000000000004",
        width: 1024,
        height: 768,
      }],
      toolCalls: null,
      reactions: null,
      replyToExternalId: null,
      createdAt: "2026-08-11T21:51:35.073Z",
    };
    const html = renderToStaticMarkup(
      <MessageRow message={message} sender={null} showAvatar={false} />,
    );
    expect(html).toContain('src="/media/dog.png"');
    expect(html).toContain("aspect-ratio:1024 / 768");
    expect(html).toContain('aria-label="View attachment larger"');
    expect(html).toContain("View larger");
    expect(html).toContain('download="eden3-00000000-0000-4000-8000-000000000004.png"');
    expect(html).not.toContain('/creations/00000000-0000-4000-8000-000000000004');
  });

  it("renders a focused media viewer with an in-place image and download action", () => {
    const html = renderToStaticMarkup(
      <AttachmentLightbox
        attachment={{
          url: "/media/dog.png",
          mime: "image/png",
          creationId: "00000000-0000-4000-8000-000000000004",
          width: 1024,
          height: 768,
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('src="/media/dog.png"');
    expect(html).toContain('aria-label="Close media viewer"');
    expect(html).toContain('download="eden3-00000000-0000-4000-8000-000000000004.png"');
  });
});
