import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  directoryAuthorityMatches,
  directoryAuthorityToken,
  directoryRowsVisible,
  type DirectoryViewerPhase,
} from "../lib/agent-directory-authority";

describe("selected-agent authentication refresh", () => {
  it.each<DirectoryViewerPhase>(["loading", "signed_out", "error"])(
    "does not admit scope=mine requests while viewer authority is %s",
    (phase) => {
      expect(directoryAuthorityToken("viewer-a", phase, 1)).toBeNull();
    },
  );

  it("rejects delayed page and load-more responses after sign-out or A-to-B", () => {
    const admitted = directoryAuthorityToken("viewer-a", "ready", 7);
    expect(admitted).toEqual({ viewerId: "viewer-a", generation: 7 });
    if (!admitted) throw new Error("test authority was not admitted");

    expect(directoryAuthorityMatches(admitted, "viewer-a", "ready", 7)).toBe(true);
    expect(directoryAuthorityMatches(admitted, null, "signed_out", 8)).toBe(false);
    expect(directoryAuthorityMatches(admitted, "viewer-b", "ready", 8)).toBe(false);
    expect(directoryAuthorityMatches(admitted, "viewer-a", "error", 8)).toBe(false);
    expect(directoryAuthorityMatches(admitted, "viewer-a", "ready", 8)).toBe(false);
    expect(directoryRowsVisible("viewer-a", null, "signed_out", false)).toBe(false);
    expect(directoryRowsVisible("viewer-a", "viewer-b", "ready", false)).toBe(false);
    expect(directoryRowsVisible("viewer-a", "viewer-a", "error", false)).toBe(false);
    expect(directoryRowsVisible("viewer-a", "viewer-a", "ready", true)).toBe(false);
    expect(directoryRowsVisible("viewer-a", "viewer-a", "ready", false)).toBe(true);
  });

  it("refreshes viewer authority and owned agents after dev impersonation", async () => {
    const source = await readFile(
      new URL("../components/shell/selected-agent-context.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      'onAgentInventoryChange,\n  onDevUserChange,\n} from "@/lib/api"',
    );
    expect(source).toMatch(
      /onDevUserChange\(\(user\) => \{\s*setViewer\(user\);\s*setViewerResolved\(true\);\s*setViewerPhase\(user \? "ready" : "signed_out"\);\s*setMyAgentsPhase\("loading"\);\s*setMyAgentsNonce\(\(nonce\) => nonce \+ 1\);/,
    );

    expect(source.match(/onDevUserChange\(/g)).toHaveLength(1);
    expect(source).toContain('import { loadClerk, selectAuthMode } from "@/lib/clerk"');
    expect(source).toMatch(
      /if \(selectAuthMode\(\) !== "clerk"\) return;[\s\S]*const imageUrl = clerk\.user\?\.imageUrl;[\s\S]*api\.account\.syncIdentityAvatar\(imageUrl\)/,
    );
    expect(source).toContain("const [viewerResolved, setViewerResolved] = useState(false);");
    expect(source).toContain('const [viewerPhase, setViewerPhase] = useState<ViewerPhase>("loading");');
    const viewerFetch = source.slice(
      source.indexOf("// ---- viewer"),
      source.indexOf("// ---- selected agent"),
    );
    const viewerError = viewerFetch.slice(viewerFetch.indexOf(".catch(() =>"));
    expect(viewerError).toContain('setViewerPhase("error")');
    expect(viewerError).not.toContain("setViewer(null)");
    expect(source).toMatch(
      /if \(!viewerResolved\) return;\s*if \(viewer === null\) \{\s*setMyAgents\(\[\]\);\s*setMyAgentsPhase\("ready"\);\s*return;\s*\}\s*let cancelled = false;\s*void \(async \(\) => \{\s*try \{\s*const page = await api\.agents\.list\(\{ scope: "mine" \}\);/,
    );
  });

  it("refreshes the owned-agent inventory after successful agent mutations", async () => {
    const contextSource = await readFile(
      new URL("../components/shell/selected-agent-context.tsx", import.meta.url),
      "utf8",
    );
    const apiSource = await readFile(new URL("../lib/api.ts", import.meta.url), "utf8");
    const selectorSource = await readFile(
      new URL("../components/shell/agent-selector.tsx", import.meta.url),
      "utf8",
    );

    expect(contextSource).toContain(
      'onAgentInventoryChange,\n  onDevUserChange,\n} from "@/lib/api"',
    );
    expect(contextSource).toMatch(
      /onAgentInventoryChange\(\(\) => \{\s*setMyAgentsPhase\("loading"\);\s*setMyAgentsNonce\(\(nonce\) => nonce \+ 1\);/,
    );
    expect(contextSource.match(/onAgentInventoryChange\(/g)).toHaveLength(1);

    const agentsClient = apiSource.slice(
      apiSource.indexOf("  agents: {"),
      apiSource.indexOf("\n  feed: {"),
    );
    expect(agentsClient.match(/emitAgentInventoryChange\(\);/g)).toHaveLength(5);
    for (const operation of [
      "async create",
      "async importBundle",
      "async update",
      "async uploadAvatar",
      "async removeAvatar",
    ]) {
      expect(agentsClient).toContain(operation);
    }

    expect(selectorSource).toContain(
      "const { agents, phase: myAgentsPhase } = useMyAgents();",
    );
    expect(selectorSource.indexOf('myAgentsPhase === "loading"')).toBeLessThan(
      selectorSource.indexOf("agents.length === 0"),
    );
    expect(selectorSource).toContain("Couldn’t load your agents.");
  });

  it("does not fetch or retain private directory rows without exact viewer authority", async () => {
    const source = await readFile(
      new URL("../components/agents/agents-directory.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("const { viewer, viewerPhase } = useSelectedAgent();");
    expect(source).toContain("directoryAuthorityToken(");
    expect(source.match(/directoryAuthorityMatches\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toMatch(
      /authorityGeneration\.current \+= 1;[\s\S]*setItems\(\[\]\);[\s\S]*setCursor\(null\);/,
    );
    expect(source).toContain(
      "refusedViewerId === viewer?.id ? null : directoryAuthorityToken(",
    );
    expect(source).toMatch(
      /if \(!token\) \{[\s\S]*viewerPhase === "loading"[\s\S]*viewerPhase === "error"[\s\S]*return;[\s\S]*api\.agents\.list/,
    );
    expect(source).toContain(
      'if (viewerPhase === "error" || locallyRefused) window.location.reload();',
    );
    expect(source).toContain("const rowsVisible = directoryRowsVisible(");
    expect(source).toContain("error.status === 401 || error.status === 403");
    expect(source.match(/setRefusedViewerId\(token\.viewerId\)/g)).toHaveLength(2);
  });
});
