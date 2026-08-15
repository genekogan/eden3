import { describe, expect, it } from 'vitest';

import {
  COST_TABLE_VERSION,
  CostTableError,
  costFromLlmUsage,
  costFromParams,
  mannaForEstimate,
  mannaFromUsd,
  selectCostTableEntry,
  selectTurnCeilingEntry,
  TURN_CEILING_TABLE_VERSION,
  type CostTableEntry,
  type TurnCeilingEntry,
  TurnCeilingError,
  turnAuthorizedMax,
} from './metering';

describe('CostTable', () => {
  const rate = (
    effectiveDate: string,
    usdPerUnit: number,
    model = 'dated-model',
  ): CostTableEntry => ({
    provider: 'anthropic',
    model,
    unit: 'input_1m_tokens',
    usdPerUnit,
    effectiveDate,
    source: `test rate ${effectiveDate}`,
  });

  it('selects the latest eligible rate independent of registry order', () => {
    const older = rate('2026-01-01', 1);
    const current = rate('2026-02-01', 2);
    const future = rate('2026-03-01', 3);
    const route = {
      provider: 'anthropic' as const,
      model: 'anthropic/dated-model',
      unit: 'input_1m_tokens' as const,
    };

    for (const table of [
      [older, current, future],
      [future, older, current],
      [current, future, older],
    ]) {
      expect(selectCostTableEntry(route, { table, asOf: '2026-02-15' })).toBe(current);
    }
  });

  it('fails before the first rate, switches exactly at the boundary, and ignores future rows', () => {
    const older = rate('2026-01-01', 1);
    const current = rate('2026-02-01', 2);
    const future = rate('2027-01-01', 99);
    const table = [future, current, older];
    const route = {
      provider: 'anthropic' as const,
      model: 'dated-model',
      unit: 'input_1m_tokens' as const,
    };

    expect(() => selectCostTableEntry(route, { table, asOf: '2025-12-31' })).toThrow(
      CostTableError,
    );
    expect(selectCostTableEntry(route, { table, asOf: '2026-01-01' })).toBe(older);
    expect(selectCostTableEntry(route, { table, asOf: '2026-01-31' })).toBe(older);
    expect(selectCostTableEntry(route, { table, asOf: '2026-02-01' })).toBe(current);
    expect(selectCostTableEntry(route, { table, asOf: '2026-12-31' })).toBe(current);
  });

  it('rejects duplicate-date and normalized-model overlaps instead of using first match', () => {
    const route = {
      provider: 'anthropic' as const,
      model: 'dated-model',
      unit: 'input_1m_tokens' as const,
    };
    expect(() =>
      selectCostTableEntry(route, {
        table: [rate('2026-01-01', 1), rate('2026-01-01', 2)],
        asOf: '2026-01-01',
      }),
    ).toThrow(/ambiguous/i);
    expect(() =>
      selectCostTableEntry(route, {
        table: [rate('2026-2-01', 1)],
        asOf: '2026-02-01',
      }),
    ).toThrow(CostTableError);
    for (const effectiveDate of [undefined, new Date('2026-01-01T00:00:00.000Z')]) {
      expect(() =>
        selectCostTableEntry(route, {
          table: [
            {
              ...rate('2026-01-01', 1),
              effectiveDate,
            } as unknown as CostTableEntry,
          ],
          asOf: '2026-02-01',
        }),
      ).toThrow(CostTableError);
    }
    expect(() =>
      selectCostTableEntry(route, {
        table: [
          rate('2026-01-01', 1, 'dated-model'),
          rate('2026-01-01', 2, 'anthropic\/dated-model'),
        ],
        asOf: '2026-01-01',
      }),
    ).toThrow(/ambiguous/i);
  });

  it('uses an eligible exact model over the wildcard fallback', () => {
    const wildcard = rate('2026-02-01', 9, '*');
    const exact = rate('2026-01-01', 2);
    const route = {
      provider: 'anthropic' as const,
      model: 'dated-model',
      unit: 'input_1m_tokens' as const,
    };

    expect(
      selectCostTableEntry(route, { table: [wildcard, exact], asOf: '2026-02-15' }),
    ).toBe(exact);
    expect(
      selectCostTableEntry(route, {
        table: [wildcard, rate('2027-01-01', 2)],
        asOf: '2026-02-15',
      }),
    ).toBe(wildcard);
  });

  it('throws for unknown provider/model/unit combinations', () => {
    expect(() =>
      costFromParams({
        provider: 'fal',
        model: 'unknown/model',
        units: { image: 1 },
      }),
    ).toThrow(CostTableError);
  });

  it('threads historical as-of dates through ordinary cost estimates', () => {
    expect(() =>
      costFromParams({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        units: { input_1m_tokens: 1 },
        asOf: '2026-07-05',
      }),
    ).toThrow(CostTableError);
    expect(
      costFromParams({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        units: { input_1m_tokens: 1 },
        asOf: '2026-07-06',
      }).totalCostUsd,
    ).toBe(1);
  });

  it('computes LLM token costs and marks the table version', () => {
    const estimate = costFromLlmUsage({
      provider: 'anthropic',
      model: 'anthropic/claude-haiku-4-5',
      promptTokens: 1_000_000,
      completionTokens: 100_000,
    });

    expect(estimate.tableVersion).toBe(COST_TABLE_VERSION);
    expect(estimate.totalCostUsd).toBe(1.5);
    expect(estimate.lineItems.map((line) => [line.unit, line.quantity, line.costUsd])).toEqual([
      ['input_1m_tokens', 1, 1],
      ['output_1m_tokens', 0.1, 0.5],
    ]);
  });

  it('charges cached prompt tokens at the cache-read rate', () => {
    const cold = costFromLlmUsage({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    const warm = costFromLlmUsage({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      promptTokens: 1_000_000,
      cachedTokens: 900_000,
      completionTokens: 0,
    });

    expect(cold.totalCostUsd).toBe(1);
    expect(warm.totalCostUsd).toBeCloseTo(0.19, 10);
    expect(warm.totalCostUsd).toBeLessThan(cold.totalCostUsd);
  });

  it('prices Sonnet 4.6 cache writes separately for notional subscription billing', () => {
    const estimate = costFromLlmUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      promptTokens: 1_000_000,
      cachedTokens: 900_000,
      cacheWriteTokens: 200_000,
      completionTokens: 10_000,
    });

    expect(estimate.totalCostUsd).toBeCloseTo(1.47, 10);
    expect(estimate.lineItems.map((line) => line.unit)).toEqual([
      'input_1m_tokens',
      'cache_read_1m_tokens',
      'cache_write_1m_tokens',
      'output_1m_tokens',
    ]);
  });

  it('prices comparable Haiku < Sonnet < Opus turns', () => {
    const usage = { promptTokens: 50_000, completionTokens: 5_000 };
    const haiku = costFromLlmUsage({ provider: 'anthropic', model: 'claude-haiku-4-5', ...usage });
    const sonnet = costFromLlmUsage({ provider: 'anthropic', model: 'claude-sonnet-4-5', ...usage });
    const opus = costFromLlmUsage({ provider: 'anthropic', model: 'claude-opus-4-6', ...usage });

    expect(haiku.totalCostUsd).toBeLessThan(sonnet.totalCostUsd);
    expect(sonnet.totalCostUsd).toBeLessThan(opus.totalCostUsd);
  });

  it('computes deterministic media/provider units from the table', () => {
    const falImage = costFromParams({
      provider: 'fal',
      model: 'fal-ai/flux/dev',
      units: { image: 2 },
    });
    const elevenTts = costFromParams({
      provider: 'elevenlabs',
      model: 'tts',
      units: { audio_character: 1_200 },
    });
    const runwayVideo = costFromParams({
      provider: 'runway',
      model: 'gen4-turbo',
      units: { video_second: 10 },
    });
    const geminiImage = costFromParams({
      provider: 'google',
      model: 'gemini-3-pro-image',
      units: { image: 1 },
    });
    const lyriaClip = costFromParams({
      provider: 'google',
      model: 'lyria-3-clip-preview',
      units: { music_clip: 1 },
    });
    const veoFast = costFromParams({
      provider: 'google',
      model: 'veo-3.1-fast-generate-preview',
      units: { video_second: 8 },
    });

    expect(falImage.totalCostUsd).toBe(0.05);
    expect(elevenTts.totalCostUsd).toBeCloseTo(0.06, 10);
    expect(runwayVideo.totalCostUsd).toBe(0.5);
    expect(geminiImage.totalCostUsd).toBe(0.134);
    expect(lyriaClip.totalCostUsd).toBe(0.04);
    expect(veoFast.totalCostUsd).toBe(0.8);
  });
});

