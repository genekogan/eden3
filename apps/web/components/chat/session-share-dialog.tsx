"use client";

import { useEffect, useReducer, useState } from "react";

import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import {
  absoluteShareUrl,
  initialSessionShareDialogState,
  sessionShareDialogReducer,
} from "./session-share-model";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Sharing failed. Try again.";
}

export function SessionShareDialog({
  sessionId,
  boundaryMessageId,
}: {
  sessionId: string;
  boundaryMessageId: string | null;
}) {
  const [state, dispatch] = useReducer(
    sessionShareDialogReducer,
    initialSessionShareDialogState,
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!state.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch({ type: "close" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.open]);

  const open = () => {
    dispatch({ type: "open" });
    dispatch({ type: "load/start" });
    void api.shares
      .list(sessionId)
      .then((response) => dispatch({ type: "load/success", items: response.items }))
      .catch((error) => dispatch({ type: "failure", message: errorMessage(error) }));
  };

  const create = () => {
    dispatch({ type: "create/start" });
    void api.shares
      .create(sessionId, {
        mode: state.mode,
        ...(state.title.trim() ? { title: state.title.trim() } : {}),
        ...(boundaryMessageId ? { boundaryMessageId } : {}),
      })
      .then((response) => {
        dispatch({
          type: "create/success",
          share: response.share,
          publicUrl: absoluteShareUrl(response.publicPath, window.location.origin),
        });
      })
      .catch((error) => dispatch({ type: "failure", message: errorMessage(error) }));
  };

  const revoke = (shareId: string) => {
    dispatch({ type: "revoke/start" });
    void api.shares
      .revoke(sessionId, shareId)
      .then((share) => dispatch({ type: "revoke/success", share }))
      .catch((error) => dispatch({ type: "failure", message: errorMessage(error) }));
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="rounded-md border border-edge px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground"
      >
        Share
      </button>
      {state.open ? (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-background/75 px-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) dispatch({ type: "close" });
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-dialog-title"
            className="w-full max-w-md rounded-xl border border-edge bg-raised p-5 shadow-2xl shadow-black/40"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="share-dialog-title" className="text-base font-medium">
                  Share conversation
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-faint">
                  Unlisted links never appear in feeds or directories.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close share dialog"
                onClick={() => dispatch({ type: "close" })}
                className="text-muted hover:text-foreground"
              >
                ✕
              </button>
            </div>

            <fieldset className="mt-5 grid grid-cols-2 gap-2">
              {(["snapshot", "live"] as const).map((mode) => (
                <label
                  key={mode}
                  className={`cursor-pointer rounded-lg border p-3 text-sm ${
                    state.mode === mode ? "border-accent/60 bg-accent/10" : "border-edge"
                  }`}
                >
                  <input
                    type="radio"
                    name="share-mode"
                    value={mode}
                    checked={state.mode === mode}
                    onChange={() => dispatch({ type: "mode", mode })}
                    className="sr-only"
                  />
                  <span className="font-medium capitalize">{mode}</span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-faint">
                    {mode === "snapshot"
                      ? "Fixed at the latest saved message."
                      : "New saved messages keep appearing."}
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="mt-4 block text-xs text-muted">
              Optional title
              <input
                value={state.title}
                maxLength={160}
                onChange={(event) => dispatch({ type: "title", title: event.target.value })}
                placeholder="Shared conversation"
                className="mt-1.5 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent/60"
              />
            </label>

            {state.publicUrl ? (
              <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-3">
                <p className="break-all font-mono text-[11px] text-accent-soft">
                  {state.publicUrl}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(state.publicUrl!).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                  className="mt-2 text-xs text-foreground underline underline-offset-2"
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            ) : null}

            {state.error ? (
              <p role="alert" className="mt-3 text-xs text-danger-soft">
                {state.error}
              </p>
            ) : null}

            <button
              type="button"
              disabled={state.pending !== null}
              onClick={create}
              className="mt-4 w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {state.pending === "create" ? "Creating…" : "Create unlisted link"}
            </button>

            {state.items.length > 0 ? (
              <div className="mt-5 border-t border-edge pt-4">
                <h3 className="text-xs font-medium text-muted">Previous links</h3>
                <ul className="mt-2 max-h-36 space-y-2 overflow-y-auto">
                  {state.items.map((share) => (
                    <li key={share.id} className="flex items-center justify-between gap-3 text-xs">
                      <span className="min-w-0 truncate text-faint">
                        {share.title || share.mode} · {formatDateTime(share.createdAt)}
                        {share.revokedAt ? " · revoked" : ""}
                      </span>
                      {!share.revokedAt ? (
                        <button
                          type="button"
                          disabled={state.pending !== null}
                          onClick={() => revoke(share.id)}
                          className="shrink-0 text-danger-soft hover:underline disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
