import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  directoryAuthorityMatches,
  directoryAuthorityToken,
  directoryRowsVisible,
  type DirectoryViewerPhase,
} from "../lib/agent-directory-authority";
import {
  AgentCacheAuthority,
  authIdentityChanged,
  paletteOwnedAgents,
  privateSearchAuthority,
  privateSearchAuthorityMatches,
} from "../components/shell/agent-cache-authority";

describe("selected-agent authentication refresh", () => {
  it("synchronously evicts A's cached private profile and refuses its delayed response", () => {
    const authority = new AgentCacheAuthority();
    const cache = new Map([["private-a", { owner: "viewer-a" }]]);
    const viewerARequest = authority.token();

    authority.invalidate(cache);

    expect(cache.size).toBe(0);
    expect(authority.admits(viewerARequest)).toBe(false);
    expect(authority.admits(authority.token())).toBe(true);
  });

  it("distinguishes the first Clerk observation from later subject changes", () => {
    expect(authIdentityChanged(undefined, "clerk-a")).toBe(false);
    expect(authIdentityChanged("clerk-a", "clerk-a")).toBe(false);
    expect(authIdentityChanged("clerk-a", null)).toBe(true);
    expect(authIdentityChanged("clerk-a", "clerk-b")).toBe(true);
  });

  it("rejects a viewer-A response admitted before Clerk switches to B", () => {
    const authority = new AgentCacheAuthority();
    const admittedA = authority.token();
    authority.invalidate(new Map());
    expect(authority.admits(admittedA)).toBe(false);
    // Clerk subjects and Eden account IDs deliberately differ; the generation
    // fence, not cross-namespace equality, rejects the old response.
    expect("user_clerk_b").not.toBe("db1d42a1-e25b-4e17-bc8c-f9ed36cd57bd");
  });

  it("synchronously hides command-palette private results across auth transitions", () => {
    const admitted = privateSearchAuthority("viewer-a", "ready", 4);
    expect(admitted).toEqual({ viewerId: "viewer-a", generation: 4 });
    if (!admitted) throw new Error("test search authority was not admitted");
    expect(privateSearchAuthorityMatches(admitted, "viewer-a", "ready", 4)).toBe(true);
    expect(privateSearchAuthorityMatches(admitted, "viewer-b", "ready", 5)).toBe(false);
    expect(privateSearchAuthorityMatches(admitted, null, "signed_out", 5)).toBe(false);
    expect(privateSearchAuthorityMatches(admitted, "viewer-a", "error", 5)).toBe(false);
    expect(privateSearchAuthority(null, "loading", 5)).toBeNull();
  });

  it("hides old owned-agent palette rows until the replacement inventory is ready", () => {
    const viewerAAgents = [{ username: "private-a" }];
    expect(paletteOwnedAgents(viewerAAgents, "loading")).toEqual([]);
    expect(paletteOwnedAgents(viewerAAgents, "error")).toEqual([]);
    expect(paletteOwnedAgents(viewerAAgents, "ready")).toBe(viewerAAgents);
    expect(paletteOwnedAgents(null, "ready")).toEqual([]);
    expect(paletteOwnedAgents(viewerAAgents, "ready", "error")).toEqual([]);
    expect(paletteOwnedAgents(viewerAAgents, "ready", "signed_out")).toEqual([]);
  });

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
    const invalidation = source.slice(
      source.indexOf("const invalidateViewerCustody"),
      source.indexOf("  // Clerk copies", source.indexOf("const invalidateViewerCustody")),
    );
    for (const required of [
      "cacheAuthority.current.invalidate(agentCache);",
      "setAgent(null);",
      'setPhase((current) => (current === "idle" ? "idle" : "loading"));',
      "setMyAgents(null);",
      'setMyAgentsPhase("loading");',
      "setAgentNonce((nonce) => nonce + 1);",
      "setMyAgentsNonce((nonce) => nonce + 1);",
    ]) {
      expect(invalidation).toContain(required);
    }

    expect(source.match(/onDevUserChange\(/g)).toHaveLength(1);
    expect(source).toContain("clerk.addListener?.(apply)");
    expect(source).toContain("authIdentityChanged(previous, identity)");
    expect(source).toContain("previous === undefined || authIdentityChanged(previous, identity)");
    expect(source).toContain("const authority = cacheAuthority.current.token();");
    expect(source).toContain("!cancelled && cacheAuthority.current.admits(authority)");
    expect(source).not.toContain("authIdentitiesConflict(");
    expect(source).toMatch(
      /const identity = user\?\.id \?\? null;\s*const previous = resolvedViewerIdentityRef\.current;\s*resolvedViewerIdentityRef\.current = identity;\s*if \(authIdentityChanged\(previous, identity\)\) \{[\s\S]*cacheAuthority\.current\.invalidate\(agentCache\);[\s\S]*setAgent\(null\);/,
    );
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
    expect(source).toContain('const privateAuthorityReady = viewerPhase === "ready";');
    expect(source).toContain("const visibleAgent = privateAuthorityReady ? agent : null;");
    expect(source).toContain("const visibleViewer = privateAuthorityReady ? viewer : null;");
    expect(source).toMatch(
      /if \(!viewerResolved\) return;\s*if \(viewerPhase !== "ready"\) \{[\s\S]*return;\s*\}\s*if \(viewer === null\) \{\s*setMyAgents\(\[\]\);\s*setMyAgentsPhase\("ready"\);\s*return;\s*\}\s*let cancelled = false;\s*const authority = cacheAuthority\.current\.token\(\);\s*void \(async \(\) => \{\s*try \{\s*const page = await api\.agents\.list\(\{ scope: "mine" \}\);/,
    );
    expect(source.match(/cacheAuthority\.current\.admits\(authority\)/g)).toHaveLength(6);
    expect(source).toMatch(
      /status === 401 \|\| status === 403[\s\S]*agentCache\.delete\(username\);[\s\S]*setAgent\(null\);[\s\S]*setPhase\("error"\);/,
    );
    const ordinaryRefresh = source.slice(
      source.indexOf("const refreshAgent = useCallback"),
      source.indexOf("const refreshMyAgents = useCallback"),
    );
    expect(ordinaryRefresh).toContain("setAgentNonce((n) => n + 1);");
    expect(ordinaryRefresh).not.toContain("agentCache.delete(username)");

    const palette = await readFile(
      new URL("../components/shell/command-palette.tsx", import.meta.url),
      "utf8",
    );
    expect(palette).toContain("const { agents, phase: agentsPhase } = useMyAgents();");
    expect(palette).toContain("agents: paletteOwnedAgents(agents, agentsPhase, viewerPhase),");
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
