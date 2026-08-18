import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CREDENTIAL_CONTENT_RULES = Object.freeze([
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g],
  ['aws-access-key', /(?:AKIA|ASIA)[0-9A-Z]{16}/g],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/g],
  ['github-fine-grained-token', /github_pat_[A-Za-z0-9_]{30,}/g],
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-project-key', /sk-proj-[A-Za-z0-9_-]{20,}/g],
  ['generic-secret-key', /sk-[A-Za-z0-9]{32,}/g],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/g],
  ['stripe-live-key', /(?:sk|rk)_live_[0-9A-Za-z]{20,}/g],
  ['gitlab-token', /glpat-[A-Za-z0-9_-]{20,}/g],
]);

const ALLOWED_ENV_SUFFIXES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];
const INDEX_BLOB_MODES = new Set(['100644', '100755', '120000']);
const PRIVATE_KEY_BASENAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
const SECRET_CONFIG_BASENAMES = new Set(['.git-credentials', '.npmrc', '.pypirc', '.netrc']);
const SECRET_EXTENSIONS = new Set(['.pem', '.p12', '.pfx', '.keystore', '.jks']);

export function secretLikeFilename(file) {
  const portable = file.replaceAll('\\', '/');
  const basename = path.posix.basename(portable);
  if (ALLOWED_ENV_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return false;
  if (basename === '.env' || basename.includes('.env.')) return true;
  if (basename.endsWith('.env')) return true;
  if (PRIVATE_KEY_BASENAMES.has(basename)) return true;
  if (SECRET_EXTENSIONS.has(path.posix.extname(basename))) return true;
  if (SECRET_CONFIG_BASENAMES.has(basename)) return true;
  if (basename === 'credentials.json') return true;
  if (basename.startsWith('service-account') && basename.endsWith('.json')) return true;
  return basename.startsWith('client_secret') && basename.endsWith('.json');
}

function trackedEntries(repositoryRoot) {
  const records = execFileSync('git', ['ls-files', '--stage', '-z'], {
    cwd: repositoryRoot,
    encoding: 'buffer',
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const seen = new Set();
  return records.map((record) => {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error('tracked credential scan received malformed index entry');
    const [mode, objectId, stage, ...extra] = record.slice(0, separator).split(' ');
    const file = record.slice(separator + 1);
    if (extra.length > 0 || !mode || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(objectId ?? '')) {
      throw new Error(`tracked credential scan received malformed index metadata for ${JSON.stringify(file)}`);
    }
    if (stage !== '0' || seen.has(file)) {
      throw new Error(`tracked credential scan refuses unresolved index entry: ${JSON.stringify(file)}`);
    }
    if (!INDEX_BLOB_MODES.has(mode)) {
      throw new Error(`tracked credential scan refuses non-blob index entry: ${JSON.stringify(file)}`);
    }
    seen.add(file);
    return { file, mode, objectId };
  });
}

function indexBytes(repositoryRoot, entries) {
  if (entries.length === 0) return [];
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repositoryRoot,
    input: Buffer.from(`${entries.map(({ objectId }) => objectId).join('\n')}\n`, 'ascii'),
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });
  const blobs = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) throw new Error('tracked credential scan received truncated index blob header');
    const [returnedId, type, sizeText, ...extra] = output
      .subarray(offset, headerEnd)
      .toString('ascii')
      .split(' ');
    const size = Number(sizeText);
    const blobStart = headerEnd + 1;
    const blobEnd = blobStart + size;
    if (
      extra.length > 0 || returnedId !== entry.objectId || type !== 'blob' ||
      !Number.isSafeInteger(size) || size < 0 || blobEnd >= output.length || output[blobEnd] !== 10
    ) {
      throw new Error(`tracked credential scan received malformed index blob for ${JSON.stringify(entry.file)}`);
    }
    blobs.push(output.subarray(blobStart, blobEnd));
    offset = blobEnd + 1;
  }
  if (offset !== output.length) throw new Error('tracked credential scan received trailing index blob data');
  return blobs;
}

function workingTreeBytes(repositoryRoot, file) {
  const absolute = path.join(repositoryRoot, file);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(absolute), 'utf8');
  if (!stat.isFile()) throw new Error(`tracked credential scan refuses non-file path: ${file}`);
  return readFileSync(absolute);
}

function lineForOffset(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export function scanTrackedCredentialExposure(repositoryRoot, options = {}) {
  const root = path.resolve(repositoryRoot);
  const contentRules = options.contentRules ?? CREDENTIAL_CONTENT_RULES;
  const entries = trackedEntries(root);
  const blobs = indexBytes(root, entries);
  const findings = new Map();
  function record(file, rule, line) {
    const key = JSON.stringify([file, rule, line ?? null]);
    if (!findings.has(key)) findings.set(key, { file, rule, ...(line ? { line } : {}) });
  }
  function scanBytes(file, bytes) {
    const text = bytes.toString('utf8');
    for (const [rule, sourceRegex] of contentRules) {
      const regex = new RegExp(sourceRegex.source, sourceRegex.flags.includes('g')
        ? sourceRegex.flags
        : `${sourceRegex.flags}g`);
      const match = regex.exec(text);
      if (match) record(file, rule, lineForOffset(text, match.index));
    }
  }
  for (const [position, { file }] of entries.entries()) {
    if (secretLikeFilename(file)) record(file, 'secret-like-filename');
    const indexed = blobs[position];
    scanBytes(file, indexed);
    const working = workingTreeBytes(root, file);
    if (working && !working.equals(indexed)) scanBytes(file, working);
  }
  return { filesScanned: entries.length, findings: [...findings.values()] };
}

function formatFinding({ file, rule, line }) {
  return `${JSON.stringify(file)}${line ? `:${line}` : ''} (${rule})`;
}

export function credentialExposureCli(repositoryRoot) {
  const result = scanTrackedCredentialExposure(repositoryRoot);
  if (result.findings.length > 0) {
    process.stderr.write('credential exposure scan failed; matched values are intentionally redacted\n');
    for (const finding of result.findings) process.stderr.write(`- ${formatFinding(finding)}\n`);
    return 1;
  }
  process.stdout.write(`credential exposure scan: ${result.filesScanned} tracked files, 0 findings\n`);
  return 0;
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = credentialExposureCli(process.cwd());
