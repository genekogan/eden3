import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  openWorkspaceDownload,
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
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    body += chunk;
  });
  await once(stream, 'end');
  return body;
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
      const download = await openWorkspaceDownload(fixture.root, 'notes/safe.txt');
      await expect(bodyOf(download.stream)).resolves.not.toContain('NEIGHBOR SECRET');
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('never streams through an ancestor swapped after containment', async () => {
    const fixture = await freshFixture();
    try {
      await swapAncestorAfterFirstResolution(fixture.root, fixture.neighbor);
      const download = await openWorkspaceDownload(fixture.root, 'notes/safe.txt');
      await expect(bodyOf(download.stream)).resolves.not.toContain('NEIGHBOR SECRET');
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
});
