import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MediaPendingBubble } from "../components/chat/message-bubble";

describe("chat media progress placeholder", () => {
  it("renders an image-shaped live status before the finished attachment", () => {
    const html = renderToStaticMarkup(
      <MediaPendingBubble
        item={{
          kind: "media-pending",
          clientId: "pending:1",
          tool: "image_generate",
          at: "2026-08-11T12:00:00.000Z",
        }}
        sender={null}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Creating your image…"');
    expect(html).toContain("aspect-square");
    expect(html).toContain("Creating your image…");
    expect(html).not.toContain("<img");
  });
});
