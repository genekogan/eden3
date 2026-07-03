import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, copyFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getEnv } from './env';

/**
 * Media store — where generated files (images/video/audio) land.
 *
 * Content-addressed: a file is stored once as `<sha256><ext>` no matter how
 * many times it is put. {@link LocalMediaStore} writes under `MEDIA_DIR` and
 * serves from `MEDIA_BASE_URL` (the api statically mounts the dir); an R2/S3
 * implementation slots in behind the same {@link MediaStore} interface at
 * deploy time.
 */

export interface MediaPutOptions {
  /** Content type, e.g. `image/png` (parameters like `; charset=` are ignored). */
  mime: string;
}

export interface MediaPutResult {
  /** Public URL the file is served from: `<MEDIA_BASE_URL>/<sha256><ext>`. */
  url: string;
  /** Absolute path of the stored file on disk. */
  localPath: string;
  /** Hex sha256 of the file contents (the content address). */
  sha256: string;
  /** Normalized mime type. */
  mime: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Pixel dimensions, when the file is a parseable png/jpeg/gif/webp. */
  width?: number;
  height?: number;
}

export interface MediaStore {
  /** Store a file (in-memory buffer or path to an existing file on disk). */
  put(file: Buffer | string, opts: MediaPutOptions): Promise<MediaPutResult>;
}

// ---------------------------------------------------------------------------
// Mime → extension
// ---------------------------------------------------------------------------

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
};

/** Strip parameters and lowercase: `IMAGE/PNG; foo=bar` → `image/png`. */
export function normalizeMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/** Map a (normalized) mime type to a file extension, or `null` when unknown. */
export function extensionForMime(mime: string): string | null {
  return MIME_EXTENSIONS[normalizeMime(mime)] ?? null;
}

// ---------------------------------------------------------------------------
// Image dimension probing (header parsing — no native deps)
// ---------------------------------------------------------------------------

export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function probePng(buf: Buffer): ImageSize | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function probeGif(buf: Buffer): ImageSize | null {
  if (buf.length < 10) return null;
  const sig = buf.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

function probeJpeg(buf: Buffer): ImageSize | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return null; // lost marker sync
    const marker = buf[i + 1];
    if (marker === undefined) return null;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Standalone markers (no length field).
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan before SOF
    if (i + 3 >= buf.length) return null;
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 8 >= buf.length) return null;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + segLen;
  }
  return null;
}

function probeWebp(buf: Buffer): ImageSize | null {
  if (buf.length < 30) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + buf.readUIntLE(24, 3);
    const height = 1 + buf.readUIntLE(27, 3);
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}

/** Read pixel dimensions from a png/jpeg/gif/webp header, else `null`. */
export function probeImageSize(buf: Buffer): ImageSize | null {
  return probePng(buf) ?? probeGif(buf) ?? probeJpeg(buf) ?? probeWebp(buf);
}

// ---------------------------------------------------------------------------
// LocalMediaStore
// ---------------------------------------------------------------------------

/** How many leading bytes we read for dimension probing on path inputs. */
const PROBE_BYTES = 512 * 1024;

async function sha256OfFile(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buf = chunk as Buffer;
    hash.update(buf);
    sizeBytes += buf.length;
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function readHead(filePath: string): Promise<Buffer> {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(PROBE_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PROBE_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface LocalMediaStoreOptions {
  /** Directory files are written into (default: env `MEDIA_DIR`). */
  mediaDir?: string;
  /** Public base URL (default: env `MEDIA_BASE_URL`); trailing slashes are trimmed. */
  baseUrl?: string;
}

/**
 * Media store backed by a local directory. Writes are atomic (temp file +
 * rename) and idempotent: an already-present content address is not
 * rewritten. Path inputs are hashed/copied streaming, never fully buffered.
 */
export class LocalMediaStore implements MediaStore {
  readonly mediaDir: string;
  readonly baseUrl: string;

  constructor(opts: LocalMediaStoreOptions = {}) {
    const mediaDir = opts.mediaDir ?? getEnv().MEDIA_DIR;
    const baseUrl = opts.baseUrl ?? getEnv().MEDIA_BASE_URL;
    this.mediaDir = path.resolve(mediaDir);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async put(file: Buffer | string, opts: MediaPutOptions): Promise<MediaPutResult> {
    const mime = normalizeMime(opts.mime);
    const isBuffer = Buffer.isBuffer(file);

    let sha256: string;
    let sizeBytes: number;
    let head: Buffer;
    if (isBuffer) {
      sha256 = createHash('sha256').update(file).digest('hex');
      sizeBytes = file.length;
      head = file.subarray(0, PROBE_BYTES);
    } else {
      ({ sha256, sizeBytes } = await sha256OfFile(file));
      head = await readHead(file);
    }

    const ext =
      extensionForMime(mime) ??
      (!isBuffer && /^\.[a-z0-9]{1,8}$/i.test(path.extname(file))
        ? path.extname(file).toLowerCase()
        : '.bin');

    const filename = `${sha256}${ext}`;
    const localPath = path.join(this.mediaDir, filename);
    await mkdir(this.mediaDir, { recursive: true });

    if (!(await fileExists(localPath))) {
      const tmpPath = path.join(this.mediaDir, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
      try {
        if (isBuffer) await writeFile(tmpPath, file);
        else await copyFile(file, tmpPath);
        await rename(tmpPath, localPath);
      } catch (err) {
        await rm(tmpPath, { force: true });
        throw err;
      }
    }

    const dims = mime.startsWith('image/') ? probeImageSize(head) : null;
    return {
      url: `${this.baseUrl}/${filename}`,
      localPath,
      sha256,
      mime,
      sizeBytes,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
    };
  }
}
