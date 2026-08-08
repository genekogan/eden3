import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ApiError } from '../errors';

/**
 * Owner-facing agent-workspace file access (the /agents/:username/workspace
 * routes). The workspace root is the agent row's `workspace_path` — the same
 * host directory the OpenClaw runtime writes (see gateway provisioner.ts and
 * memory-distillation.ts, which already read/write files there).
 *
 * Security model (P0):
 *   - Every user-supplied path is JAILED to the workspace root: no absolute
 *     paths, no `..`/`.` segments, no backslashes or NUL bytes, and — after
 *     lexical checks — fs.realpath containment so symlinks cannot escape into
 *     the host or a neighboring agent's workspace.
 *   - Dotfiles and runtime-internal names (openclaw-workspace-state.json,
 *     BOOTSTRAP.md, node_modules, __pycache__, .venv) are invisible: hidden
 *     from the tree/zip, unreadable (404 — indistinguishable from missing),
 *     and unwritable (400).
 *   - Size limits are enforced server-side (text 512KB, download 100MB).
 *
 * Writes are conflict-checked (sha256 of the current bytes vs the caller's
 * baseSha256) and atomic (tmp file + rename) so a save can never interleave
 * with — or silently clobber — a concurrent write by the agent itself. The
 * check-then-rename window is not transactional, but the atomic rename means
 * the worst case is last-writer-wins on two near-simultaneous saves, never a
 * torn file.
 */

export const WORKSPACE_TREE_MAX_ENTRIES = 2_000;
/** sha256 is computed for tree files at or below this size (conflict detection). */
export const WORKSPACE_HASH_MAX_BYTES = 1024 * 1024;
/** Text read/write ceiling — larger files are reported as binary. */
export const WORKSPACE_TEXT_MAX_BYTES = 512 * 1024;
export const WORKSPACE_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

const HIDDEN_NAMES = new Set([
  'openclaw-workspace-state.json',
  'BOOTSTRAP.md',
  'node_modules',
  '__pycache__',
  '.venv',
]);

/** Internal/hidden names never listed, served, or written. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || HIDDEN_NAMES.has(name);
}

export interface WorkspaceTreeEntry {
  path: string;
  kind: 'file' | 'dir';
  sizeBytes: number;
  /** ISO-8601 mtime. */
  mtime: string;
  /** Present for files ≤ {@link WORKSPACE_HASH_MAX_BYTES} (conflict detection). */
  sha256?: string;
}

export type WorkspaceFileContent =
  | {
      path: string;
      kind: 'text';
      content: string;
      sizeBytes: number;
      mtime: string;
      sha256: string;
    }
  | { path: string; kind: 'binary'; sizeBytes: number; mtime: string };

export type WorkspaceWriteResult =
  | {
      ok: true;
      file: { path: string; kind: 'text'; sizeBytes: number; mtime: string; sha256: string };
    }
  | { ok: false; currentSha256: string | null; currentMtime: string | null };

// ---------------------------------------------------------------------------
// Path jail
// ---------------------------------------------------------------------------

function invalidPath(): ApiError {
  return new ApiError(400, 'workspace_invalid_path', 'Path must stay inside the agent workspace');
}

function notFound(): ApiError {
  return new ApiError(404, 'workspace_file_not_found', 'No such workspace file');
}

function hiddenPath(forWrite: boolean): ApiError {
  // Reads 404 (hidden files are indistinguishable from missing ones); writes
  // get an explicit 400 so the client knows the name itself is off-limits.
  return forWrite
    ? new ApiError(400, 'workspace_path_forbidden', 'This path is reserved for the runtime')
    : notFound();
}

function containsHiddenSegment(rel: string): boolean {
  return rel.split(path.sep).some((segment) => isHiddenName(segment));
}

/**
 * Lexical jail: reject absolute paths, traversal, backslashes, NUL, and
 * hidden/internal segments; return the normalized relative path plus the
 * absolute (not yet symlink-checked) target under `root`.
 */
