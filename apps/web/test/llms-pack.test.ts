import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const readPublic = (name: string) =>
  readFileSync(resolve(WEB_ROOT, "public", name), "utf8");

const llms = readPublic("llms.txt");
const full = readPublic("llms-full.txt");
const overview = readPublic("eden-overview.md");
const publishedPack = [llms, full, overview].join("\n");

describe("LLM legibility pack", () => {
  it("ships discoverable root documents and explicit link metadata", () => {
    const layout = readFileSync(resolve(WEB_ROOT, "app/layout.tsx"), "utf8");
    expect(llms).toContain("/llms-full.txt");
    expect(llms).toContain("/eden-overview.md");
    expect(full).toContain("/llms.txt");
    expect(layout).toContain('rel="alternate"');
    expect(layout).toContain('href="/llms.txt"');
    expect(layout).toContain('href="/llms-full.txt"');
  });

  it.each([
    "Availability",
    "Privacy",
    "Agents and chat",
    "Media, usage, and channels",
    "Guidance",
  ])("covers %s", (heading) => {
    expect(full).toContain(`## ${heading}`);
  });

  it("states the prototype boundary without implying a public launch", () => {
    for (const document of [llms, full, overview]) {
      expect(document.toLowerCase()).toMatch(/working prototype|in-progress checkpoint/);
      expect(document.toLowerCase()).toMatch(/not (?:a )?(?:production|production-ready)/);
    }
    expect(full).toContain("not a production-readiness, public-launch, or legacy-migration claim");
  });

  it("links only to declared safe public product paths and reference files", () => {
    expect(publishedPack).not.toMatch(/https?:\/\/(?!example\.invalid)/);
  });

  it("omits sensitive implementation and credential vocabulary", () => {
    const prohibited = [
      /\blocalhost\b/i,
      /\b(?:postgres|mongodb|docker)\b/i,
      /\b(?:clerk|privy)\b/i,
      /\b(?:api|secret|encryption|vault)[_-](?:key|token|secret)\b/i,
      /\b(?:database|schema) migration\b/i,
      /\bapps\/(?:api|web)\b/i,
      /\bpackages\//i,
      /\b(?:exploit|bypass|attack path)\b/i,
      /(?:^|[^\d]):\d{2,5}\b/,
      /\b(?:127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)\b/,
    ];
    for (const pattern of prohibited) expect(publishedPack).not.toMatch(pattern);
  });
});
