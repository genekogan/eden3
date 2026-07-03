import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  LocalMediaStore,
  extensionForMime,
  normalizeMime,
  probeImageSize,
} from './media-store';

const tmpDirs: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eden3-core-media-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

// --- crafted media headers ---------------------------------------------------

function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 6; // color type RGBA
  return buf;
}

function gifBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'latin1');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function jpegBuffer(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0; // SOF0
  sof.writeUInt16BE(17, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // component count
  return Buffer.concat([soi, app0, sof, Buffer.from([0xff, 0xd9])]);
}

function webpBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8X', 12, 'latin1');
  buf.writeUInt32LE(10, 16); // chunk size
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

// -----------------------------------------------------------------------------

describe('normalizeMime / extensionForMime', () => {
  it('normalizes case and strips parameters', () => {
    expect(normalizeMime('IMAGE/PNG; charset=binary')).toBe('image/png');
    expect(normalizeMime('  video/mp4 ')).toBe('video/mp4');
  });

  it('maps known mimes and rejects unknown ones', () => {
    expect(extensionForMime('image/png')).toBe('.png');
    expect(extensionForMime('image/jpeg; q=1')).toBe('.jpg');
    expect(extensionForMime('audio/mpeg')).toBe('.mp3');
    expect(extensionForMime('video/mp4')).toBe('.mp4');
    expect(extensionForMime('application/x-mystery')).toBeNull();
  });
});

describe('probeImageSize', () => {
  it('reads png, gif, jpeg, and webp dimensions', () => {
    expect(probeImageSize(pngBuffer(3, 2))).toEqual({ width: 3, height: 2 });
    expect(probeImageSize(gifBuffer(320, 200))).toEqual({ width: 320, height: 200 });
    expect(probeImageSize(jpegBuffer(640, 480))).toEqual({ width: 640, height: 480 });
    expect(probeImageSize(webpBuffer(1024, 768))).toEqual({ width: 1024, height: 768 });
  });

  it('returns null for garbage', () => {
    expect(probeImageSize(Buffer.from('not an image, definitely not at all'))).toBeNull();
    expect(probeImageSize(Buffer.alloc(0))).toBeNull();
    expect(probeImageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toBeNull();
  });
});

describe('LocalMediaStore', () => {
  it('stores a buffer content-addressed with url, dims, and size', async () => {
    const dir = await freshDir();
    const store = new LocalMediaStore({ mediaDir: dir, baseUrl: 'http://localhost:4301/media/' });
    const png = pngBuffer(3, 2);
    const hash = sha256(png);

    const result = await store.put(png, { mime: 'image/png' });
    expect(result.sha256).toBe(hash);
    expect(result.localPath).toBe(path.join(dir, `${hash}.png`));
    expect(result.url).toBe(`http://localhost:4301/media/${hash}.png`); // trailing slash trimmed
    expect(result.mime).toBe('image/png');
    expect(result.sizeBytes).toBe(png.length);
    expect(result.width).toBe(3);
    expect(result.height).toBe(2);
    expect((await stat(result.localPath)).size).toBe(png.length);
  });

  it('is idempotent: same content stored once, no temp litter', async () => {
    const dir = await freshDir();
    const store = new LocalMediaStore({ mediaDir: dir, baseUrl: 'http://media.test' });
    const gif = gifBuffer(10, 20);

    const first = await store.put(gif, { mime: 'image/gif' });
    const second = await store.put(gif, { mime: 'image/gif' });
    expect(second).toEqual(first);
    expect(await readdir(dir)).toEqual([`${first.sha256}.gif`]);
  });

  it('stores from a file path without touching the source', async () => {
    const dir = await freshDir();
    const srcDir = await freshDir();
    const store = new LocalMediaStore({ mediaDir: dir, baseUrl: 'http://media.test' });
    const jpeg = jpegBuffer(111, 222);
    const srcPath = path.join(srcDir, 'photo.jpeg');
    await writeFile(srcPath, jpeg);

    const result = await store.put(srcPath, { mime: 'image/jpeg' });
    expect(result.sha256).toBe(sha256(jpeg));
    expect(result.localPath).toBe(path.join(dir, `${result.sha256}.jpg`));
    expect(result.width).toBe(111);
    expect(result.height).toBe(222);
    expect(result.sizeBytes).toBe(jpeg.length);
    expect((await stat(srcPath)).size).toBe(jpeg.length); // source intact
  });

  it('does not probe dimensions for non-image mimes', async () => {
    const dir = await freshDir();
    const store = new LocalMediaStore({ mediaDir: dir, baseUrl: 'http://media.test' });
    const result = await store.put(Buffer.from('fake mp4 bytes'), { mime: 'video/mp4' });
    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();
    expect(result.localPath.endsWith('.mp4')).toBe(true);
  });

  it('falls back to .bin for unknown mimes on buffers', async () => {
    const dir = await freshDir();
    const store = new LocalMediaStore({ mediaDir: dir, baseUrl: 'http://media.test' });
    const result = await store.put(Buffer.from('mystery'), { mime: 'application/x-mystery' });
    expect(result.localPath.endsWith('.bin')).toBe(true);
  });

  it('falls back to the source extension for unknown mimes on paths', async () => {
    const dir = await freshDir();
    const srcDir = await freshDir();
    const store = new LocalMediaStore({ mediaDir: dir, baseUrl: 'http://media.test' });
    const srcPath = path.join(srcDir, 'blob.DAT');
    await writeFile(srcPath, Buffer.from('mystery bytes'));
    const result = await store.put(srcPath, { mime: 'application/x-mystery' });
    expect(result.localPath.endsWith('.dat')).toBe(true);
  });

  it('same content under different mimes yields distinct files', async () => {
    const dir = await freshDir();
    const store = new LocalMediaStore({ mediaDir: dir, baseUrl: 'http://media.test' });
    const buf = Buffer.from('ambiguous bytes');
    const asTxt = await store.put(buf, { mime: 'text/plain' });
    const asJson = await store.put(buf, { mime: 'application/json' });
    expect(asTxt.sha256).toBe(asJson.sha256);
    expect(asTxt.localPath).not.toBe(asJson.localPath);
    expect((await readdir(dir)).sort()).toEqual(
      [`${asTxt.sha256}.json`, `${asTxt.sha256}.txt`].sort(),
    );
  });

  it('defaults mediaDir/baseUrl from the environment', async () => {
    const dir = await freshDir();
    const prevDir = process.env.MEDIA_DIR;
    const prevUrl = process.env.MEDIA_BASE_URL;
    const { resetEnvCache } = await import('./env');
    try {
      process.env.MEDIA_DIR = dir;
      process.env.MEDIA_BASE_URL = 'http://env.test/media';
      resetEnvCache();
      const store = new LocalMediaStore();
      expect(store.mediaDir).toBe(dir);
      expect(store.baseUrl).toBe('http://env.test/media');
    } finally {
      if (prevDir === undefined) delete process.env.MEDIA_DIR;
      else process.env.MEDIA_DIR = prevDir;
      if (prevUrl === undefined) delete process.env.MEDIA_BASE_URL;
      else process.env.MEDIA_BASE_URL = prevUrl;
      resetEnvCache();
    }
  });
});
