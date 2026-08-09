import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type Stats } from 'node:fs';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

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
/** Whole ZIP exports are bounded across all files to protect the API worker. */
export const WORKSPACE_EXPORT_MAX_BYTES = 1024 * 1024 * 1024;

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

function assertContainedRealPath(
  rootReal: string,
  targetReal: string,
  forWrite: boolean,
  allowInternal = false,
): void {
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw forWrite ? invalidPath() : notFound();
  }
  const rel = path.relative(rootReal, targetReal);
  if (!allowInternal && rel !== '' && containsHiddenSegment(rel)) throw hiddenPath(forWrite);
}

// ---------------------------------------------------------------------------
// Hashing / text detection
// ---------------------------------------------------------------------------

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
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
  const entries: WorkspaceTreeEntry[] = [];
  let truncated = false;
  const maxScannedEntries = Math.max(maxEntries * 4, maxEntries + 1_024);
  let scannedEntries = 0;

  const pendingDirectories = [''];
  while (pendingDirectories.length > 0 && !truncated) {
    const relPrefix = pendingDirectories.pop()!;
    let directory: PinnedWorkspaceDirectory;
    try {
      directory = await openPinnedDirectoryPath(root, relPrefix, false);
    } catch (error) {
      // A never-provisioned, concurrently moved, or wiped directory simply
      // disappears from this point-in-time listing.
      if (isNotFoundError(error) || isPathRaceOrTypeError(error)) continue;
      throw error;
    }

    const candidates: Array<{ name: string; directoryHint: boolean }> = [];
    try {
      const dir = await fs.opendir(directoryAccessPath(directory));
      try {
        for await (const dirent of dir) {
          scannedEntries += 1;
          if (scannedEntries > maxScannedEntries) {
            truncated = true;
            break;
          }
          if (isHiddenName(dirent.name) || dirent.isSymbolicLink()) continue;
          if (candidates.length >= Math.max(0, maxEntries - entries.length)) {
            truncated = true;
            break;
          }
          candidates.push({ name: dirent.name, directoryHint: dirent.isDirectory() });
        }
      } finally {
        await dir.close().catch(() => {});
      }

      candidates.sort((a, b) => {
        if (a.directoryHint !== b.directoryHint) return a.directoryHint ? -1 : 1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

      const childDirectories: string[] = [];
      for (const candidate of candidates) {
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        const rel = relPrefix === '' ? candidate.name : `${relPrefix}/${candidate.name}`;
        if (candidate.directoryHint) {
          let child: PinnedWorkspaceDirectory | null = null;
          try {
            child = await openPinnedChildDirectory(directory, candidate.name, false);
            entries.push({
              path: rel,
              kind: 'dir',
              sizeBytes: 0,
              mtime: child.stat.mtime.toISOString(),
            });
            childDirectories.push(rel);
          } catch (error) {
            if (!isPathRaceOrTypeError(error) && !isNotFoundError(error)) throw error;
          } finally {
            await child?.handle.close().catch(() => {});
          }
          continue;
        }

        let file: PinnedWorkspaceFile | null = null;
        try {
          file = await openPinnedRegularAt(directory, candidate.name, rel, false);
          const entry: WorkspaceTreeEntry = {
            path: rel,
            kind: 'file',
            sizeBytes: file.stat.size,
            mtime: file.stat.mtime.toISOString(),
          };
          if (withHashes && file.stat.size <= WORKSPACE_HASH_MAX_BYTES) {
            entry.sha256 = sha256Hex(await readPinnedSnapshot(file.handle, file.stat.size));
          }
          entries.push(entry);
        } catch (error) {
          if (!isPathRaceOrTypeError(error) && !isNotFoundError(error)) throw error;
        } finally {
          await file?.handle.close().catch(() => {});
        }
      }
      // Stack in reverse so the visible traversal remains alphabetic while no
      // ancestor descriptor is retained across a child walk.
      pendingDirectories.push(...childDirectories.reverse());
    } finally {
      await directory.handle.close().catch(() => {});
    }
  }
  return { entries, truncated };
}

// ---------------------------------------------------------------------------
// File read
// ---------------------------------------------------------------------------

interface PinnedWorkspaceFile {
  handle: FileHandle;
  rel: string;
  stat: Stats;
}

interface PinnedWorkspaceDirectory {
  handle: FileHandle;
  rootReal: string;
  realPath: string;
  stat: Stats;
}

function isPathRaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP';
}

function isPathRaceOrTypeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return isPathRaceError(error) || code === 'EISDIR' || code === 'EINVAL';
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'workspace_file_not_found';
}

async function descriptorRealpath(
  handle: FileHandle,
  openedPath: string,
  descriptorIdentity: BigIntStats,
  expectedKind: 'file' | 'directory',
): Promise<string> {
  if (process.platform === 'linux') {
    const descriptorPath = await realpathIfExists(`/proc/self/fd/${handle.fd}`);
    if (descriptorPath === null) throw notFound();
    return descriptorPath;
  }

  // macOS has no procfs and Node does not expose F_GETPATH. This fallback
  // keeps local development fail-closed against ordinary swaps. Production is
  // Linux and uses the descriptor-authoritative procfs branch above.
  const reboundReal = await realpathIfExists(openedPath);
  if (reboundReal === null) throw notFound();
  const reboundStat = await fs.stat(reboundReal, { bigint: true });
  const expectedType = expectedKind === 'file' ? reboundStat.isFile() : reboundStat.isDirectory();
  if (
    !expectedType
    || reboundStat.dev !== descriptorIdentity.dev
    || reboundStat.ino !== descriptorIdentity.ino
  ) {
    throw notFound();
  }
  return reboundReal;
}

function directoryAccessPath(directory: PinnedWorkspaceDirectory): string {
  return process.platform === 'linux'
    ? `/proc/self/fd/${directory.handle.fd}`
    : directory.realPath;
}

function childAccessPath(directory: PinnedWorkspaceDirectory, name: string): string {
  return path.join(directoryAccessPath(directory), name);
}

async function openPinnedWorkspaceRoot(root: string): Promise<PinnedWorkspaceDirectory> {
  const rootReal = await realpathIfExists(path.resolve(root));
  if (rootReal === null) throw notFound();
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(
      rootReal,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    const identity = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) throw notFound();
    const descriptorReal = await descriptorRealpath(handle, rootReal, identity, 'directory');
    if (descriptorReal !== rootReal) throw notFound();
    return { handle, rootReal, realPath: descriptorReal, stat };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (isPathRaceOrTypeError(error)) throw notFound();
    throw error;
  }
}

async function assertPinnedDirectoryStillBound(directory: PinnedWorkspaceDirectory): Promise<void> {
  const identity = await directory.handle.stat({ bigint: true });
  const descriptorReal = await descriptorRealpath(
    directory.handle,
    directory.realPath,
    identity,
    'directory',
  );
  assertContainedRealPath(directory.rootReal, descriptorReal, true);
  directory.realPath = descriptorReal;
}

