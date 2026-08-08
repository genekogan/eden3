/**
 * T08-U03 — the INDEPENDENT economic oracle (MVP-ACCEPTANCE §1.11).
 *
 * This module recomputes expected reservations, settlements, ceilings and
 * studio quotes from FIRST PRINCIPLES — provider price sheets and platform
 * policy literals — and imports NOTHING from `@eden3/core`, `@eden3/gateway`,
 * or any production source module. A verifier that shared the implementation's
 * mappings would prove nothing (rule 11); everything here is a hand-entered
 * literal with a cited source, or arithmetic over those literals.
 *
 * Circularity guard (checkpoint-#1 finding 7): the oracle owns its own
 * bidirectional route manifest (the set of models/tools it EXPECTS the system
 * to authorize). A completeness check compares that independent manifest to the
 * set the system actually authorizes and fails on a mismatch in EITHER
 * direction — a coordinated omission in both the impl and a copied verifier
 * cannot hide here.
 *
 * If a future review wants to prove this module never imports production code,
 * `econ-oracle.independence.test.ts` reads this file's source and asserts the
 * absence of any `@eden3/core|gateway|shared|db` or `../src/` import.
 */

// ---------------------------------------------------------------------------
// Platform policy literals (independent of packages/core/src/metering.ts)
// ---------------------------------------------------------------------------

/** Fixed USD peg: 1000 manna = $1. Source: MVP.md economy subspec, DEFAULT peg. */
export const ORACLE_MANNA_PER_USD = 1_000;
/** Default platform markup. Source: MVP.md T-BILL markup knob launch value. */
export const ORACLE_DEFAULT_MARKUP = 0.35;

/**
 * Convert a USD provider cost to manna at a given markup — the pricing model,
 * independently coded (cost × (1 + markup) × peg, rounded UP to whole manna).
 * Parameterized over markup so the battery can prove the T-BILL knob propagates
 * (checkpoint-#1 finding 13), rather than freezing a single markup.
 */
export function oracleMannaFromUsd(costUsd: number, markup: number = ORACLE_DEFAULT_MARKUP): number {
  if (!(costUsd >= 0) || !Number.isFinite(costUsd)) {
    throw new RangeError(`oracle: costUsd must be finite ≥ 0, got ${String(costUsd)}`);
  }
  const raw = costUsd * (1 + markup) * ORACLE_MANNA_PER_USD;
  // Whole-manna ceiling; guard the classic 60.75→61 / 904.5→905 boundaries
  // against binary float dust without ever rounding a real fractional manna
  // down.
  const rounded = Math.ceil(raw - 1e-6);
  return rounded > 0 ? rounded : 0;
}

// ---------------------------------------------------------------------------
// Provider price sheets (USD per unit) — hand-entered literals with sources
// ---------------------------------------------------------------------------

export interface LlmRates {
  /** USD per 1M full-price (uncached) input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
  /** USD per 1M cache-read tokens. */
  cacheReadPerM: number;
  /** USD per 1M cache-write tokens. */
  cacheWritePerM: number;
  source: string;
}

/**
 * Anthropic per-model token rates. Source: Anthropic public pricing +
 * OpenClaw 2026.7.1 provider catalog (haiku 1/5, sonnet 3/15, opus 15/75 USD
 * per M in/out; cache read 0.1×input, cache write 1.25×input — the launch
 * convention). Entered independently here so a silent COST_TABLE edit is
 * caught by the settlement oracle.
 */
export const ORACLE_LLM_RATES: Record<string, LlmRates> = {
  'anthropic/claude-haiku-4-5': {
    inputPerM: 1,
    outputPerM: 5,
    cacheReadPerM: 0.1,
    cacheWritePerM: 1.25,
    source: 'Anthropic Haiku 4.5 pricing; launch cache convention',
  },
  'anthropic/claude-sonnet-4-5': {
    inputPerM: 3,
    outputPerM: 15,
    cacheReadPerM: 0.3,
    cacheWritePerM: 3.75,
    source: 'Anthropic Sonnet 4.5 pricing; launch cache convention',
  },
  'anthropic/claude-sonnet-4-6': {
    inputPerM: 3,
    outputPerM: 15,
    cacheReadPerM: 0.3,
    cacheWritePerM: 3.75,
    source: 'OpenClaw 2026.7.1 Anthropic catalog, Sonnet 4.6',
  },
  'anthropic/claude-opus-4-6': {
    inputPerM: 15,
    outputPerM: 75,
    cacheReadPerM: 1.5,
    cacheWritePerM: 18.75,
    source: 'Anthropic Opus 4.6 pricing; launch cache convention',
  },
};

