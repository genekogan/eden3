/**
 * Cost metering for Eden3's USD-pegged manna model.
 *
 * This module is intentionally fail-closed: a provider/model/unit that is not
 * in the versioned table throws instead of returning zero. Values are a launch
 * snapshot and should be reconciled against provider invoices/pricing updates.
 */

export const COST_TABLE_VERSION = '2026-08-15.voice-stt-v1';

export const DEFAULT_MANNA_PER_USD = 1_000;
export const DEFAULT_MARKUP = 0.35;

export type CostProvider =
  | 'anthropic'
  | 'cartesia'
  | 'deepinfra'
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
  | 'audio_second'
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

/** UTC calendar date used to select an effective-dated pricing row. */
export type EffectiveDateInput = Date | string;

export interface CostTableSelectionOptions {
  /** Defaults to today's UTC calendar date. Strings must be exact YYYY-MM-DD. */
  asOf?: EffectiveDateInput;
  /** Explicit registry for deterministic validation/testing; production uses COST_TABLE. */
  table?: readonly CostTableEntry[];
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
  {
    provider: 'cartesia',
    model: 'ink-2',
    unit: 'audio_second',
    // Ink-2 realtime is 3 credits/second. Cartesia Pro is $5 for 100,000
    // credits, so the plan-value equivalent is $0.00015/second ($0.009/min).
    usdPerUnit: 0.00015,
    effectiveDate: '2026-08-15',
    source: 'Cartesia official pricing and Ink-2 pricing docs, reviewed 2026-08-15',
  },
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
    model: 'fal-ai/kling-video/v3/pro/image-to-video',
    unit: 'video_second',
    usdPerUnit: 0.112,
    effectiveDate: '2026-08-12',
    source: 'fal Kling Video v3 Pro image-to-video pricing page, audio disabled',
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
    provider: 'deepinfra',
    model: 'hexgrad/Kokoro-82M',
    unit: 'audio_character',
    usdPerUnit: 0.00000062,
    effectiveDate: '2026-08-15',
    source: 'DeepInfra Kokoro-82M model page: $0.62 per 1M input characters',
  },
  {
    provider: 'cartesia',
    model: 'sonic-3.5-2026-05-04',
    unit: 'audio_character',
    usdPerUnit: 0.00005,
    effectiveDate: '2026-08-15',
    source: 'Cartesia Pro allocation: $5 per 100,000 credits; TTS is one credit per character',
    estimated: true,
  },
  {
    provider: 'elevenlabs',
    model: 'eleven_flash_v2_5',
    unit: 'audio_character',
    usdPerUnit: 0.00005,
    effectiveDate: '2026-08-15',
    source: 'ElevenLabs API pricing: Flash/Turbo pay-as-you-go $0.05 per 1,000 characters',
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

type MeteringErrorFactory = (message: string) => Error;

function strictUtcCalendarDay(
  value: unknown,
  label: string,
  error: MeteringErrorFactory,
): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw error(`${label} must be an exact UTC YYYY-MM-DD date, got ${JSON.stringify(value)}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw error(`${label} is not a real UTC calendar date, got ${JSON.stringify(value)}`);
  }
  return value;
}

function effectiveDay(
  value: EffectiveDateInput | undefined,
  label: string,
  error: MeteringErrorFactory,
): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw error(`${label} must be a valid date`);
    return value.toISOString().slice(0, 10);
  }
  if (value === undefined) return new Date().toISOString().slice(0, 10);
  return strictUtcCalendarDay(value, label, error);
}

function assertUnambiguousEffectiveRows<T extends { effectiveDate: string }>(
  table: readonly T[],
  identity: (entry: T) => string,
  registryName: string,
  error: MeteringErrorFactory,
): void {
  const seen = new Set<string>();
  for (const entry of table) {
    // Registry rows are configuration truth, not optional queries: unlike an
    // omitted asOf, a missing/non-string effectiveDate must never default.
    const date = strictUtcCalendarDay(
      entry.effectiveDate,
      `${registryName} effectiveDate`,
      error,
    );
    const version = `${identity(entry)}\u0000${date}`;
    if (seen.has(version)) {
      throw error(
        `${registryName} has ambiguous overlapping rows for ${identity(entry)} at ${date}`,
      );
    }
    seen.add(version);
  }
}

function latestEligible<T extends { effectiveDate: string }>(
  entries: readonly T[],
  asOf: string,
): T | undefined {
  let selected: T | undefined;
  for (const entry of entries) {
    if (entry.effectiveDate > asOf) continue;
    if (!selected || entry.effectiveDate > selected.effectiveDate) selected = entry;
  }
  return selected;
}

function assertFiniteNonnegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite nonnegative number, got ${String(value)}`);
  }
}

