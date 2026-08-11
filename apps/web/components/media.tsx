"use client";

/**
 * Media rendering — the hero of every surface.
 *
 *   <MediaThumb creation={c} />   grid/list tile: thumbnail-first, lazy,
 *                                 blurhash placeholder, hover-plays videos.
 *   <MediaFull creation={c} />    permalink/lightbox: full asset, <video>
 *                                 or <audio> with controls when applicable,
 *                                 <img> otherwise.
 *
 * URLs render verbatim: legacy creations point at CloudFront/S3 absolute
 * URLs, new ones at local /media/... paths (proxied to the api). Element
 * choice is by file extension (mp4/webm -> <video>) with mime as an
 * override when the caller has one (e.g. media.attached events).
 */

import React, { useEffect, useRef, useState } from "react";
import type { CreationDto } from "@/lib/types";
import { decodeBlurhash } from "@/lib/blurhash";
import { promptOf } from "@/components/feed/creation-fields";

const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]);

/** True when the URL (or explicit mime) should render as <video>. */
export function isVideoMedia(
  url: string | null | undefined,
  mime?: string | null,
): boolean {
  if (mime) return mime.startsWith("video/");
  if (!url) return false;
  const path = url.split(/[?#]/, 1)[0] ?? "";
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return VIDEO_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** True when the URL (or explicit mime) should render as <audio>. */
export function isAudioMedia(
  url: string | null | undefined,
  mime?: string | null,
): boolean {
  if (mime) return mime.startsWith("audio/");
  if (!url) return false;
  const path = url.split(/[?#]/, 1)[0] ?? "";
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return AUDIO_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

interface MediaSource {
  url: string | null;
  thumbnailUrl: string | null;
  mime: string | null;
  alt: string;
  blurhash: string | null;
  width: number | null;
  height: number | null;
}

function resolveSource(
  creation: CreationDto | undefined,
  overrides: Partial<MediaSource>,
): MediaSource {
  const attrs = creation?.mediaAttributes ?? {};
  const attr = (key: string): unknown => (attrs as Record<string, unknown>)[key];
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : null;
  return {
    url: overrides.url ?? creation?.url ?? null,
    thumbnailUrl: overrides.thumbnailUrl ?? creation?.thumbnailUrl ?? null,
    mime:
      overrides.mime ??
      (typeof attr("mimeType") === "string" ? (attr("mimeType") as string) : null),
    alt:
      overrides.alt ??
      // The prompt is the most descriptive alt text for AI-generated art —
      // trimmed for screen readers; fall back to filename, then a generic.
      (creation ? promptOf(creation)?.slice(0, 200) ?? null : null) ??
      creation?.filename ??
      (creation?.tool ? `${creation.tool} creation` : "creation"),
    blurhash:
      overrides.blurhash ??
      (typeof attr("blurhash") === "string" ? (attr("blurhash") as string) : null),
    width: overrides.width ?? num(attr("width")),
    height: overrides.height ?? num(attr("height")),
  };
}

/** Tiny canvas painted with the creation's blurhash (behind the real asset). */
function BlurhashCanvas({ hash }: { hash: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const pixels = decodeBlurhash(hash, 32, 32);
    const ctx = canvas.getContext("2d");
    if (!pixels || !ctx) return;
    const imageData = ctx.createImageData(32, 32);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
  }, [hash]);

  return (
    <canvas
      ref={ref}
      width={32}
      height={32}
      aria-hidden
      className="absolute inset-0 h-full w-full"
    />
  );
}

/**
 * Grid/list tile. Prefers thumbnailUrl (usually a still, even for videos);
 * falls back to the full asset. Videos are muted, looped, and play on hover.
 */
export function MediaThumb({
  creation,
  url,
  thumbnailUrl,
  mime,
  alt,
  blurhash,
  className,
}: {
  creation?: CreationDto;
  url?: string | null;
  thumbnailUrl?: string | null;
  mime?: string | null;
  alt?: string;
  blurhash?: string | null;
  className?: string;
}) {
  const source = resolveSource(creation, {
    ...(url !== undefined ? { url } : {}),
    ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
    ...(mime !== undefined ? { mime } : {}),
    ...(alt !== undefined ? { alt } : {}),
    ...(blurhash !== undefined ? { blurhash } : {}),
  });
  const display = source.thumbnailUrl ?? source.url;
  // mime describes the primary asset — only trust it when showing that asset.
  const video = isVideoMedia(
    display,
    display === source.url ? source.mime : null,
  );
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // A new URL gets a fresh chance (tiles can be re-rendered with new data).
  useEffect(() => setBroken(false), [display]);

  // Cached media can finish before React attaches onLoad/onLoadedData —
  // catch already-complete elements at ref time or the tile stays faded out.
  const markImgComplete = (node: HTMLImageElement | null) => {
    if (node?.complete && node.naturalWidth > 0) setLoaded(true);
  };

  const wrapper = `relative block overflow-hidden rounded-xl bg-raised ${className ?? "aspect-square"}`;

  // Missing url and undecodable file (zero-byte/pending uploads) get the
  // same quiet placeholder — never the browser's broken-image glyph.
  if (!display || broken) {
    return (
      <div className={wrapper}>
        <div className="flex h-full w-full items-center justify-center text-xs text-faint">
          no media
        </div>
      </div>
    );
  }

  const mediaClass = `absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`;

  return (
    <div className={wrapper}>
      {source.blurhash && !loaded ? (
        <BlurhashCanvas hash={source.blurhash} />
      ) : null}
      {video ? (
        <video
          ref={(node) => {
            videoRef.current = node;
            if (node && node.readyState >= 2) setLoaded(true);
          }}
          src={display}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedData={() => setLoaded(true)}
          onMouseEnter={() => void videoRef.current?.play().catch(() => {})}
          onMouseLeave={() => videoRef.current?.pause()}
          className={mediaClass}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- URLs render
        // verbatim (legacy CDN or local /media), no optimizer.
        <img
          ref={markImgComplete}
          src={display}
          alt={source.alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setBroken(true)}
          className={mediaClass}
        />
      )}
    </div>
  );
}

/**
 * Full-size rendering for permalinks and chat attachments. Constrains to the
 * container width, keeps the intrinsic aspect ratio, controls for video.
 */
export function MediaFull({
  creation,
  url,
  mime,
  alt,
  blurhash,
  width,
  height,
  className,
  autoPlay = false,
}: {
  creation?: CreationDto;
  url?: string | null;
  mime?: string | null;
  alt?: string;
  blurhash?: string | null;
  width?: number | null;
  height?: number | null;
  className?: string;
  /** Autoplay (muted) — for freshly attached chat media. */
  autoPlay?: boolean;
}) {
  const source = resolveSource(creation, {
    ...(url !== undefined ? { url } : {}),
    ...(mime !== undefined ? { mime } : {}),
    ...(alt !== undefined ? { alt } : {}),
    ...(blurhash !== undefined ? { blurhash } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  });
  const display = source.url ?? source.thumbnailUrl;
  const directMime = display === source.url ? source.mime : null;
  const video = isVideoMedia(display, directMime);
  const audio = isAudioMedia(display, directMime);
  const [loaded, setLoaded] = useState(false);

  // Same cached-media race as MediaThumb: mark complete elements at ref time.
  const markImgComplete = (node: HTMLImageElement | null) => {
    if (node?.complete) setLoaded(true);
  };
  const markVideoReady = (node: HTMLVideoElement | null) => {
    if (node && node.readyState >= 2) setLoaded(true);
  };

  if (!display) {
    return (
      <div
        className={`flex aspect-square items-center justify-center rounded-xl bg-raised text-sm text-faint ${className ?? ""}`}
      >
        no media
      </div>
    );
  }

  const ratio =
    source.width && source.height
      ? { aspectRatio: `${source.width} / ${source.height}` }
      : undefined;

  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-raised ${audio ? "p-3" : ""} ${className ?? ""}`}
      style={audio ? undefined : ratio}
    >
      {!audio && source.blurhash && !loaded ? (
        <BlurhashCanvas hash={source.blurhash} />
      ) : null}
      {audio ? (
        <audio
          src={display}
          controls
          preload="metadata"
          aria-label={source.alt}
          className="w-full"
        />
      ) : video ? (
        <video
          ref={markVideoReady}
          src={display}
          controls
          loop
          playsInline
          autoPlay={autoPlay}
          muted={autoPlay}
          preload="metadata"
          poster={
            source.thumbnailUrl && !isVideoMedia(source.thumbnailUrl)
              ? source.thumbnailUrl
              : undefined
          }
          onLoadedData={() => setLoaded(true)}
          className={`h-auto w-full ${ratio ? "absolute inset-0 h-full object-contain" : ""} ${loaded ? "opacity-100" : "opacity-0"} transition-opacity duration-300`}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- URLs render
        // verbatim (legacy CDN or local /media), no optimizer.
        <img
          ref={markImgComplete}
          src={display}
          alt={source.alt}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(true)}
          className={`h-auto w-full ${ratio ? "absolute inset-0 h-full object-contain" : ""} ${loaded ? "opacity-100" : "opacity-0"} transition-opacity duration-300`}
        />
      )}
    </div>
  );
}