export function resolveWorkspacePath(
  root: string,
  rawPath: unknown,
  opts: { forWrite?: boolean } = {},
): { abs: string; rel: string } {
  const forWrite = opts.forWrite === true;
  if (typeof rawPath !== 'string' || rawPath === '') throw invalidPath();
  if (rawPath.includes('\0') || rawPath.includes('\\')) throw invalidPath();
  if (path.isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath)) throw invalidPath();

  const segments = rawPath.split('/');
  if (segments.length === 0) throw invalidPath();
  for (const segment of segments) {
    // Empty segments make aliases such as `SOUL.md/` and `SOUL.md//` resolve
    // to a managed doctrine file after ownership policy has run. Reject them
    // instead of normalizing so one spelling always means one policy.
    if (segment === '' || segment === '.' || segment === '..') throw invalidPath();
    if (isHiddenName(segment)) throw hiddenPath(forWrite);
  }

  const rootAbs = path.resolve(root);
  const abs = path.join(rootAbs, ...segments);
  // Defense in depth — the segment checks above already guarantee this.
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw invalidPath();
  return { abs, rel: segments.join('/') };
}

async function realpathIfExists(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Symlink jail for an EXISTING path: resolve the real location and require it
 * to stay inside the workspace root and outside hidden names (a symlink to
 * `.secret` or to a neighboring agent's workspace must behave like a missing
 * file). Returns the real absolute path.
 */
async function assertRealContained(root: string, abs: string, forWrite: boolean): Promise<string> {
  const rootReal = await realpathIfExists(path.resolve(root));
  if (rootReal === null) throw notFound();
  const targetReal = await realpathIfExists(abs);
  if (targetReal === null) throw notFound();
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw forWrite ? invalidPath() : notFound();
  }
  const rel = path.relative(rootReal, targetReal);
  if (rel !== '' && containsHiddenSegment(rel)) throw hiddenPath(forWrite);
  return targetReal;
}

/**
 * Symlink jail for a possibly-missing WRITE target: realpath the deepest
 * existing ancestor directory and require containment (missing path segments
 * cannot be symlinks, so this covers the whole chain).
 */
async function assertParentContained(root: string, abs: string): Promise<void> {
  const rootReal = await realpathIfExists(path.resolve(root));
  if (rootReal === null) throw notFound();
  let dir = path.dirname(abs);
  let dirReal = await realpathIfExists(dir);
  while (dirReal === null) {
    const parent = path.dirname(dir);
    if (parent === dir) throw invalidPath();
    dir = parent;
    dirReal = await realpathIfExists(dir);
  }
  if (dirReal !== rootReal && !dirReal.startsWith(rootReal + path.sep)) throw invalidPath();
  const rel = path.relative(rootReal, dirReal);
  if (rel !== '' && containsHiddenSegment(rel)) throw hiddenPath(true);
}

