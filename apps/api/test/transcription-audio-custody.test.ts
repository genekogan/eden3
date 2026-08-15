import { access, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PrivateTranscriptionAudioStore } from '../src/services/transcription-audio-custody';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PrivateTranscriptionAudioStore', () => {
  it('writes private bytes under opaque relative locators and verifies reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eden-stt-'));
    roots.push(root);
    const store = new PrivateTranscriptionAudioStore(root);
    const body = Buffer.alloc(320, 4);
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const relativePath = await store.writeChunk({ ownerId, sessionId, chunkNumber: 0, body });

    expect(relativePath).not.toContain(root);
    expect(await readFile(join(root, relativePath))).toEqual(body);
    expect((await stat(join(root, relativePath))).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(join(root, relativePath)))).mode & 0o777).toBe(0o700);
    await expect(
      store.readVerified(relativePath, {
        sizeBytes: body.length,
        sha256: '0'.repeat(64),
      }),
    ).rejects.toThrow(/checksum/);
    await store.deletePaths([relativePath]);
    await store.pruneSessionDirectories(ownerId, sessionId);
  });

  it('rejects traversal and absolute locators without touching them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eden-stt-'));
    roots.push(root);
    const store = new PrivateTranscriptionAudioStore(root);
    await expect(
      store.deletePaths(['../../outside.pcm']),
    ).rejects.toThrow(/invalid relative chunk path/);
    await expect(
      store.deletePaths(['/tmp/outside.pcm']),
    ).rejects.toThrow(/invalid relative chunk path/);
  });

  it('removes validated crash-orphan chunks from the exact session directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eden-stt-'));
    roots.push(root);
    const store = new PrivateTranscriptionAudioStore(root);
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const tracked = await store.writeChunk({ ownerId, sessionId, chunkNumber: 0, body: Buffer.alloc(320) });
    const orphan = join(root, ownerId, sessionId, '1-33333333-3333-4333-8333-333333333333.pcm');
    await writeFile(orphan, Buffer.alloc(320), { mode: 0o600 });

    await store.deleteSession(ownerId, sessionId);

    await expect(access(join(root, tracked))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
