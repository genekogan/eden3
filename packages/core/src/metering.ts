/**
 * Cost metering for Eden3's USD-pegged manna model.
 *
 * This module is intentionally fail-closed: a provider/model/unit that is not
 * in the versioned table throws instead of returning zero. Values are a launch
 * snapshot and should be reconciled against provider invoices/pricing updates.
 */

export const COST_TABLE_VERSION = '2026-07-06.launch-v1';

export const DEFAULT_MANNA_PER_USD = 1_000;
export const DEFAULT_MARKUP = 0.35;

export type CostProvider =
  | 'anthropic'
  | 'elevenlabs'
  | 'fal'
  | 'google'
  | 'openrouter'
  | 'replicate'
  | 'runway';

export type CostUnit =
  | 'input_1m_tokens'
  | 'output_1m_tokens'
  | 'cache_read_1m_tokens'
  | 'cache_write_1m_tokens'
  | 'image'
  | 'megapixel'
  | 'video_second'
  | 'audio_character'
  | 'music_clip'
  | 'music_second'
  | 'credit'
  | 'response_usd';

export interface CostTableEntry {
  provider: CostProvider;
  /** Provider-native model id, with or without the provider prefix. */
  model: string;
  unit: CostUnit;
  usdPerUnit: number;
  effectiveDate: string;
  source: string;
  estimated?: boolean;
}

export interface CostLineItem extends CostTableEntry {
  quantity: number;
  costUsd: number;
}

export interface CostEstimate {
  tableVersion: string;
  provider: CostProvider;
  model: string;
  totalCostUsd: number;
  lineItems: CostLineItem[];
  estimated: boolean;
}

export class CostTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostTableError';
  }
}

const RATE_SOURCE = 'Eden3 launch pricing snapshot; reconcile monthly before production billing';

