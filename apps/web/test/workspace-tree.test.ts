import { describe, expect, it } from "vitest";

import {
  buildWorkspaceTree,
  formatBytes,
  isImagePath,
} from "@/components/agents/workspace-tree";
import type { WorkspaceFileEntry } from "@/lib/types";

function entry(
  path: string,
  kind: "file" | "dir",
  overrides: Partial<WorkspaceFileEntry> = {},
): WorkspaceFileEntry {
  return { path, kind, sizeBytes: 10, mtime: "2026-07-10T00:00:00.000Z", ...overrides };
}

describe("buildWorkspaceTree", () => {
  it("nests entries with folders first, alphabetical", () => {
    const tree = buildWorkspaceTree([
      entry("zebra.md", "file"),
      entry("art", "dir"),
      entry("art/plan.md", "file"),
      entry("art/drafts", "dir"),
      entry("art/drafts/v1.md", "file"),
      entry("alpha.md", "file"),
    ]);
    expect(tree.map((n) => n.path)).toEqual(["art", "alpha.md", "zebra.md"]);
    const art = tree[0]!;
    expect(art.kind).toBe("dir");
    expect(art.children.map((n) => n.path)).toEqual(["art/drafts", "art/plan.md"]);
    expect(art.children[0]!.children.map((n) => n.path)).toEqual(["art/drafts/v1.md"]);
  });

  it("synthesizes missing parent directories for deep files", () => {
    const tree = buildWorkspaceTree([entry("memory/users/alice.md", "file")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.path).toBe("memory");
    expect(tree[0]!.kind).toBe("dir");
    expect(tree[0]!.children[0]!.path).toBe("memory/users");
    expect(tree[0]!.children[0]!.children[0]!.path).toBe("memory/users/alice.md");
  });

  it("keeps file metadata (size, mtime, sha256)", () => {
    const tree = buildWorkspaceTree([
      entry("notes.md", "file", { sizeBytes: 42, sha256: "abc" }),
    ]);
    expect(tree[0]).toMatchObject({ sizeBytes: 42, sha256: "abc", kind: "file" });
  });
});

describe("formatBytes", () => {
  it("formats across magnitudes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(412)).toBe("412 B");
    expect(formatBytes(3276)).toBe("3.2 KB");
    expect(formatBytes(1024 * 1024 * 1.8)).toBe("1.8 MB");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("isImagePath", () => {
  it("detects inline-renderable images by extension", () => {
    expect(isImagePath("art/pic.png")).toBe(true);
    expect(isImagePath("PIC.JPG")).toBe(true);
    expect(isImagePath("notes.md")).toBe(false);
    expect(isImagePath("no-extension")).toBe(false);
  });
});
