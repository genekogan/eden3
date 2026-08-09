import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WORKSPACE_DOWNLOAD_MAX_BYTES,
  openWorkspaceDownload,
  openWorkspaceExportStream,
  readWorkspaceFile,
} from '../src/services/workspace-files';

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

async function swapFinalComponentAfterFirstResolution(root: string, neighbor: string) {
  const target = path.join(root, 'notes', 'safe.txt');
  const outside = path.join(neighbor, 'notes', 'safe.txt');
  const originalRealpath = fs.realpath.bind(fs);
  let swapped = false;
  vi.spyOn(fs, 'realpath').mockImplementation(async (candidate) => {
    const resolved = await originalRealpath(candidate);
    if (!swapped && path.resolve(String(candidate)) === path.resolve(target)) {
      swapped = true;
      await fs.unlink(target);
      await fs.symlink(outside, target);
    }
    return resolved;
  });
}

async function swapAncestorAfterFirstResolution(root: string, neighbor: string) {
  const target = path.join(root, 'notes', 'safe.txt');
  const ownerNotes = path.join(root, 'notes');
  const parkedNotes = path.join(root, 'notes-before-swap');
  const neighborNotes = path.join(neighbor, 'notes');
  const originalRealpath = fs.realpath.bind(fs);
  let swapped = false;
  vi.spyOn(fs, 'realpath').mockImplementation(async (candidate) => {
    const resolved = await originalRealpath(candidate);
    if (!swapped && path.resolve(String(candidate)) === path.resolve(target)) {
      swapped = true;
      await fs.rename(ownerNotes, parkedNotes);
      await fs.symlink(neighborNotes, ownerNotes);
    }
    return resolved;
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

  it('does not hand a previously listed pathname to the zip archiver', async () => {
    const source = await fs.readFile(
      path.join(import.meta.dirname, '../src/routes/workspace.ts'),
      'utf8',
    );
    expect(source).not.toContain("archive.file(path.join(root, entry.path), { name: entry.path })");
    expect(source).toMatch(/archive\.append\([^;]*entry\.path/s);
  });

  it('re-attests a lazy export stream at consumption time', async () => {
    const fixture = await freshFixture();
    try {
      const stream = openWorkspaceExportStream(fixture.root, 'notes/safe.txt');
      await swapFinalComponentAfterFirstResolution(fixture.root, fixture.neighbor);
      await expectSafeOrRejected(async () => stream);
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

      const exported = openWorkspaceExportStream(fixture.root, 'notes/safe.txt');
      await expect(bodyOf(exported)).resolves.toBe('OWNER BYTES');
      expect(opened.at(-1)?.fd).toBe(-1);

      const abandoned = await openWorkspaceDownload(fixture.root, 'notes/safe.txt');
      const abandonedHandle = opened.at(-1);
      abandoned.stream.destroy();
      await vi.waitFor(() => expect(abandonedHandle?.fd).toBe(-1));

      const replacement = path.join(fixture.root, 'replacement.txt');
      await fs.writeFile(replacement, 'OTHER OWNER BYTES');
      const target = path.join(fixture.root, 'notes', 'safe.txt');
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await originalOpen(...args);
        opened.push(handle);
        await fs.rename(replacement, target);
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
      expect(flags).toHaveLength(1);
      expect(flags[0]! & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });
});
