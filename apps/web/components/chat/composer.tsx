"use client";

import React from "react";

/**
 * Chat composer — autosizing textarea, Enter=send / Shift+Enter=newline
 * (IME-safe), disabled while a turn streams with a stop (client-side abort)
 * button in its place. `notice` renders above the input (402 insufficient
 * manna, endpoint-missing hints, …).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent, ReactNode } from "react";
import { getClerkToken } from "@/lib/clerk";
import { ResumableUploader } from "@/lib/resumable-upload";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";
import {
  clearDictationComposerDraft,
  commitDictationTranscriptToComposer,
  currentDictationCustodyEpoch,
  loadDictationComposerDraft,
  persistDictationComposerDraft,
} from "@/lib/dictation-storage";
import type { DictationPurgeFenceStore } from "@/lib/dictation-storage";
import type { MessageAttachment } from "@/lib/types";
import {
  formatDictationTime,
  useDictation,
} from "./use-dictation";

const MAX_HEIGHT_PX = 220;
const MAX_ATTACHMENTS = 8;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "application/json"]);

export interface ComposerAttachment {
  objectId: string;
  attachment: MessageAttachment;
}

export function hasComposerRetryPayload(
  content: string | null,
  attachments: ComposerAttachment[],
): boolean {
  return content !== null || attachments.length > 0;
}

interface StagedAttachment {
  id: string;
  file: File;
  previewUrl: string | null;
  phase: "uploading" | "ready" | "error";
  result?: ComposerAttachment;
  error?: string;
}

export function attachmentError(file: File): string | null {
  if (!ACCEPTED.has(file.type)) return "Use PNG, JPEG, GIF, WebP, plain text, or JSON.";
  const limit = file.type.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  if (file.size <= 0) return "Empty files cannot be attached.";
  if (file.size > limit) return file.type.startsWith("image/") ? "Images must be 10 MiB or smaller." : "Text files must be 1 MiB or smaller.";
  return null;
}

export async function clearComposerDraftAfterTurnAcceptance(
  acceptance: boolean | Promise<boolean>,
  clear: () => void | Promise<void>,
): Promise<boolean> {
  try {
    const accepted = await acceptance;
    if (accepted) await clear();
    return accepted;
  } catch {
    return false;
  }
}

export function retryComposerDraftAfterTurnAcceptance(
  acceptance: boolean | Promise<boolean>,
  ownerId: string | null | undefined,
  contextKey: string,
  options?: { indexedDB?: IDBFactory; purgeFenceStore?: DictationPurgeFenceStore },
): Promise<boolean> {
  const expectedEpoch = currentDictationCustodyEpoch(options?.purgeFenceStore);
  return clearComposerDraftAfterTurnAcceptance(acceptance, () => {
    if (ownerId) return clearDictationComposerDraft(ownerId, contextKey, options, expectedEpoch);
  });
}

export async function retryInlineErrorAfterTurnAcceptance(
  acceptance: boolean | Promise<boolean>,
  ownerId: string | null | undefined,
  contextKey: string,
  dismiss: () => void,
  options?: { indexedDB?: IDBFactory; purgeFenceStore?: DictationPurgeFenceStore },
): Promise<boolean> {
  const accepted = await retryComposerDraftAfterTurnAcceptance(
    acceptance,
    ownerId,
    contextKey,
    options,
  );
  if (accepted) dismiss();
  return accepted;
}

export function composerDraftIdentity(ownerId: string, contextKey: string): string {
  return `${ownerId.length}:${ownerId}:${contextKey}`;
}

export function shouldApplyComposerHydration(
  expectedIdentity: string,
  currentIdentity: string | null,
  revisionAtStart: number,
  currentRevision: number,
): boolean {
  return expectedIdentity === currentIdentity && revisionAtStart === currentRevision;
}

export async function resolveComposerDraftIdentity(
  ownerId: string,
  contextKey: string,
  previousIdentity: string | null,
  options?: { indexedDB?: IDBFactory; purgeFenceStore?: DictationPurgeFenceStore },
): Promise<{ identity: string; changed: boolean; value: string }> {
  const identity = composerDraftIdentity(ownerId, contextKey);
  if (identity === previousIdentity) return { identity, changed: false, value: "" };
  return {
    identity,
    changed: true,
    value: await loadDictationComposerDraft(ownerId, contextKey, options) ?? "",
  };
}

function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-4"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-3">
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
    </svg>
  );
}

function MicrophoneIcon({ active = false }: { active?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-4">
      <rect x="9" y="3" width="6" height="11" rx="3" fill={active ? "currentColor" : "none"} />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
    </svg>
  );
}

export function Composer({
  onSend,
  onStop,
  streaming = false,
  disabled = false,
  placeholder = "Message…",
  notice,
  autoFocus = false,
  draftKey,
}: {
  /** Called with trimmed content; the input clears immediately. */
  onSend: (content: string, attachments: ComposerAttachment[]) => boolean | Promise<boolean>;
  /** Abort the active stream (only rendered while `streaming`). */
  onStop?: () => void;
  streaming?: boolean;
  /** Hard-disable input (no agent yet, session missing, …). */
  disabled?: boolean;
  placeholder?: string;
  /** Rendered above the input — 402 notices, retry hints. */
  notice?: ReactNode;
  autoFocus?: boolean;
  /** Stable view identity for crash-safe dictation transcript handoff. */
  draftKey: string;
}) {
  const [value, setValue] = useState("");
  const valueRef = useRef("");
  const draftIdentityRef = useRef<string | null>(null);
  const editRevisionRef = useRef(0);
  const persistChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrls = useRef(new Set<string>());
  const uploader = useMemo(() => new ResumableUploader({
    apiBaseUrl: "/api",
    getAuthToken: getClerkToken,
    refreshCredentials: async () => { await getClerkToken(); },
  }), []);
  const { viewer, viewerPhase } = useSelectedAgent();
  const receiveTranscript = useCallback(async (transcript: string, deliveryId: string) => {
    if (viewerPhase !== "ready" || !viewer) return false;
    // Serialize same-tab edits before the transactional cross-tab handoff.
    await persistChainRef.current.catch(() => undefined);
    const committed = await commitDictationTranscriptToComposer(viewer.id, draftKey, deliveryId, transcript);
    if (committed === null) return false;
    if (draftIdentityRef.current !== composerDraftIdentity(viewer.id, draftKey)) return true;
    editRevisionRef.current += 1;
    valueRef.current = committed;
    setValue(committed);
    queueMicrotask(() => textareaRef.current?.focus());
    return true;
  }, [draftKey, viewer, viewerPhase]);
  const dictation = useDictation({
    ownerId: viewer?.id ?? null,
    ownerPhase: viewerPhase,
    onTranscript: receiveTranscript,
  });
  const dictationBusy = !["idle", "error"].includes(dictation.state.phase);
  const dictationRecording =
    dictation.state.phase === "recording" || dictation.state.phase === "retrying";

  useEffect(() => {
    let cancelled = false;
    if (viewerPhase === "signed_out") {
      draftIdentityRef.current = null;
      editRevisionRef.current += 1;
      persistChainRef.current = Promise.resolve();
      valueRef.current = "";
      setValue("");
      return () => { cancelled = true; };
    }
    if (viewerPhase !== "ready" || !viewer) return () => { cancelled = true; };
    const identity = composerDraftIdentity(viewer.id, draftKey);
    if (draftIdentityRef.current === identity) return () => { cancelled = true; };
    draftIdentityRef.current = identity;
    const hydrationRevision = editRevisionRef.current;
    persistChainRef.current = Promise.resolve();
    valueRef.current = "";
    setValue("");
    void resolveComposerDraftIdentity(viewer.id, draftKey, null).then((next) => {
      if (cancelled || !shouldApplyComposerHydration(
        next.identity, draftIdentityRef.current, hydrationRevision, editRevisionRef.current,
      )) return;
      valueRef.current = next.value;
      setValue(next.value);
    });
    return () => { cancelled = true; };
  }, [draftKey, viewer, viewerPhase]);

  useEffect(() => () => {
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
    previewUrls.current.clear();
  }, []);

  const addFiles = useCallback(async (incoming: File[]) => {
    setAttachmentNotice(null);
    const remaining = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (incoming.length > remaining) {
      setAttachmentNotice(`A message can include at most ${MAX_ATTACHMENTS} attachments.`);
      incoming = incoming.slice(0, remaining);
    }
    const existingBytes = attachments.reduce((sum, item) => sum + item.file.size, 0);
    let admittedBytes = existingBytes;
    const accepted: StagedAttachment[] = [];
    for (const file of incoming) {
      const error = attachmentError(file);
      if (error) {
        setAttachmentNotice(`${file.name}: ${error}`);
        continue;
      }
      if (admittedBytes + file.size > MAX_TOTAL_BYTES) {
        setAttachmentNotice("Attachments may total at most 20 MiB per message.");
        continue;
      }
      admittedBytes += file.size;
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      if (previewUrl) previewUrls.current.add(previewUrl);
      accepted.push({
        id: crypto.randomUUID(),
        file,
        previewUrl,
        phase: "uploading",
      });
    }
    if (accepted.length === 0) return;
    setAttachments((current) => [...current, ...accepted]);
    for (const item of accepted) {
      try {
        const uploaded = await uploader.uploadFile(item.file, { purpose: "chat" });
        setAttachments((current) => current.map((candidate) => candidate.id === item.id ? {
          ...candidate,
          phase: "ready",
          result: {
            objectId: uploaded.objectId,
            attachment: { url: uploaded.url, mime: item.file.type },
          },
        } : candidate));
      } catch (cause) {
        setAttachments((current) => current.map((candidate) => candidate.id === item.id ? {
          ...candidate,
          phase: "error",
          error: cause instanceof Error ? cause.message : "Upload failed",
        } : candidate));
      }
    }
  }, [attachments, uploader]);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Empty: clear the inline height so CSS (rows=1) governs — measuring at
    // mount can happen before styles apply and bake in a bogus height.
    if (el.value === "") {
      el.style.height = "";
      el.style.overflowY = "hidden";
      return;
    }
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  // Re-focus once a turn finishes so the reply flow keeps its rhythm.
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming && !disabled) {
      textareaRef.current?.focus();
    }
    wasStreaming.current = streaming;
  }, [streaming, disabled]);

  const uploadPending = attachments.some((item) => item.phase === "uploading");
  const uploadFailed = attachments.some((item) => item.phase === "error");
  const canSend = !streaming && !disabled && !dictationBusy && !uploadPending && !uploadFailed &&
    (value.trim().length > 0 || attachments.some((item) => item.phase === "ready"));

  const submit = useCallback(() => {
    const content = value.trim();
    const ready = attachments.flatMap((item) => item.result ? [item.result] : []);
    if ((!content && ready.length === 0) || streaming || disabled || dictationBusy || uploadPending || uploadFailed) return;
    setValue("");
    valueRef.current = "";
    setAttachments([]);
    for (const item of attachments) if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
      previewUrls.current.delete(item.previewUrl);
    }
    const expectedEpoch = currentDictationCustodyEpoch();
    // Keep the durable dictation handoff through network ambiguity. Only a
    // server turn.started acknowledgement in this exact auth epoch may erase
    // it, after every already-admitted local edit has drained.
    void clearComposerDraftAfterTurnAcceptance(onSend(content, ready), async () => {
      await persistChainRef.current.catch(() => undefined);
      if (viewer) await clearDictationComposerDraft(viewer.id, draftKey, undefined, expectedEpoch);
    });
  }, [value, attachments, streaming, disabled, dictationBusy, uploadPending, uploadFailed, onSend, viewer, draftKey]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return; // IME confirmation, not send
    event.preventDefault();
    submit();
  };

  return (
    <div
      className="w-full"
      onDragEnter={(event) => { event.preventDefault(); if (!disabled && !streaming && !dictationBusy) setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled && !streaming && !dictationBusy) void addFiles([...event.dataTransfer.files]);
      }}
    >
      {notice ? <div className="mb-2">{notice}</div> : null}
      {attachmentNotice ? <p role="alert" className="mb-2 text-xs text-danger-soft">{attachmentNotice}</p> : null}
      {dictation.state.phase !== "idle" ? (
        <div
          role="status"
          aria-live="polite"
          className={`mb-2 flex min-h-12 items-center gap-3 rounded-xl border px-3 py-2 text-xs ${
            dictation.state.phase === "error"
              ? "border-danger/25 bg-danger/[0.04] text-danger-soft"
              : "border-edge bg-surface text-muted"
          }`}
        >
          {dictationRecording ? (
            <span className="relative flex size-3 shrink-0" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger/45" />
              <span className="relative inline-flex size-3 rounded-full bg-danger" />
            </span>
          ) : (
            <span className="flex gap-0.5" aria-hidden>
              <span className="size-1 animate-pulse rounded-full bg-accent" />
              <span className="size-1 animate-pulse rounded-full bg-accent [animation-delay:150ms]" />
              <span className="size-1 animate-pulse rounded-full bg-accent [animation-delay:300ms]" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-foreground">
              {dictationRecording
                ? `Listening · ${formatDictationTime(dictation.state.elapsedMs)}`
                : dictation.state.phase === "requesting"
                  ? "Starting microphone…"
                  : dictation.state.phase === "recovering"
                    ? "Recovering your recording…"
                    : dictation.state.phase === "transcribing"
                      ? "Transcribing…"
                      : dictation.state.phase === "error"
                        ? "Dictation needs attention"
                        : "Saving your recording…"}
            </span>
            {dictation.state.message ? <span className="block truncate text-faint">{dictation.state.message}</span> : null}
          </span>
          {dictationRecording ? (
            <button type="button" onClick={dictation.stop} className="rounded-lg border border-edge px-2.5 py-1.5 text-foreground hover:bg-foreground/[0.04]">
              Done
            </button>
          ) : null}
          {dictationBusy ? (
            <button type="button" onClick={dictation.cancel} className="rounded-lg px-2 py-1.5 text-faint hover:text-foreground">
              Cancel
            </button>
          ) : null}
          {dictation.state.phase === "error" ? (
            <button type="button" onClick={() => void dictation.start()} className="rounded-lg border border-edge px-2.5 py-1.5 text-foreground hover:bg-foreground/[0.04]">
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attached files">
          {attachments.map((item) => (
            <li key={item.id} className="flex max-w-[220px] items-center gap-2 rounded-xl border border-edge bg-surface p-1.5 pr-2 text-xs">
              {item.previewUrl ? <img src={item.previewUrl} alt="" className="size-10 rounded-lg object-cover" /> : <span className="flex size-10 items-center justify-center rounded-lg bg-foreground/[0.05] text-[9px] font-medium">FILE</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.file.name}</span>
                <span className={item.phase === "error" ? "text-danger-soft" : "text-faint"}>{item.phase === "uploading" ? "Uploading…" : item.phase === "ready" ? "Ready" : item.error}</span>
              </span>
              <button type="button" aria-label={`Remove ${item.file.name}`} className="text-faint hover:text-foreground" onClick={() => {
                if (item.previewUrl) {
                  URL.revokeObjectURL(item.previewUrl);
                  previewUrls.current.delete(item.previewUrl);
                }
                setAttachments((current) => current.filter((candidate) => candidate.id !== item.id));
              }}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={`flex items-end gap-2 rounded-2xl border bg-raised px-3 py-3 transition-colors ${
          dragging ? "border-accent bg-accent/[0.04]" :
          disabled
            ? "border-edge/60 opacity-60"
            : "border-edge focus-within:border-accent/50"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,text/plain,application/json"
          className="sr-only"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            void addFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          title="Attach files"
          aria-label="Attach files"
          disabled={disabled || streaming || dictationBusy || attachments.length >= MAX_ATTACHMENTS}
          onClick={() => inputRef.current?.click()}
          className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden className="size-4"><path d="m9 17 7.8-7.8a3 3 0 0 0-4.2-4.2L4.8 12.8a5 5 0 0 0 7.1 7.1l7.4-7.4" /></svg>
        </button>
        {dictation.supported ? (
          <button
            type="button"
            title={dictationRecording ? "Finish dictation" : "Dictate a message"}
            aria-label={dictationRecording ? "Finish dictation" : "Dictate a message"}
            disabled={disabled || streaming || (dictationBusy && !dictationRecording)}
            onClick={() => dictationRecording ? dictation.stop() : void dictation.start()}
            className={`mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
              dictationRecording
                ? "bg-danger/10 text-danger hover:bg-danger/15"
                : "text-muted hover:bg-foreground/[0.05] hover:text-foreground"
            }`}
          >
            <MicrophoneIcon active={dictationRecording} />
          </button>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            editRevisionRef.current += 1;
            valueRef.current = next;
            setValue(next);
            if (viewerPhase === "ready" && viewer) {
              persistChainRef.current = persistChainRef.current
                .catch(() => undefined)
                .then(() => persistDictationComposerDraft(viewer.id, draftKey, next));
            }
          }}
          onKeyDown={onKeyDown}
          placeholder={streaming ? "Streaming…" : dragging ? "Drop files here…" : placeholder}
          disabled={disabled || streaming || dictationBusy}
          autoFocus={autoFocus}
          aria-label="Message"
          className="max-h-[220px] min-w-0 flex-1 resize-none bg-transparent text-[15px] leading-relaxed text-foreground outline-none placeholder:text-faint disabled:cursor-not-allowed"
        />
        {streaming && onStop ? (
          <button
            type="button"
            onClick={onStop}
            title="Stop generating"
            aria-label="Stop generating"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-edge text-muted transition-colors hover:border-accent/60 hover:text-foreground"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            title="Send (Enter)"
            aria-label="Send message"
            className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-all ${
              canSend
                ? "bg-accent text-white hover:bg-accent-soft"
                : "bg-foreground/[0.06] text-faint"
            }`}
          >
            <SendIcon />
          </button>
        )}
      </div>
      <p className="mt-1.5 px-1 text-right text-[10px] text-faint">
        Add up to 8 images or text files · Dictation up to 10 minutes · Enter to send · Shift+Enter for a new line
      </p>
    </div>
  );
}

/** Inline notice styles shared by chat surfaces (402, endpoint-missing…). */
export function ComposerNotice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn";
  children: ReactNode;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-3.5 py-2 text-xs ${
        tone === "warn"
          ? "border-warning/25 bg-warning/[0.06] text-warning-soft/90"
          : "border-edge bg-surface text-muted"
      }`}
    >
      {children}
    </div>
  );
}
