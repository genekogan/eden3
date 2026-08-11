"use client";

/**
 * Settings › Persona — the agent's SOUL.md, edited through the workspace
 * file API. The file IS the source of truth: the API mirrors SOUL.md bytes
 * into agents.persona on save, and edits made anywhere else (the Workspace
 * browser, the agent itself) show up here. Saves are conflict-checked
 * (sha256 base) and doctrine-linted (422 with the violations).
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { WorkspaceWriteConflict } from "@/lib/types";
import { describeApiFailure } from "@/components/agents/agent-utils";
import { ButtonSpinner, primaryButtonClass, quietButtonClass } from "@/components/agents/form-fields";
import { Toast } from "@/components/agents/toast";
import { Skeleton } from "@/components/skeleton";
import { formatRelativeTime } from "@/lib/format";
import { useSettingsUnsavedChanges } from "./unsaved-changes";

const SOUL_PATH = "SOUL.md";

/** The other doctrine files, editable in the Workspace browser. */
const SIBLING_FILES = ["IDENTITY.md", "AGENTS.md", "USER.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"];

type EditorState =
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | {
      kind: "ready";
      draft: string;
      loadedContent: string;
      baseSha256: string;
      doctrineRevision: number;
      doctrineSyncState: "synced" | "conflict";
      mtime: string | null;
    };