export const COST_TABLE: readonly CostTableEntry[] = [
  // Anthropic-style LLM tiers. Cache read/write rates follow the common
  // 0.1x / 1.25x prompt-cache convention for launch accounting.
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    unit: 'input_1m_tokens',
    usdPerUnit: 1,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    unit: 'output_1m_tokens',
    usdPerUnit: 5,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    unit: 'cache_read_1m_tokens',
    usdPerUnit: 0.1,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    unit: 'cache_write_1m_tokens',
    usdPerUnit: 1.25,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    unit: 'input_1m_tokens',
    usdPerUnit: 3,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    unit: 'output_1m_tokens',
    usdPerUnit: 15,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    unit: 'cache_read_1m_tokens',
    usdPerUnit: 0.3,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    unit: 'cache_write_1m_tokens',
    usdPerUnit: 3.75,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    unit: 'input_1m_tokens',
    usdPerUnit: 3,
    effectiveDate: '2026-07-31',
    source: 'OpenClaw 2026.7.1 Anthropic provider catalog',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    unit: 'output_1m_tokens',
    usdPerUnit: 15,
    effectiveDate: '2026-07-31',
    source: 'OpenClaw 2026.7.1 Anthropic provider catalog',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    unit: 'cache_read_1m_tokens',
    usdPerUnit: 0.3,
    effectiveDate: '2026-07-31',
    source: 'OpenClaw 2026.7.1 Anthropic provider catalog',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    unit: 'cache_write_1m_tokens',
    usdPerUnit: 3.75,
    effectiveDate: '2026-07-31',
    source: 'OpenClaw 2026.7.1 Anthropic provider catalog',
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    unit: 'input_1m_tokens',
    usdPerUnit: 15,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    unit: 'output_1m_tokens',
    usdPerUnit: 75,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    unit: 'cache_read_1m_tokens',
    usdPerUnit: 1.5,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    unit: 'cache_write_1m_tokens',
    usdPerUnit: 18.75,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },

  // Launch media routes pinned in infra/openclaw/data/openclaw.json.
  {
    provider: 'google',
    model: 'gemini-3-pro-image',
    unit: 'image',
    usdPerUnit: 0.134,
    effectiveDate: '2026-07-06',
    source: 'Gemini Developer API pricing page, Gemini 3 Pro Image standard 1K/2K image output',
  },
  {
    provider: 'google',
    model: 'gemini-3-pro-image-preview',
    unit: 'image',
    usdPerUnit: 0.134,
    effectiveDate: '2026-07-06',
    source: 'Gemini Developer API pricing page, Gemini 3 Pro Image standard 1K/2K image output',
  },
  {
    provider: 'google',
    model: 'lyria-3-clip-preview',
    unit: 'music_clip',
    usdPerUnit: 0.04,
    effectiveDate: '2026-07-06',
    source: 'Gemini Developer API pricing page, Lyria 3 Clip Preview 30s per-song price',
  },
  {
    provider: 'google',
    model: 'veo-3.1-generate-preview',
    unit: 'video_second',
    usdPerUnit: 0.4,
    effectiveDate: '2026-07-06',
    source: 'Gemini Developer API pricing page, Veo 3.1 Standard 720p/1080p per-second price',
  },
  {
    provider: 'google',
    model: 'veo-3.1-fast-generate-preview',
    unit: 'video_second',
    usdPerUnit: 0.1,
    effectiveDate: '2026-07-06',
    source: 'Gemini Developer API pricing page, Veo 3.1 Fast 720p per-second price',
  },
  {
    provider: 'google',
    model: 'veo-3.1-lite-generate-preview',
    unit: 'video_second',
    usdPerUnit: 0.05,
    effectiveDate: '2026-07-06',
    source: 'Gemini Developer API pricing page, Veo 3.1 Lite 720p per-second price',
  },
  {
    provider: 'fal',
    model: 'fal-ai/flux/dev',
    unit: 'image',
    usdPerUnit: 0.025,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
  },
  {
    provider: 'fal',
    model: 'fal-ai/kling-video/v3/pro/text-to-video',
    unit: 'video_second',
    usdPerUnit: 0.09,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
    estimated: true,
  },
  {
    provider: 'fal',
    model: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
    unit: 'video_second',
    usdPerUnit: 0.05,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
    estimated: true,
  },
  {
    provider: 'elevenlabs',
    model: 'tts',
    unit: 'audio_character',
    usdPerUnit: 0.0001667,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
    estimated: true,
  },
  {
    provider: 'runway',
    model: 'gen4-turbo',
    unit: 'video_second',
    usdPerUnit: 0.05,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
    estimated: true,
  },
  {
    provider: 'replicate',
    model: 'black-forest-labs/flux-schnell',
    unit: 'image',
    usdPerUnit: 0.003,
    effectiveDate: '2026-07-06',
    source: RATE_SOURCE,
    estimated: true,
  },
  {
    provider: 'openrouter',
    model: '*',
    unit: 'response_usd',
    usdPerUnit: 1,
    effectiveDate: '2026-07-06',
    source: 'OpenRouter response usage.cost field',
  },
] as const;

