"use client";

/**
 * Transcript rendering — one component per row shape.
 *
 *   <MessageRow />          persisted MessageDto, dispatched by role:
 *                           user (right, violet tint) · assistant (left,
 *                           avatar + markdown) · eden/system (centered
 *                           banner) · tool (collapsed disclosure)
 *   <StreamBubble />        live assistant turn (typing dots -> tokens ->
 *                           stopped/failed states)
 *   <MediaPendingBubble />  "creating…" shimmer while a generation runs
 *   <MediaBubble />         media.attached that isn't a fetched row yet
 *   <InlineError />         failure row with retry affordance
 *
 * The media is the hero: attachments render large through MediaFull with a
 * quiet, discoverable viewer and download controls.
 */

import Link from "next/link";
import React from "react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { isAudioMedia, isVideoMedia, MediaFull } from "@/components/media";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { AccountSummary, MessageAttachment, MessageDto } from "@/lib/types";
import { Markdown } from "./markdown";
import { stripMediaSentinelLines } from "./conversation-state";
import type {
  AssistantStreamItem,
  ErrorItem,
  MediaItem,
  MediaPendingItem,
  UserEchoItem,
} from "./conversation-state";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function attachmentDownloadName(attachment: MessageAttachment): string {
  const pathname = attachment.url.split(/[?#]/, 1)[0] ?? "";
  const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
  const extension = /^[a-zA-Z0-9._-]+$/.test(basename) && basename.includes(".")
    ? basename.slice(basename.lastIndexOf("."))
    : "";
  return `eden3-${attachment.creationId ?? "media"}${extension}`;
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden className="size-3.5">
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden className="size-3.5">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AttachmentLightbox({
  attachment,
  onClose,
}: {
  attachment: MessageAttachment;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const video = isVideoMedia(attachment.url, attachment.mime ?? null);
  const audio = isAudioMedia(attachment.url, attachment.mime ?? null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="attachment-lightbox-title"
      className="fixed inset-0 z-[120] flex flex-col bg-black/80 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4 text-white">
        <h2 id="attachment-lightbox-title" className="text-sm font-medium">Generated media</h2>
        <div className="flex items-center gap-1.5">
          <a
            href={attachment.url}
            download={attachmentDownloadName(attachment)}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <DownloadIcon />
            Download
          </a>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close media viewer"
            onClick={onClose}
            className="rounded-lg p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden className="size-5">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>
      <section
        className="flex min-h-0 flex-1 items-center justify-center p-4"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {audio ? (
          <audio src={attachment.url} controls autoPlay className="w-full max-w-2xl" />
        ) : video ? (
          <video
            src={attachment.url}
            controls
            autoPlay
            playsInline
            className="max-h-full max-w-full rounded-xl shadow-2xl"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- exact media URL is already policy-reviewed.
          <img
            src={attachment.url}
            alt="Generated media"
            className="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
          />
        )}
      </section>
    </div>
  );
}

function AttachmentList({ attachments }: { attachments: MessageAttachment[] }) {
  const [expanded, setExpanded] = useState<MessageAttachment | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <div className="mt-2 flex flex-col gap-3">
        {attachments.map((attachment, index) => {
          const image = attachment.mime?.startsWith("image/") ?? false;
          const video = isVideoMedia(attachment.url, attachment.mime ?? null);
          const audio = isAudioMedia(attachment.url, attachment.mime ?? null);
          const media = image || video || audio;
          return (
            <figure key={`${attachment.url}:${index}`} className="max-w-md">
              {image ? (
                <button
                  type="button"
                  aria-label="View attachment larger"
                  onClick={() => setExpanded(attachment)}
                  className="block w-full cursor-zoom-in rounded-xl text-left outline-none ring-accent/50 focus-visible:ring-2"
                >
                  <MediaFull
                    url={attachment.url}
                    mime={attachment.mime ?? null}
                    alt="attachment"
                    width={attachment.width ?? null}
                    height={attachment.height ?? null}
                  />
                </button>
              ) : media ? (
                <MediaFull
                  url={attachment.url}
                  mime={attachment.mime ?? null}
                  alt="attachment"
                  width={attachment.width ?? null}
                  height={attachment.height ?? null}
                />
              ) : (
                <a
                  href={attachment.url}
                  download={attachmentDownloadName(attachment)}
                  className="flex min-w-64 items-center gap-3 rounded-xl border border-edge bg-surface px-4 py-3 text-sm transition-colors hover:border-accent/40"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-[10px] font-medium uppercase text-muted">
                    {attachment.mime === "application/json" ? "JSON" : "TXT"}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">Attached file</span>
                    <span className="block truncate text-xs text-faint">{attachment.mime ?? "file"}</span>
                  </span>
                </a>
              )}
              <figcaption className="mt-1.5 flex items-center justify-end gap-1 text-[11px] text-faint">
                {media ? (
                  <button
                    type="button"
                    onClick={() => setExpanded(attachment)}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-foreground/[0.05] hover:text-accent-soft"
                  >
                    <ExpandIcon />
                    View larger
                  </button>
                ) : null}
                <a
                  href={attachment.url}
                  download={attachmentDownloadName(attachment)}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-foreground/[0.05] hover:text-accent-soft"
                >
                  <DownloadIcon />
                  Download
                </a>
              </figcaption>
            </figure>
          );
        })}
      </div>
      {expanded ? (
        <AttachmentLightbox attachment={expanded} onClose={() => setExpanded(null)} />
      ) : null}
    </>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-2" aria-label="thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-pulse rounded-full bg-muted"
          style={{ animationDelay: `${i * 220}ms` }}
        />
      ))}
    </span>
  );
}

