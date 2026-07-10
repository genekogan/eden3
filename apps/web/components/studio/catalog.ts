/**
 * Studio domain logic — pure helpers behind the /studio surface.
 *
 * The tool registry is api-owned (GET /api/studio/tools) and still landing,
 * so everything here is defensive: category, label, latency hints and the
 * optional duration field are derived from whatever fields exist on the
 * StudioTool, and FALLBACK_TOOLS keeps the surface navigable when the
 * registry 501s (canonical OpenClaw tool names + launch metered pricing).
 *
 * Relative imports (not "@/…") so vitest can load this without alias config.
 */

import { ApiError, isEndpointMissing } from "../../lib/api";
import type { StudioTool, StudioToolModelOption } from "../../lib/types";

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type StudioCategory = "image" | "video" | "music" | "speech" | "other";

const CATEGORY_ORDER: readonly StudioCategory[] = [
  "image",
  "video",
  "music",
  "speech",
  "other",
];

/** Best-effort bucket for a tool — drives icon, copy, and latency hints. */
export function categorizeTool(tool: StudioTool): StudioCategory {
  const name = tool.name.toLowerCase();
  if (name.includes("image") || name.includes("img")) return "image";
  if (name.includes("video")) return "video";
  if (name.includes("music") || name.includes("song")) return "music";
  if (
    name.includes("tts") ||
    name.includes("speech") ||
    name.includes("speak") ||
    name.includes("voice")
  ) {
    return "speech";
  }
  const output =
    typeof tool.outputType === "string" ? tool.outputType.toLowerCase() : "";
  if (output.includes("image")) return "image";
  if (output.includes("video")) return "video";
  if (output.includes("speech")) return "speech";
  if (output.includes("audio") || output.includes("music")) return "music";
  return "other";
}

/** Card order: image, video, music, speech, then anything else (stable). */
export function sortTools(tools: StudioTool[]): StudioTool[] {
  return [...tools].sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(categorizeTool(a)) -
      CATEGORY_ORDER.indexOf(categorizeTool(b)),
  );
}

const CANONICAL_LABELS: Record<string, string> = {
  image_generate: "Image",
  video_generate: "Video",
  music_generate: "Music",
  tts: "Speech",
};

