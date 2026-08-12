import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ZipArchive } from 'archiver';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WORKSPACE_DOWNLOAD_MAX_BYTES,
  WORKSPACE_EXPORT_MAX_BYTES,
  WORKSPACE_TEXT_MAX_BYTES,
  WORKSPACE_TREE_MAX_DEPTH,
  listWorkspaceTree,
  openWorkspaceDownload,
  openWorkspaceExportFile,
  readWorkspaceFile,
  sha256Hex,
  writeWorkspaceFile,
} from '../src/services/workspace-files';
import { appendWorkspaceArchiveFiles } from '../src/routes/workspace';

async function freshFixture() {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'eden3-workspace-fd-'));
  const root = path.join(parent, 'workspace-owner');
  const neighbor = path.join(parent, 'workspace-neighbor');
  await fs.mkdir(path.join(root, 'notes'), { recursive: true });
  await fs.mkdir(path.join(neighbor, 'notes'), { recursive: true });
  await fs.writeFile(path.join(root, 'notes', 'safe.txt'), 'OWNER BYTES');
  await fs.writeFile(path.join(neighbor, 'notes', 'safe.txt'), 'NEIGHBOR SECRET');
  return { parent, root, neighbor };
}

async function bodyOf(stream: NodeJS.ReadableStream): Promise<string> {
  let body = '';
  for await (const chunk of stream) body += Buffer.from(chunk).toString('utf8');
  return body;
}

async function expectSafeOrRejected(streamFactory: () => Promise<NodeJS.ReadableStream>) {
  let body: string | null = null;
  try {
    body = await bodyOf(await streamFactory());
  } catch (error) {
    expect(error).toMatchObject({ code: 'workspace_file_not_found' });
  }
  if (body !== null) expect(body).not.toContain('NEIGHBOR SECRET');
}

function isSafeFileCandidate(candidate: Parameters<typeof fs.open>[0]): boolean {
  return path.basename(String(candidate)) === 'safe.txt';
}

async function swapFinalComponentAfterFirstResolution(root: string, neighbor: string) {
  const target = path.join(root, 'notes', 'safe.txt');
  const outside = path.join(neighbor, 'notes', 'safe.txt');
  const originalOpen = fs.open.bind(fs);
  let swapped = false;
  vi.spyOn(fs, 'open').mockImplementation(async (candidate, flags, mode) => {
    if (!swapped && isSafeFileCandidate(candidate)) {
      swapped = true;
      await fs.unlink(target);
      await fs.symlink(outside, target);
    }
    return originalOpen(candidate, flags, mode);
  });
}

