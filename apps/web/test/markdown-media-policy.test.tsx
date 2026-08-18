import { readFileSync } from "node:fs";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "../components/chat/markdown";
import { isAllowedMarkdownImageSource } from "../components/chat/markdown-media-policy";

const OBJECT_ID = "018f47a2-0d31-7c0d-8fa2-111111111111";
const SHARE_TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEF";

function renderImage(source: string, alt = "probe"): string {
  return renderToStaticMarkup(<Markdown text={`![${alt}](${source})`} />);
}

describe("Markdown media policy", () => {
  it.each([
    `/media/${OBJECT_ID}`,
    `/media/share/${SHARE_TOKEN}/${OBJECT_ID}`,
  ])("renders a policy-owned image source: %s", (source) => {
    expect(isAllowedMarkdownImageSource(source)).toBe(true);
    const html = renderImage(source);
    expect(html).toContain("<img");
    expect(html).toContain(`src=\"${source.replaceAll("&", "&amp;")}\"`);
  });

  it.each([
    "https://tracker.example/viewer-id.png",
    "http://127.0.0.1:18789/private",
    "http://localhost/private",
    "http://[::1]/private",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/private",
    "http://172.16.0.1/private",
    "http://192.168.0.1/private",
    "//tracker.example/pixel.png",
    "data:image/svg+xml,<svg/>",
    "blob:https://eden.example/id",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pass@cdn.example.invalid/image.png",
    "https://media-one.example.invalid:444/image.png",
    "https://media-one.example.invalid/image.png#fragment",
    "https://media-one.example.invalid.evil.example/image.png",
    "/media/not-a-uuid",
    `/media/${OBJECT_ID}?redirect=https://tracker.example`,
    `/media/share/${SHARE_TOKEN}/not-a-uuid`,
    "/%6dedia/018f47a2-0d31-7c0d-8fa2-111111111111",
    "https:%2f%2ftracker.example/pixel.png",
  ])("renders an untrusted image source inertly: %s", (source) => {
    expect(isAllowedMarkdownImageSource(source)).toBe(false);
    const html = renderImage(source, "blocked image");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("href=");
  });

  it("keeps ordinary blocked-image alt text inert and visible", () => {
    const html = renderImage("https://tracker.example/pixel.png", "blocked image");
    expect(html).toContain("blocked image");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("href=");
  });

  it("rejects malformed and noncanonical lifecycle capabilities", () => {
    expect(isAllowedMarkdownImageSource("")).toBe(false);
    expect(isAllowedMarkdownImageSource(`/media/share/short/${OBJECT_ID}`)).toBe(false);
    expect(isAllowedMarkdownImageSource(`/media/${OBJECT_ID}/extra`)).toBe(false);
    expect(isAllowedMarkdownImageSource(` /media/${OBJECT_ID}`)).toBe(false);
    expect(isAllowedMarkdownImageSource("x".repeat(4097))).toBe(false);
  });

  it("keeps every untrusted agent-text surface on the shared Markdown policy", () => {
    const messageBubble = readFileSync(
      new URL("../components/chat/message-bubble.tsx", import.meta.url),
      "utf8",
    );
    const newChat = readFileSync(
      new URL("../components/chat/new-chat.tsx", import.meta.url),
      "utf8",
    );
    const publicShare = readFileSync(
      new URL("../app/share/[token]/page.tsx", import.meta.url),
      "utf8",
    );

    expect(messageBubble.match(/<Markdown text=/g)).toHaveLength(2);
    expect(messageBubble).toMatch(/export function MessageRow[\s\S]*<Markdown text=\{assistantText\}/);
    expect(messageBubble).toMatch(/export function StreamBubble[\s\S]*<Markdown text=\{item\.text\}/);
    expect(newChat).toMatch(/agent\.greeting[\s\S]*<Markdown text=\{agent\.greeting\}/);
    expect(publicShare).toMatch(/message\.role === "assistant"[\s\S]*<Markdown text=\{message\.content\}/);
  });
});
