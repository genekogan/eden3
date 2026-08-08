import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Design-token floor: UI colors come from the @theme tokens in
 * app/globals.css (background/surface/raised/edge/foreground/muted/faint,
 * accent/accent-soft, success/warning/danger[-soft]) so the light theme can
 * re-resolve every class. Hardcoded Tailwind palette classes and raw
 * white-alpha overlays break theming — this test keeps them out for good.
 */

const ROOTS = ["app", "components"];
const BANNED =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|shadow|accent|caret|decoration)-(?:emerald|rose|red|amber|zinc|slate|gray|neutral|stone|lime|teal|cyan|sky|indigo|violet|purple|fuchsia|pink)-[0-9]{2,3}\b|\bwhite\/\[/;

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collect(path, out);
    else if (/\.(tsx|ts)$/.test(entry) && !/\.test\./.test(entry)) out.push(path);
  }
  return out;
}

describe("design tokens", () => {
  it("no hardcoded palette classes or white-alpha overlays in app/ + components/", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of collect(root)) {
        const source = readFileSync(file, "utf8");
        const lines = source.split("\n");
        lines.forEach((line, index) => {
          if (BANNED.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
