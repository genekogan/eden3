"use client";

/**
 * Chat composer — autosizing textarea, Enter=send / Shift+Enter=newline
 * (IME-safe), disabled while a turn streams with a stop (client-side abort)
 * button in its place. `notice` renders above the input (402 insufficient
 * manna, endpoint-missing hints, …).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

const MAX_HEIGHT_PX = 220;

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
  onSend: (content: string) => void;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const canSend = !streaming && !disabled && value.trim().length > 0;

  const submit = useCallback(() => {
    const content = value.trim();
    if (!content || streaming || disabled) return;
    setValue("");
    onSend(content);
  }, [value, streaming, disabled, onSend]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return; // IME confirmation, not send
    event.preventDefault();
    submit();
  };

  return (
    <div className="w-full">
      {notice ? <div className="mb-2">{notice}</div> : null}
      <div
        className={`flex items-end gap-2 rounded-2xl border bg-raised px-4 py-3 transition-colors ${
          disabled
            ? "border-edge/60 opacity-60"
            : "border-edge focus-within:border-accent/50"
        }`}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={streaming ? "Streaming…" : placeholder}
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
        Enter to send · Shift+Enter for a new line
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
