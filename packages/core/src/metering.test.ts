import { describe, expect, it } from 'vitest';

import {
  COST_TABLE_VERSION,
  CostTableError,
  costFromLlmUsage,
  costFromParams,
  mannaForEstimate,
  mannaFromUsd,
} from './metering';

describe('CostTable', () => {
  it('throws for unknown provider/model/unit combinations', () => {
    expect(() =>
      costFromParams({
        provider: 'fal',
        model: 'unknown/model',
        units: { image: 1 },
      }),
    ).toThrow(CostTableError);
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
    expect(elevenTts.totalCostUsd).toBeCloseTo(0.20004, 10);
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
