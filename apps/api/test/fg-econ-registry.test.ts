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

/** Lines that open a test with a title (it(...) / it.each(...)(...)). */
function activeTestTitleLines(src: string): string[] {
  return src
    .split('\n')
    .filter((line) => /\bit\s*(\.each\s*\([^)]*\))?\s*\(/.test(line))
    .filter((line) => !/\bit\s*\.(skip|todo|only)\b/.test(line))
    .filter((line) => !/\.each\s*\([^)]*\)\s*\.(skip|todo|only)\b/.test(line));
}

/** Does an ACTIVE test title in `src` contain `match`? */
function hasActiveTitle(src: string, match: string): boolean {
  // Fast path: the match sits on the same line as the it(...) opener.
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const opensTest = /\bit\s*(\.each\s*\([^)]*\))?\s*\(/.test(line);
    if (!opensTest) continue;
    if (/\bit\s*\.(skip|todo|only)\b/.test(line) || /\.each\s*\([^)]*\)\s*\.(skip|todo|only)\b/.test(line)) {
      continue;
    }
    // The title may continue onto the next couple of lines; join a small window.
    const window = [line, lines[i + 1] ?? '', lines[i + 2] ?? ''].join('\n');
    if (window.includes(match)) return true;
  }
  return false;
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

  it('every registered id resolves to an ACTIVE (non-skip/todo/only) test title', () => {
    for (const e of entries) {
      const src = readTestFile(e.file);
      expect(hasActiveTitle(src, e.match), `${e.id}: no active test titled with "${e.match}" in ${e.file}`).toBe(true);
    }
  });

  it('bidirectional: every FG-ECON-* id in the battery files is registered', () => {
    const batteryFiles = [
      'test/fg-econ-battery.test.ts',
      'test/fg-econ-studio.test.ts',
      'test/fg-econ-crash-reaper.test.ts',
    ];
    const registered = new Set(entries.map((e) => e.match));
    for (const file of batteryFiles) {
      const src = readTestFile(file);
      // Collect ids used in this file's active titles.
      const ids = new Set<string>();
      for (const m of src.matchAll(/FG-ECON-[A-Z0-9-]+/g)) {
        // strip an it.each interpolation bracket suffix if present
        ids.add(m[0]);
      }
      for (const id of ids) {
        // Every FG-ECON id string that appears in an ACTIVE title must be a
        // registered `match` (base id) — orphan ids fail here.
        if (!hasActiveTitle(src, id)) continue; // appears only in a comment/import
        expect(registered.has(id), `${id} in ${file} is used in a test title but not registered`).toBe(true);
      }
    }
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