async function openPinnedChildDirectory(
  parent: PinnedWorkspaceDirectory,
  name: string,
  create: boolean,
): Promise<PinnedWorkspaceDirectory> {
  const openedPath = childAccessPath(parent, name);
  if (create) {
    try {
      await fs.mkdir(openedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(
      openedPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    const identity = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) throw create ? invalidPath() : notFound();
    const descriptorReal = await descriptorRealpath(handle, openedPath, identity, 'directory');
    assertContainedRealPath(parent.rootReal, descriptorReal, create);
    return { handle, rootReal: parent.rootReal, realPath: descriptorReal, stat };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function openPinnedParent(
  root: string,
  rel: string,
  create: boolean,
): Promise<{ directory: PinnedWorkspaceDirectory; name: string }> {
  const segments = rel.split('/');
  const name = segments.pop();
  if (!name) throw invalidPath();
  return {
    directory: await openPinnedDirectoryPath(root, segments.join('/'), create),
    name,
  };
}

async function openPinnedDirectoryPath(
  root: string,
  rel: string,
  create: boolean,
): Promise<PinnedWorkspaceDirectory> {
  const segments = rel === '' ? [] : rel.split('/');
  let directory = await openPinnedWorkspaceRoot(root);
  try {
    for (const segment of segments) {
      const child = await openPinnedChildDirectory(directory, segment, create);
      await directory.handle.close();
      directory = child;
    }
    return directory;
  } catch (error) {
    await directory.handle.close().catch(() => {});
    throw error;
  }
}

async function openPinnedRegularAt(
  parent: PinnedWorkspaceDirectory,
  name: string,
  rel: string,
  forWrite: boolean,
): Promise<PinnedWorkspaceFile> {
  const openedPath = childAccessPath(parent, name);
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(
      openedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    const identity = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      throw forWrite
        ? new ApiError(400, 'workspace_path_forbidden', 'This path cannot be edited')
        : notFound();
    }
    const descriptorReal = await descriptorRealpath(handle, openedPath, identity, 'file');
    assertContainedRealPath(parent.rootReal, descriptorReal, forWrite);
    return { handle, rel, stat };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!forWrite && isPathRaceOrTypeError(error)) throw notFound();
    throw error;
  }
}

/**
 * Resolve, open, and then re-attest a regular workspace file. The returned
 * descriptor is the authority: callers must read only through it and close it.
 *
 * O_NOFOLLOW rejects a final-component swap. Linux production resolves the
 * opened descriptor through procfs, so containment is bound to the kernel-held
 * file rather than another attacker-controlled pathname lookup. The local
 * macOS fallback additionally binds its post-open path by exact device/inode.
 */
async function openPinnedWorkspaceFile(
  root: string,
  rawPath: unknown,
): Promise<PinnedWorkspaceFile> {
  const { rel } = resolveWorkspacePath(root, rawPath);
  let parent: PinnedWorkspaceDirectory | null = null;
  try {
    const pinned = await openPinnedParent(root, rel, false);
    parent = pinned.directory;
    return await openPinnedRegularAt(parent, pinned.name, rel, false);
  } catch (error) {
    if (isPathRaceError(error)) throw notFound();
    throw error;
  } finally {
    await parent?.handle.close().catch(() => {});
  }
}

async function readPinnedAtMost(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const result = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < result.byteLength) {
    const { bytesRead } = await handle.read(
      result,
      offset,
      result.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return result.subarray(0, offset);
}

async function readPinnedSnapshot(handle: FileHandle, sizeBytes: number): Promise<Buffer> {
  const result = Buffer.allocUnsafe(sizeBytes);
  let offset = 0;
  while (offset < result.byteLength) {
    const { bytesRead } = await handle.read(result, offset, result.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return result.subarray(0, offset);
}

/** A descriptor-backed, snapshot-bounded stream. */
async function retainedHandleStream(handle: FileHandle, sizeBytes: number): Promise<Readable> {
  if (sizeBytes === 0) {
    await handle.close();
    return Readable.from([]);
  }
  return handle.createReadStream({
    autoClose: true,
    start: 0,
    end: sizeBytes - 1,
  });
}

export async function readWorkspaceFile(root: string, rawPath: unknown): Promise<WorkspaceFileContent> {
  const { handle, rel, stat } = await openPinnedWorkspaceFile(root, rawPath);
  try {
    const mtime = stat.mtime.toISOString();
    if (stat.size > WORKSPACE_TEXT_MAX_BYTES) {
      return { path: rel, kind: 'binary', sizeBytes: stat.size, mtime };
    }
    const buf = await readPinnedAtMost(handle, WORKSPACE_TEXT_MAX_BYTES);
    if (buf.byteLength > WORKSPACE_TEXT_MAX_BYTES) {
      return { path: rel, kind: 'binary', sizeBytes: buf.byteLength, mtime };
    }
    const text = decodeText(buf);
    if (text === null) {
      return { path: rel, kind: 'binary', sizeBytes: buf.byteLength, mtime };
    }
    return {
      path: rel,
      kind: 'text',
      content: text,
      sizeBytes: buf.byteLength,
      mtime,
      sha256: sha256Hex(buf),
    };
  } finally {
    await handle.close();
  }
}

/** Jail-checked stat + read stream for the raw download route. */
export async function openWorkspaceDownload(
  root: string,
  rawPath: unknown,
): Promise<{ rel: string; sizeBytes: number; mtime: string; stream: Readable }> {
  const pinned = await openPinnedWorkspaceFile(root, rawPath);
  const { handle, rel, stat } = pinned;
  if (stat.size > WORKSPACE_DOWNLOAD_MAX_BYTES) {
    await handle.close();
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
    stream: await retainedHandleStream(handle, stat.size),
  };
}

/** Open one ZIP entry through a retained descriptor and exact snapshot bound. */
export async function openWorkspaceExportFile(
  root: string,
  rawPath: unknown,
  remainingBytes = WORKSPACE_EXPORT_MAX_BYTES,
): Promise<{ sizeBytes: number; stream: Readable }> {
  const { handle, stat } = await openPinnedWorkspaceFile(root, rawPath);
  if (stat.size > remainingBytes) {
    await handle.close();
    throw new ApiError(
      413,
      'workspace_export_too_large',
      `Workspace export exceeds the ${WORKSPACE_EXPORT_MAX_BYTES / (1024 * 1024)}MB limit`,
    );
  }
  return {
    sizeBytes: stat.size,
    stream: await retainedHandleStream(handle, stat.size),
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
  const { rel } = resolveWorkspacePath(params.root, params.path, { forWrite: true });
  const content = Buffer.from(params.content, 'utf8');
  if (content.byteLength > WORKSPACE_TEXT_MAX_BYTES) {
    throw new ApiError(413, 'workspace_file_too_large', 'Workspace text file is too large');
  }
  // Production is Linux, where /proc/self/fd gives this module genuine
  // descriptor-relative open/rename semantics. Node exposes no equivalent
  // openat/renameat primitive on macOS or Windows; a pathname fallback would
  // reintroduce an ancestor-swap write window. Refuse before any filesystem
  // mutation instead of offering a weaker local write boundary.
  if (process.platform !== 'linux') {
    throw new ApiError(
      503,
      'workspace_secure_write_unavailable',
      'Workspace editing requires descriptor-relative filesystem support',
    );
  }

  const { directory, name } = await openPinnedParent(params.root, rel, true);
  let current: PinnedWorkspaceFile | null = null;
  let temporary: FileHandle | null = null;
  let temporaryPath: string | null = null;
  try {
    try {
      current = await openPinnedRegularAt(directory, name, rel, true);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP' || code === 'EISDIR') {
        throw new ApiError(400, 'workspace_path_forbidden', 'This path cannot be edited');
      }
      if (code !== 'ENOENT') throw error;
    }

    if (current !== null) {
      const currentBytes = await readPinnedAtMost(current.handle, WORKSPACE_TEXT_MAX_BYTES);
      if (currentBytes.byteLength > WORKSPACE_TEXT_MAX_BYTES || decodeText(currentBytes) === null) {
        throw new ApiError(400, 'workspace_not_text', 'Only text files can be edited');
      }
      const currentSha = sha256Hex(currentBytes);
      if (params.baseSha256 !== currentSha) {
        return {
          ok: false,
          currentSha256: currentSha,
          currentMtime: current.stat.mtime.toISOString(),
        };
      }
    } else if (params.baseSha256 !== 'new') {
      return { ok: false, currentSha256: null, currentMtime: null };
    }

    await current?.handle.close();
    current = null;
    await assertPinnedDirectoryStillBound(directory);

    // Both names are resolved relative to the retained parent descriptor in
    // Linux production. A concurrent ancestor replacement therefore cannot
    // redirect either the temporary write or the atomic rename.
    temporaryPath = childAccessPath(directory, `.eden3-write-${randomUUID()}.tmp`);
    temporary = await fs.open(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
      0o600,
    );
    const temporaryIdentity = await temporary.stat({ bigint: true });
    const temporaryReal = await descriptorRealpath(
      temporary,
      temporaryPath,
      temporaryIdentity,
      'file',
    );
    assertContainedRealPath(directory.rootReal, temporaryReal, true, true);
    await temporary.writeFile(content);
    await temporary.sync();
    const writtenStat = await temporary.stat();
    await assertPinnedDirectoryStillBound(directory);
    await fs.rename(temporaryPath, childAccessPath(directory, name));
    temporaryPath = null;

    return {
      ok: true,
      file: {
        path: rel,
        kind: 'text',
        sizeBytes: writtenStat.size,
        mtime: writtenStat.mtime.toISOString(),
        sha256: sha256Hex(content),
      },
    };
  } finally {
    await current?.handle.close().catch(() => {});
    await temporary?.close().catch(() => {});
    if (temporaryPath !== null) await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await directory.handle.close().catch(() => {});
  }
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