/**
 * Resolve one cost rate deterministically. Exact model history takes
 * precedence over the wildcard fallback; within that history the latest row
 * effective on or before `asOf` wins regardless of registry order.
 */
export function selectCostTableEntry(
  route: { provider: CostProvider; model: string; unit: CostUnit },
  options: CostTableSelectionOptions = {},
): CostTableEntry {
  const table = options.table ?? COST_TABLE;
  const error = (message: string) => new CostTableError(message);
  const asOf = effectiveDay(options.asOf, 'cost-table asOf', error);
  assertUnambiguousEffectiveRows(
    table,
    (item) =>
      `${item.provider}/${item.model === '*' ? '*' : normalizeModel(item.provider, item.model)}/${item.unit}`,
    'cost table',
    error,
  );

  const normalized = normalizeModel(route.provider, route.model);
  const eligibleExact = table.filter(
    (item) =>
      item.provider === route.provider &&
      item.unit === route.unit &&
      item.model !== '*' &&
      normalizeModel(item.provider, item.model) === normalized &&
      item.effectiveDate <= asOf,
  );
  const eligibleWildcard = table.filter(
    (item) =>
      item.provider === route.provider &&
      item.unit === route.unit &&
      item.model === '*' &&
      item.effectiveDate <= asOf,
  );
  const entry = latestEligible(
    eligibleExact.length > 0 ? eligibleExact : eligibleWildcard,
    asOf,
  );
  if (!entry) {
    throw new CostTableError(
      `no cost table entry for ${route.provider}/${normalized} unit ${route.unit} effective on or before ${asOf}`,
    );
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
  /** Defaults to today's UTC date; supply this to reproduce a historical quote. */
  asOf?: EffectiveDateInput;
}

export function costFromParams(input: CostFromParamsInput): CostEstimate {
  // Freeze one UTC pricing day for the whole quote. A request crossing UTC
  // midnight must never mix rows from two effective-date versions.
  const asOf = effectiveDay(
    input.asOf,
    'cost-table asOf',
    (message) => new CostTableError(message),
  );
  const lines: CostLineItem[] = [];
  for (const [unit, rawQuantity] of Object.entries(input.units) as [CostUnit, number | undefined][]) {
    if (rawQuantity === undefined) continue;
    assertFiniteNonnegative(unit, rawQuantity);
    if (rawQuantity === 0) continue;
    const entry = selectCostTableEntry(
      { provider: input.provider, model: input.model, unit },
      { asOf },
    );
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
  /** Defaults to today's UTC date; supply this to reproduce historical metering. */
  asOf?: EffectiveDateInput;
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
    ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
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

// ---------------------------------------------------------------------------
// Turn authorization ceilings (MVP gap 42, T08-U02)
// ---------------------------------------------------------------------------

export const TURN_CEILING_TABLE_VERSION = '2026-08-08.authz-v1';

export class TurnCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnCeilingError';
  }
}

export interface TurnCeilingEntry {
  provider: CostProvider;
  model: string;
  /**
   * Maximum PERMITTED provider cost per turn, USD, pre-markup. This is the
   * economic authorization ceiling: the turn reserves `mannaFromUsd(maxTurnUsd)`
   * before any provider call, and settlement may never charge beyond it.
   */
  maxTurnUsd: number;
  /**
   * Per-provider-call output-token cap passed to the gateway as `max_tokens`
   * (belt: enforcement depends on OpenClaw honoring it; the economic ceiling
   * never relies on it).
   */
  maxOutputTokens: number;
  effectiveDate: string;
  source: string;
}

export interface TurnCeilingSelectionOptions {
  /** Defaults to today's UTC calendar date. Strings must be exact YYYY-MM-DD. */
  asOf?: EffectiveDateInput;
  /** Explicit registry for deterministic validation/testing; production uses TURN_CEILINGS. */
  table?: readonly TurnCeilingEntry[];
}

/**
 * Per-model per-turn authorization ceilings — POLICY values (operator-tunable,
 * ruling RP-1 in T08-U02), not token-derived worst cases: an OpenClaw compat
 * "turn" aggregates an unbounded agentic loop and cannot be cancelled
 * mid-stream, so no finite token-derived maximum exists at this interface.
 * Values are grounded in observed turn telemetry (2026-08-08, usage_events on
 * canonical eden3 + eden3_stg) at ≈2× the observed per-model maximum:
 *   haiku  p50 17 / max 26 manna (189 turns, ≤95k prompt tokens)
 *   sonnet max 456 manna (380k prompt tokens, 41k cache-write — agentic loop)
 *   opus   max 235 manna
 * A turn whose metered actual exceeds the ceiling settles AT the ceiling
 * (never above), records `overrun`, and alerts — the platform absorbs the
 * bounded overage; the user is never charged beyond what was authorized.
 */
export const TURN_CEILINGS: readonly TurnCeilingEntry[] = [
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    maxTurnUsd: 0.045,
    // 8192 × $5/M = $0.041 ≤ the $0.045 ceiling: the declared per-call output
    // cap can never by itself exceed the economic authorization.
    maxOutputTokens: 8192,
    effectiveDate: '2026-08-08',
    source:
      'T08-U02 policy snapshot: ≈2.3× observed max (26 manna); ≈61 manna — below the 100-manna signup grant so the default route stays usable',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    maxTurnUsd: 0.67,
    maxOutputTokens: 32768,
    effectiveDate: '2026-08-08',
    source: 'T08-U02 policy snapshot: ≈2× observed sonnet max (456 manna); ≈905 manna',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    maxTurnUsd: 0.67,
    maxOutputTokens: 32768,
    effectiveDate: '2026-08-08',
    source: 'T08-U02 policy snapshot: ≈2× observed sonnet max (456 manna); ≈905 manna',
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    maxTurnUsd: 1.12,
    // 14336 × $75/M = $1.075 ≤ the $1.12 ceiling.
    maxOutputTokens: 14336,
    effectiveDate: '2026-08-08',
    source:
      'T08-U02 policy snapshot: 5× sonnet rates; observed max 235 manna; ≈1512 manna ceiling',
  },
] as const;

