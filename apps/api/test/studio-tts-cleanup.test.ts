import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeStudioOutput,
  createOwnedTtsTempFile,
} from '../src/routes/studio';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'eden3-tts-cleanup-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('owned Studio TTS output cleanup', () => {
  it('removes only the owned temporary directory and is idempotent', async () => {
    const root = await tempRoot();
    const sibling = path.join(root, 'keep.txt');
    await writeFile(sibling, 'keep');

    const output = await createOwnedTtsTempFile(Buffer.from('fake mp3'), { tempRoot: root });
    expect(await readdir(root)).toEqual(expect.arrayContaining(['keep.txt', path.basename(path.dirname(output.path))]));
    await access(output.path);

    await output.cleanup?.();
    await output.cleanup?.();

    await expect(access(output.path)).rejects.toThrow();
    await expect(access(sibling)).resolves.toBeUndefined();
  });

  it('removes the temporary directory when writing the provider output fails', async () => {
    const root = await tempRoot();
    const writeFailure = new Error('write failed');

    await expect(
      createOwnedTtsTempFile(Buffer.from('fake mp3'), {
        tempRoot: root,
        write: async () => {
          throw writeFailure;
        },
      }),
    ).rejects.toBe(writeFailure);

    expect(await readdir(root)).toEqual([]);
  });

  it('cleans after consumer success and failure without changing the consumer outcome', async () => {
    const successCleanup = vi.fn(async () => {});
    await expect(
      consumeStudioOutput(
        { path: '/owned/success.mp3', cleanup: successCleanup },
        async (sourcePath) => `ingested:${sourcePath}`,
      ),
    ).resolves.toBe('ingested:/owned/success.mp3');
    expect(successCleanup).toHaveBeenCalledOnce();

    const ingestFailure = new Error('ingest failed');
    const failureCleanup = vi.fn(async () => {});
    await expect(
      consumeStudioOutput(
        { path: '/owned/failure.mp3', cleanup: failureCleanup },
        async () => {
          throw ingestFailure;
        },
      ),
    ).rejects.toBe(ingestFailure);
    expect(failureCleanup).toHaveBeenCalledOnce();
  });

  it('does not let cleanup or cleanup reporting overturn a committed consumer result', async () => {
    const cleanupFailure = new Error('cleanup failed');
    const report = vi.fn(() => {
      throw new Error('logger failed');
    });

    await expect(
      consumeStudioOutput(
        {
          path: '/owned/result.mp3',
          cleanup: async () => {
            throw cleanupFailure;
          },
        },
        async () => 'committed',
        report,
      ),
    ).resolves.toBe('committed');
    expect(report).toHaveBeenCalledWith(cleanupFailure);
  });

  it('keeps injected non-owned source files compatible', async () => {
    const consume = vi.fn(async (sourcePath: string) => sourcePath);
    await expect(consumeStudioOutput({ path: '/external/source.mp3' }, consume)).resolves.toBe(
      '/external/source.mp3',
    );
    expect(consume).toHaveBeenCalledOnce();
  });
});
