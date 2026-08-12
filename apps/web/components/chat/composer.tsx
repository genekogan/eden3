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
import type { MessageAttachment } from "@/lib/types";

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

export function Composer({
  onSend,
  onStop,
  streaming = false,
  disabled = false,
  placeholder = "Message…",
  notice,
  autoFocus = false,
}: {
  /** Called with trimmed content; the input clears immediately. */
  onSend: (content: string, attachments: ComposerAttachment[]) => void;
  /** Abort the active stream (only rendered while `streaming`). */
  onStop?: () => void;
  streaming?: boolean;
  /** Hard-disable input (no agent yet, session missing, …). */
  disabled?: boolean;
  placeholder?: string;
  /** Rendered above the input — 402 notices, retry hints. */
  notice?: ReactNode;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
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
  const canSend = !streaming && !disabled && !uploadPending && !uploadFailed &&
    (value.trim().length > 0 || attachments.some((item) => item.phase === "ready"));

  const submit = useCallback(() => {
    const content = value.trim();
    const ready = attachments.flatMap((item) => item.result ? [item.result] : []);
    if ((!content && ready.length === 0) || streaming || disabled || uploadPending || uploadFailed) return;
    setValue("");
    setAttachments([]);
    for (const item of attachments) if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
      previewUrls.current.delete(item.previewUrl);
    }
    onSend(content, ready);
  }, [value, attachments, streaming, disabled, uploadPending, uploadFailed, onSend]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return; // IME confirmation, not send
    event.preventDefault();
    submit();
  };

  return (
    <div
      className="w-full"
      onDragEnter={(event) => { event.preventDefault(); if (!disabled && !streaming) setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled && !streaming) void addFiles([...event.dataTransfer.files]);
      }}
    >
      {notice ? <div className="mb-2">{notice}</div> : null}
      {attachmentNotice ? <p role="alert" className="mb-2 text-xs text-danger-soft">{attachmentNotice}</p> : null}
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
          disabled={disabled || streaming || attachments.length >= MAX_ATTACHMENTS}
          onClick={() => inputRef.current?.click()}
          className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden className="size-4"><path d="m9 17 7.8-7.8a3 3 0 0 0-4.2-4.2L4.8 12.8a5 5 0 0 0 7.1 7.1l7.4-7.4" /></svg>
        </button>
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={streaming ? "Streaming…" : dragging ? "Drop files here…" : placeholder}
          disabled={disabled || streaming}
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
        Add up to 8 images or text files · Enter to send · Shift+Enter for a new line
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