export function PersonaEditor({ username }: { username: string }) {
  const [state, setState] = useState<EditorState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<WorkspaceWriteConflict | null>(null);
  const [doctrineError, setDoctrineError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    setConflict(null);
    setDoctrineError(null);
    setActionError(null);
    try {
      const { file } = await api.agents.workspaceFile(username, SOUL_PATH);
      if (file.kind !== "text") {
        setState({ kind: "error", text: "SOUL.md is not a text file." });
        return;
      }
      if (file.doctrineRevision === undefined || file.doctrineSyncState === undefined) {
        setState({ kind: "error", text: "SOUL.md revision metadata is unavailable." });
        return;
      }
      setState({
        kind: "ready",
        draft: file.content,
        loadedContent: file.content,
        baseSha256: file.sha256,
        doctrineRevision: file.doctrineRevision,
        doctrineSyncState: file.doctrineSyncState,
        mtime: file.mtime ?? null,
      });
    } catch (error) {
      setState({
        kind: "error",
        text:
          error instanceof ApiError && error.status === 404
            ? "This agent has no SOUL.md yet — it may still be provisioning."
            : describeApiFailure(error),
      });
    }
  }, [username]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<boolean> => {
    if (state.kind !== "ready" || saving) return false;
    const snapshot = state;
    setSaving(true);
    setDoctrineError(null);
    setActionError(null);
    try {
      const { file } = await api.agents.workspaceSave(username, {
        path: SOUL_PATH,
        content: snapshot.draft,
        baseSha256: snapshot.baseSha256,
        baseRevision: snapshot.doctrineRevision,
      });
      if (file.doctrineRevision === undefined || file.doctrineSyncState === undefined) {
        throw new Error("SOUL.md saved but revision confirmation was unavailable; reload the page.");
      }
      setState({
        ...snapshot,
        loadedContent: snapshot.draft,
        baseSha256: file.sha256,
        doctrineRevision: file.doctrineRevision,
        doctrineSyncState: file.doctrineSyncState,
        mtime: file.mtime,
      });
      setConflict(null);
      setToast("Saved — the soul shapes the very next message.");
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const body = (error.body ?? {}) as Partial<WorkspaceWriteConflict> & {
          error?: { code?: string };
        };
        if (body.error?.code === "workspace_sync_busy") {
          setActionError("The agent is finishing a Workspace sync. Retry Save in a moment.");
        } else {
          setConflict({
            currentSha256: body.currentSha256 ?? null,
            currentMtime: body.currentMtime ?? null,
            currentRevision: body.currentRevision,
          });
        }
      } else if (error instanceof ApiError && error.status === 422) {
        setDoctrineError(error.message);
      } else {
        setActionError(describeApiFailure(error));
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const dirty = state.kind === "ready" && state.draft !== state.loadedContent;

  const discardChanges = () => {
    if (state.kind !== "ready") return;
    setState({ ...state, draft: state.loadedContent });
    setConflict(null);
    setDoctrineError(null);
    setActionError(null);
  };

  useSettingsUnsavedChanges({
    label: "this agent’s persona",
    dirty,
    saving,
    save,
    discard: discardChanges,
  });

  const keepEditing = () => {
    if (state.kind !== "ready" || conflict === null) return;
    setState({
      ...state,
      ...(conflict.currentSha256 ? { baseSha256: conflict.currentSha256 } : {}),
      ...(conflict.currentRevision !== undefined
        ? { doctrineRevision: conflict.currentRevision }
        : {}),
    });
    setConflict(null);
    setToast("Still editing your version — Save again to replace theirs.");
  };

  if (state.kind === "loading") {
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-9 w-40" />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="rounded-xl border border-dashed border-edge px-5 py-6">
        <p className="text-sm text-muted">{state.text}</p>
        <button type="button" onClick={() => void load()} className={`mt-4 ${quietButtonClass}`}>
          Try again
        </button>
      </div>
    );
  }

  const needsSync = state.doctrineSyncState === "conflict";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs text-faint">
          {SOUL_PATH}
          {state.mtime ? ` · updated ${formatRelativeTime(state.mtime)}` : ""}
          {` · Revision ${state.doctrineRevision}`}
        </p>
        <p className="text-xs text-faint">
          Synced both ways with the file in{" "}
          <Link
            href={`/agents/${encodeURIComponent(username)}/workspace`}
            className="text-accent-soft transition-colors hover:text-accent"
          >
            Workspace
          </Link>
          .
        </p>
      </div>

      <textarea
        value={state.draft}
        onChange={(event) => setState({ ...state, draft: event.target.value })}
        disabled={saving}
        rows={22}
        spellCheck={false}
        aria-label="SOUL.md content"
        className="w-full resize-y rounded-xl border border-edge bg-raised px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground focus:border-accent/60 focus:outline-none"
      />

      {conflict ? (
        <div className="rounded-lg border border-warning/25 bg-warning/5 px-4 py-3 text-xs text-warning-soft">
          <p>
            The agent (or another editor) changed SOUL.md while you were editing.
            {conflict.currentMtime
              ? ` Their version landed ${formatRelativeTime(conflict.currentMtime)}.`
              : ""}
          </p>
          <div className="mt-2.5 flex gap-2">
            <button type="button" onClick={() => void load()} className={quietButtonClass}>
              Load their version
            </button>
            <button type="button" onClick={keepEditing} className={quietButtonClass}>
              Keep mine — overwrite on save
            </button>
          </div>
        </div>
      ) : null}

      {doctrineError ? (
        <div className="rounded-lg border border-danger/25 bg-danger/5 px-4 py-3 text-xs text-danger">
          <p className="font-medium">The save would violate the persona doctrine:</p>
          <p className="mt-1 leading-relaxed">{doctrineError}</p>
        </div>
      ) : null}

      {actionError ? (
        <p className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger">
          {actionError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-edge pt-4">
        <p role="status" className={conflict ? "text-xs text-warning-soft" : "text-xs text-faint"}>
          {conflict
            ? "Conflict — choose which version to keep"
            : saving
              ? "Saving to Workspace…"
              : dirty
                ? "Unsaved changes"
                : needsSync
                  ? "Conflict — file and Settings bytes differ"
                  : "Synced with Workspace"}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={discardChanges}
            disabled={saving || !dirty}
            className={quietButtonClass}
          >
            Discard changes
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || (!dirty && !needsSync) || conflict !== null}
            className={primaryButtonClass}
          >
            {saving ? <ButtonSpinner /> : null}
            {saving ? "Saving…" : needsSync && !dirty ? "Use file in Settings" : "Save SOUL.md"}
          </button>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-faint">
        The rest of the persona doctrine ({SIBLING_FILES.join(", ")}) is visible in{" "}
        <Link
          href={`/agents/${encodeURIComponent(username)}/workspace`}
          className="text-accent-soft transition-colors hover:text-accent"
        >
          Workspace
        </Link>
        . Generated files are labeled by their real owner and remain read-only there;
        use the linked Settings surface when one exists.
      </p>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}
