import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { materializeMediaRoots } from '../src/services/private-media-roots';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('materializeMediaRoots', () => {
  it('materializes three physically disjoint roots', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-private-roots-'));
    roots.push(root);
    const result = await materializeMediaRoots({
      mediaDir: path.join(root, 'media'),
      transcriptionAudioDir: path.join(root, 'dictation'),
      voiceOutputDir: path.join(root, 'voice'),
    });
    expect(new Set(Object.values(result)).size).toBe(3);
    expect((await stat(result.transcriptionAudioDir)).mode & 0o777).toBe(0o700);
    expect((await stat(result.voiceOutputDir)).mode & 0o777).toBe(0o700);
  });

  it('tightens existing private directories only after physical attestation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-private-roots-'));
    roots.push(root);
    const dictation = path.join(root, 'dictation');
    const voice = path.join(root, 'voice');
    await Promise.all([mkdir(dictation), mkdir(voice)]);
    await Promise.all([chmod(dictation, 0o755), chmod(voice, 0o755)]);
    const result = await materializeMediaRoots({ mediaDir: path.join(root, 'media'), transcriptionAudioDir: dictation, voiceOutputDir: voice });
    expect((await stat(result.transcriptionAudioDir)).mode & 0o777).toBe(0o700);
    expect((await stat(result.voiceOutputDir)).mode & 0o777).toBe(0o700);
  });

  it('rejects a voice root symlink aliasing the public media root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-private-roots-'));
    roots.push(root);
    const mediaDir = path.join(root, 'media');
    await mkdir(mediaDir);
    await symlink(mediaDir, path.join(root, 'voice'));
    await expect(materializeMediaRoots({
      mediaDir,
      transcriptionAudioDir: path.join(root, 'dictation'),
      voiceOutputDir: path.join(root, 'voice'),
    })).rejects.toThrow(/VOICE_OUTPUT_DIR.*physically outside MEDIA_DIR/);
  });

  it('rejects physical containment in either direction', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-private-roots-'));
    roots.push(root);
    await expect(materializeMediaRoots({
      mediaDir: path.join(root, 'media'),
      transcriptionAudioDir: path.join(root, 'dictation'),
      voiceOutputDir: root,
    })).rejects.toThrow(/VOICE_OUTPUT_DIR/);
  });
});