// ---------------------------------------------------------------------------
// Hashing / text detection
// ---------------------------------------------------------------------------

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function sha256File(abs: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Valid UTF-8 without NUL bytes -> decoded string; otherwise null (binary). */
function decodeText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  try {
    return utf8Decoder.decode(buf);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tree listing
// ---------------------------------------------------------------------------

export async function listWorkspaceTree(
  root: string,
  opts: { maxEntries?: number; withHashes?: boolean } = {},
): Promise<{ entries: WorkspaceTreeEntry[]; truncated: boolean }> {
  const maxEntries = opts.maxEntries ?? WORKSPACE_TREE_MAX_ENTRIES;
  const withHashes = opts.withHashes ?? true;
  const rootReal = await realpathIfExists(path.resolve(root));
  // A never-provisioned or wiped workspace is just empty, not an error.
  if (rootReal === null) return { entries: [], truncated: false };

  const entries: WorkspaceTreeEntry[] = [];
  let truncated = false;

  async function walk(dirAbs: string, relPrefix: string): Promise<void> {
    const dirents = await fs.readdir(dirAbs, { withFileTypes: true });
    // Folders first, then files, alphabetical — a stable order for the UI.
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const dirent of dirents) {
      if (isHiddenName(dirent.name)) continue;
      // Symlinks are never listed: reads through them are rejected anyway,
      // and following them could loop or wander outside the jail.
      if (dirent.isSymbolicLink()) continue;
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const abs = path.join(dirAbs, dirent.name);
      const rel = relPrefix === '' ? dirent.name : `${relPrefix}/${dirent.name}`;
      const stat = await fs.stat(abs);
      if (dirent.isDirectory()) {
        entries.push({ path: rel, kind: 'dir', sizeBytes: 0, mtime: stat.mtime.toISOString() });
        await walk(abs, rel);
        if (truncated) return;
      } else if (dirent.isFile()) {
        const entry: WorkspaceTreeEntry = {
          path: rel,
          kind: 'file',
          sizeBytes: stat.size,
          mtime: stat.mtime.toISOString(),
        };
        if (withHashes && stat.size <= WORKSPACE_HASH_MAX_BYTES) {
          entry.sha256 = await sha256File(abs);
        }
        entries.push(entry);
      }
    }
  }

  await walk(rootReal, '');
  return { entries, truncated };
}

// ---------------------------------------------------------------------------
// File read
// ---------------------------------------------------------------------------

export async function readWorkspaceFile(root: string, rawPath: unknown): Promise<WorkspaceFileContent> {
  const { abs, rel } = resolveWorkspacePath(root, rawPath);
  const real = await assertRealContained(root, abs, false);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw notFound();
  const mtime = stat.mtime.toISOString();
  if (stat.size > WORKSPACE_TEXT_MAX_BYTES) {
    return { path: rel, kind: 'binary', sizeBytes: stat.size, mtime };
  }
  const buf = await fs.readFile(real);
  const text = decodeText(buf);
  if (text === null) {
    return { path: rel, kind: 'binary', sizeBytes: stat.size, mtime };
  }
  return {
    path: rel,
    kind: 'text',
    content: text,
    sizeBytes: stat.size,
    mtime,
    sha256: sha256Hex(buf),
  };
}

/** Jail-checked stat + read stream for the raw download route. */
export async function openWorkspaceDownload(
  root: string,
  rawPath: unknown,
): Promise<{ rel: string; sizeBytes: number; mtime: string; stream: ReadStream }> {
  const { abs, rel } = resolveWorkspacePath(root, rawPath);
  const real = await assertRealContained(root, abs, false);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw notFound();
  if (stat.size > WORKSPACE_DOWNLOAD_MAX_BYTES) {
    throw new ApiError(
      413,
      'workspace_file_too_large',
      `File exceeds the ${WORKSPACE_DOWNLOAD_MAX_BYTES / (1024 * 1024)}MB download limit`,
    );
  }
  return {
    rel,
    sizeBytes: stat.size,
    mtime: stat.mtime.toISOString(),
    stream: createReadStream(real),
  };
}

// ---------------------------------------------------------------------------
// Conflict-checked atomic write
// ---------------------------------------------------------------------------

export async function writeWorkspaceFile(params: {
  root: string;
  path: unknown;
  content: string;
  baseSha256: string;
}): Promise<WorkspaceWriteResult> {
  const { abs, rel } = resolveWorkspacePath(params.root, params.path, { forWrite: true });

  let currentSha: string | null = null;
  let currentMtime: string | null = null;
  let lstat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    lstat = await fs.lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (lstat !== null) {
    // Never write THROUGH a symlink (its target may be outside the jail or a
    // runtime-internal file) and never replace a directory.
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      throw new ApiError(400, 'workspace_path_forbidden', 'This path cannot be edited');
    }
    await assertRealContained(params.root, abs, true);
    if (lstat.size > WORKSPACE_TEXT_MAX_BYTES) {
      throw new ApiError(400, 'workspace_not_text', 'Only text files can be edited');
    }
    const buf = await fs.readFile(abs);
    if (decodeText(buf) === null) {
      throw new ApiError(400, 'workspace_not_text', 'Only text files can be edited');
    }
    currentSha = sha256Hex(buf);
    currentMtime = lstat.mtime.toISOString();
    if (params.baseSha256 !== currentSha) {
      return { ok: false, currentSha256: currentSha, currentMtime };
    }
  } else {
    await assertParentContained(params.root, abs);
    if (params.baseSha256 !== 'new') {
      // Caller thinks it is editing an existing file that is gone (or never
      // existed) — that is a conflict too, not a silent create.
      return { ok: false, currentSha256: null, currentMtime: null };
    }
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Atomic write: the tmp name starts with '.', so a concurrent tree listing
  // never sees the half-written file.
  const tmp = path.join(path.dirname(abs), `.eden3-write-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, params.content, 'utf8');
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }

  const stat = await fs.stat(abs);
  return {
    ok: true,
    file: {
      path: rel,
      kind: 'text',
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
      sha256: sha256Hex(Buffer.from(params.content, 'utf8')),
    },
  };
}

// ---------------------------------------------------------------------------
// Download content types (the API sets nosniff globally, so inline image
// rendering in the web file viewer needs real MIME types)
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function workspaceDownloadMime(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}