function normalizeModel(provider: CostProvider, model: string): string {
  const trimmed = model.trim();
  const prefix = `${provider}/`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function assertFiniteNonnegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite nonnegative number, got ${String(value)}`);
  }
}

function findRate(provider: CostProvider, model: string, unit: CostUnit): CostTableEntry {
  const normalized = normalizeModel(provider, model);
  const entry = COST_TABLE.find(
    (item) =>
      item.provider === provider &&
      item.unit === unit &&
      (item.model === normalized || item.model === model || item.model === '*'),
  );
  if (!entry) {
    throw new CostTableError(`no cost table entry for ${provider}/${normalized} unit ${unit}`);
  }
  return entry;
}

function sumLines(provider: CostProvider, model: string, lines: CostLineItem[]): CostEstimate {
  const totalCostUsd = lines.reduce((sum, item) => sum + item.costUsd, 0);
  return {
    tableVersion: COST_TABLE_VERSION,
    provider,
    model: normalizeModel(provider, model),
    totalCostUsd,
    lineItems: lines,
    estimated: lines.some((line) => line.estimated === true),
  };
}

export interface CostFromParamsInput {
  provider: CostProvider;
  model: string;
  units: Partial<Record<CostUnit, number>>;
}

export function costFromParams(input: CostFromParamsInput): CostEstimate {
  const lines: CostLineItem[] = [];
  for (const [unit, rawQuantity] of Object.entries(input.units) as [CostUnit, number | undefined][]) {
    if (rawQuantity === undefined) continue;
    assertFiniteNonnegative(unit, rawQuantity);
    if (rawQuantity === 0) continue;
    const entry = findRate(input.provider, input.model, unit);
    lines.push({
      ...entry,
      quantity: rawQuantity,
      costUsd: rawQuantity * entry.usdPerUnit,
    });
  }
  if (lines.length === 0) {
    return sumLines(input.provider, input.model, []);
  }
  return sumLines(input.provider, input.model, lines);
}

export interface LlmUsageCostInput {
  provider: Extract<CostProvider, 'anthropic' | 'google' | 'openrouter'>;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens read from cache. They are excluded from full-price input. */
  cachedTokens?: number;
  /** Prompt tokens written to cache, if the provider reports them. */
  cacheWriteTokens?: number;
}

export function costFromLlmUsage(input: LlmUsageCostInput): CostEstimate {
  assertFiniteNonnegative('promptTokens', input.promptTokens);
  assertFiniteNonnegative('completionTokens', input.completionTokens);
  const cachedTokens = input.cachedTokens ?? 0;
  const cacheWriteTokens = input.cacheWriteTokens ?? 0;
  assertFiniteNonnegative('cachedTokens', cachedTokens);
  assertFiniteNonnegative('cacheWriteTokens', cacheWriteTokens);

  const fullPriceInputTokens = Math.max(0, input.promptTokens - cachedTokens);
  return costFromParams({
    provider: input.provider,
    model: input.model,
    units: {
      input_1m_tokens: fullPriceInputTokens / 1_000_000,
      cache_read_1m_tokens: cachedTokens / 1_000_000,
      cache_write_1m_tokens: cacheWriteTokens / 1_000_000,
      output_1m_tokens: input.completionTokens / 1_000_000,
    },
  });
}

export interface MannaConversionOptions {
  /** Fixed USD peg: e.g. 1,000 manna = $1. */
  mannaPerUsd?: number;
  /** Platform margin/risk buffer: 0.35 = 35%. */
  markup?: number;
}

export function mannaFromUsd(costUsd: number, options: MannaConversionOptions = {}): number {
  assertFiniteNonnegative('costUsd', costUsd);
  const mannaPerUsd = options.mannaPerUsd ?? DEFAULT_MANNA_PER_USD;
  const markup = options.markup ?? DEFAULT_MARKUP;
  if (!Number.isFinite(mannaPerUsd) || mannaPerUsd <= 0) {
    throw new RangeError(`mannaPerUsd must be a finite positive number, got ${String(mannaPerUsd)}`);
  }
  if (!Number.isFinite(markup) || markup < 0) {
    throw new RangeError(`markup must be a finite nonnegative number, got ${String(markup)}`);
  }
  const raw = costUsd * (1 + markup) * mannaPerUsd;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(raw)) * 8;
  if (raw <= epsilon) return 0;
  return Math.ceil(raw - epsilon);
}

export function mannaForEstimate(
  estimate: Pick<CostEstimate, 'totalCostUsd'>,
  options: MannaConversionOptions = {},
): number {
  return mannaFromUsd(estimate.totalCostUsd, options);
}

/**
 * Metered manna price of the DEFAULT provider route for each in-chat media
 * kind, at the default quantity (image 1 · video 5s · music 1 clip · tts 120
 * chars). Used by the media pipeline to charge agent-generated (async
 * in-chat) media honestly: the pipeline has no task→file identity from
 * OpenClaw (spike probe #4), so it cannot know the exact model/duration used
 * — it bills the default route the gateway is configured to use. Replaces
 * the legacy flat PRICING for media (image 5 / video 25 / … undercharged the
 * real provider cost by up to 20×).
 */
export function defaultChatMediaManna(action: 'image' | 'video' | 'music' | 'tts'): number {
  switch (action) {
    case 'image':
      return mannaForEstimate(
        costFromParams({ provider: 'fal', model: 'fal-ai/flux/dev', units: { image: 1 } }),
      );
    case 'video':
      return mannaForEstimate(
        costFromParams({
          provider: 'fal',
          model: 'fal-ai/kling-video/v3/pro/text-to-video',
          units: { video_second: 5 },
        }),
      );
    case 'music':
      return mannaForEstimate(
        costFromParams({
          provider: 'google',
          model: 'lyria-3-clip-preview',
          units: { music_clip: 1 },
        }),
      );
    case 'tts':
      return mannaForEstimate(
        costFromParams({ provider: 'elevenlabs', model: 'tts', units: { audio_character: 120 } }),
      );
  }
}
