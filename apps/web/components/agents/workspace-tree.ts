import type { WorkspaceFileEntry } from "@/lib/types";

/**
 * Pure helpers for the workspace Files tab (agent-workspace.tsx): flat API
 * tree -> nested nodes (folders first, alphabetical), plus small presentation
 * utilities. No React — unit-tested in test/workspace-tree.test.ts.
 */

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  sizeBytes: number;
  mtime: string;
  sha256?: string;
  children: WorkspaceTreeNode[];
}

/**
 * Build the nested tree from the API's flat entries. Directories usually
 * arrive as their own entries; parents are still synthesized defensively so
 * a file like `a/b/c.md` never dangles. Ordering inside every folder is
 * directories first, then files, each alphabetical.
 */
export function buildWorkspaceTree(entries: WorkspaceFileEntry[]): WorkspaceTreeNode[] {
  const roots: WorkspaceTreeNode[] = [];
  const byPath = new Map<string, WorkspaceTreeNode>();

  const ensureDir = (path: string): WorkspaceTreeNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const name = path.split("/").at(-1) ?? path;
    const node: WorkspaceTreeNode = {
      name,
      path,
      kind: "dir",
      sizeBytes: 0,
      mtime: "",
      children: [],
    };
    byPath.set(path, node);
    siblingsOf(path).push(node);
    return node;
  };

  const siblingsOf = (path: string): WorkspaceTreeNode[] => {
    const slash = path.lastIndexOf("/");
    if (slash === -1) return roots;
    return ensureDir(path.slice(0, slash)).children;
  };

  for (const entry of entries) {
    if (entry.kind === "dir") {
      const node = ensureDir(entry.path);
      node.sizeBytes = entry.sizeBytes;
      node.mtime = entry.mtime;
      continue;
    }
    const name = entry.path.split("/").at(-1) ?? entry.path;
    const node: WorkspaceTreeNode = {
      name,
      path: entry.path,
      kind: "file",
      sizeBytes: entry.sizeBytes,
      mtime: entry.mtime,
      ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}),
      children: [],
    };
    byPath.set(entry.path, node);
    siblingsOf(entry.path).push(node);
  }

  const sort = (nodes: WorkspaceTreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

/** "412 B", "3.2 KB", "1.8 MB" — file rows and the binary card. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1).replace(/\.0$/, "")} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, "")} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1).replace(/\.0$/, "")} GB`;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"]);

/** Files the viewer renders inline as an <img> via the download URL. */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
