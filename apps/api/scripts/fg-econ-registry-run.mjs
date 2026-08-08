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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  'test/econ-d004-evidence.test.ts',
  'test/fg-econ-registry.test.ts',
  'test/turns-authorization.test.ts',
  'test/turn-reservation-reaper.test.ts',
  'test/turns-usage.test.ts',
  'test/triggers-routes.test.ts',
  'test/studio-routes.test.ts',
  'test/channel-metering.test.ts',
];

const jsonOut = path.join(outDir, 'vitest-fg-econ.json');
// Never trust a stale report (checkpoint-#2): delete any prior output first so a
// crashed run can't certify old results.
if (existsSync(jsonOut)) rmSync(jsonOut);
const tsx = path.join(apiDir, 'node_modules/.bin/vitest');
const res = spawnSync(
  tsx,
  ['run', '--reporter=json', `--outputFile=${jsonOut}`, ...batteryFiles],
  { cwd: apiDir, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, FG_ECON_EVIDENCE_DIR: outDir } },
);

let results;
try {
  results = JSON.parse(readFileSync(jsonOut, 'utf8'));
} catch (err) {
  console.error(`fg-econ-registry-run: could not read vitest json output at ${jsonOut}: ${String(err)}`);
  process.exit(1);
}

// Index assertion results BY FILE, so a match must land in the registered file
// (not any file globally), and record skipped/todo separately so a
// skipped/focused sibling can never certify an id.
const byFile = new Map(); // fileBasenameSuffix -> { passed:Set<string>, skipped:Set<string> }
for (const file of results.testResults ?? []) {
  const name = file.name ?? '';
  const rec = { passed: [], skipped: [] };
  for (const a of file.assertionResults ?? []) {
    const full = `${(a.ancestorTitles ?? []).join(' > ')} ${a.fullName ?? a.title ?? ''}`;
    if (a.status === 'passed') rec.passed.push(full);
    else rec.skipped.push({ status: a.status, full });
  }
  byFile.set(name, rec);
}
function fileRecordFor(relFile) {
  for (const [name, rec] of byFile) {
    if (name.endsWith(relFile) || name.endsWith(relFile.replace(/^test\//, ''))) return rec;
  }
  return null;
}

const executed = [];
let allBound = true;
for (const entry of registry.cases) {
  const tier = entry.tier ?? 'unit';
  const rec = fileRecordFor(entry.file);
  const passed = !!rec && rec.passed.some((t) => t.includes(entry.match));
  const skippedSibling = !!rec && rec.skipped.some((s) => s.full.includes(entry.match));
  executed.push({ id: entry.id, match: entry.match, file: entry.file, tier, defect: !!entry.defect, passed, skippedSibling });
  // itest-tier ids run under the shared-stack VERIFY step, not this unit-vitest
  // generator; their evidence is the stack run log, so they never fail the
  // generator (they are recorded pending here).
  if (tier === 'unit' && (!passed || skippedSibling)) allBound = false;
}

// The whole battery run must itself be green (no failed/skipped anywhere in the
// registered unit files) — a failing sibling can't hide behind a passing id.
const unitRunClean = res.status === 0;

const unitIds = executed.filter((e) => e.tier === 'unit');
const manifest = {
  version: registry.version,
  row: registry.row,
  generatedAt: new Date().toISOString(),
  vitestExitCode: res.status,
  unitRunClean,
  totalRegistered: registry.cases.length,
  unitRegistered: unitIds.length,
  unitPassed: unitIds.filter((e) => e.passed).length,
  defectEvidenceIds: executed.filter((e) => e.defect).map((e) => e.id),
  itestPending: executed.filter((e) => e.tier === 'itest').map((e) => e.id),
  executed,
};
const outFile = path.join(outDir, 'fg-econ-executed.json');
writeFileSync(outFile, JSON.stringify(manifest, null, 2));
console.log(
  `fg-econ-registry-run: wrote ${outFile} (unit ${manifest.unitPassed}/${manifest.unitRegistered} passed; runClean=${unitRunClean}; itest pending: ${manifest.itestPending.join(', ') || 'none'})`,
);

if (!allBound || !unitRunClean) {
  console.error('fg-econ-registry-run: not every UNIT-tier id executed-and-passed on a fully-green run');
  process.exit(1);
}