/** Media provider unit prices (USD). Source: provider pricing pages, 2026-07. */
export const ORACLE_MEDIA_RATES = {
  // fal flux/dev image
  'fal/fal-ai/flux/dev': { unit: 'image', usdPerUnit: 0.025, source: 'fal flux/dev per-image' },
  // google gemini 3 pro image (studio premium)
  'google/gemini-3-pro-image-preview': {
    unit: 'image',
    usdPerUnit: 0.134,
    source: 'Gemini 3 Pro Image standard output',
  },
  // fal kling v3 pro text-to-video, per second
  'fal/fal-ai/kling-video/v3/pro/text-to-video': {
    unit: 'video_second',
    usdPerUnit: 0.09,
    source: 'fal kling v3 pro per-second (estimated)',
  },
  // google lyria 3 clip, per clip
  'google/lyria-3-clip-preview': {
    unit: 'music_clip',
    usdPerUnit: 0.04,
    source: 'Gemini Lyria 3 Clip 30s per-song',
  },
  // elevenlabs tts, per character
  'elevenlabs/tts': {
    unit: 'audio_character',
    usdPerUnit: 0.0001667,
    source: 'ElevenLabs TTS per-character (estimated)',
  },
} as const;

// ---------------------------------------------------------------------------
// Turn-authorization ceilings — independent policy literals
// ---------------------------------------------------------------------------

export interface OracleCeiling {
  /** Maximum PERMITTED provider USD per turn (pre-markup). */
  maxTurnUsd: number;
  /** Per-provider-call output-token cap the gateway is asked to enforce. */
  maxOutputTokens: number;
  /** FROZEN expected reservation manna at the default markup — a silent table
   * or markup change must fail the battery (independent anchor). */
  expectedReservationManna: number;
}

/**
 * The ceiling POLICY, entered independently. These are the LANDED D-004 policy
 * numbers; the battery proves the mechanism at these numbers and separately
 * emits the whole-turn-worst-case gap as D-004 evidence.
 */
export const ORACLE_CEILINGS: Record<string, OracleCeiling> = {
  'anthropic/claude-haiku-4-5': { maxTurnUsd: 0.045, maxOutputTokens: 8192, expectedReservationManna: 61 },
  'anthropic/claude-sonnet-4-5': { maxTurnUsd: 0.67, maxOutputTokens: 32768, expectedReservationManna: 905 },
  'anthropic/claude-sonnet-4-6': { maxTurnUsd: 0.67, maxOutputTokens: 32768, expectedReservationManna: 905 },
  'anthropic/claude-opus-4-6': { maxTurnUsd: 1.12, maxOutputTokens: 14336, expectedReservationManna: 1512 },
};

/**
 * The oracle's INDEPENDENT enumeration of the chat models the system must
 * authorize (the bidirectional-manifest guard, checkpoint-#1 finding 7). If the
 * implementation adds/removes a routable chat model, the completeness check
 * must flag it here.
 */
export const ORACLE_CHAT_MODEL_MANIFEST: readonly string[] = [
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-opus-4-6',
];

// ---------------------------------------------------------------------------
// Oracle functions
// ---------------------------------------------------------------------------

export interface OracleUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
}

/** Expected raw metered manna for a turn's usage (before ceiling clamp). */
export function oracleMeteredManna(
  usage: OracleUsage,
  model: string,
  markup: number = ORACLE_DEFAULT_MARKUP,
): number {
  const rates = ORACLE_LLM_RATES[model];
  if (!rates) throw new RangeError(`oracle: no LLM rates for ${model}`);
  const cached = usage.cachedTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const fullInput = Math.max(0, usage.promptTokens - cached);
  const usd =
    (fullInput / 1_000_000) * rates.inputPerM +
    (cached / 1_000_000) * rates.cacheReadPerM +
    (cacheWrite / 1_000_000) * rates.cacheWritePerM +
    (usage.completionTokens / 1_000_000) * rates.outputPerM;
  return oracleMannaFromUsd(usd, markup);
}

/** Expected worst-case reservation manna for a chat/dream turn on `model`. */
export function oracleReservation(model: string, markup: number = ORACLE_DEFAULT_MARKUP): number {
  const ceiling = ORACLE_CEILINGS[model];
  if (!ceiling) throw new RangeError(`oracle: no ceiling for ${model}`);
  const computed = oracleMannaFromUsd(ceiling.maxTurnUsd, markup);
  if (markup === ORACLE_DEFAULT_MARKUP && computed !== ceiling.expectedReservationManna) {
    throw new Error(
      `oracle self-check: ${model} reservation ${computed} ≠ frozen ${ceiling.expectedReservationManna} — ` +
        'ceiling policy or markup drifted',
    );
  }
  return computed;
}

/** Expected settled charge = min(metered, reservation) — settle ≤ authorized-max. */
export function oracleSettlement(
  usage: OracleUsage,
  model: string,
  markup: number = ORACLE_DEFAULT_MARKUP,
): { metered: number; reservation: number; charged: number; overrun: boolean } {
  const metered = oracleMeteredManna(usage, model, markup);
  const reservation = oracleReservation(model, markup);
  const charged = Math.min(metered, reservation);
  return { metered, reservation, charged, overrun: metered > reservation };
}

