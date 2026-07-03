/**
 * Tolerant readers for the loose parts of a creation.
 *
 * The CreationDto contract guarantees url/thumbnailUrl/tool/timestamps, but
 * the interesting display fields — prompt, generation args, dimensions, a
 * session backlink — live in `mediaAttributes` (jsonb) or in extra keys the
 * api may embed. These helpers probe those spots without trusting any of
 * them, so surfaces render whatever exists and stay quiet about the rest.
 *
 * Plain module (no "use client") so both server pages (creation permalink)
 * and client components (feed cards) can share it. Kept free of `@/` aliases
 * so vitest can resolve it without extra config.
 */

import type { CreationDto } from "@eden3/shared";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Extra top-level keys the api may send beyond the typed DTO. */
function looseOf(creation: CreationDto): Record<string, unknown> {
  return creation as unknown as Record<string, unknown>;
}

function attrsOf(creation: CreationDto): Record<string, unknown> {
  return asRecord(creation.mediaAttributes);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

// ---------------------------------------------------------------------------
// Media shape
// ---------------------------------------------------------------------------

/** Explicit mime, when mediaAttributes carries one. */
export function mimeOf(creation: CreationDto): string | null {
  const attrs = attrsOf(creation);
  return firstString(attrs.mimeType, attrs.mime);
}

/** Pixel dimensions from mediaAttributes, when both are present and sane. */
export function dimensionsOf(
  creation: CreationDto,
): { width: number; height: number } | null {
  const attrs = attrsOf(creation);
  const width = positive(attrs.width);
  const height = positive(attrs.height);
  return width && height ? { width, height } : null;
}

/** Feed tiles keep their true ratio inside these bounds (width / height). */
export const FEED_RATIO_MIN = 0.55; // portrait cap: ~9:16
export const FEED_RATIO_MAX = 1.8; // landscape cap: ~16:9

/**
 * Aspect ratio (width / height) for a masonry tile: the creation's natural
 * ratio clamped to sane bounds, or 1 (square) when dimensions are unknown.
 */
export function feedAspectRatio(creation: CreationDto): number {
  const dims = dimensionsOf(creation);
  if (!dims) return 1;
  return Math.min(
    FEED_RATIO_MAX,
    Math.max(FEED_RATIO_MIN, dims.width / dims.height),
  );
}

const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);

/**
 * Extension/mime sniff for choosing <video> over <img> — mirrors
 * components/media.tsx (that module is client-only; this one must also run
 * in server components).
 */
export function isVideoAsset(
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

/** Whether the creation's primary asset is a video. */
export function isVideoCreation(creation: CreationDto): boolean {
  return isVideoAsset(creation.url, mimeOf(creation));
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Generation args, when the api includes them (top-level or in jsonb). */
export function argsOf(creation: CreationDto): Record<string, unknown> | null {
  const record = asRecord(looseOf(creation).args ?? attrsOf(creation).args);
  return Object.keys(record).length > 0 ? record : null;
}

const PROMPT_KEYS = ["prompt", "text_input", "text"] as const;

/** The human-readable prompt, wherever it lives (args, jsonb, extra key). */
export function promptOf(creation: CreationDto): string | null {
  const args = argsOf(creation) ?? {};
  const attrs = attrsOf(creation);
  const loose = looseOf(creation);
  for (const key of PROMPT_KEYS) {
    const found = firstString(args[key], attrs[key], loose[key]);
    if (found) return found;
  }
  return null;
}

/**
 * Session backlink (uuid or legacy 24-hex — /sessions/:id accepts both),
 * when the api includes a reference to the originating session.
 */
export function sessionRefOf(creation: CreationDto): string | null {
  const loose = looseOf(creation);
  const attrs = attrsOf(creation);
  const session = asRecord(loose.session);
  return firstString(
    loose.sessionId,
    session.id,
    session.externalId,
    attrs.sessionId,
    attrs.session_id,
  );
}
