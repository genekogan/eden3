import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

const MANAGED_SLUG = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MANIFEST_BEGIN = '<!-- EDEN3_SKILLS_BEGIN -->';
const MANIFEST_END = '<!-- EDEN3_SKILLS_END -->';
const TOMBSTONE_MARKER = '.eden3-managed-tombstone.json';
const INERT_SKILL =
  '---\nname: eden-disabled-skill\ndescription: Disabled by Eden review policy.\n---\n\nThis skill is disabled.\n';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function input() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function verifyCwd(expected) {
  const current = await fs.stat('.', { bigint: true });
  if (
    !current.isDirectory() ||
    current.dev.toString() !== expected.dev ||
    current.ino.toString() !== expected.ino
  ) {
    throw new Error('anchored directory identity changed');
  }
}

async function syncCwd() {
  const directory = await fs.open('.', constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function syncParent() {
  const directory = await fs.open('..', constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function atomicWrite(name, body) {
  if (path.basename(name) !== name || name.includes('/') || name.includes('\\')) {
    throw new Error('invalid anchored filename');
  }
  const temporary = `.${name}.eden3-tmp-${process.pid}-${Date.now()}`;
  let handle;
  try {
    handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, name);
    await syncCwd();
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function removeManifest(text) {
  const start = text.indexOf(MANIFEST_BEGIN);
  const end = text.indexOf(MANIFEST_END);
  if (start === -1 || end === -1 || end < start) return text.trimEnd();
  return `${text.slice(0, start).trimEnd()}\n${text.slice(end + MANIFEST_END.length).trimStart()}`.trimEnd();
}

async function rewriteTools(manifest) {
  const entries = await fs.readdir('.');
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith('.TOOLS.md.eden3-tmp-'))
      .map((entry) => fs.rm(entry, { force: true })),
  );
  let base = '';
  let handle;
  try {
    handle = await fs.open('TOOLS.md', constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('TOOLS.md is not a regular file');
    base = await handle.readFile('utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const without = removeManifest(base);
  await atomicWrite('TOOLS.md', manifest ? `${without}\n\n${manifest}\n` : `${without}\n`);
}

async function writeSkill(body) {
  const entries = await fs.readdir('.');
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.startsWith('.SKILL.md.eden3-tmp-') ||
          entry.startsWith('SKILL.md.eden3-tmp-'),
      )
      .map((entry) => fs.rm(entry, { force: true })),
  );
  await atomicWrite('SKILL.md', body);
}

async function sanitizeAndTombstone(slug) {
  if (!MANAGED_SLUG.test(slug)) throw new Error('invalid managed slug');
  const current = await fs.stat('.', { bigint: true });
  await atomicWrite('SKILL.md', INERT_SKILL);
  await atomicWrite(
    TOMBSTONE_MARKER,
    `${JSON.stringify({
      version: 1,
      slug,
      dev: current.dev.toString(),
      ino: current.ino.toString(),
    })}\n`,
  );
  const parentEntry = await fs.lstat(`../${slug}`, { bigint: true });
  if (
    !parentEntry.isDirectory() ||
    parentEntry.isSymbolicLink() ||
    parentEntry.dev !== current.dev ||
    parentEntry.ino !== current.ino
  ) {
    throw new Error('managed skill entry changed before tombstone rename');
  }
  const tombstone = `../.eden3-managed-remove-${slug}`;
  try {
    await fs.lstat(tombstone);
    throw new Error('managed skill tombstone path is already occupied');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.rename(`../${slug}`, tombstone);
  await syncParent();
}

async function removeSpecialEntries(slugs) {
  for (const slug of slugs) {
    if (!MANAGED_SLUG.test(slug)) throw new Error('invalid managed slug');
    try {
      const entry = await fs.lstat(slug);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        throw new Error('managed directory was not tombstoned');
      }
      await fs.unlink(slug);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await syncCwd();
}

async function verifyCurrentTombstone(slug) {
  const entry = await fs.stat('.', { bigint: true });
  const markerHandle = await fs.open(
    TOMBSTONE_MARKER,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let marker;
  try {
    marker = JSON.parse(await markerHandle.readFile('utf8'));
  } finally {
    await markerHandle.close();
  }
  if (
    marker?.version !== 1 ||
    marker?.slug !== slug ||
    marker?.dev !== entry.dev.toString() ||
    marker?.ino !== entry.ino.toString()
  ) {
    throw new Error('managed skill tombstone marker mismatch');
  }
  const skillHandle = await fs.open(
    'SKILL.md',
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    if ((await skillHandle.readFile('utf8')) !== INERT_SKILL) {
      throw new Error('managed skill tombstone is not inert');
    }
  } finally {
    await skillHandle.close();
  }
  return entry;
}

async function cleanupCurrentTombstone(slug, phase) {
  if (!MANAGED_SLUG.test(slug) || !['remove', 'delete'].includes(phase)) {
    throw new Error('invalid managed tombstone cleanup');
  }
  const entry = await verifyCurrentTombstone(slug);
  const currentName = `.eden3-managed-${phase}-${slug}`;
  const parentEntry = await fs.lstat(`../${currentName}`, { bigint: true });
  if (
    !parentEntry.isDirectory() ||
    parentEntry.isSymbolicLink() ||
    parentEntry.dev !== entry.dev ||
    parentEntry.ino !== entry.ino
  ) {
    throw new Error('managed skill tombstone changed before cleanup');
  }
  const deleting = `../.eden3-managed-delete-${slug}`;
  if (phase === 'remove') {
    try {
      await fs.lstat(deleting);
      throw new Error('managed skill delete path is already occupied');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await fs.rename(`../${currentName}`, deleting);
    await syncParent();
  }
  await fs.rm(deleting, { recursive: true, force: true });
}

try {
  const request = await input();
  await verifyCwd(request.expected);
  if (request.operation === 'rewrite-tools' && typeof request.manifest === 'string') {
    await rewriteTools(request.manifest);
  } else if (request.operation === 'write-skill' && typeof request.body === 'string') {
    await writeSkill(request.body);
  } else if (
    request.operation === 'sanitize-and-tombstone' &&
    typeof request.slug === 'string'
  ) {
    await sanitizeAndTombstone(request.slug);
  } else if (
    request.operation === 'remove-special' &&
    Array.isArray(request.slugs) &&
    request.slugs.every((slug) => typeof slug === 'string')
  ) {
    await removeSpecialEntries(request.slugs);
  } else if (
    request.operation === 'cleanup-tombstone' &&
    typeof request.slug === 'string' &&
    typeof request.phase === 'string'
  ) {
    await cleanupCurrentTombstone(request.slug, request.phase);
  } else {
    throw new Error('invalid skill filesystem operation');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'skill filesystem worker failed');
}
