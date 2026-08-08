"use client";

/**
 * Files tab on /agents/[username] (owner/admin only, like Memory) — a friendly
 * file manager over the agent's OpenClaw workspace. Left: collapsible tree
 * (folders first). Right: viewer — text files open in a monospace editor with
 * conflict-safe saves (the API rejects a save when the agent changed the file
 * meanwhile; we surface a reload/keep-editing choice, never silently
 * overwrite), images render inline, binaries get a quiet download card.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type {
  WorkspaceFileEntry,
  WorkspaceWriteConflict,
} from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/skeleton";
import { describeApiFailure } from "@/components/agents/agent-utils";
import {
  primaryButtonClass,
  quietButtonClass,
} from "@/components/agents/form-fields";
import {
  buildWorkspaceTree,
  formatBytes,
  isImagePath,
  type WorkspaceTreeNode,
} from "@/components/agents/workspace-tree";
import { formatRelativeTime } from "@/lib/format";
import { DoctrineOwnershipNotice } from "@/components/agents/doctrine-ownership-notice";
import {
  doctrineFileOwnership,
  type DoctrineSyncState,
} from "@/lib/doctrine-file-ownership";

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-3.5 shrink-0 text-faint"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Tree column
// ---------------------------------------------------------------------------

function TreeRows({
  nodes,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  nodes: WorkspaceTreeNode[];
  depth: number;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: WorkspaceTreeNode) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => {
        const isOpen = expanded.has(node.path);
        const isSelected = selected === node.path;
        return (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => (node.kind === "dir" ? onToggle(node.path) : onSelect(node))}
              title={node.path}
              className={`flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-[13px] transition-colors ${
                isSelected
                  ? "bg-accent/15 text-foreground"
                  : "text-muted hover:bg-white/5 hover:text-foreground"
              }`}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
            >
              {node.kind === "dir" ? <ChevronIcon open={isOpen} /> : <FileIcon />}
              <span className="truncate">{node.name}</span>
            </button>
            {node.kind === "dir" && isOpen ? (
              <TreeRows
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// File viewer
// ---------------------------------------------------------------------------

type ViewerState =
  | { kind: "idle" }
  | { kind: "loading"; path: string }
  | { kind: "error"; path: string; text: string }
  | { kind: "image"; path: string; sizeBytes: number; mtime: string }
  | { kind: "binary"; path: string; sizeBytes: number; mtime: string }
  | {
      kind: "text";
      path: string;
      draft: string;
      loadedContent: string;
      baseSha256: string;
      doctrineRevision?: number;
      doctrineSyncState?: "synced" | "conflict";
      sizeBytes: number;
      mtime: string;
    };

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function AgentWorkspacePanel({
  username,
  canManage,
}: {
  username: string;
  canManage: boolean;
}) {
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<ViewerState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [conflict, setConflict] = useState<WorkspaceWriteConflict | null>(null);
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const treeSeq = useRef(0);
  const fileSeq = useRef(0);

  const loadTree = useCallback(async () => {
    const id = ++treeSeq.current;
    setPhase("loading");
    try {
      const data = await api.agents.workspaceTree(username);
      if (treeSeq.current !== id) return;
      setEntries(data.entries);
      setTruncated(data.truncated);
      setPhase("ready");
    } catch (error) {
      if (treeSeq.current !== id) return;
      setErrorText(describeApiFailure(error));
      setPhase("error");
    }
  }, [username]);

  useEffect(() => {
    // New agent -> drop any file from the previous one before refetching.
    setViewer({ kind: "idle" });
    setConflict(null);
    setNote(null);
    if (!canManage) return;
    void loadTree();
  }, [canManage, loadTree]);

  const openFile = useCallback(
    async (node: WorkspaceTreeNode) => {
      setNote(null);
      setConflict(null);
      setActionError(null);
      if (isImagePath(node.path)) {
        setViewer({ kind: "image", path: node.path, sizeBytes: node.sizeBytes, mtime: node.mtime });
        return;
      }
      const id = ++fileSeq.current;
      setViewer({ kind: "loading", path: node.path });
      try {
        const { file } = await api.agents.workspaceFile(username, node.path);
        if (fileSeq.current !== id) return;
        if (file.kind === "binary") {
          setViewer({ kind: "binary", path: file.path, sizeBytes: file.sizeBytes, mtime: file.mtime });
        } else {
          setViewer({
            kind: "text",
            path: file.path,
            draft: file.content,
            loadedContent: file.content,
            baseSha256: file.sha256,
            doctrineRevision: file.doctrineRevision,
            doctrineSyncState: file.doctrineSyncState,
            sizeBytes: file.sizeBytes,
            mtime: file.mtime,
          });
        }
      } catch (error) {
        if (fileSeq.current !== id) return;
        setViewer({ kind: "error", path: node.path, text: describeApiFailure(error) });
      }
    },
    [username],
  );

  const save = async () => {
    if (viewer.kind !== "text" || saving) return;
    setSaving(true);
    setNote(null);
    setActionError(null);
    try {
      const { file } = await api.agents.workspaceSave(username, {
        path: viewer.path,
        content: viewer.draft,
        baseSha256: viewer.baseSha256,
        ...(viewer.path === "SOUL.md" ? { baseRevision: viewer.doctrineRevision } : {}),
      });
      if (
        viewer.path === "SOUL.md" &&
        (file.doctrineRevision === undefined || file.doctrineSyncState === undefined)
      ) {
        throw new Error(
          "SOUL.md saved but revision confirmation was unavailable; reload the file.",
        );
      }
      setViewer({
        ...viewer,
        loadedContent: viewer.draft,
        baseSha256: file.sha256,
        doctrineRevision: file.doctrineRevision,
        doctrineSyncState: file.doctrineSyncState,
        sizeBytes: file.sizeBytes,
        mtime: file.mtime,
      });
      setConflict(null);
      setNote(
        viewer.path === "SOUL.md"
          ? "Saved and synced with Settings → Persona."
          : "Saved.",
      );
      void loadTree();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const body = (error.body ?? {}) as Partial<WorkspaceWriteConflict> & {
          error?: { code?: string };
        };
        if (body.error?.code === "workspace_sync_busy") {
          setActionError("The agent is finishing a Settings sync. Retry Save in a moment.");
        } else {
          setConflict({
            currentSha256: body.currentSha256 ?? null,
            currentMtime: body.currentMtime ?? null,
            currentRevision: body.currentRevision,
          });
        }
      } else {
        setActionError(describeApiFailure(error));
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadTheirs = async () => {
    if (viewer.kind !== "text") return;
    setConflict(null);
    await openFile({
      name: viewer.path,
      path: viewer.path,
      kind: "file",
      sizeBytes: viewer.sizeBytes,
      mtime: viewer.mtime,
      children: [],
    });
  };

  const keepEditing = () => {
    if (viewer.kind !== "text" || conflict === null) return;
    // Informed choice: the next explicit Save replaces the agent's version.
    if (conflict.currentSha256) {
      setViewer({
        ...viewer,
        baseSha256: conflict.currentSha256,
        ...(conflict.currentRevision !== undefined
          ? { doctrineRevision: conflict.currentRevision }
          : {}),
      });
    }
    setConflict(null);
    setNote("Still editing your version — Save again to replace theirs.");
  };

  const download = async (path: string) => {
    setActionError(null);
    try {
      saveBlob(await api.agents.workspaceDownload(username, path), path.split("/").at(-1) ?? path);
    } catch (error) {
      setActionError(describeApiFailure(error));
    }
  };

  const exportZip = async () => {
    if (exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      saveBlob(await api.agents.workspaceExport(username), `${username}-workspace.zip`);
    } catch (error) {
      setActionError(describeApiFailure(error));
    } finally {
      setExporting(false);
    }
  };

  if (!canManage) {
    return (
      <EmptyState
        title="Files are private"
        hint="Only the owner can browse this agent's workspace."
      />
    );
  }
  if (phase === "loading" && entries.length === 0) return <SkeletonRows count={5} />;
  if (phase === "error") {
    return (
      <EmptyState
        title="Couldn't load files"
        hint={errorText}
        action={
          <button type="button" onClick={() => void loadTree()} className={quietButtonClass}>
            Try again
          </button>
        }
      />
    );
  }
  if (entries.length === 0) {
    return (
      <EmptyState
        title="This agent hasn't made any files yet"
        hint="They'll appear here as it works."
        action={
          <button type="button" onClick={() => void loadTree()} className={quietButtonClass}>
            Refresh
          </button>
        }
      />
    );
  }

  const tree = buildWorkspaceTree(entries);
  const dirty = viewer.kind === "text" && viewer.draft !== viewer.loadedContent;
  const needsDoctrineSync =
    viewer.kind === "text" && viewer.doctrineSyncState === "conflict";
  const ownership =
    viewer.kind === "idle" || viewer.kind === "loading" || viewer.kind === "error"
      ? null
      : doctrineFileOwnership(viewer.path, username);
  const workspaceEditable = ownership?.editableInWorkspace ?? true;
  const syncState: DoctrineSyncState | undefined =
    ownership?.kind !== "two-way-settings"
      ? undefined
      : conflict
        ? "conflict"
        : needsDoctrineSync
          ? "conflict"
        : saving
          ? "saving"
          : dirty
            ? "unsaved"
            : "synced";

  return (
    <div className="min-w-0">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
          Workspace
          {truncated ? (
            <span className="ml-2 normal-case tracking-normal text-warning-soft/80">
              showing the first 2,000 entries
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void loadTree()}
            disabled={phase !== "ready"}
            className={quietButtonClass}
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void exportZip()}
            disabled={exporting}
            className={quietButtonClass}
          >
            {exporting ? "Exporting…" : "Export workspace (.zip)"}
          </button>
        </div>
      </div>

      {actionError ? (
        <p className="mt-3 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger">
          {actionError}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-6 md:flex-row">
        {/* Tree */}
        <aside className="min-w-0 max-w-full shrink-0 md:w-64 md:border-r md:border-edge md:pr-4">
          <TreeRows
            nodes={tree}
            depth={0}
            expanded={expanded}
            selected={viewer.kind === "idle" ? null : viewer.path}
            onToggle={(path) =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
            onSelect={(node) => void openFile(node)}
          />
        </aside>

        {/* Viewer */}
        <section className="min-w-0 max-w-full flex-1">
          {viewer.kind === "idle" ? (
            <p className="pt-8 text-center text-sm text-faint">Select a file to view it.</p>
          ) : viewer.kind === "loading" ? (
            <SkeletonRows count={4} />
          ) : viewer.kind === "error" ? (
            <EmptyState title={`Couldn't open ${viewer.path}`} hint={viewer.text} />
          ) : (
            <div className="space-y-4">
              {/* File header */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-foreground">{viewer.path}</p>
                  <p className="mt-0.5 text-xs text-faint">
                    {formatBytes(viewer.sizeBytes)} · Last changed{" "}
                    {formatRelativeTime(viewer.mtime)}
                    {viewer.kind === "text" && viewer.doctrineRevision !== undefined
                      ? ` · Revision ${viewer.doctrineRevision}`
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void download(viewer.path)}
                  className={quietButtonClass}
                >
                  Download
                </button>
              </div>

              {note ? (
                <p className="rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-accent-soft">
                  {note}
                </p>
              ) : null}

              {ownership ? (
                <DoctrineOwnershipNotice
                  ownership={ownership}
                  syncState={syncState}
                  revision={viewer.kind === "text" ? viewer.doctrineRevision : undefined}
                />
              ) : null}

              {conflict ? (
                <div className="rounded-xl border border-warning/25 bg-warning/5 px-4 py-3 text-sm">
                  <p className="font-medium text-warning-soft">
                    The agent changed this file while you were editing.
                  </p>
                  <p className="mt-1 text-xs text-faint">
                    {conflict.currentMtime
                      ? `Their version landed ${formatRelativeTime(conflict.currentMtime)}. `
                      : ""}
                    Reload to see their version, or keep editing — saving again will replace
                    their changes.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void reloadTheirs()}
                      className={quietButtonClass}
                    >
                      Reload their version
                    </button>
                    <button type="button" onClick={keepEditing} className={quietButtonClass}>
                      Keep editing
                    </button>
                  </div>
                </div>
              ) : null}

              {viewer.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={api.agents.workspaceDownloadUrl(username, viewer.path)}
                  alt={viewer.path}
                  className="max-h-[480px] max-w-full rounded-xl border border-edge bg-black/20"
                />
              ) : viewer.kind === "binary" ? (
                <div className="rounded-xl border border-edge bg-surface p-5 text-sm text-muted">
                  <p>Binary file — {formatBytes(viewer.sizeBytes)}.</p>
                  <p className="mt-1 text-xs text-faint">
                    This file can't be previewed here. Download it to take a look.
                  </p>
                </div>
              ) : (
                <>
                  <textarea
                    value={viewer.draft}
                    onChange={(event) =>
                      workspaceEditable
                        ? setViewer({ ...viewer, draft: event.target.value })
                        : undefined
                    }
                    readOnly={!workspaceEditable}
                    aria-readonly={!workspaceEditable}
                    spellCheck={false}
                    className={`min-h-[360px] w-full max-w-full resize-y rounded-lg border border-edge p-4 font-mono text-[13px] leading-relaxed text-muted outline-none transition-colors ${
                      workspaceEditable
                        ? "bg-black/20 focus:border-accent/60"
                        : "cursor-default bg-surface/70"
                    }`}
                  />
                  {workspaceEditable ? (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void save()}
                        disabled={saving || (!dirty && !needsDoctrineSync) || conflict !== null}
                        className={primaryButtonClass}
                      >
                        {saving
                          ? "Saving…"
                          : needsDoctrineSync && !dirty
                            ? "Use file in Settings"
                            : "Save"}
                      </button>
                      {dirty && !saving ? (
                        <span className="text-xs text-faint">Unsaved changes</span>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