describe('manna conversion', () => {
  it('uses ceil(cost_usd * (1 + markup) * manna_per_usd)', () => {
    expect(mannaFromUsd(0.1234, { markup: 0.35, mannaPerUsd: 1_000 })).toBe(167);
    expect(mannaFromUsd(0, { markup: 0.35, mannaPerUsd: 1_000 })).toBe(0);
  });

  it('converts an estimate through the same central formula', () => {
    const estimate = costFromParams({
      provider: 'fal',
      model: 'fal-ai/flux/dev',
      units: { image: 1 },
    });
    expect(mannaForEstimate(estimate, { markup: 0, mannaPerUsd: 1_000 })).toBe(25);
  });
});

describe('turn authorization ceilings (T08-U02, MVP gap 42)', () => {
  const ceiling = (
    effectiveDate: string,
    maxTurnUsd: number,
    model = 'dated-model',
  ): TurnCeilingEntry => ({
    provider: 'anthropic',
    model,
    maxTurnUsd,
    maxOutputTokens: 1_024,
    effectiveDate,
    source: `test ceiling ${effectiveDate}`,
  });

  it('selects the latest eligible ceiling independent of order at exact date boundaries', () => {
    const older = ceiling('2026-01-01', 1);
    const current = ceiling('2026-02-01', 2);
    const future = ceiling('2027-01-01', 99);
    const route = { provider: 'anthropic', model: 'anthropic/dated-model' };

    expect(() =>
      selectTurnCeilingEntry(route, {
        table: [current, older, future],
        asOf: '2025-12-31',
      }),
    ).toThrow(TurnCeilingError);
    expect(
      selectTurnCeilingEntry(route, {
        table: [future, current, older],
        asOf: '2026-01-31',
      }),
    ).toBe(older);
    expect(
      selectTurnCeilingEntry(route, {
        table: [future, older, current],
        asOf: '2026-02-01',
      }),
    ).toBe(current);
    expect(
      selectTurnCeilingEntry(route, {
        table: [current, future, older],
        asOf: '2026-12-31',
      }),
    ).toBe(current);
  });

  it('rejects duplicate effective-date ceilings and invalid as-of dates', () => {
    const route = { provider: 'anthropic', model: 'dated-model' };
    expect(() =>
      selectTurnCeilingEntry(route, {
        table: [ceiling('2026-01-01', 1), ceiling('2026-01-01', 2)],
        asOf: '2026-01-01',
      }),
    ).toThrow(/ambiguous/i);
    expect(() =>
      selectTurnCeilingEntry(route, {
        table: [ceiling('2026-01-01', 1)],
        asOf: '2026-02-30',
      }),
    ).toThrow(TurnCeilingError);
    expect(() =>
      selectTurnCeilingEntry(route, {
        table: [ceiling('not-a-date', 1)],
        asOf: '2026-02-01',
      }),
    ).toThrow(TurnCeilingError);
    for (const effectiveDate of [undefined, new Date('2026-01-01T00:00:00.000Z')]) {
      expect(() =>
        selectTurnCeilingEntry(route, {
          table: [
            {
              ...ceiling('2026-01-01', 1),
              effectiveDate,
            } as unknown as TurnCeilingEntry,
          ],
          asOf: '2026-02-01',
        }),
      ).toThrow(TurnCeilingError);
    }
  });

  it('uses an eligible exact-model ceiling over wildcard fallback', () => {
    const wildcard = ceiling('2026-02-01', 9, '*');
    const exact = ceiling('2026-01-01', 2);
    const route = { provider: 'anthropic', model: 'dated-model' };

    expect(
      selectTurnCeilingEntry(route, {
        table: [wildcard, exact],
        asOf: '2026-02-15',
      }),
    ).toBe(exact);
    expect(
      selectTurnCeilingEntry(route, {
        table: [wildcard, ceiling('2027-01-01', 2)],
        asOf: '2026-02-15',
      }),
    ).toBe(wildcard);
  });

  it('covers every registered anthropic chat model with a frozen expected max', () => {
    // Expected manna values are FROZEN literals (not recomputed from the
    // table): a silent ceiling-table regression must fail this test. True
    // independent route-envelope oracles are T08-U03's deliverable.
    const expected: Record<string, number> = {
      'claude-haiku-4-5': 61,
      'claude-sonnet-4-5': 905,
      'claude-sonnet-4-6': 905,
      'claude-opus-4-6': 1512,
    };
    for (const [model, manna] of Object.entries(expected)) {
      const auth = turnAuthorizedMax({ provider: 'anthropic', model });
      expect(auth.manna, model).toBe(manna);
      expect(auth.tableVersion).toBe(TURN_CEILING_TABLE_VERSION);
      expect(auth.usd).toBeGreaterThan(0);
    }
  });

  it('accepts provider-prefixed model ids (the agents.model form)', () => {
    expect(turnAuthorizedMax({ provider: 'anthropic', model: 'anthropic/claude-haiku-4-5' }).manna).toBe(61);
  });

  it('threads historical as-of dates through ordinary turn authorization', () => {
    expect(() =>
      turnAuthorizedMax(
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { asOf: '2026-08-07' },
      ),
    ).toThrow(TurnCeilingError);
    expect(
      turnAuthorizedMax(
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { asOf: '2026-08-08' },
      ).manna,
    ).toBe(61);
  });

  it('fails closed on a model without a ceiling entry', () => {
    expect(() => turnAuthorizedMax({ provider: 'anthropic', model: 'claude-nonexistent' })).toThrow(
      TurnCeilingError,
    );
    expect(() => turnAuthorizedMax({ provider: 'google', model: 'gemini-3-pro' })).toThrow(
      TurnCeilingError,
    );
  });

  it('propagates the markup knob (T-BILL: one knob moves every monetary stage)', () => {
    const base = turnAuthorizedMax({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    const doubled = turnAuthorizedMax(
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      { markup: 1.7 },
    );
    expect(doubled.manna).toBeGreaterThan(base.manna);
    expect(doubled.manna).toBe(Math.ceil(0.045 * 2.7 * 1000));
  });

  it('ceiling values dominate every observed real turn (2026-08-08 telemetry)', () => {
    // Observed per-model maxima from canonical eden3 + eden3_stg usage_events
    // (documented in the unit file): haiku 26, sonnet 456, opus 235.
    expect(turnAuthorizedMax({ provider: 'anthropic', model: 'claude-haiku-4-5' }).manna).toBeGreaterThan(26);
    expect(turnAuthorizedMax({ provider: 'anthropic', model: 'claude-sonnet-4-6' }).manna).toBeGreaterThan(456);
    expect(turnAuthorizedMax({ provider: 'anthropic', model: 'claude-opus-4-6' }).manna).toBeGreaterThan(235);
  });
});
