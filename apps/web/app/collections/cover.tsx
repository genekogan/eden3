"use client";

/**
 * Collection cover art — shared by the /collections grid cards.
 *
 * Uses `coverCreations` when the API embeds them: a 2x2 mosaic when there are
 * four or more, otherwise the first one full-bleed. URLs render verbatim
 * (legacy CloudFront/S3 or local /media); mp4/webm covers render as muted
 * <video> stills. Falls back to a quiet glyph when there is no cover at all.
 */

import type { CollectionDto, CreationDto } from "@/lib/types";
import { isVideoMedia } from "@/components/media";

function CoverTile({ creation }: { creation: CreationDto }) {
  const src = creation.thumbnailUrl ?? creation.url;
  if (!src) return <div className="h-full w-full bg-raised" />;
  if (isVideoMedia(src)) {
    return (
      <video
        src={src}
        muted
        playsInline
        preload="metadata"
        aria-hidden
        className="h-full w-full object-cover"
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- media URLs render
    // verbatim (legacy CDN or local /media), no optimizer.
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-full w-full object-cover"
    />
  );
}

export function CollectionCover({ collection }: { collection: CollectionDto }) {
  const covers = (collection.coverCreations ?? []).filter(
    (creation) => creation.thumbnailUrl ?? creation.url,
  );

  if (covers.length >= 4) {
    return (
      <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-px bg-edge/60">
        {covers.slice(0, 4).map((creation) => (
          <CoverTile key={creation.id} creation={creation} />
        ))}
      </div>
    );
  }

  const first = covers[0];
  if (first) return <CoverTile creation={first} />;

  return (
    <div className="flex h-full w-full items-center justify-center bg-raised">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="size-7 text-faint/70"
      >
        <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
        <path d="M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
        <path d="M22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      </svg>
    </div>
  );
}