/** Copy the message text to the clipboard, flashing a check for feedback. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [text]);
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy message"}
      className="inline-flex items-center rounded transition-colors hover:text-muted"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="size-3"
      >
        {copied ? (
          <path d="M20 6 9 17l-5-5" />
        ) : (
          <>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
          </>
        )}
      </svg>
    </button>
  );
}

/**
 * Subtle hover meta beneath a text bubble: relative time + (optional) copy.
 * Muted, hidden until the row is hovered or the copy button is focused.
 * The parent row must be a `group`.
 */
function MessageMeta({
  at,
  copyText,
  align = "left",
}: {
  at?: string;
  copyText?: string;
  align?: "left" | "right";
}) {
  if (!at && !copyText) return null;
  return (
    <div
      className={`mt-1 flex items-center gap-2 text-faint opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
        align === "right" ? "justify-end" : ""
      }`}
    >
      {at ? (
        <span className="text-[11px]" title={formatDateTime(at)}>
          {formatRelativeTime(at)}
        </span>
      ) : null}
      {copyText ? <CopyButton text={copyText} /> : null}
    </div>
  );
}

/** Left column: agent avatar + name + content. */
function AgentRow({
  sender,
  showAvatar = true,
  children,
}: {
  sender: AccountSummary | null;
  showAvatar?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="group flex gap-3" data-testid="message" data-role="assistant">
      <div className="w-7 shrink-0 pt-0.5">
        {showAvatar ? (
          sender ? (
            <Link href={`/agents/${encodeURIComponent(sender.username)}`}>
              <AgentAvatar account={sender} size={28} />
            </Link>
          ) : (
            <AgentAvatar name="?" size={28} />
          )
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        {showAvatar ? (
          <p className="mb-1 text-xs">
            <span className="font-medium text-muted">
              {sender?.username ?? "agent"}
            </span>
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

function ToolCallDisclosure({
  label,
  payload,
}: {
  label: string;
  payload: unknown;
}) {
  let pretty: string;
  try {
    pretty = JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    pretty = String(payload);
  }
  return (
    <details className="group/tool mt-1.5 max-w-lg">
      <summary className="flex w-fit cursor-pointer select-none items-center gap-1.5 rounded-md border border-edge/80 px-2 py-1 font-mono text-[11px] text-faint transition-colors hover:border-accent/40 hover:text-muted [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="size-3 transition-transform group-open/tool:rotate-90"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        {label}
      </summary>
      <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-edge bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-muted">
        {pretty}
      </pre>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Persisted messages
// ---------------------------------------------------------------------------

function UserBubble({
  content,
  attachments,
  at,
  pending = false,
}: {
  content: string;
  attachments?: MessageAttachment[];
  at?: string;
  pending?: boolean;
}) {
  return (
    <div
      className="group flex flex-col items-end"
      data-testid="message"
      data-role="user"
    >
      <div
        className={`max-w-[85%] rounded-2xl rounded-br-md border border-accent/20 bg-accent/[0.13] px-4 py-2.5 sm:max-w-[70%] ${
          pending ? "opacity-80" : ""
        }`}
      >
        {attachments && attachments.length > 0 ? (
          <AttachmentList attachments={attachments} />
        ) : null}
        <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground">
          {content}
        </p>
      </div>
      <MessageMeta at={at} copyText={content} align="right" />
    </div>
  );
}

/** Centered banner for role="eden" / "system" rows. */
function SystemBanner({ message }: { message: MessageDto }) {
  const record = message as unknown as Record<string, unknown>;
  const data = record["eden_message_data"] ?? record["edenMessageData"];
  let text = message.content ?? "";
  if (typeof data === "string" && data.trim()) {
    text = data;
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["message", "text", "title", "content"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) {
        text = value;
        break;
      }
    }
    if (text === (message.content ?? "") && typeof obj.action === "string") {
      text = obj.action.replace(/[_-]+/g, " ");
    }
  }
  if (!text.trim()) return null;
  return (
    <div className="flex justify-center" title={formatDateTime(message.createdAt)}>
      <p className="max-w-md truncate rounded-full border border-edge/70 bg-surface px-4 py-1.5 text-center text-xs text-faint">
        {text}
      </p>
    </div>
  );
}

function ToolMessageRow({
  message,
  sender,
}: {
  message: MessageDto;
  sender: AccountSummary | null;
}) {
  const label =
    message.toolCalls && message.toolCalls.length > 0
      ? `tool · ${message.toolCalls.length} call${message.toolCalls.length > 1 ? "s" : ""}`
      : "tool result";
  return (
    <AgentRow sender={sender} showAvatar={false}>
      <ToolCallDisclosure
        label={label}
        payload={
          message.toolCalls && message.toolCalls.length > 0
            ? message.toolCalls
            : (message.content ?? "")
        }
      />
      <AttachmentList attachments={message.attachments} />
    </AgentRow>
  );
}

/**
 * Persisted MessageDto row, dispatched by role. `sender` should be resolved
 * by the caller (embedded message.sender, else session membership lookup).
 */
export function MessageRow({
  message,
  sender,
  showAvatar = true,
}: {
  message: MessageDto;
  sender: AccountSummary | null;
  showAvatar?: boolean;
}) {
  const role = message.role ?? "assistant";

  if (role === "user") {
    return (
      <UserBubble
        content={message.content ?? ""}
        attachments={message.attachments}
        at={message.createdAt}
      />
    );
  }
  if (role === "eden" || role === "system") {
    return <SystemBanner message={message} />;
  }
  if (role === "tool") {
    return <ToolMessageRow message={message} sender={sender} />;
  }

  // assistant (and any unknown migrated role) — agent-side rendering.
  // Sentinel lines are parked by the media pipeline; if one survives into a
  // persisted body (late attachment correlation) never show the raw path.
  const assistantText = stripMediaSentinelLines(message.content ?? "");
  const hasText = assistantText.length > 0;
  return (
    <AgentRow sender={sender} showAvatar={showAvatar}>
      {hasText ? <Markdown text={assistantText} /> : null}
      {message.toolCalls && message.toolCalls.length > 0 ? (
        <ToolCallDisclosure
          label={`tool · ${message.toolCalls.length} call${message.toolCalls.length > 1 ? "s" : ""}`}
          payload={message.toolCalls}
        />
      ) : null}
      <AttachmentList attachments={message.attachments} />
      <MessageMeta
        at={message.createdAt}
        copyText={hasText ? assistantText : undefined}
      />
    </AgentRow>
  );
}

// ---------------------------------------------------------------------------
// Live tail items
// ---------------------------------------------------------------------------

export function UserEchoBubble({ item }: { item: UserEchoItem }) {
  return <UserBubble content={item.content} attachments={item.attachments} at={item.at} pending />;
}

/** Live assistant turn: typing dots until the first token, then markdown. */
export function StreamBubble({
  item,
  sender,
}: {
  item: AssistantStreamItem;
  sender: AccountSummary | null;
}) {
  const hasText = item.text.length > 0;
  return (
    <AgentRow sender={sender}>
      {hasText ? <Markdown text={item.text} /> : null}
      {item.phase === "streaming" ? (
        hasText ? (
          <span
            aria-hidden
            className="mt-1.5 inline-block h-3.5 w-[3px] animate-pulse rounded-full bg-accent-soft"
          />
        ) : (
          <TypingDots />
        )
      ) : null}
      {item.phase === "stopped" ? (
        <p className="mt-1.5 text-xs italic text-faint">stopped</p>
      ) : null}
      {item.phase === "failed" && hasText ? (
        <p className="mt-1.5 text-xs italic text-faint">interrupted</p>
      ) : null}
    </AgentRow>
  );
}

/** "creating…" shimmer bubble (media.pending -> media.attached). */
export function MediaPendingBubble({
  item,
  sender,
}: {
  item: MediaPendingItem;
  sender: AccountSummary | null;
}) {
  const label =
    item.tool === "image_generate"
      ? "Creating your image"
      : item.tool === "video_generate"
        ? "Creating your video"
        : item.tool === "music_generate"
          ? "Creating your audio"
          : "Creating media";
  return (
    <AgentRow sender={sender} showAvatar={false}>
      <div
        className="w-64 max-w-full"
        role="status"
        aria-live="polite"
        aria-label={`${label}…`}
      >
        <div className="relative aspect-square overflow-hidden rounded-xl border border-edge/70 bg-foreground/[0.04]">
          <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-foreground/[0.02] via-foreground/[0.08] to-accent/[0.08]" />
          <div className="absolute inset-x-8 bottom-8 top-8 animate-pulse rounded-lg border border-edge/60 bg-background/20" />
        </div>
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-faint">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
          </span>
          {label}…
        </p>
      </div>
    </AgentRow>
  );
}

/** Freshly attached media that has no fetched server row yet. */
export function MediaBubble({
  item,
  sender,
}: {
  item: MediaItem;
  sender: AccountSummary | null;
}) {
  return (
    <AgentRow sender={sender} showAvatar={false}>
      <AttachmentList attachments={item.attachments} />
    </AgentRow>
  );
}

export function InlineError({
  item,
  onRetry,
  onDismiss,
}: {
  item: ErrorItem;
  onRetry?: (content: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex justify-center">
      <div className="flex max-w-lg flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-danger/25 bg-danger/[0.06] px-4 py-2.5 text-xs text-danger-soft/90">
        <span className="min-w-0 break-words">
          {item.message || "The turn failed."}
          {item.code ? (
            <span className="ml-1.5 font-mono text-[10px] text-danger-soft/50">
              {item.code}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          {item.retryContent && onRetry ? (
            <button
              type="button"
              onClick={() => onRetry(item.retryContent ?? "")}
              className="rounded-md border border-danger/30 px-2 py-1 transition-colors hover:border-danger-soft/60 hover:text-danger-soft"
            >
              Retry
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss error"
            className="rounded-md px-1.5 py-1 text-danger-soft/60 transition-colors hover:text-danger-soft"
          >
            ✕
          </button>
        </span>
      </div>
    </div>
  );
}
