"use client";

/**
 * Round avatar for agents and users. Renders the account image verbatim
 * (configured HTTPS URL or local /media path) — except bare legacy filenames,
 * which require an operator-configured origin — and falls back to the username's
 * initial on a violet-tinted disc when there is no image or it fails to load.
 */

import React, { useEffect, useState } from "react";

/**
 * Legacy accounts store userImage as a bare CDN filename ("ab12….jpg") rather
 * than an absolute URL or a rooted /media path; resolve those against the
 * legacy CloudFront distribution the creations themselves serve from.
 * Anything absolute or rooted still renders verbatim.
 */
const LEGACY_MEDIA_ORIGIN = (process.env.NEXT_PUBLIC_LEGACY_MEDIA_ORIGIN ?? "").replace(/\/$/, "");

function resolveAccountImage(url: string | null): string | null {
  if (!url) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(url)) return url; // absolute or rooted
  return LEGACY_MEDIA_ORIGIN ? `${LEGACY_MEDIA_ORIGIN}/${url}` : null;
}

export function AgentAvatar({
  account,
  src,
  name,
  size = 32,
  className,
}: {
  /** Any account-shaped object — agent, embedded summary, or dev user. */
  account?: { username: string; userImage?: string | null };
  /** Explicit image URL (overrides account.userImage). */
  src?: string | null;
  /** Explicit display name (overrides account.username). */
  name?: string | null;
  /** Pixel size (default 32). */
  size?: number;
  className?: string;
}) {
  const url = resolveAccountImage(src ?? account?.userImage ?? null);
  const label = name ?? account?.username ?? "?";
  const [broken, setBroken] = useState(false);

  // A new URL gets a fresh chance (e.g. after impersonating someone else).
  useEffect(() => setBroken(false), [url]);

  const style = { width: size, height: size };
  const showImage = url && !broken;

  if (showImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- media URLs are
      // rendered verbatim (legacy CDN or local /media), no optimizer.
      <img
        src={url}
        alt={label}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full border border-edge bg-raised object-cover ${className ?? ""}`}
        style={style}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`flex shrink-0 select-none items-center justify-center rounded-full border border-accent/25 bg-accent/10 font-medium uppercase text-accent-soft ${className ?? ""}`}
      style={{ ...style, fontSize: Math.max(10, Math.round(size * 0.42)) }}
    >
      {label.trim().charAt(0) || "?"}
    </span>
  );
}
