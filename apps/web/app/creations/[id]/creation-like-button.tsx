"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { CreationDto } from "@/lib/types";

interface CreationLikeButtonProps {
  creation: Pick<CreationDto, "id" | "likeCount" | "viewerHasLiked">;
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-4"
    >
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z" />
    </svg>
  );
}

export function CreationLikeButton({ creation }: CreationLikeButtonProps) {
  const [liked, setLiked] = useState(Boolean(creation.viewerHasLiked));
  const [count, setCount] = useState(creation.likeCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void api.creations
      .get(creation.id)
      .then((fresh) => {
        if (!alive.current) return;
        setLiked(Boolean(fresh.viewerHasLiked));
        setCount(fresh.likeCount);
      })
      .catch(() => {
        // The server-rendered detail already has the public count; keep it.
      });
    return () => {
      alive.current = false;
    };
  }, [creation.id]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = liked
        ? await api.creations.unlike(creation.id)
        : await api.creations.like(creation.id);
      if (!alive.current) return;
      setLiked(Boolean(fresh.viewerHasLiked));
      setCount(fresh.likeCount);
    } catch (toggleError) {
      if (!alive.current) return;
      if (toggleError instanceof ApiError && toggleError.status === 401) {
        setError("Sign in to like creations.");
      } else {
        setError(toggleError instanceof Error ? toggleError.message : "Couldn't update like.");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        aria-pressed={liked}
        disabled={busy}
        onClick={() => void toggle()}
        className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          liked
            ? "border-rose-300/50 bg-rose-300/10 text-rose-200"
            : "border-edge text-muted hover:border-accent/50 hover:text-foreground"
        }`}
      >
        <HeartIcon filled={liked} />
        <span>{liked ? "Liked" : "Like"}</span>
        <span className="font-mono text-[11px] text-faint">{count}</span>
      </button>
      {error ? <p className="text-xs text-rose-300">{error}</p> : null}
    </div>
  );
}
