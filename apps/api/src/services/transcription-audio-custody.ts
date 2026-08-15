import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELATIVE_CHUNK = /^[0-9a-f-]{36}[/][0-9a-f-]{36}[/][0-9]+-[0-9a-f-]{36}[.]pcm$/i;
const CHUNK_BASENAME = /^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]pcm$/i;

function assertUuid(label: string, value: string): void {
  if (!UUID.test(value)) throw new Error(`transcription custody: invalid ${label}`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('transcription custody: directory boundary is not a real directory');
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Private local audio boundary. No method returns an HTTP/CDN URL. */
export class PrivateTranscriptionAudioStore {
  private canonicalRoot: string | null = null;

  constructor(readonly configuredRoot: string) {
    if (!configuredRoot || configuredRoot.includes('\0')) {
      throw new Error('transcription custody: audio root is required');
    }
  }

  async initialize(): Promise<void> {
    const root = resolve(this.configuredRoot);
    await ensurePrivateDirectory(root);
    this.canonicalRoot = await realpath(root);
  }

  private async root(): Promise<string> {
    if (this.canonicalRoot === null) await this.initialize();
    return this.canonicalRoot!;
  }

  private async resolveRelative(relativePath: string): Promise<string> {
    if (!RELATIVE_CHUNK.test(relativePath) || isAbsolute(relativePath)) {
      throw new Error('transcription custody: invalid relative chunk path');
    }
    const root = await this.root();
    const candidate = resolve(root, relativePath);
    const relation = relative(root, candidate);
    if (!relation || relation.startsWith(`..${sep}`) || relation === '..' || isAbsolute(relation)) {
      throw new Error('transcription custody: chunk path escapes the private root');
    }
    return candidate;
  }

  async writeChunk(input: {
    ownerId: string;
    sessionId: string;
    chunkNumber: number;
    body: Buffer;
  }): Promise<string> {
    assertUuid('owner id', input.ownerId);
    assertUuid('session id', input.sessionId);
    if (!Number.isSafeInteger(input.chunkNumber) || input.chunkNumber < 0) {
      throw new Error('transcription custody: invalid chunk number');
    }
    const root = await this.root();
    const ownerDir = resolve(root, input.ownerId);
    const sessionDir = resolve(ownerDir, input.sessionId);
    await ensurePrivateDirectory(ownerDir);
    await ensurePrivateDirectory(sessionDir);
    const relativePath = `${input.ownerId}/${input.sessionId}/${input.chunkNumber}-${randomUUID()}.pcm`;
    const absolutePath = await this.resolveRelative(relativePath);
    const handle = await open(
      absolutePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    let closed = false;
    try {
      await handle.writeFile(input.body);
      await handle.sync();
      await handle.close();
      closed = true;
      // Persist the file entry and both newly-created directory links before
      // the database checkpoint can be acknowledged.
      await syncDirectory(sessionDir);
      await syncDirectory(ownerDir);
      await syncDirectory(root);
    } catch (error) {
      if (!closed) await handle.close().catch(() => undefined);
      await unlink(absolutePath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      throw error;
    }
    return relativePath;
  }

  async readVerified(relativePath: string, expected: { sizeBytes: number; sha256: string }): Promise<Buffer> {
    const absolutePath = await this.resolveRelative(relativePath);
    const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expected.sizeBytes) {
        throw new Error('transcription custody: private audio shape mismatch');
      }
      const body = await handle.readFile();
      const digest = createHash('sha256').update(body).digest('hex');
      if (digest !== expected.sha256) {
        throw new Error('transcription custody: private audio checksum mismatch');
      }
      return body;
    } finally {
      await handle.close();
    }
  }

  async deletePaths(relativePaths: readonly string[]): Promise<void> {
    for (const relativePath of relativePaths) {
      const absolutePath = await this.resolveRelative(relativePath);
      try {
        const stat = await lstat(absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error('transcription custody: refusing to delete a non-file chunk');
        }
        await unlink(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  /**
   * Remove every validated chunk in one exact owner/session directory. This
   * also converges files written just before a process crash but before their
   * database locator committed.
   */
  async deleteSession(ownerId: string, sessionId: string): Promise<void> {
    assertUuid('owner id', ownerId);
    assertUuid('session id', sessionId);
    const root = await this.root();
    const sessionDir = resolve(root, ownerId, sessionId);
    let entries;
    try {
      const stat = await lstat(sessionDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('transcription custody: session boundary is not a real directory');
      }
      entries = await readdir(sessionDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !CHUNK_BASENAME.test(entry.name)) {
        throw new Error('transcription custody: refusing to delete an unexpected session entry');
      }
      await unlink(resolve(sessionDir, entry.name));
    }
    // Persist removal of every file entry before removing its directory and
    // before the caller can delete the database locators.
    await syncDirectory(sessionDir);
    await this.pruneSessionDirectories(ownerId, sessionId);
  }

  async pruneSessionDirectories(ownerId: string, sessionId: string): Promise<void> {
    assertUuid('owner id', ownerId);
    assertUuid('session id', sessionId);
    const root = await this.root();
    const ownerDir = resolve(root, ownerId);
    const sessionDir = resolve(ownerDir, sessionId);
    let removedSession = false;
    try {
      await rmdir(sessionDir);
      removedSession = true;
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (removedSession) await syncDirectory(ownerDir);
    let removedOwner = false;
    try {
      await rmdir(ownerDir);
      removedOwner = true;
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (removedOwner) await syncDirectory(root);
  }
}