/**
 * Per-call output-cap coherence DIAGNOSTIC (checkpoint-#1 finding 1): the
 * declared `maxOutputTokens` priced at the oracle's own output rate must not by
 * itself exceed the ceiling. This is NOT a proof of "max never understated" —
 * the whole-turn worst case (input + cache + multi-call agentic loop) is
 * unbounded at the OpenClaw interface (D-004). It feeds the D-004 evidence
 * artifact, not a green gate.
 */
export function oracleOutputCapCoherent(model: string): { coherent: boolean; outputOnlyUsd: number; ceilingUsd: number } {
  const rates = ORACLE_LLM_RATES[model];
  const ceiling = ORACLE_CEILINGS[model];
  if (!rates || !ceiling) throw new RangeError(`oracle: no rates/ceiling for ${model}`);
  const outputOnlyUsd = (ceiling.maxOutputTokens / 1_000_000) * rates.outputPerM;
  return { coherent: outputOnlyUsd <= ceiling.maxTurnUsd, outputOnlyUsd, ceilingUsd: ceiling.maxTurnUsd };
}

/**
 * D-004 evidence: the machine-readable whole-turn gap. For each model it
 * reports how many uncached input tokens (and cache-write tokens) the ceiling
 * budget still permits AFTER the declared max output, and the fact that the
 * agentic loop can issue arbitrarily many such calls — i.e. the residual
 * exposure the clamp policy tolerates.
 */
export function oracleD004Gap(model: string): {
  model: string;
  ceilingUsd: number;
  maxOutputTokens: number;
  outputOnlyUsd: number;
  inputTokensStillPermittedInOneCall: number;
  unboundedMultiCall: true;
} {
  const rates = ORACLE_LLM_RATES[model];
  const ceiling = ORACLE_CEILINGS[model];
  if (!rates || !ceiling) throw new RangeError(`oracle: no rates/ceiling for ${model}`);
  const outputOnlyUsd = (ceiling.maxOutputTokens / 1_000_000) * rates.outputPerM;
  const remainingUsd = Math.max(0, ceiling.maxTurnUsd - outputOnlyUsd);
  const inputTokensStillPermitted = Math.floor((remainingUsd / rates.inputPerM) * 1_000_000);
  return {
    model,
    ceilingUsd: ceiling.maxTurnUsd,
    maxOutputTokens: ceiling.maxOutputTokens,
    outputOnlyUsd,
    inputTokensStillPermittedInOneCall: inputTokensStillPermitted,
    unboundedMultiCall: true,
  };
}

// ---------------------------------------------------------------------------
// Studio quote oracle (quote == settle, T-BILL deterministic-media leg)
// ---------------------------------------------------------------------------

export type OracleStudioTool = 'image_generate' | 'video_generate' | 'music_generate' | 'tts';

/** Independent tool → provider/model/unit/quantity mapping for studio. */
export function oracleStudioQuote(
  tool: OracleStudioTool,
  args: Record<string, unknown> = {},
  markup: number = ORACLE_DEFAULT_MARKUP,
): { provider: string; model: string; unit: string; quantity: number; usd: number; manna: number } {
  let key: keyof typeof ORACLE_MEDIA_RATES;
  let quantity: number;
  switch (tool) {
    case 'image_generate': {
      const model = typeof args.model === 'string' ? args.model : 'flux-dev';
      key = model === 'gemini-pro' ? 'google/gemini-3-pro-image-preview' : 'fal/fal-ai/flux/dev';
      quantity = 1;
      break;
    }
    case 'video_generate': {
      key = 'fal/fal-ai/kling-video/v3/pro/text-to-video';
      const d = typeof args.duration === 'number' ? args.duration : 5;
      if (d < 2 || d > 10) throw new RangeError(`oracle: video duration ${d} out of [2,10]`);
      quantity = d;
      break;
    }
    case 'music_generate': {
      key = 'google/lyria-3-clip-preview';
      quantity = 1;
      break;
    }
    case 'tts': {
      key = 'elevenlabs/tts';
      const raw = typeof args.text === 'string' ? args.text : typeof args.prompt === 'string' ? args.prompt : '';
      const text = raw.trim();
      if (text.length === 0) throw new RangeError('oracle: tts text required');
      quantity = text.length;
      break;
    }
  }
  const rate = ORACLE_MEDIA_RATES[key];
  const usd = quantity * rate.usdPerUnit;
  const [provider, ...modelParts] = key.split('/');
  return {
    provider: provider!,
    model: modelParts.join('/'),
    unit: rate.unit,
    quantity,
    usd,
    manna: oracleMannaFromUsd(usd, markup),
  };
}
