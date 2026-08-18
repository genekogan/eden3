import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// OpenClaw 2026.7.1 includes exec SecretRef ids in three messages and the
// structured resolution error. Eden channel ids are durable capabilities, so
// redact only this provider at the point where the error is created. Exact
// anchors fail the image build on upstream drift.
const distDir = process.env.OPENCLAW_DIST_DIR ?? '/app/dist';
const candidates = (await readdir(distDir))
  .filter((name) => /^[A-Za-z0-9_.-]+\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const replacements = [
  {
    anchor: 'this.refId = params.refId;',
    replacement:
      'this.refId = params.provider === "eden-channel-vault" ? "protected-channel-credential" : params.refId;',
  },
  {
    anchor:
      'message: `Exec provider "${params.providerName}" failed for id "${id}" (${entry.message.trim()}).`',
    replacement:
      'message: params.providerName === "eden-channel-vault" ? `Exec provider "${params.providerName}" failed for a protected channel credential.` : `Exec provider "${params.providerName}" failed for id "${id}" (${entry.message.trim()}).`',
  },
  {
    anchor: 'message: `Exec provider "${params.providerName}" failed for id "${id}".`',
    replacement:
      'message: params.providerName === "eden-channel-vault" ? `Exec provider "${params.providerName}" failed for a protected channel credential.` : `Exec provider "${params.providerName}" failed for id "${id}".`',
  },
  {
    anchor: 'message: `Exec provider "${params.providerName}" response missing id "${id}".`',
    replacement:
      'message: params.providerName === "eden-channel-vault" ? `Exec provider "${params.providerName}" response omitted a protected channel credential.` : `Exec provider "${params.providerName}" response missing id "${id}".`',
  },
];

let patchedFiles = 0;
for (const file of candidates) {
  const source = await readFile(file, 'utf8');
  const counts = replacements.map(({ anchor }) => source.split(anchor).length - 1);
  if (counts.every((count) => count === 0)) continue;
  if (counts.some((count) => count !== 1)) {
    throw new Error(
      `OpenClaw channel secret error-redaction anchors changed in ${path.basename(file)} (${counts.join(',')})`,
    );
  }
  let next = source;
  for (const { anchor, replacement } of replacements) next = next.replace(anchor, replacement);
  await writeFile(file, next, 'utf8');
  patchedFiles += 1;
}

if (patchedFiles !== 1) {
  throw new Error(`Expected one OpenClaw secret error bundle to patch, found ${patchedFiles}`);
}
