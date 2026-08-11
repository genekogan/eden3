import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runManagedRuntimeRehearsal } from './managed-runtime-rehearsal';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function resolveManagedRuntimeEvidencePath(output: string): string {
  const resolved = path.isAbsolute(output)
    ? path.resolve(output)
    : path.resolve(REPO_ROOT, output);
  const allowed = path.join(REPO_ROOT, 'var', 'acceptance') + path.sep;
  if (!resolved.startsWith(allowed) || path.extname(resolved) !== '.json') {
    throw new Error('managed runtime rehearsal output must be JSON under var/acceptance');
  }
  return resolved;
}

async function main() {
  const databaseUrl = process.env.MANAGED_DATABASE_URL;
  const expectedDatabaseName = process.env.MANAGED_DATABASE_EXPECTED_NAME;
  if (!databaseUrl || !expectedDatabaseName) {
    throw new Error('managed runtime rehearsal environment is incomplete');
  }
  const evidence = await runManagedRuntimeRehearsal(databaseUrl, expectedDatabaseName);
  const output = process.env.MANAGED_RUNTIME_REHEARSAL_OUT;
  if (output) {
    const resolved = resolveManagedRuntimeEvidencePath(output);
    await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
    await writeFile(resolved, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return evidence;
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entryPoint && pathToFileURL(entryPoint).href === import.meta.url) {
  main()
    .then((evidence) => console.log(JSON.stringify({ ok: true, evidence })))
    .catch(() => {
      console.error(JSON.stringify({ ok: false, error: 'managed_runtime_rehearsal_failed' }));
      process.exitCode = 1;
    });
}
