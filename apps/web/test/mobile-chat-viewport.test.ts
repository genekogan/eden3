import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const layout = readFileSync(
  fileURLToPath(new URL("../app/agents/[username]/chats/layout.tsx", import.meta.url)),
  "utf8",
);

function hasMobileViewportContract(source: string): boolean {
  return (
    source.includes("h-[calc(100dvh-3.5rem-var(--eden-safe-top)-var(--eden-safe-bottom))]") &&
    source.includes("sm:h-[calc(100dvh-var(--eden-safe-top)-var(--eden-safe-bottom))]") &&
    !source.includes('className="flex h-dvh min-w-0"')
  );
}

describe("agent chat viewport", () => {
  it("subtracts the mobile header and both safe-area insets at every width", () => {
    expect(hasMobileViewportContract(layout)).toBe(true);
    for (const [from, to] of [
      ["-var(--eden-safe-top)", ""],
      ["-var(--eden-safe-bottom)", ""],
    ] as const) {
      expect(hasMobileViewportContract(layout.replace(from, to))).toBe(false);
    }
  });
});
