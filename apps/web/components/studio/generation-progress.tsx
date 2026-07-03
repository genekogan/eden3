"use client";

/**
 * In-flight generation panel. The POST stays open until the file is ready
 * (image ~10–120s, video minutes), so this renders the waiting time:
 * an elapsed timer, rotating status lines (overtime copy once the job runs
 * past its budget), and a progress bar that eases toward — but never
 * reaches — done. Cancel aborts the fetch.
 */

import { useEffect, useRef, useState } from "react";
import {
  OVERTIME_LINES,
  expectedSeconds,
  latencyHint,
  statusLines,
  type StudioCategory,
} from "./catalog";

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Rotate through `lines`, fading out/in on each swap. */
function useRotatingLine(
  lines: readonly string[],
  periodMs = 6000,
): { text: string; visible: boolean } {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const swapTimeout = useRef<number | null>(null);

  useEffect(() => {
    setIndex(0);
    setVisible(true);
    const rotate = window.setInterval(() => {
      setVisible(false);
      swapTimeout.current = window.setTimeout(() => {
        setIndex((i) => i + 1);
        setVisible(true);
      }, 350);
    }, periodMs);
    return () => {
      window.clearInterval(rotate);
      if (swapTimeout.current != null) window.clearTimeout(swapTimeout.current);
    };
  }, [lines, periodMs]);

  return { text: lines[index % lines.length] ?? "", visible };
}

export function GenerationProgress({
  startedAt,
  category,
  prompt,
  toolLabel,
  onCancel,
}: {
  startedAt: number;
  category: StudioCategory;
  prompt: string;
  toolLabel: string;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const expected = expectedSeconds(category);
  const overtime = elapsed > expected;
  const percent = Math.min(96, (elapsed / expected) * 100);
  const { text, visible } = useRotatingLine(
    overtime ? OVERTIME_LINES : statusLines(category),
  );

  return (
    <div className="rounded-xl border border-edge bg-surface p-6">
      <p className="text-xs text-faint">
        Generating {toolLabel.toLowerCase()} · usually {latencyHint(category)}
      </p>
      <p className="mt-2 line-clamp-2 text-sm text-muted">&ldquo;{prompt}&rdquo;</p>

      <div className="mt-8 flex items-baseline justify-between gap-4">
        <span
          aria-live="polite"
          className={`text-sm text-foreground transition-opacity duration-300 ${
            visible ? "opacity-100" : "opacity-0"
          }`}
        >
          {text}…
        </span>
        <span className="font-mono text-xs tabular-nums text-faint">
          {formatElapsed(elapsed)}
        </span>
      </div>

      <div className="mt-3 h-1 overflow-hidden rounded-full bg-raised">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="mt-5 flex items-center justify-between gap-4">
        <p className="text-xs text-faint">
          The request stays open until the file is ready — keep this tab around.
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-md border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
