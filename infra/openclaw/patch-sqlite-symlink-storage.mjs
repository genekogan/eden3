import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// OpenClaw 2026.7.1 resolves a SQLite symlink to inspect the actual volume,
// but then combines that safe canonical path with the SSHFS directory that
// merely contains the symlink. The unsafe outer mount wins and the database
// is refused even though SQLite opens the VM-native target. Inspect only the
// canonical existing volume. A non-symlinked SSHFS database still resolves to
// SSHFS and remains correctly blocked.
const distDir = '/app/dist';
const candidates = (await readdir(distDir))
  .filter((name) => /^[A-Za-z0-9_.-]+\.js$/.test(name))
  .map((name) => path.join(distDir, name));

async function patchExactlyOne(label, replacements) {
  let patchedFiles = 0;
  for (const file of candidates) {
    const source = await readFile(file, 'utf8');
    const counts = replacements.map(({ anchor }) => source.split(anchor).length - 1);
    if (counts.every((count) => count === 0)) continue;
    const invalid = counts.findIndex(
      (count, index) => count !== replacements[index].expectedCount,
    );
    if (invalid !== -1) {
      throw new Error(
        `OpenClaw ${label} patch anchors changed in ${path.basename(file)} ` +
          `(${counts.join(',')})`,
      );
    }
    let next = source;
    for (const { anchor, replacement } of replacements) {
      next = next.split(anchor).join(replacement);
    }
    await writeFile(file, next, 'utf8');
    patchedFiles += 1;
  }
  if (patchedFiles !== 1) {
    throw new Error(`Expected one OpenClaw ${label} bundle to patch, found ${patchedFiles}`);
  }
}

await patchExactlyOne('SQLite canonical-volume storage', [
  {
    expectedCount: 1,
    anchor:
      'const mountLookupPaths = [checkedPaths.originalPath, checkedPaths.canonicalPath];',
    replacement: 'const mountLookupPaths = [checkedPaths.canonicalPath];',
  },
]);

// Full reindexes build a shadow DB and a SQLite lock beside the configured
// path. Put those auxiliaries beside the resolved native target too; otherwise
// a file-level symlink fixes the live DB while its shadow DB still lands on
// SSHFS and is refused (or could replace the symlink).
await patchExactlyOne('memory reindex canonical-volume storage', [
  {
    expectedCount: 1,
    anchor:
      'const dbPath = resolveUserPath(this.settings.store.databasePath);\n' +
      '\t\tconst tempDbPath = `${dbPath}.memory-reindex-${randomUUID()}`;',
    replacement:
      'const dbPath = resolveUserPath(this.settings.store.databasePath);\n' +
      '\t\tconst reindexDbPath = fs.realpathSync(dbPath);\n' +
      '\t\tconst tempDbPath = `${reindexDbPath}.memory-reindex-${randomUUID()}`;',
  },
  {
    expectedCount: 1,
    anchor: 'cleanupAgedMemoryReindexTempFiles(dbPath);',
    replacement: 'cleanupAgedMemoryReindexTempFiles(reindexDbPath);',
  },
  {
    expectedCount: 1,
    anchor: 'reindexLock = acquireMemoryReindexLock(dbPath);',
    replacement: 'reindexLock = acquireMemoryReindexLock(reindexDbPath);',
  },
]);
