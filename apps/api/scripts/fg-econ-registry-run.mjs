#!/usr/bin/env node
/**
 * T08-U03 — FG-ECON execution-binding generator (MVP-ACCEPTANCE §1.7).
 *
 * Runs the FG-ECON battery with vitest's JSON reporter, then writes
 * `fg-econ-executed.json` mapping each registry id to its executed/passed
 * state. This is what binds the FG-ECON registry to REAL execution rather than
 * to naming: the evidence bundle carries proof that every registered id ran and
 * passed (and that none was skipped/todo'd).
 *
 * Usage (from apps/api):
 *   DATABASE_URL=...eden3_stg node scripts/fg-econ-registry-run.mjs <outDir>
 *
 * Exit non-zero if any registered id did not execute-and-pass.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(apiDir, 'var/fg-econ');
mkdirSync(outDir, { recursive: true });

const registry = JSON.parse(readFileSync(path.join(apiDir, 'test/fg-econ-registry.json'), 'utf8'));

const batteryFiles = [
  'test/fg-econ-battery.test.ts',
  'test/fg-econ-studio.test.ts',
  'test/fg-econ-crash-reaper.test.ts',
  'test/econ-oracle.independence.test.ts',
  'test/fg-econ-registry.test.ts',
  'test/turns-authorization.test.ts',
  'test/turn-reservation-reaper.test.ts',
  'test/turns-usage.test.ts',
  'test/triggers-routes.test.ts',
];

const jsonOut = path.join(outDir, 'vitest-fg-econ.json');
const tsx = path.join(apiDir, 'node_modules/.bin/vitest');
const res = spawnSync(
  tsx,
  ['run', '--reporter=json', `--outputFile=${jsonOut}`, ...batteryFiles],
  { cwd: apiDir, stdio: ['ignore', 'inherit', 'inherit'], env: process.env },
);

let results;
try {
  results = JSON.parse(readFileSync(jsonOut, 'utf8'));
} catch (err) {
  console.error(`fg-econ-registry-run: could not read vitest json output at ${jsonOut}: ${String(err)}`);
  process.exit(1);
}

// Collect passed test titles.
const passedTitles = [];
for (const file of results.testResults ?? []) {
  for (const a of file.assertionResults ?? []) {
    if (a.status === 'passed') passedTitles.push(a.fullName ?? a.title ?? '');
  }
}

const executed = [];
let allBound = true;
for (const entry of registry.cases) {
  const tier = entry.tier ?? 'unit';
  const passed = passedTitles.some((t) => t.includes(entry.match));
  executed.push({ id: entry.id, match: entry.match, file: entry.file, tier, passed });
  // itest-tier ids run under the shared-stack VERIFY step, not this unit-vitest
  // generator; their evidence is the stack run log, so they never fail the
  // generator (they are recorded pending here).
  if (tier === 'unit' && !passed) allBound = false;
}

const unitIds = executed.filter((e) => e.tier === 'unit');
const manifest = {
  version: registry.version,
  row: registry.row,
  generatedAt: new Date().toISOString(),
  vitestExitCode: res.status,
  totalRegistered: registry.cases.length,
  unitRegistered: unitIds.length,
  unitPassed: unitIds.filter((e) => e.passed).length,
  itestPending: executed.filter((e) => e.tier === 'itest').map((e) => e.id),
  executed,
};
const outFile = path.join(outDir, 'fg-econ-executed.json');
writeFileSync(outFile, JSON.stringify(manifest, null, 2));
console.log(
  `fg-econ-registry-run: wrote ${outFile} (unit ${manifest.unitPassed}/${manifest.unitRegistered} passed; itest pending: ${manifest.itestPending.join(', ') || 'none'})`,
);

if (!allBound) {
  console.error('fg-econ-registry-run: not every UNIT-tier registered id executed-and-passed');
  process.exit(1);
}
