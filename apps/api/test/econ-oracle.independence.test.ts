import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ORACLE_CEILINGS,
  ORACLE_CHAT_MODEL_MANIFEST,
  oracleMannaFromUsd,
  oracleMeteredManna,
  oracleReservation,
  oracleSettlement,
  oracleStudioQuote,
  oracleOutputCapCoherent,
  oracleD004Gap,
} from './helpers/econ-oracle';

/**
 * T08-U03 — the oracle's own trustworthiness (MVP-ACCEPTANCE §1.11).
 * Two duties: (1) prove the oracle imports NOTHING from production code, so it
 * cannot silently mirror the implementation; (2) pin the oracle's arithmetic to
 * hand-computed literals so a bug in the oracle can never bless a broken kernel.
 */

describe('econ-oracle independence (rule 11)', () => {
  it('imports no production module', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./helpers/econ-oracle.ts', import.meta.url)),
      'utf8',
    );
    // No import may reference a production package or the src tree. Comments are
    // allowed to mention them (they do, explaining the independence), so match
    // only actual import/require forms.
    const importLines = src
      .split('\n')
      .filter((line) => /^\s*(import|export)\s.*\bfrom\b/.test(line) || /\brequire\(/.test(line));
    for (const line of importLines) {
      expect(line, `forbidden import in oracle: ${line}`).not.toMatch(
        /@eden3\/(core|gateway|shared|db)|\.\.\/src\/|\.\/[^']*\/src\//,
      );
    }
    // Sanity: the oracle really is where we think (has the literal price sheet).
    expect(src).toContain('ORACLE_LLM_RATES');
    expect(src).toContain('inputPerM');
  });
});

describe('econ-oracle arithmetic pinned to hand-computed literals', () => {
  it('markup + peg: hand-computed manna conversions', () => {
    // $0.045 × 1.35 × 1000 = 60.75 → 61
    expect(oracleMannaFromUsd(0.045)).toBe(61);
    // $0.67 × 1.35 × 1000 = 904.5 → 905
    expect(oracleMannaFromUsd(0.67)).toBe(905);
    // $1.12 × 1.35 × 1000 = 1512.0 → 1512
    expect(oracleMannaFromUsd(1.12)).toBe(1512);
    // zero stays zero
    expect(oracleMannaFromUsd(0)).toBe(0);
    // a second markup: $0.045 × 2.0 × 1000 = 90
    expect(oracleMannaFromUsd(0.045, 1.0)).toBe(90);
  });

  it('frozen reservations match the ceiling anchors', () => {
    expect(oracleReservation('anthropic/claude-haiku-4-5')).toBe(61);
    expect(oracleReservation('anthropic/claude-sonnet-4-5')).toBe(905);
    expect(oracleReservation('anthropic/claude-sonnet-4-6')).toBe(905);
    expect(oracleReservation('anthropic/claude-opus-4-6')).toBe(1512);
  });

  it('metered manna: hand-computed usage shapes', () => {
    // haiku 30k in + 2k out: 30000/1e6*1 + 2000/1e6*5 = 0.03 + 0.01 = 0.04 USD
    // × 1.35 × 1000 = 54.0 → 54
    expect(oracleMeteredManna({ promptTokens: 30_000, completionTokens: 2_000 }, 'anthropic/claude-haiku-4-5')).toBe(54);
    // haiku 1k in + 100 out: 0.001 + 0.0005 = 0.0015 × 1.35 × 1000 = 2.025 → 3
    expect(oracleMeteredManna({ promptTokens: 1_000, completionTokens: 100 }, 'anthropic/claude-haiku-4-5')).toBe(3);
    // haiku 1M in + 100k out: 1 + 0.5 = 1.5 × 1.35 × 1000 = 2025 (overrun vs 61)
    expect(oracleMeteredManna({ promptTokens: 1_000_000, completionTokens: 100_000 }, 'anthropic/claude-haiku-4-5')).toBe(2025);
    // cache-read discount: 30k cached (of 30k prompt) + 0 out on haiku:
    // 30000/1e6*0.1 = 0.003 × 1.35 × 1000 = 4.05 → 5
    expect(
      oracleMeteredManna(
        { promptTokens: 30_000, completionTokens: 0, cachedTokens: 30_000 },
        'anthropic/claude-haiku-4-5',
      ),
    ).toBe(5);
  });

  it('settlement clamps at the reservation and flags overrun', () => {
    const under = oracleSettlement({ promptTokens: 30_000, completionTokens: 2_000 }, 'anthropic/claude-haiku-4-5');
    expect(under).toEqual({ metered: 54, reservation: 61, charged: 54, overrun: false });
    const over = oracleSettlement({ promptTokens: 1_000_000, completionTokens: 100_000 }, 'anthropic/claude-haiku-4-5');
    expect(over).toEqual({ metered: 2025, reservation: 61, charged: 61, overrun: true });
  });

  it('studio quotes: hand-computed per tool/route', () => {
    // flux/dev image: 1 × 0.025 = 0.025 × 1.35 × 1000 = 33.75 → 34
    expect(oracleStudioQuote('image_generate').manna).toBe(34);
    // gemini premium: 1 × 0.134 = 0.134 × 1.35 × 1000 = 180.9 → 181
    expect(oracleStudioQuote('image_generate', { model: 'gemini-pro' }).manna).toBe(181);
    // kling video 5s: 5 × 0.09 = 0.45 × 1.35 × 1000 = 607.5 → 608
    expect(oracleStudioQuote('video_generate', { duration: 5 }).manna).toBe(608);
    // kling video 2s: 2 × 0.09 = 0.18 × 1.35 × 1000 = 243 → 243
    expect(oracleStudioQuote('video_generate', { duration: 2 }).manna).toBe(243);
    // lyria music clip: 1 × 0.04 = 0.04 × 1.35 × 1000 = 54 → 54
    expect(oracleStudioQuote('music_generate').manna).toBe(54);
    // tts 120 chars: 120 × 0.0001667 = 0.0200040 × 1.35 × 1000 = 27.0054 → 28
    expect(oracleStudioQuote('tts', { text: 'x'.repeat(120) }).manna).toBe(28);
    expect(() => oracleStudioQuote('video_generate', { duration: 99 })).toThrow();
  });

  it('output-cap coherence holds for every ceiling (per-call diagnostic)', () => {
    for (const model of ORACLE_CHAT_MODEL_MANIFEST) {
      const c = oracleOutputCapCoherent(model);
      expect(c.coherent, `${model}: output-only $${c.outputOnlyUsd} > ceiling $${c.ceilingUsd}`).toBe(true);
    }
  });

  it('D-004 gap is machine-readable and non-trivial (whole-turn worst case unbounded)', () => {
    const gap = oracleD004Gap('anthropic/claude-haiku-4-5');
    // Output-only consumes most of the ceiling but input room remains, and the
    // agentic loop is unbounded — the residual the clamp policy tolerates.
    expect(gap.inputTokensStillPermittedInOneCall).toBeGreaterThan(0);
    expect(gap.unboundedMultiCall).toBe(true);
    expect(Object.keys(ORACLE_CEILINGS)).toContain('anthropic/claude-haiku-4-5');
  });
});