/** "image_generate" -> "Image"; unknown names get a tidy title-case. */
export function toolLabel(tool: StudioTool): string {
  const canonical = CANONICAL_LABELS[tool.name];
  if (canonical) return canonical;
  const words = tool.name
    .replace(/[_-]+/g, " ")
    .replace(/\bgenerate\b/gi, "")
    .trim();
  if (!words) return tool.name;
  return words
    .split(/\s+/)
    .map((word) => (word[0]?.toUpperCase() ?? "") + word.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Fallback catalog (registry down/501) — canonical names, launch metered pricing
// ---------------------------------------------------------------------------

export const FALLBACK_TOOLS: StudioTool[] = [
  {
    name: "image_generate",
    description: "Generate an image from a text prompt.",
    outputType: "image",
    costManna: 34,
    models: [
      { key: "flux-dev", label: "Standard · Flux", costManna: 34, default: true },
      { key: "gemini-pro", label: "Premium · Gemini 3 Pro", costManna: 181 },
    ],
    parameters: null,
  },
  {
    name: "video_generate",
    description: "Generate a short video clip.",
    outputType: "video",
    costManna: 608,
    parameters: {
      properties: { duration: { type: "number", minimum: 2, maximum: 10, default: 5 } },
    },
  },
  {
    name: "music_generate",
    description: "Compose a piece of music from a description.",
    outputType: "audio",
    costManna: 54,
    parameters: {
      properties: { duration: { type: "number", minimum: 5, maximum: 120, default: 30 } },
    },
  },
  {
    name: "tts",
    description: "Speak text aloud in an expressive voice.",
    outputType: "audio",
    costManna: 28,
    parameters: null,
  },
];

// ---------------------------------------------------------------------------
// Latency expectations + progress copy
// ---------------------------------------------------------------------------

/** Rough wall-clock budget in seconds — the progress bar eases toward it. */
export function expectedSeconds(category: StudioCategory): number {
  switch (category) {
    case "image":
      return 75;
    case "video":
      return 420;
    case "music":
      return 150;
    case "speech":
      return 30;
    default:
      return 120;
  }
}

/** Short latency hint shown on cards and during generation. */
export function latencyHint(category: StudioCategory): string {
  switch (category) {
    case "image":
      return "10s – 2 min";
    case "video":
      return "up to 10 min";
    case "music":
      return "a few minutes";
    case "speech":
      return "under a minute";
    default:
      return "a minute or two";
  }
}

const STATUS_LINES: Record<StudioCategory, readonly string[]> = {
  image: [
    "Priming the canvas",
    "Mixing pigments",
    "Sketching the composition",
    "Refining the details",
    "One more denoising pass",
    "Signing the corner",
  ],
  video: [
    "Storyboarding the shot",
    "Blocking the scene",
    "Rendering frames",
    "Interpolating the motion",
    "Grading the colors",
    "Cutting the final frames",
  ],
  music: [
    "Tuning the instruments",
    "Finding a tempo",
    "Laying down the rhythm",
    "Layering harmonies",
    "Balancing the mix",
    "Mastering the track",
  ],
  speech: [
    "Warming up the voice",
    "Reading the script",
    "Finding the right intonation",
    "Recording the take",
    "Polishing the sibilants",
  ],
  other: [
    "Warming up the model",
    "Gathering entropy",
    "Shaping the output",
    "Nearly there",
  ],
};

/** Stable per-category array (identity matters for rotation hooks). */
export function statusLines(category: StudioCategory): readonly string[] {
  return STATUS_LINES[category];
}

/** Rotation once a job runs past its expected budget. */
export const OVERTIME_LINES: readonly string[] = [
  "Taking longer than usual — still working",
  "Big jobs take time",
  "The request is still open",
  "Good things, slow ovens",
];

export function promptPlaceholder(category: StudioCategory): string {
  switch (category) {
    case "image":
      return "Describe the image — subject, style, light…";
    case "video":
      return "Describe the video — scene, motion, mood…";
    case "music":
      return "Describe the music — genre, tempo, instrumentation…";
    case "speech":
      return "Write the words to be spoken…";
    default:
      return "Describe what to generate…";
  }
}

// ---------------------------------------------------------------------------
// Parameter schema (JSON-schema-ish; shape not part of the contract)
// ---------------------------------------------------------------------------

function schemaProperties(tool: StudioTool): Record<string, unknown> | null {
  const params = tool.parameters;
  if (!params || typeof params !== "object") return null;
  const props = (params as Record<string, unknown>).properties;
  if (props && typeof props === "object") {
    return props as Record<string, unknown>;
  }
  // Some registries put the property map at the top level.
  return params as Record<string, unknown>;
}

/** Arg key for the main text input — "prompt" unless the schema says "text". */
export function promptKey(tool: StudioTool): "prompt" | "text" {
  const props = schemaProperties(tool);
  if (props) {
    if ("prompt" in props) return "prompt";
    if ("text" in props) return "text";
  }
  return categorizeTool(tool) === "speech" ? "text" : "prompt";
}

export interface DurationSpec {
  min: number | null;
  max: number | null;
  defaultValue: number | null;
}

/**
 * Optional duration field (seconds) — only when the tool's schema exposes a
 * `duration` property (video/music). Returns null otherwise.
 */
export function durationSpec(tool: StudioTool): DurationSpec | null {
  const props = schemaProperties(tool);
  const raw = props?.["duration"];
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    min: num(rec.minimum) ?? num(rec.min),
    max: num(rec.maximum) ?? num(rec.max),
    defaultValue: num(rec.default),
  };
}

/** Model tier options exposed by the tool, when it has more than one. */
export function modelOptions(tool: StudioTool): StudioToolModelOption[] {
  return Array.isArray(tool.models) && tool.models.length > 1 ? tool.models : [];
}

/** The tool's default model key ("" when the tool has no model tiers). */
export function defaultModelKey(tool: StudioTool): string {
  const options = modelOptions(tool);
  return options.find((o) => o.default)?.key ?? options[0]?.key ?? "";
}

/** Args for POST /api/studio/generate — prompt (or text) + optional duration/model. */
export function buildArgs(
  tool: StudioTool,
  prompt: string,
  duration: string,
  model = "",
): Record<string, unknown> {
  const args: Record<string, unknown> = { [promptKey(tool)]: prompt.trim() };
  if (durationSpec(tool) && duration.trim() !== "") {
    const seconds = Number(duration);
    if (Number.isFinite(seconds) && seconds > 0) args.duration = seconds;
  }
  if (model && modelOptions(tool).some((o) => o.key === model)) {
    args.model = model;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Result media kind (music/tts need <audio>, which shared MediaFull lacks)
// ---------------------------------------------------------------------------

const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "ogg",
  "oga",
  "m4a",
  "flac",
  "aac",
  "opus",
]);

function extensionOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const path = url.split(/[?#]/, 1)[0] ?? "";
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return path.slice(dot + 1).toLowerCase();
}

/**
 * True when a generation result should render as an <audio> player: known
 * audio extension, or an extension-less URL from a music/speech tool.
 */
export function isAudioResult(
  url: string | null | undefined,
  category: StudioCategory,
): boolean {
  const ext = extensionOf(url);
  if (ext) return AUDIO_EXTENSIONS.has(ext);
  return category === "music" || category === "speech";
}

// ---------------------------------------------------------------------------
// Failure copy
// ---------------------------------------------------------------------------

export interface GenerateFailure {
  title: string;
  detail: string | null;
  /** Show the "manna refunded" notice (spend happened, then failed). */
  refunded: boolean;
  /** Endpoint not implemented yet — nothing was charged. */
  missing: boolean;
  /** 402 — link to /manna. */
  insufficient: boolean;
}

function bodyMessage(error: ApiError): string | null {
  const body = error.body;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["message", "error", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

/** Map a thrown generate() error onto user-facing copy. */
export function describeFailure(error: unknown): GenerateFailure {
  if (isEndpointMissing(error)) {
    return {
      title: "Studio isn't live yet",
      detail:
        "The generation endpoint hasn't landed on the API — nothing was charged. Try again once the backend is up.",
      refunded: false,
      missing: true,
      insufficient: false,
    };
  }
  if (error instanceof ApiError) {
    if (error.status === 402) {
      return {
        title: "Not enough manna",
        detail:
          bodyMessage(error) ?? "This tool costs more than your current balance.",
        refunded: false,
        missing: false,
        insufficient: true,
      };
    }
    return {
      title: "Generation failed",
      detail: bodyMessage(error) ?? error.message,
      refunded: true,
      missing: false,
      insufficient: false,
    };
  }
  return {
    title: "Connection lost",
    detail:
      "The request didn't complete. If the job failed server-side any charge is refunded automatically — and if it finished, the result will still land in your creations.",
    refunded: false,
    missing: false,
    insufficient: false,
  };
}
