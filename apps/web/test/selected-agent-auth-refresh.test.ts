import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("selected-agent authentication refresh", () => {
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
});
