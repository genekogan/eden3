"use client";

/**
 * One tile in the explore masonry. The media is the whole card: natural
 * aspect ratio (clamped by feedAspectRatio), no chrome. Attribution appears
 * as a small placard on hover/focus — display-only here, since the entire
 * tile is one link to the permalink (where the real creator/agent links
 * live). Videos carry a quiet always-on glyph so the Video filter reads.
 */

import Link from "next/link";
import type { CreationDto } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { MediaThumb } from "@/components/media";
import { feedAspectRatio, isVideoCreation, promptOf } from "./creation-fields";

function PlayGlyph() {
  return (
    <span
      aria-hidden
      className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-black/55 text-white/85"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="ml-px size-3">
        <path d="M8 5.5v13l11-6.5z" />
      </svg>
    </span>
  );
}

export function CreationCard({ creation }: { creation: CreationDto }) {
  const agent = creation.agent ?? null;
  const creator = creation.creator ?? null;
  const byline = agent ?? creator;
  const secondary =
    agent && creator && creator.username !== agent.username ? creator : null;
  const video = isVideoCreation(creation);
  const prompt = promptOf(creation);
  const label = prompt
    ? prompt.length > 140
      ? `${prompt.slice(0, 139)}…`
      : prompt
    : `${creation.tool ?? "creation"}${byline ? ` by ${byline.username}` : ""}`;

  return (
    <Link
      href={`/creations/${encodeURIComponent(creation.id)}`}
      aria-label={label}
      className="group relative mb-3 block break-inside-avoid overflow-hidden rounded-xl"
      style={{ aspectRatio: String(feedAspectRatio(creation)) }}
    >
      <MediaThumb
        creation={creation}
        alt={prompt ?? undefined}
        className="h-full w-full"
      />
      {video ? <PlayGlyph /> : null}
      {byline ? (
        <span className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-black/65 py-1 pl-1 pr-2.5 opacity-0 transition-opacity duration-200 group-focus-visible:opacity-100 group-hover:opacity-100">
          <AgentAvatar account={byline} size={18} className="border-white/15" />
          <span className="truncate text-xs leading-none text-white/90">
            {byline.username}
          </span>
          {secondary ? (
            <span className="truncate text-xs leading-none text-white/50">
              · {secondary.username}
            </span>
          ) : null}
        </span>
      ) : null}
    </Link>
  );
}
