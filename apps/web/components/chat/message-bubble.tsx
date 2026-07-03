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
 * quiet caption link to the creation permalink.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { MediaFull } from "@/components/media";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { AccountSummary, MessageAttachment, MessageDto } from "@/lib/types";
import { Markdown } from "./markdown";
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

function AttachmentList({ attachments }: { attachments: MessageAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-3">
      {attachments.map((attachment, index) => (
        <figure key={`${attachment.url}:${index}`} className="max-w-md">
          <MediaFull
            url={attachment.url}
            mime={attachment.mime ?? null}
            alt="attachment"
          />
          {attachment.creationId ? (
            <figcaption className="mt-1.5 text-right">
              <Link
                href={`/creations/${attachment.creationId}`}
                className="text-[11px] text-faint transition-colors hover:text-accent-soft"
              >
                open creation →
              </Link>
            </figcaption>
          ) : null}
        </figure>
      ))}
    </div>
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

/** Left column: agent avatar + name/time meta + content. */
function AgentRow({
  sender,
  meta,
  showAvatar = true,
  children,
}: {
  sender: AccountSummary | null;
  /** Right side of the name line (usually a timestamp). */
  meta?: string;
  showAvatar?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="group flex gap-3">
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
          <p className="mb-1 flex items-baseline gap-2 text-xs">
            <span className="font-medium text-muted">
              {sender?.username ?? "agent"}
            </span>
            {meta ? (
              <span className="text-faint opacity-0 transition-opacity group-hover:opacity-100">
                {meta}
              </span>
            ) : null}
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
    <div className="flex justify-end">
      <div
        className={`max-w-[85%] rounded-2xl rounded-br-md border border-accent/20 bg-accent/[0.13] px-4 py-2.5 sm:max-w-[70%] ${
          pending ? "opacity-80" : ""
        }`}
        {...(at ? { title: formatDateTime(at) } : {})}
      >
        {attachments && attachments.length > 0 ? (
          <AttachmentList attachments={attachments} />
        ) : null}
        <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground">
          {content}
        </p>
      </div>
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
  const hasText = (message.content ?? "").trim().length > 0;
  return (
    <AgentRow
      sender={sender}
      meta={formatRelativeTime(message.createdAt)}
      showAvatar={showAvatar}
    >
      {hasText ? <Markdown text={message.content ?? ""} /> : null}
      {message.toolCalls && message.toolCalls.length > 0 ? (
        <ToolCallDisclosure
          label={`tool · ${message.toolCalls.length} call${message.toolCalls.length > 1 ? "s" : ""}`}
          payload={message.toolCalls}
        />
      ) : null}
      <AttachmentList attachments={message.attachments} />
    </AgentRow>
  );
}

// ---------------------------------------------------------------------------
// Live tail items
// ---------------------------------------------------------------------------

export function UserEchoBubble({ item }: { item: UserEchoItem }) {
  return <UserBubble content={item.content} at={item.at} pending />;
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
  return (
    <AgentRow sender={sender} showAvatar={false}>
      <div className="w-64 max-w-full">
        <div className="relative aspect-square animate-pulse overflow-hidden rounded-xl border border-edge/70 bg-white/[0.04]" />
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-faint">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
          </span>
          creating with <span className="font-mono">{item.tool}</span>…
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
      <div className="flex max-w-lg flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-red-500/25 bg-red-500/[0.06] px-4 py-2.5 text-xs text-red-200/90">
        <span className="min-w-0 break-words">
          {item.message || "The turn failed."}
          {item.code ? (
            <span className="ml-1.5 font-mono text-[10px] text-red-200/50">
              {item.code}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          {item.retryContent && onRetry ? (
            <button
              type="button"
              onClick={() => onRetry(item.retryContent ?? "")}
              className="rounded-md border border-red-400/30 px-2 py-1 transition-colors hover:border-red-300/60 hover:text-red-100"
            >
              Retry
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss error"
            className="rounded-md px-1.5 py-1 text-red-200/60 transition-colors hover:text-red-100"
          >
            ✕
          </button>
        </span>
      </div>
    </div>
  );
}
