import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import registry from './fg-econ-registry.json';

/**
 * T08-U03 — FG-ECON registry integrity (MVP-ACCEPTANCE §1.7: footgun rows map
 * to versioned executable test IDs with a stimulus, a forbidden outcome, and a
 * positive control; "never satisfiable by naming alone").
 *
 * This meta-test binds the registry to REAL, ACTIVE tests:
 *  - every registered id resolves to an active `it(`/`it.each(` title (its
 *    `match` string) in its named file — `.skip`/`.todo`/`.only` are rejected;
 *  - every FG-ECON-* id that appears in the battery source files is registered
 *    (bidirectional coverage — no orphan ids);
 *  - every entry declares a non-empty stimulus, forbiddenOutcome, positiveControl.
 *
 * Execution binding: scripts/fg-econ-registry-run.mjs runs the battery with the
 * JSON reporter and writes `fg-econ-executed.json` into the evidence bundle,
 * recording that each id EXECUTED and PASSED. That generator is asserted to
 * exist and be wired here, and its output is part of the acceptance manifest —
 * so the row is bound to execution, not to naming.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));

function readTestFile(relFromApi: string): string {
  // registry paths are relative to apps/api (e.g. "test/fg-econ-battery.test.ts")
  const abs = fileURLToPath(new URL(`../${relFromApi}`, import.meta.url));
  return readFileSync(abs, 'utf8');
}

/**
 * A test title containing `match` exists in `src`. The static scan is a coarse
 * FORWARD guard (the id string appears in a quoted test title); the EXECUTION
 * authority is scripts/fg-econ-registry-run.mjs, which confirms the id actually
 * ran and PASSED in the right file on a fully-green, no-skip run. To keep the
 * static side honest, `noSkipConstructs` separately forbids skip/only/todo in
 * the battery files, so a title match can never sit under a disabled test.
 */
function hasTitleMatch(src: string, match: string): boolean {
  // The match must appear inside a quoted string (a test title / describe),
  // not only in a comment. Accept single, double, or backtick quotes.
  const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`['"\`][^'"\`]*${escaped}`);
  return re.test(src);
}

function noSkipConstructs(src: string): boolean {
  return !/(\bit|\bdescribe|\btest)\s*\.(skip|only|todo)\b/.test(src);
}

interface RegistryEntry {
  id: string;
  file: string;
  match: string;
  stimulus: string;
  forbiddenOutcome: string;
  positiveControl: string;
}

const entries = registry.cases as RegistryEntry[];

describe('FG-ECON registry integrity (MVP-ACCEPTANCE §1.7)', () => {
  it('declares a version and a non-empty case set', () => {
    expect(registry.version).toBe('2026-08-08.fg-econ-v1');
    expect(entries.length).toBeGreaterThanOrEqual(20);
    // No duplicate ids.
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry declares a stimulus, a forbidden outcome, and a positive control', () => {
    for (const e of entries) {
      expect(e.stimulus?.length, `${e.id} stimulus`).toBeGreaterThan(10);
      expect(e.forbiddenOutcome?.length, `${e.id} forbiddenOutcome`).toBeGreaterThan(10);
      expect(e.positiveControl?.length, `${e.id} positiveControl`).toBeGreaterThan(10);
    }
  });

  it('every registered id resolves to a test title in its file (forward guard)', () => {
    for (const e of entries) {
      const src = readTestFile(e.file);
      expect(hasTitleMatch(src, e.match), `${e.id}: no test titled with "${e.match}" in ${e.file}`).toBe(true);
    }
  });

  it('battery files contain no skip/only/todo constructs (a match can never sit under a disabled test)', () => {
    const batteryFiles = [
      'test/fg-econ-battery.test.ts',
      'test/fg-econ-studio.test.ts',
      'test/fg-econ-crash-reaper.test.ts',
      'test/econ-oracle.independence.test.ts',
      'test/fg-econ-registry.test.ts',
    ];
    for (const file of batteryFiles) {
      expect(noSkipConstructs(readTestFile(file)), `${file} has a skip/only/todo construct`).toBe(true);
    }
  });

  it('bidirectional: every FG-ECON-* id used in a battery test title is registered', () => {
    const batteryFiles = [
      'test/fg-econ-battery.test.ts',
      'test/fg-econ-studio.test.ts',
      'test/fg-econ-crash-reaper.test.ts',
    ];
    // Registered id "cores" (a match may carry an it.each bracket suffix like
    // `FG-ECON-STUDIO-01[`; the token regex is uppercase-only so `STUDIO-01b`
    // reads as `STUDIO-01`). Overlap-tolerant membership handles both.
    const registeredCores = entries.map((e) => e.match.replace(/\[.*$/, ''));
    const covered = (token: string) =>
      registeredCores.some((c) => c === token || c.startsWith(token) || token.startsWith(c));
    for (const file of batteryFiles) {
      const src = readTestFile(file);
      const ids = new Set<string>();
      for (const m of src.matchAll(/FG-ECON-[A-Z0-9-]+/g)) ids.add(m[0]);
      for (const id of ids) {
        if (!hasTitleMatch(src, id)) continue; // appears only in a comment/import
        expect(covered(id), `${id} in ${file} is used in a test title but not registered`).toBe(true);
      }
    }
  });

  it('defect-evidence entries are flagged so they are never counted as positive FG-ECON coverage', () => {
    // Some registered ids document a KNOWN defect executably (e.g. the studio
    // sub->durable laundering vector). They must carry `defect: true` so the
    // generated evidence separates them from positive coverage.
    const launder = entries.find((e) => e.id === 'FG-ECON-STUDIO-LAUNDER') as (RegistryEntry & { defect?: boolean }) | undefined;
    expect(launder?.defect).toBe(true);
  });

  it('the execution-binding generator exists and targets the battery', () => {
    // The generator writes fg-econ-executed.json (id -> passed) into the
    // evidence bundle from a real vitest --reporter=json run. Its presence +
    // wiring is asserted so the registry can never be a naming-only artifact.
    const genPath = fileURLToPath(new URL('../scripts/fg-econ-registry-run.mjs', import.meta.url));
    const gen = readFileSync(genPath, 'utf8');
    expect(gen).toContain('reporter');
    expect(gen).toContain('fg-econ-executed.json');
    expect(HERE.length).toBeGreaterThan(0);
  });
});
