import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("selected-agent authentication refresh", () => {
  it("refreshes viewer authority and owned agents after dev impersonation", async () => {
    const source = await readFile(
      new URL("../components/shell/selected-agent-context.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('import { api, onDevUserChange } from "@/lib/api"');
    expect(source).toMatch(
      /onDevUserChange\(\(user\) => \{\s*setViewer\(user\);\s*setMyAgentsPhase\("loading"\);\s*setMyAgentsNonce\(\(nonce\) => nonce \+ 1\);/,
    );

    expect(source.match(/onDevUserChange\(/g)).toHaveLength(1);
  });
});