async function swapAncestorAfterFirstResolution(root: string, neighbor: string) {
  const ownerNotes = path.join(root, 'notes');
  const parkedNotes = path.join(root, 'notes-before-swap');
  const neighborNotes = path.join(neighbor, 'notes');
  const originalOpen = fs.open.bind(fs);
  let swapped = false;
  vi.spyOn(fs, 'open').mockImplementation(async (candidate, flags, mode) => {
    if (!swapped && String(candidate).endsWith('/notes')) {
      swapped = true;
      await fs.rename(ownerNotes, parkedNotes);
      await fs.symlink(neighborNotes, ownerNotes);
    }
    return originalOpen(candidate, flags, mode);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workspace file descriptor pinning', () => {
  it('never reads a neighbor file swapped in after final-path containment', async () => {
    const fixture = await freshFixture();
    try {
      await swapFinalComponentAfterFirstResolution(fixture.root, fixture.neighbor);
      await expect(readWorkspaceFile(fixture.root, 'notes/safe.txt')).rejects.toMatchObject({
        code: 'workspace_file_not_found',
      });
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('never streams a neighbor file swapped in after final-path containment', async () => {
    const fixture = await freshFixture();
    try {
      await swapFinalComponentAfterFirstResolution(fixture.root, fixture.neighbor);
      await expectSafeOrRejected(async () =>
        (await openWorkspaceDownload(fixture.root, 'notes/safe.txt')).stream);
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('never streams through an ancestor swapped after containment', async () => {
    const fixture = await freshFixture();
    try {
      await swapAncestorAfterFirstResolution(fixture.root, fixture.neighbor);
      await expectSafeOrRejected(async () =>
        (await openWorkspaceDownload(fixture.root, 'notes/safe.txt')).stream);
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('never writes into an ancestor swapped after the parent descriptor is pinned', async () => {
    const fixture = await freshFixture();
    const ownerNotes = path.join(fixture.root, 'notes');
    const parkedNotes = path.join(fixture.root, 'notes-before-write-swap');
    const neighborNotes = path.join(fixture.neighbor, 'notes');
    const originalOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'open').mockImplementation(async (candidate, flags, mode) => {
      if (!swapped && String(candidate).includes('.eden3-write-')) {
        swapped = true;
        await fs.rename(ownerNotes, parkedNotes);
        await fs.symlink(neighborNotes, ownerNotes);
      }
      return originalOpen(candidate, flags, mode);
    });
    try {
      const outcome = await writeWorkspaceFile({
        root: fixture.root,
        path: 'notes/new.txt',
        content: 'OWNER NEW CONTENT',
        baseSha256: 'new',
      }).catch((error: unknown) => error);
      if (process.platform === 'linux') {
        expect(outcome).toMatchObject({ ok: true });
        expect(await fs.readFile(path.join(parkedNotes, 'new.txt'), 'utf8')).toBe('OWNER NEW CONTENT');
      } else {
        expect(outcome).toMatchObject({ code: 'workspace_secure_write_unavailable' });
        expect(swapped).toBe(false);
      }
      await expect(fs.readFile(path.join(neighborNotes, 'new.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await fs.readFile(path.join(neighborNotes, 'safe.txt'), 'utf8')).toBe('NEIGHBOR SECRET');
      expect((await fs.readdir(neighborNotes)).some((name) => name.startsWith('.eden3-write-'))).toBe(false);
      const source = await fs.readFile(
        path.join(import.meta.dirname, '../src/services/workspace-files.ts'),
        'utf8',
      );
      const writeBody = source.slice(source.indexOf('export async function writeWorkspaceFile'));
      expect(writeBody.indexOf("process.platform !== 'linux'")).toBeGreaterThanOrEqual(0);
      expect(writeBody.indexOf("process.platform !== 'linux'")).toBeLessThan(
        writeBody.indexOf('openPinnedParent(params.root, rel, true)'),
      );
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'linux')(
    'reports a symlinked ancestor as a rejected write without touching the neighbor',
    async () => {
      const fixture = await freshFixture();
      const neighborTarget = path.join(fixture.neighbor, 'notes', 'injected.txt');
      try {
        await fs.symlink(
          path.join(fixture.neighbor, 'notes'),
          path.join(fixture.root, 'escape-dir'),
        );
        await expect(writeWorkspaceFile({
          root: fixture.root,
          path: 'escape-dir/injected.txt',
          content: 'must stay contained',
          baseSha256: 'new',
        })).rejects.toMatchObject({
          statusCode: 400,
          code: 'workspace_path_forbidden',
        });
        await expect(fs.readFile(neighborTarget)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await fs.rm(fixture.parent, { recursive: true, force: true });
      }
    },
  );

  it('retains normal conflict-checked create and update behavior through pinned parents', async () => {
    const fixture = await freshFixture();
    try {
      if (process.platform !== 'linux') {
        await expect(writeWorkspaceFile({
          root: fixture.root,
          path: 'drafts/new.txt',
          content: 'first',
          baseSha256: 'new',
        })).rejects.toMatchObject({ code: 'workspace_secure_write_unavailable' });
        return;
      }
      const created = await writeWorkspaceFile({
        root: fixture.root,
        path: 'drafts/new.txt',
        content: 'first',
        baseSha256: 'new',
      });
      expect(created).toMatchObject({ ok: true, file: { sha256: sha256Hex('first') } });
      expect(await fs.readFile(path.join(fixture.root, 'drafts', 'new.txt'), 'utf8')).toBe('first');

      const updated = await writeWorkspaceFile({
        root: fixture.root,
        path: 'drafts/new.txt',
        content: 'second',
        baseSha256: sha256Hex('first'),
      });
      expect(updated).toMatchObject({ ok: true, file: { sha256: sha256Hex('second') } });
      expect(await fs.readFile(path.join(fixture.root, 'drafts', 'new.txt'), 'utf8')).toBe('second');
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('bounds the conflict read when an existing file grows after admission', async () => {
    const fixture = await freshFixture();
    const target = path.join(fixture.root, 'notes', 'safe.txt');
    const originalOpen = fs.open.bind(fs);
    let instrumented = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (!instrumented && isSafeFileCandidate(args[0])) {
        instrumented = true;
        const originalStat = handle.stat.bind(handle);
        let statCalls = 0;
        vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
          const result = await originalStat(options as never);
          statCalls += 1;
          if (statCalls === 2) {
            await fs.appendFile(target, Buffer.alloc(WORKSPACE_TEXT_MAX_BYTES + 1, 0x78));
          }
          return result as never;
        });
      }
      return handle;
    });
    try {
      if (process.platform !== 'linux') {
        await expect(writeWorkspaceFile({
          root: fixture.root,
          path: 'notes/safe.txt',
          content: 'replacement',
          baseSha256: sha256Hex('OWNER BYTES'),
        })).rejects.toMatchObject({ code: 'workspace_secure_write_unavailable' });
        expect((await fs.stat(target)).size).toBe(Buffer.byteLength('OWNER BYTES'));
        return;
      }
      await expect(writeWorkspaceFile({
        root: fixture.root,
        path: 'notes/safe.txt',
        content: 'replacement',
        baseSha256: sha256Hex('OWNER BYTES'),
      })).rejects.toMatchObject({ code: 'workspace_not_text' });
      expect((await fs.stat(target)).size).toBeGreaterThan(WORKSPACE_TEXT_MAX_BYTES);
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('does not list or hash a final component replaced after directory enumeration', async () => {
    const fixture = await freshFixture();
    try {
      await swapFinalComponentAfterFirstResolution(fixture.root, fixture.neighbor);
      const tree = await listWorkspaceTree(fixture.root);
      expect(tree.entries.some((entry) => entry.path === 'notes/safe.txt')).toBe(false);
      expect(JSON.stringify(tree)).not.toContain(sha256Hex('NEIGHBOR SECRET'));
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('bounds directory enumeration even when hidden names cannot enter the result', async () => {
    const fixture = await freshFixture();
    try {
      await Promise.all(Array.from({ length: 1_100 }, (_, index) =>
        fs.writeFile(path.join(fixture.root, `.hidden-${index}`), 'x')));
      const tree = await listWorkspaceTree(fixture.root, { maxEntries: 1, withHashes: false });
      expect(tree.truncated).toBe(true);
      expect(tree.entries.length).toBeLessThanOrEqual(1);
      const source = await fs.readFile(
        path.join(import.meta.dirname, '../src/services/workspace-files.ts'),
        'utf8',
      );
      expect(source).toContain('fs.opendir(');
      expect(source).not.toContain('fs.readdir(dirAbs');
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('keeps directory descriptor usage constant across a deeply nested tree', async () => {
    const fixture = await freshFixture();
    let cursor = fixture.root;
    for (let depth = 0; depth < 80; depth += 1) {
      cursor = path.join(cursor, `d${depth}`);
      await fs.mkdir(cursor);
    }

    const originalOpen = fs.open.bind(fs);
    let activeDirectories = 0;
    let peakDirectories = 0;
    let directoryOpenCount = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const flags = args[1];
      if (typeof flags === 'number' && (flags & constants.O_DIRECTORY) !== 0) {
        directoryOpenCount += 1;
        activeDirectories += 1;
        peakDirectories = Math.max(peakDirectories, activeDirectories);
        const originalClose = handle.close.bind(handle);
        let counted = true;
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          try {
            return await originalClose();
          } finally {
            if (counted) {
              counted = false;
              activeDirectories -= 1;
            }
          }
        });
      }
      return handle;
    });

    try {
      const tree = await listWorkspaceTree(fixture.root, { maxEntries: 100, withHashes: false });
      expect(tree.truncated).toBe(true);
      expect(tree.entries.filter((entry) => entry.kind === 'dir').length)
        .toBeLessThanOrEqual(WORKSPACE_TREE_MAX_DEPTH + 1);
      expect(peakDirectories).toBeLessThanOrEqual(WORKSPACE_TREE_MAX_DEPTH + 1);
      expect(activeDirectories).toBe(0);
      expect(directoryOpenCount).toBeLessThan(100);
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('opens each directory once across a deep trunk with broad fan-out', async () => {
    const fixture = await freshFixture();
    let cursor = fixture.root;
    for (let depth = 0; depth < WORKSPACE_TREE_MAX_DEPTH - 1; depth += 1) {
      cursor = path.join(cursor, `t${depth}`);
      await fs.mkdir(cursor);
    }
    await Promise.all(Array.from({ length: 200 }, (_, index) =>
      fs.mkdir(path.join(cursor, `leaf-${index}`))));

    const originalOpen = fs.open.bind(fs);
    let directoryOpenCount = 0;
    let activeDirectories = 0;
    let peakDirectories = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const flags = args[1];
      if (typeof flags === 'number' && (flags & constants.O_DIRECTORY) !== 0) {
        directoryOpenCount += 1;
        activeDirectories += 1;
        peakDirectories = Math.max(peakDirectories, activeDirectories);
        const originalClose = handle.close.bind(handle);
        let counted = true;
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          try {
            return await originalClose();
          } finally {
            if (counted) {
              counted = false;
              activeDirectories -= 1;
            }
          }
        });
      }
      return handle;
    });

    try {
      const tree = await listWorkspaceTree(fixture.root, { maxEntries: 300, withHashes: false });
      expect(tree.truncated).toBe(false);
      expect(tree.entries.filter((entry) => entry.kind === 'dir')).toHaveLength(264);
      expect(directoryOpenCount).toBeLessThan(300);
      expect(peakDirectories).toBeLessThanOrEqual(WORKSPACE_TREE_MAX_DEPTH + 1);
      expect(activeDirectories).toBe(0);
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('does not hand a previously listed pathname to the zip archiver', async () => {
    const source = await fs.readFile(
      path.join(import.meta.dirname, '../src/routes/workspace.ts'),
      'utf8',
    );
    expect(source).not.toContain("archive.file(path.join(root, entry.path), { name: entry.path })");
    expect(source).toMatch(/archive\.append\(source, \{ name \}\)/);
  });

  it('re-attests an export entry after discovery and before append', async () => {
    const fixture = await freshFixture();
    try {
      await swapFinalComponentAfterFirstResolution(fixture.root, fixture.neighbor);
      await expect(
        openWorkspaceExportFile(fixture.root, 'notes/safe.txt'),
      ).rejects.toMatchObject({ code: 'workspace_file_not_found' });
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('streams only the retained descriptor after the pathname changes', async () => {
    const fixture = await freshFixture();
    try {
      const target = path.join(fixture.root, 'notes', 'safe.txt');
      const outside = path.join(fixture.neighbor, 'notes', 'safe.txt');
      const download = await openWorkspaceDownload(fixture.root, 'notes/safe.txt');
      await fs.unlink(target);
      await fs.symlink(outside, target);
      await expect(bodyOf(download.stream)).resolves.toBe('OWNER BYTES');
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('bounds mutable text, download, and export bytes to their admitted snapshots', async () => {
    const fixture = await freshFixture();
    try {
      const target = path.join(fixture.root, 'notes', 'safe.txt');
      const originalOpen = fs.open.bind(fs);
      let grownDuringRead = false;
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (!grownDuringRead && isSafeFileCandidate(args[0])) {
          const originalStat = handle.stat.bind(handle);
          let statCalls = 0;
          vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
            const result = await originalStat(options as never);
            statCalls += 1;
            if (statCalls === 2) {
              grownDuringRead = true;
              await fs.truncate(target, WORKSPACE_TEXT_MAX_BYTES + 4_096);
            }
            return result as never;
          });
        }
        return handle;
      });
      const read = await readWorkspaceFile(fixture.root, 'notes/safe.txt');
      expect(grownDuringRead).toBe(true);
      expect(read).toMatchObject({
        kind: 'binary',
        sizeBytes: WORKSPACE_TEXT_MAX_BYTES + 1,
      });
      vi.restoreAllMocks();

      await fs.writeFile(target, 'OWNER BYTES');
      const download = await openWorkspaceDownload(fixture.root, 'notes/safe.txt');
      await fs.appendFile(target, Buffer.alloc(1024 * 1024, 0x78));
      await expect(bodyOf(download.stream)).resolves.toBe('OWNER BYTES');

      await fs.writeFile(target, 'OWNER BYTES');
      const exported = await openWorkspaceExportFile(fixture.root, 'notes/safe.txt');
      await fs.appendFile(target, Buffer.alloc(1024 * 1024, 0x78));
      await expect(bodyOf(exported.stream)).resolves.toBe('OWNER BYTES');

      const routeSource = await fs.readFile(
        path.join(import.meta.dirname, '../src/routes/workspace.ts'),
        'utf8',
      );
      expect(routeSource).not.toContain(".header('content-length'");
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('closes retained descriptors after reads, streams, and identity rejection', async () => {
    const fixture = await freshFixture();
    const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      opened.push(handle);
      return handle;
    });
    try {
      await readWorkspaceFile(fixture.root, 'notes/safe.txt');
      expect(opened.at(-1)?.fd).toBe(-1);

      const download = await openWorkspaceDownload(fixture.root, 'notes/safe.txt');
      await expect(bodyOf(download.stream)).resolves.toBe('OWNER BYTES');
      expect(opened.at(-1)?.fd).toBe(-1);

      const exported = await openWorkspaceExportFile(fixture.root, 'notes/safe.txt');
      await expect(bodyOf(exported.stream)).resolves.toBe('OWNER BYTES');
      expect(opened.at(-1)?.fd).toBe(-1);

      const abandoned = await openWorkspaceDownload(fixture.root, 'notes/safe.txt');
      const abandonedHandle = opened.at(-1);
      abandoned.stream.destroy();
      await vi.waitFor(() => expect(abandonedHandle?.fd).toBe(-1));

      const replacement = path.join(fixture.root, 'replacement.txt');
      await fs.writeFile(replacement, 'OTHER OWNER BYTES');
      const target = path.join(fixture.root, 'notes', 'safe.txt');
      let replaced = false;
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        opened.push(handle);
        if (!replaced && isSafeFileCandidate(args[0])) {
          replaced = true;
          await fs.rename(replacement, target);
        }
        return handle;
      });
      await expect(readWorkspaceFile(fixture.root, 'notes/safe.txt')).rejects.toMatchObject({
        code: 'workspace_file_not_found',
      });
      expect(opened.at(-1)?.fd).toBe(-1);

      const oversized = path.join(fixture.root, 'oversized.bin');
      await fs.writeFile(oversized, 'x');
      await fs.truncate(oversized, WORKSPACE_DOWNLOAD_MAX_BYTES + 1);
      await expect(openWorkspaceDownload(fixture.root, 'oversized.bin')).rejects.toMatchObject({
        code: 'workspace_file_too_large',
      });
      expect(opened.at(-1)?.fd).toBe(-1);
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('opens the attested pathname with the final-component no-follow flag', async () => {
    const fixture = await freshFixture();
    const flags: number[] = [];
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (candidate, openFlags, mode) => {
      if (typeof openFlags === 'number') flags.push(openFlags);
      return originalOpen(candidate, openFlags, mode);
    });
    try {
      await readWorkspaceFile(fixture.root, 'notes/safe.txt');
      expect(flags).toHaveLength(3);
      for (const flag of flags) {
        expect(flag & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
        expect(flag & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      }
      expect(flags.slice(0, 2).every((flag) => (flag & constants.O_DIRECTORY) !== 0)).toBe(true);
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('serializes real Archiver inputs and keeps active descriptors bounded to one', async () => {
    const fixture = await freshFixture();
    const paths: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const rel = `notes/export-${index}.txt`;
      await fs.writeFile(path.join(fixture.root, rel), `entry ${index}`);
      paths.push(rel);
    }

    let active = 0;
    let maxActive = 0;
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const originalCreateReadStream = handle.createReadStream.bind(handle);
      vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
        const stream = originalCreateReadStream(options);
        active += 1;
        maxActive = Math.max(maxActive, active);
        stream.once('close', () => {
          active -= 1;
        });
        return stream;
      });
      return handle;
    });

    try {
      const archive = new ZipArchive({ zlib: { level: 1 } });
      const output = bodyOf(archive);
      await appendWorkspaceArchiveFiles(archive, fixture.root, paths);
      await expect(output).resolves.toMatch(/^PK/);
      await vi.waitFor(() => expect(active).toBe(0));
      expect(maxActive).toBe(1);
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('handles a real Archiver list-to-open deletion without an unhandled source error', async () => {
    const fixture = await freshFixture();
    const missing = path.join(fixture.root, 'notes', 'safe.txt');
    await fs.unlink(missing);
    try {
      const archive = new ZipArchive({ zlib: { level: 1 } });
      archive.resume();
      let caught: unknown;
      await appendWorkspaceArchiveFiles(archive, fixture.root, ['notes/safe.txt']).catch(
        (error: unknown) => {
          caught = error;
          archive.destroy();
        },
      );
      await vi.waitFor(() => expect(archive.destroyed).toBe(true));
      expect(caught).toMatchObject({ code: 'workspace_file_not_found' });
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('closes the retained export descriptor when Archiver append throws', async () => {
    const fixture = await freshFixture();
    const originalOpen = fs.open.bind(fs);
    const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      opened.push(handle);
      return handle;
    });
    try {
      const archive = new ZipArchive({ zlib: { level: 1 } });
      vi.spyOn(archive, 'append').mockImplementationOnce(() => {
        throw new Error('append refused');
      });
      await expect(
        appendWorkspaceArchiveFiles(archive, fixture.root, ['notes/safe.txt']),
      ).rejects.toThrow('append refused');
      await vi.waitFor(() => expect(opened.at(-1)?.fd).toBe(-1));
      archive.destroy();
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('destroys the active export source when the archive is cancelled', async () => {
    const fixture = await freshFixture();
    const large = path.join(fixture.root, 'notes', 'large.bin');
    await fs.writeFile(large, Buffer.alloc(4 * 1024 * 1024, 0x61));
    const originalOpen = fs.open.bind(fs);
    const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      opened.push(handle);
      return handle;
    });
    try {
      const archive = new ZipArchive({ zlib: { level: 1 } });
      let captured: NodeJS.ReadableStream | null = null;
      vi.spyOn(archive, 'append').mockImplementationOnce((source) => {
        captured = source as NodeJS.ReadableStream;
        return archive;
      });
      const pending = appendWorkspaceArchiveFiles(archive, fixture.root, ['notes/large.bin']);
      await vi.waitFor(() => expect(captured).not.toBeNull());
      archive.destroy();
      await expect(pending).rejects.toThrow('workspace export closed before entry completion');
      await vi.waitFor(() => expect(opened.every((handle) => handle.fd === -1)).toBe(true));
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('caps each export against the remaining aggregate budget and closes the descriptor', async () => {
    const fixture = await freshFixture();
    const originalOpen = fs.open.bind(fs);
    const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      opened.push(handle);
      return handle;
    });
    try {
      await expect(
        openWorkspaceExportFile(fixture.root, 'notes/safe.txt', 1),
      ).rejects.toMatchObject({ code: 'workspace_export_too_large' });
      expect(opened.at(-1)?.fd).toBe(-1);
      expect(WORKSPACE_EXPORT_MAX_BYTES).toBeGreaterThan(WORKSPACE_DOWNLOAD_MAX_BYTES);
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('pins the Linux production attestation to the opened procfs descriptor', async () => {
    const source = await fs.readFile(
      path.join(import.meta.dirname, '../src/services/workspace-files.ts'),
      'utf8',
    );
    expect(source).toContain("process.platform === 'linux'");
    expect(source).toContain('`/proc/self/fd/${handle.fd}`');
    const linuxBranch = source.match(
      /if \(process\.platform === 'linux'\) \{(?<body>[\s\S]*?)\n  \}/,
    )?.groups?.body;
    expect(linuxBranch).toContain('`/proc/self/fd/${handle.fd}`');
    expect(linuxBranch).not.toContain('fs.stat(');
  });
});
