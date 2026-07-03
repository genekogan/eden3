"use client";

/**
 * Finished-generation panel: the media itself (hero), then quiet actions —
 * generate again, edit the prompt, open the creation permalink. Music/speech
 * results render an <audio> card (shared MediaFull only handles image/video);
 * everything else goes through MediaFull with extension-based detection.
 */

import Link from "next/link";
import { MediaFull } from "@/components/media";
import type { StudioGeneration } from "@/lib/types";
import { isAudioResult, type StudioCategory } from "./catalog";
import { MannaAmount } from "./manna-amount";
import { ToolIcon } from "./tool-picker";

export function ResultPanel({
  result,
  category,
  prompt,
  cost,
  onAgain,
  onNewPrompt,
}: {
  result: StudioGeneration;
  category: StudioCategory;
  prompt: string;
  cost: number | null;
  onAgain: () => void;
  onNewPrompt: () => void;
}) {
  const audio = isAudioResult(result.url, category);

  return (
    <div className="space-y-4">
      {audio ? (
        <div className="rounded-xl border border-edge bg-raised p-5">
          <div className="mb-4 flex items-center gap-3">
            <ToolIcon
              category={category}
              className="size-5 shrink-0 text-accent-soft"
            />
            <p className="min-w-0 truncate text-sm text-muted">{prompt}</p>
          </div>
          <audio src={result.url} controls preload="metadata" className="w-full" />
        </div>
      ) : (
        <MediaFull url={result.url} alt={prompt} autoPlay />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onAgain}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-soft"
        >
          Generate again
          {cost != null ? (
            <MannaAmount amount={cost} className="text-white/75" />
          ) : null}
        </button>
        <button
          type="button"
          onClick={onNewPrompt}
          className="rounded-lg border border-edge px-4 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
        >
          New prompt
        </button>
        <Link
          href={`/creations/${encodeURIComponent(result.creationId)}`}
          className="ml-auto text-xs text-accent-soft transition-colors hover:text-accent"
        >
          Open creation &rarr;
        </Link>
      </div>
    </div>
  );
}
