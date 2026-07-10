const STUDIO_PREFILL_TOOLS = new Set([
  "image_generate",
  "video_generate",
  "music_generate",
  "tts",
]);

export interface StudioPrefill {
  tool: string | null;
  prompt: string;
  duration: string;
}

export function studioPrefillFromSearch(search: string): StudioPrefill {
  const params = new URLSearchParams(search);
  const rawTool = params.get("tool");
  const prompt = (params.get("prompt") ?? params.get("text") ?? "").trim();
  const duration = (params.get("duration") ?? "").trim();
  return {
    tool: rawTool && STUDIO_PREFILL_TOOLS.has(rawTool) ? rawTool : null,
    prompt,
    duration,
  };
}

export function studioRemixHref(input: {
  prompt: string | null | undefined;
  tool?: string | null;
  duration?: string | number | null;
}): string | null {
  const prompt = input.prompt?.trim();
  if (!prompt) return null;
  const params = new URLSearchParams();
  const tool =
    input.tool && STUDIO_PREFILL_TOOLS.has(input.tool)
      ? input.tool
      : "image_generate";
  params.set("tool", tool);
  params.set("prompt", prompt);
  if (input.duration !== undefined && input.duration !== null && input.duration !== "") {
    params.set("duration", String(input.duration));
  }
  return `/studio?${params.toString()}`;
}
