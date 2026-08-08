import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ORACLE_CHAT_MODEL_MANIFEST, oracleD004Gap, oracleOutputCapCoherent } from './helpers/econ-oracle';

/**
 * T08-U03 — machine-readable D-004 evidence (checkpoint-#1 finding 1 / #2).
 *
 * The battery proves the LANDED clamp mechanism; it does NOT claim "max never
 * understated", which is structurally unprovable at the OpenClaw compat
 * interface (an uncancellable, unbounded agentic loop). This test emits, for
 * EVERY model, the whole-turn gap the clamp policy tolerates — the per-call
 * output-only cost, how much uncached input the ceiling still permits in ONE
 * call after that, and the fact that the loop can issue arbitrarily many such
 * calls. The artifact is bundled as D-004 discussion evidence (DECISIONS.md),
 * not a green gate.
 */

describe('D-004 evidence: whole-turn worst-case gap (all models)', () => {
  it('emits a per-model gap artifact and asserts it is non-trivial for every model', () => {
    const gaps = ORACLE_CHAT_MODEL_MANIFEST.map((model) => {
      const gap = oracleD004Gap(model);
      const coherence = oracleOutputCapCoherent(model);
      // Per-call output cap must not by itself exceed the ceiling (the internal
      // coherence checkpoint-#1 finding 1 asked for) ...
      expect(coherence.coherent, `${model}: output-only $${coherence.outputOnlyUsd} > ceiling`).toBe(true);
      // ... yet the whole-turn worst case is unbounded: input room remains in a
      // single call AND the agentic loop can repeat it without limit.
      expect(gap.inputTokensStillPermittedInOneCall).toBeGreaterThan(0);
      expect(gap.unboundedMultiCall).toBe(true);
      return { ...gap, outputCapCoherent: coherence.coherent };
    });
    expect(gaps).toHaveLength(ORACLE_CHAT_MODEL_MANIFEST.length);

    const outDir = process.env.FG_ECON_EVIDENCE_DIR
      ? path.resolve(process.env.FG_ECON_EVIDENCE_DIR)
      : path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'var/fg-econ');
    mkdirSync(outDir, { recursive: true });
    const artifact = {
      row: 'D-004',
      note: 'whole-turn worst-case gap the landed clamp policy tolerates; discussion evidence, not a gate',
      ceilingTableVersion: '2026-08-08.authz-v1',
      generatedAt: new Date().toISOString(),
      models: gaps,
    };
    writeFileSync(path.join(outDir, 'd004-gap.json'), JSON.stringify(artifact, null, 2));
    // The artifact covers every routable model.
    expect(new Set(gaps.map((g) => g.model)).size).toBe(ORACLE_CHAT_MODEL_MANIFEST.length);
  });
});