export interface TurnAuthorizationCeiling {
  /** Worst-case manna to reserve before the provider call (markup applied). */
  manna: number;
  /** The underlying pre-markup USD ceiling. */
  usd: number;
  /** Per-call output-token cap to pass to the gateway (`max_tokens`). */
  maxOutputTokens: number;
  tableVersion: string;
  provider: CostProvider;
  model: string;
}

/**
 * Resolve one effective-dated turn ceiling with the same deterministic rule
 * as provider prices: exact model before wildcard, then latest eligible date.
 */
export function selectTurnCeilingEntry(
  route: { provider: string; model: string },
  options: TurnCeilingSelectionOptions = {},
): TurnCeilingEntry {
  const table = options.table ?? TURN_CEILINGS;
  const error = (message: string) => new TurnCeilingError(message);
  const asOf = effectiveDay(options.asOf, 'turn-ceiling asOf', error);
  assertUnambiguousEffectiveRows(
    table,
    (item) =>
      `${item.provider}/${item.model === '*' ? '*' : normalizeModel(item.provider, item.model)}`,
    'turn ceiling table',
    error,
  );

  const provider = route.provider as CostProvider;
  const normalized = normalizeModel(provider, route.model);
  const eligibleExact = table.filter(
    (item) =>
      item.provider === provider &&
      item.model !== '*' &&
      normalizeModel(item.provider, item.model) === normalized &&
      item.effectiveDate <= asOf,
  );
  const eligibleWildcard = table.filter(
    (item) =>
      item.provider === provider && item.model === '*' && item.effectiveDate <= asOf,
  );
  const entry = latestEligible(
    eligibleExact.length > 0 ? eligibleExact : eligibleWildcard,
    asOf,
  );
  if (!entry) {
    throw new TurnCeilingError(
      `no turn-authorization ceiling for ${route.provider}/${normalized} effective on or before ${asOf} (table ${TURN_CEILING_TABLE_VERSION})`,
    );
  }
  return entry;
}

export interface TurnAuthorizationOptions extends MannaConversionOptions {
  /** Defaults to today's UTC date; supply this to reproduce historical authorization. */
  asOf?: EffectiveDateInput;
}

/**
 * The economic authorization for one LLM turn on `provider/model`.
 * FAIL-CLOSED: a model without a ceiling entry cannot start a metered turn —
 * throws {@link TurnCeilingError} (the metering doctrine: never zero, never a
 * silent default).
 */
export function turnAuthorizedMax(
  route: { provider: string; model: string },
  options: TurnAuthorizationOptions = {},
): TurnAuthorizationCeiling {
  const provider = route.provider as CostProvider;
  const normalized = normalizeModel(provider, route.model);
  const entry = selectTurnCeilingEntry(route, {
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
  });
  return {
    manna: mannaFromUsd(entry.maxTurnUsd, options),
    usd: entry.maxTurnUsd,
    maxOutputTokens: entry.maxOutputTokens,
    tableVersion: TURN_CEILING_TABLE_VERSION,
    provider,
    model: normalized,
  };
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
