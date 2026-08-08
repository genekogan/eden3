import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  rename,
  rm,
  copyFile,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
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

export async function sha256File(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
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
      ({ sha256, sizeBytes } = await sha256File(file));
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

// ---------------------------------------------------------------------------
// Immutable object service
// ---------------------------------------------------------------------------

export type ObjectLifecycleState =
  | 'pending'
  | 'uploaded'
  | 'verified'
  | 'available'
  | 'quarantined'
  | 'failed';

export type ObjectBackingStore = 'local' | 'r2' | 'legacy';

/** Minimal durable descriptor consumed by the storage layer. */
export interface StoredObject {
  objectId: string;
  backingKey: string;
  backingStore: ObjectBackingStore;
  state: ObjectLifecycleState;
  sha256: string;
  sizeBytes: number;
  mime: string;
  legacySourceUrl?: string | null;
}

export interface ObjectHead {
  key: string;
  sizeBytes: number;
  etag?: string;
  sha256?: string;
  contentType?: string;
}

export interface ObjectGetResult {
  head: ObjectHead;
  body: Buffer;
}

export interface ObjectPutInput {
  key: string;
  body: Buffer | string;
  contentType?: string;
  sha256?: string;
}

export interface MultipartCreateInput {
  key: string;
  contentType?: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface MultipartUpload {
  key: string;
  uploadId: string;
}

export interface MultipartPartInput {
  key: string;
  uploadId: string;
  partNumber: number;
  body: Buffer | string;
  sha256?: string;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
  checksumSha256?: string;
  sizeBytes: number;
}

export interface MultipartPresignInput {
  key: string;
  uploadId: string;
  partNumber: number;
  expiresInSeconds?: number;
  /** When present, both checksum and size are bound into the signed request. */
  sha256?: string;
  sizeBytes?: number;
}

export interface PresignedUploadPart {
  url: string;
  expiresAt: Date;
  requiredHeaders: Readonly<Record<string, string>>;
}

export interface MultipartCompleteInput {
  key: string;
  uploadId: string;
  parts: readonly Pick<MultipartPart, 'partNumber' | 'etag' | 'checksumSha256'>[];
}

export interface MultipartAbortInput {
  key: string;
  uploadId: string;
  signal?: AbortSignal;
}

/** Backends expose immutable whole-object operations and resumable multipart primitives. */
export interface ObjectBackend {
  put(input: ObjectPutInput): Promise<ObjectHead>;
  get(key: string): Promise<ObjectGetResult>;
  head(key: string): Promise<ObjectHead | null>;
  createMultipart(input: MultipartCreateInput): Promise<MultipartUpload>;
  uploadPart(input: MultipartPartInput): Promise<MultipartPart>;
  listParts(input: MultipartAbortInput): Promise<MultipartPart[]>;
  presignUploadPart(input: MultipartPresignInput): Promise<PresignedUploadPart>;
  completeMultipart(input: MultipartCompleteInput): Promise<ObjectHead>;
  abortMultipart(input: MultipartAbortInput): Promise<void>;
}

const OBJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_KEY_PATTERN = /^objects\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function assertObjectId(objectId: string): void {
  if (!OBJECT_ID_PATTERN.test(objectId)) throw new Error('Invalid opaque object id');
}

function assertObjectKey(key: string): void {
  if (!OBJECT_KEY_PATTERN.test(key)) throw new Error('Invalid immutable object key');
  const objectId = key.slice(key.lastIndexOf('/') + 1);
  if (key.split('/')[1] !== objectId.slice(0, 2).toLowerCase()) {
    throw new Error('Invalid immutable object key prefix');
  }
}

/** The only supported durable key derivation. Display names never enter it. */
export function objectKey(objectId: string): string {
  assertObjectId(objectId);
  const normalized = objectId.toLowerCase();
  return `objects/${normalized.slice(0, 2)}/${normalized}`;
}

function assertPartNumber(partNumber: number): void {
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new Error('Multipart part number must be between 1 and 10000');
  }
}

async function bodyBytes(body: Buffer | string): Promise<Buffer> {
  return Buffer.isBuffer(body) ? body : readFile(body);
}

async function writeAtomic(target: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export interface LocalObjectBackendOptions {
  root: string;
}

/** Filesystem backend for development/tests with the same immutable key semantics as R2. */
export class LocalObjectBackend implements ObjectBackend {
  readonly root: string;
  private readonly multipartRoot: string;

  constructor(options: LocalObjectBackendOptions) {
    if (!options.root.trim()) throw new Error('Local object root is required');
    this.root = path.resolve(options.root);
    this.multipartRoot = path.join(this.root, '.multipart');
  }

  private resolveKey(key: string): string {
    assertObjectKey(key);
    const resolved = path.resolve(this.root, ...key.split('/'));
    if (!resolved.startsWith(`${this.root}${path.sep}`)) throw new Error('Object key escapes root');
    return resolved;
  }

  private multipartDir(uploadId: string): string {
    if (!OBJECT_ID_PATTERN.test(uploadId)) throw new Error('Invalid multipart upload id');
    return path.join(this.multipartRoot, uploadId.toLowerCase());
  }

  async put(input: ObjectPutInput): Promise<ObjectHead> {
    const target = this.resolveKey(input.key);
    const bytes = await bodyBytes(input.body);
    const sha256 = digestBytes(bytes);
    if (input.sha256 && input.sha256.toLowerCase() !== sha256) {
      throw new Error('Put checksum does not match bytes');
    }
    const existing = await this.head(input.key);
    if (existing) {
      if (existing.sha256 !== sha256 || existing.sizeBytes !== bytes.length) {
        throw new Error('Immutable object conflict: key already contains different bytes');
      }
      return existing;
    }
    await writeAtomic(target, bytes);
    return { key: input.key, sizeBytes: bytes.length, sha256, etag: sha256, ...(input.contentType ? { contentType: normalizeMime(input.contentType) } : {}) };
  }

  async get(key: string): Promise<ObjectGetResult> {
    const head = await this.head(key);
    if (!head) throw new Error(`Object not found: ${key}`);
    return { head, body: await readFile(this.resolveKey(key)) };
  }

  async head(key: string): Promise<ObjectHead | null> {
    const target = this.resolveKey(key);
    try {
      const info = await stat(target);
      if (!info.isFile()) return null;
      const { sha256, sizeBytes } = await sha256File(target);
      return { key, sizeBytes, sha256, etag: sha256 };
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async createMultipart(input: MultipartCreateInput): Promise<MultipartUpload> {
    this.resolveKey(input.key);
    if (await this.head(input.key)) throw new Error('Immutable object key already exists');
    const uploadId = randomUUID();
    const dir = this.multipartDir(uploadId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'metadata.json'),
      JSON.stringify({ key: input.key, contentType: input.contentType, metadata: input.metadata }),
      { flag: 'wx' },
    );
    return { key: input.key, uploadId };
  }

  private async assertMultipart(uploadId: string, key: string): Promise<string> {
    this.resolveKey(key);
    const dir = this.multipartDir(uploadId);
    let raw: string;
    try {
      raw = await readFile(path.join(dir, 'metadata.json'), 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new Error('Multipart upload not found');
      throw error;
    }
    const metadata = JSON.parse(raw) as { key?: unknown };
    if (metadata.key !== key) throw new Error('Multipart upload is not bound to this object key');
    return dir;
  }

  async uploadPart(input: MultipartPartInput): Promise<MultipartPart> {
    assertPartNumber(input.partNumber);
    const dir = await this.assertMultipart(input.uploadId, input.key);
    const bytes = await bodyBytes(input.body);
    const checksumSha256 = digestBytes(bytes);
    if (input.sha256 && input.sha256.toLowerCase() !== checksumSha256) {
      throw new Error('Multipart part checksum does not match bytes');
    }
    const target = path.join(dir, `part-${input.partNumber}`);
    try {
      const existing = await readFile(target);
      if (!existing.equals(bytes)) {
        throw new Error('Immutable multipart part conflict');
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      await writeAtomic(target, bytes);
    }
    return { partNumber: input.partNumber, etag: checksumSha256, checksumSha256, sizeBytes: bytes.length };
  }

  async listParts(input: MultipartAbortInput): Promise<MultipartPart[]> {
    const dir = await this.assertMultipart(input.uploadId, input.key);
    const names = await readdir(dir);
    const parts: MultipartPart[] = [];
    for (const name of names) {
      const match = /^part-([1-9][0-9]{0,4})$/.exec(name);
      if (!match) continue;
      const partNumber = Number(match[1]);
      assertPartNumber(partNumber);
      const file = path.join(dir, name);
      const { sha256, sizeBytes } = await sha256File(file);
      parts.push({ partNumber, etag: sha256, checksumSha256: sha256, sizeBytes });
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async presignUploadPart(input: MultipartPresignInput): Promise<PresignedUploadPart> {
    assertPartNumber(input.partNumber);
    await this.assertMultipart(input.uploadId, input.key);
    const expires = normalizePresignExpiry(input.expiresInSeconds);
    const requiredHeaders = presignBoundHeaders(input);
    return {
      url: `local-object://${encodeURIComponent(input.uploadId)}/${input.partNumber}`,
      expiresAt: new Date(Date.now() + expires * 1000),
      requiredHeaders,
    };
  }

  async completeMultipart(input: MultipartCompleteInput): Promise<ObjectHead> {
    const dir = await this.assertMultipart(input.uploadId, input.key);
    if (input.parts.length === 0) throw new Error('Multipart completion requires parts');
    const ordered = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
    if (new Set(ordered.map((part) => part.partNumber)).size !== ordered.length) {
      throw new Error('Multipart completion contains duplicate parts');
    }
    const chunks: Buffer[] = [];
    for (const part of ordered) {
      assertPartNumber(part.partNumber);
      const bytes = await readFile(path.join(dir, `part-${part.partNumber}`));
      if (digestBytes(bytes) !== stripEtag(part.etag)) throw new Error('Multipart part ETag mismatch');
      chunks.push(bytes);
    }
    const result = await this.put({ key: input.key, body: Buffer.concat(chunks) });
    await rm(dir, { recursive: true, force: true });
    return result;
  }

  async abortMultipart(input: MultipartAbortInput): Promise<void> {
    try {
      await this.assertMultipart(input.uploadId, input.key);
    } catch (error) {
      if (error instanceof Error && error.message === 'Multipart upload not found') return;
      throw error;
    }
    await rm(this.multipartDir(input.uploadId), { recursive: true, force: true });
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(entries: readonly [string, string][]): string {
  return entries
    .map(([key, value]) => [encodePathPart(key), encodePathPart(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function xmlValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml);
  return match?.[1] ?? null;
}

function stripEtag(etag: string): string {
  return etag.replace(/^\"|\"$/g, '');
}

function normalizePresignExpiry(value: number | undefined): number {
  const seconds = value ?? 300;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error('Presigned part expiry must be between 1 and 3600 seconds');
  }
  return seconds;
}

function presignBoundHeaders(input: MultipartPresignInput): Record<string, string> {
  if ((input.sha256 === undefined) !== (input.sizeBytes === undefined)) {
    throw new Error('Presigned part checksum and size must be supplied together');
  }
  if (input.sha256 === undefined || input.sizeBytes === undefined) return {};
  const sha256 = input.sha256.toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new Error('Presigned part checksum is invalid');
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error('Presigned part size is invalid');
  }
  return {
    'content-length': String(input.sizeBytes),
    'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
  };
}

export interface R2ObjectBackendOptions {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 bucket placement must have been created with the EU jurisdiction. */
  jurisdiction?: 'eu';
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Cloudflare R2's S3-compatible API, signed directly with AWS SigV4. */
export class R2ObjectBackend implements ObjectBackend {
  readonly endpoint: URL;
  readonly bucket: string;
  readonly region = 'auto';
  readonly jurisdiction = 'eu';
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly completingKeys = new Set<string>();

  constructor(options: R2ObjectBackendOptions) {
    if (options.jurisdiction !== 'eu') throw new Error('R2 EU jurisdiction must be explicit');
    if (!/^[0-9a-f]{32}$/i.test(options.accountId)) throw new Error('Valid R2 account id is required');
    if (!options.bucket.trim() || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new Error('Valid R2 bucket is required');
    }
    if (!options.accessKeyId.trim()) throw new Error('R2 access key id is required');
    if (!options.secretAccessKey.trim()) throw new Error('R2 secret access key is required');
    const endpoint = new URL(
      options.endpoint ?? `https://${options.accountId}.eu.r2.cloudflarestorage.com`,
    );
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search) {
      throw new Error('R2 endpoint must be a credential-free HTTPS origin');
    }
    const expectedHost = `${options.accountId.toLowerCase()}.eu.r2.cloudflarestorage.com`;
    if (endpoint.hostname.toLowerCase() !== expectedHost || !['', '/'].includes(endpoint.pathname)) {
      throw new Error('R2 endpoint must match the configured account EU origin');
    }
    this.endpoint = endpoint;
    this.bucket = options.bucket;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private pathname(key: string): string {
    assertObjectKey(key);
    return `/${encodePathPart(this.bucket)}/${key.split('/').map(encodePathPart).join('/')}`;
  }

  private dateParts(date: Date): { amzDate: string; dateStamp: string } {
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    return { amzDate, dateStamp: amzDate.slice(0, 8) };
  }

  private signingKey(dateStamp: string): Buffer {
    const dateKey = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, this.region);
    const serviceKey = hmac(regionKey, 's3');
    return hmac(serviceKey, 'aws4_request');
  }

  private async request(
    method: string,
    key: string,
    query: readonly [string, string][] = [],
    body?: Buffer,
    extraHeaders: Readonly<Record<string, string>> = {},
    expected: readonly number[] = [200],
    signal?: AbortSignal,
  ): Promise<Response> {
    const now = this.now();
    const { amzDate, dateStamp } = this.dateParts(now);
    const payloadHash = digestBytes(body ?? Buffer.alloc(0));
    const pathname = this.pathname(key);
    const host = this.endpoint.host;
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([name, value]) => [name.toLowerCase(), value])),
    };
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]!.trim()}\n`).join('');
    const canonical = [
      method,
      pathname,
      canonicalQuery(query),
      canonicalHeaders,
      signedNames.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n');
    const signature = createHmac('sha256', this.signingKey(dateStamp))
      .update(stringToSign)
      .digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;
    const url = new URL(pathname, this.endpoint);
    url.search = canonicalQuery(query);
    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(body ? { body } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!expected.includes(response.status)) {
      throw new Error(`R2 ${method} failed with status ${response.status}`);
    }
    return response;
  }

  async put(input: ObjectPutInput): Promise<ObjectHead> {
    const bytes = await bodyBytes(input.body);
    const sha256 = digestBytes(bytes);
    if (input.sha256 && input.sha256.toLowerCase() !== sha256) throw new Error('Put checksum mismatch');
    const existing = await this.head(input.key);
    if (existing) {
      if (existing.sha256 !== sha256 || existing.sizeBytes !== bytes.length) {
        throw new Error('Immutable object conflict: key already exists');
      }
      return existing;
    }
    await this.request(
      'PUT',
      input.key,
      [],
      bytes,
      {
        'if-none-match': '*',
        'x-amz-meta-sha256': sha256,
        ...(input.contentType ? { 'content-type': normalizeMime(input.contentType) } : {}),
      },
      [200],
    );
    return { key: input.key, sizeBytes: bytes.length, sha256, etag: sha256, ...(input.contentType ? { contentType: normalizeMime(input.contentType) } : {}) };
  }

  async get(key: string): Promise<ObjectGetResult> {
    const response = await this.request('GET', key);
    const body = Buffer.from(await response.arrayBuffer());
    return {
      head: {
        key,
        sizeBytes: Number(response.headers.get('content-length') ?? body.length),
        ...(response.headers.get('etag') ? { etag: stripEtag(response.headers.get('etag')!) } : {}),
        ...(response.headers.get('x-amz-meta-sha256') ? { sha256: response.headers.get('x-amz-meta-sha256')! } : {}),
        ...(response.headers.get('content-type') ? { contentType: normalizeMime(response.headers.get('content-type')!) } : {}),
      },
      body,
    };
  }

  async head(key: string): Promise<ObjectHead | null> {
    let response: Response;
    try {
      response = await this.request('HEAD', key, [], undefined, {}, [200, 404]);
    } catch (error) {
      throw error;
    }
    if (response.status === 404) return null;
    const size = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('R2 returned invalid object size');
    return {
      key,
      sizeBytes: size,
      ...(response.headers.get('etag') ? { etag: stripEtag(response.headers.get('etag')!) } : {}),
      ...(response.headers.get('x-amz-meta-sha256') ? { sha256: response.headers.get('x-amz-meta-sha256')! } : {}),
      ...(response.headers.get('content-type') ? { contentType: normalizeMime(response.headers.get('content-type')!) } : {}),
    };
  }

  async createMultipart(input: MultipartCreateInput): Promise<MultipartUpload> {
    if (await this.head(input.key)) throw new Error('Immutable object key already exists');
    const headers: Record<string, string> = { 'x-amz-checksum-algorithm': 'SHA256' };
    if (input.contentType) headers['content-type'] = normalizeMime(input.contentType);
    for (const [name, value] of Object.entries(input.metadata ?? {})) {
      if (!/^[a-z0-9-]{1,64}$/i.test(name) || /[\r\n]/.test(value)) throw new Error('Invalid multipart metadata');
      headers[`x-amz-meta-${name.toLowerCase()}`] = value;
    }
    const response = await this.request('POST', input.key, [['uploads', '']], undefined, headers, [200]);
    const uploadId = xmlValue(await response.text(), 'UploadId');
    if (!uploadId) throw new Error('R2 multipart response omitted upload id');
    return { key: input.key, uploadId };
  }

  async uploadPart(input: MultipartPartInput): Promise<MultipartPart> {
    assertPartNumber(input.partNumber);
    const bytes = await bodyBytes(input.body);
    const checksumSha256 = digestBytes(bytes);
    if (input.sha256 && input.sha256.toLowerCase() !== checksumSha256) throw new Error('Part checksum mismatch');
    const response = await this.request(
      'PUT',
      input.key,
      [
        ['partNumber', String(input.partNumber)],
        ['uploadId', input.uploadId],
      ],
      bytes,
      { 'x-amz-checksum-sha256': Buffer.from(checksumSha256, 'hex').toString('base64') },
      [200],
    );
    const etag = response.headers.get('etag');
    if (!etag) throw new Error('R2 upload-part response omitted ETag');
    return { partNumber: input.partNumber, etag: stripEtag(etag), checksumSha256, sizeBytes: bytes.length };
  }

  async listParts(input: MultipartAbortInput): Promise<MultipartPart[]> {
    const parts: MultipartPart[] = [];
    let marker: string | undefined;
    do {
      const query: [string, string][] = [['uploadId', input.uploadId]];
      if (marker) query.push(['part-number-marker', marker]);
      const response = await this.request('GET', input.key, query, undefined, {}, [200]);
      const xml = await response.text();
      const partBlocks = xml.match(/<Part>[\s\S]*?<\/Part>/g) ?? [];
      for (const block of partBlocks) {
        const numberText = xmlValue(block, 'PartNumber');
        const etag = xmlValue(block, 'ETag');
        const sizeText = xmlValue(block, 'Size');
        if (!numberText || !etag || !sizeText) throw new Error('R2 ListParts returned an incomplete part');
        const partNumber = Number(numberText);
        const sizeBytes = Number(sizeText);
        assertPartNumber(partNumber);
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error('R2 ListParts returned an invalid size');
        const checksumBase64 = xmlValue(block, 'ChecksumSHA256');
        const checksumBytes = checksumBase64 ? Buffer.from(checksumBase64, 'base64') : null;
        if (checksumBytes && checksumBytes.length !== 32) {
          throw new Error('R2 ListParts returned an invalid SHA-256 checksum');
        }
        parts.push({
          partNumber,
          etag: stripEtag(etag),
          sizeBytes,
          ...(checksumBytes
            ? { checksumSha256: checksumBytes.toString('hex') }
            : {}),
        });
      }
      const truncated = xmlValue(xml, 'IsTruncated') === 'true';
      marker = truncated ? (xmlValue(xml, 'NextPartNumberMarker') ?? undefined) : undefined;
      if (truncated && !marker) throw new Error('R2 ListParts pagination marker missing');
    } while (marker);
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async presignUploadPart(input: MultipartPresignInput): Promise<PresignedUploadPart> {
    assertObjectKey(input.key);
    assertPartNumber(input.partNumber);
    const expires = normalizePresignExpiry(input.expiresInSeconds);
    const now = this.now();
    const { amzDate, dateStamp } = this.dateParts(now);
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const pathname = this.pathname(input.key);
    const requiredHeaders = presignBoundHeaders(input);
    const signedHeaders = ['host', ...Object.keys(requiredHeaders)].sort();
    const canonicalHeaders = signedHeaders
      .map((name) => `${name}:${name === 'host' ? this.endpoint.host : requiredHeaders[name]}\n`)
      .join('');
    const query: [string, string][] = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${this.accessKeyId}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(expires)],
      ['X-Amz-SignedHeaders', signedHeaders.join(';')],
      ['partNumber', String(input.partNumber)],
      ['uploadId', input.uploadId],
    ];
    const canonical = [
      'PUT',
      pathname,
      canonicalQuery(query),
      canonicalHeaders,
      signedHeaders.join(';'),
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n');
    const signature = createHmac('sha256', this.signingKey(dateStamp)).update(stringToSign).digest('hex');
    const url = new URL(pathname, this.endpoint);
    url.search = `${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
    return {
      url: url.toString(),
      expiresAt: new Date(now.getTime() + expires * 1000),
      requiredHeaders,
    };
  }

  async completeMultipart(input: MultipartCompleteInput): Promise<ObjectHead> {
    if (input.parts.length === 0) throw new Error('Multipart completion requires parts');
    assertObjectKey(input.key);
    if (this.completingKeys.has(input.key)) {
      throw new Error('Multipart completion already in progress for immutable key');
    }
    this.completingKeys.add(input.key);
    try {
      if (await this.head(input.key)) throw new Error('Immutable object key already exists');
      const parts = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
      if (new Set(parts.map((part) => part.partNumber)).size !== parts.length) {
        throw new Error('Duplicate multipart parts');
      }
      const xml = `<CompleteMultipartUpload>${parts
        .map((part) => {
          assertPartNumber(part.partNumber);
          const etag = stripEtag(part.etag);
          if (!/^[0-9a-f]{32}$/i.test(etag)) throw new Error('Invalid R2 multipart ETag');
          if (part.checksumSha256 && !SHA256_PATTERN.test(part.checksumSha256)) {
            throw new Error('Invalid R2 multipart checksum');
          }
          const checksum = part.checksumSha256
            ? `<ChecksumSHA256>${Buffer.from(part.checksumSha256, 'hex').toString('base64')}</ChecksumSHA256>`
            : '';
          return `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>\"${etag}\"</ETag>${checksum}</Part>`;
        })
        .join('')}</CompleteMultipartUpload>`;
      await this.request(
        'POST',
        input.key,
        [['uploadId', input.uploadId]],
        Buffer.from(xml),
        { 'content-type': 'application/xml' },
        [200],
      );
      const head = await this.head(input.key);
      if (!head) throw new Error('R2 completed multipart object is missing');
      return head;
    } finally {
      this.completingKeys.delete(input.key);
    }
  }

  async abortMultipart(input: MultipartAbortInput): Promise<void> {
    // Abort is intentionally idempotent for crash recovery: after provider
    // success but before our durable success write, the next lease repeats the
    // DELETE and R2 reports the already-absent multipart upload as 404.
    await this.request(
      'DELETE',
      input.key,
      [['uploadId', input.uploadId]],
      undefined,
      {},
      [204, 404],
      input.signal,
    );
  }
}

// ---------------------------------------------------------------------------
// Staging cache + hydration
// ---------------------------------------------------------------------------

interface CacheEntry {
  objectId: string;
  localPath: string;
  sha256: string;
  sizeBytes: number;
  pins: number;
  lastUsed: number;
}

export interface HydratedObject {
  objectId: string;
  localPath: string;
  agentPath: string;
  sandboxPath?: string;
  sha256: string;
  sizeBytes: number;
  /** Idempotently release this caller's eviction pin. */
  release(): Promise<void>;
}

export interface StagingCacheOptions {
  root: string;
  maxUnpinnedBytes: number;
  now?: () => number;
}

export class StagingCache {
  readonly root: string;
  readonly maxUnpinnedBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private initialized?: Promise<void>;

  constructor(options: StagingCacheOptions) {
    if (!options.root.trim()) throw new Error('Staging cache root is required');
    if (!Number.isSafeInteger(options.maxUnpinnedBytes) || options.maxUnpinnedBytes < 0) {
      throw new Error('Staging cache quota must be a non-negative integer');
    }
    this.root = path.resolve(options.root);
    this.maxUnpinnedBytes = options.maxUnpinnedBytes;
    this.now = options.now ?? Date.now;
  }

  pathFor(objectId: string): string {
    assertObjectId(objectId);
    const normalized = objectId.toLowerCase();
    return path.join(this.root, normalized.slice(0, 2), normalized);
  }

  private async ensureLoaded(): Promise<void> {
    this.initialized ??= (async () => {
      await mkdir(this.root, { recursive: true });
      const prefixes = await readdir(this.root, { withFileTypes: true });
      for (const prefix of prefixes) {
        if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/i.test(prefix.name)) continue;
        const prefixPath = path.join(this.root, prefix.name);
        for (const candidate of await readdir(prefixPath, { withFileTypes: true })) {
          if (!candidate.isFile() || !OBJECT_ID_PATTERN.test(candidate.name)) continue;
          if (candidate.name.slice(0, 2).toLowerCase() !== prefix.name.toLowerCase()) continue;
          const localPath = path.join(prefixPath, candidate.name);
          const [{ sha256, sizeBytes }, info] = await Promise.all([
            sha256File(localPath),
            stat(localPath),
          ]);
          this.entries.set(candidate.name, {
            objectId: candidate.name,
            localPath,
            sha256,
            sizeBytes,
            pins: 0,
            lastUsed: info.mtimeMs,
          });
        }
      }
      await this.evictFor(0);
    })();
    await this.initialized;
  }

  async has(objectId: string): Promise<boolean> {
    await this.ensureLoaded();
    try {
      return (await stat(this.pathFor(objectId))).isFile();
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    }
  }

  private async evictFor(incomingBytes: number, preserveObjectId?: string): Promise<void> {
    const unpinned = [...this.entries.values()].filter(
      (entry) => entry.pins === 0 && entry.objectId !== preserveObjectId,
    );
    let used = unpinned.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    unpinned.sort((a, b) => a.lastUsed - b.lastUsed || a.objectId.localeCompare(b.objectId));
    while (used + incomingBytes > this.maxUnpinnedBytes && unpinned.length > 0) {
      const victim = unpinned.shift()!;
      await rm(victim.localPath, { force: true });
      this.entries.delete(victim.objectId);
      used -= victim.sizeBytes;
    }
    if (used + incomingBytes > this.maxUnpinnedBytes) {
      throw new Error('Staging cache quota exceeded');
    }
  }

  async acquire(
    objectId: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<CacheEntry | null> {
    await this.ensureLoaded();
    const localPath = this.pathFor(objectId);
    if (!(await this.has(objectId))) {
      this.entries.delete(objectId);
      return null;
    }
    const verified = await sha256File(localPath);
    if (verified.sha256 !== expectedSha256 || verified.sizeBytes !== expectedSize) {
      await rm(localPath, { force: true });
      this.entries.delete(objectId);
      return null;
    }
    const entry = this.entries.get(objectId) ?? {
      objectId,
      localPath,
      sha256: verified.sha256,
      sizeBytes: verified.sizeBytes,
      pins: 0,
      lastUsed: this.now(),
    };
    entry.pins += 1;
    entry.lastUsed = this.now();
    this.entries.set(objectId, entry);
    return entry;
  }

  async publish(objectId: string, bytes: Buffer, sha256: string): Promise<CacheEntry> {
    await this.ensureLoaded();
    const actual = digestBytes(bytes);
    if (actual !== sha256) throw new Error('Cannot publish cache entry with checksum mismatch');
    // The new entry is pinned for this caller, so it does not consume the
    // unpinned quota until release.
    await this.evictFor(0, objectId);
    const localPath = this.pathFor(objectId);
    await writeAtomic(localPath, bytes);
    const existing = this.entries.get(objectId);
    if (existing) {
      existing.pins += 1;
      existing.lastUsed = this.now();
      return existing;
    }
    const entry: CacheEntry = {
      objectId,
      localPath,
      sha256,
      sizeBytes: bytes.length,
      pins: 1,
      lastUsed: this.now(),
    };
    this.entries.set(objectId, entry);
    return entry;
  }

  async release(objectId: string): Promise<void> {
    await this.ensureLoaded();
    const entry = this.entries.get(objectId);
    if (!entry || entry.pins === 0) return;
    entry.pins -= 1;
    entry.lastUsed = this.now();
    await this.evictFor(0);
  }
}

export interface ObjectManifestEntry {
  object: StoredObject;
  displayName?: string;
}

export interface ObjectManifest {
  entries: readonly ObjectManifestEntry[];
}

export interface HydrationDestination {
  displayName?: string;
}

export interface ObjectServiceOptions {
  backend: ObjectBackend;
  cache: StagingCache;
  hydrationAttempts?: number;
  sandboxRoot?: string;
  legacyHttpsHosts?: readonly string[];
  fetch?: typeof fetch;
}

function sanitizedDisplayName(value: string | undefined): string {
  const leaf = path.basename((value ?? 'object').replaceAll('\\', '/'));
  const safe = leaf
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 120);
  return safe || 'object';
}

async function copyAtomic(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
      throw new Error('Backing response exceeds verified object size');
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maximumBytes) {
        await reader.cancel('verified size exceeded');
        throw new Error('Backing response exceeds verified object size');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export class ObjectService {
  readonly backend: ObjectBackend;
  readonly cache: StagingCache;
  private readonly hydrationAttempts: number;
  private readonly sandboxRoot?: string;
  private readonly legacyHttpsHosts: ReadonlySet<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ObjectServiceOptions) {
    if (!Number.isSafeInteger(options.hydrationAttempts ?? 3) || (options.hydrationAttempts ?? 3) < 1 || (options.hydrationAttempts ?? 3) > 5) {
      throw new Error('Hydration attempts must be between 1 and 5');
    }
    this.backend = options.backend;
    this.cache = options.cache;
    this.hydrationAttempts = options.hydrationAttempts ?? 3;
    this.sandboxRoot = options.sandboxRoot ? path.resolve(options.sandboxRoot) : undefined;
    this.legacyHttpsHosts = new Set(
      (options.legacyHttpsHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean),
    );
    this.fetchImpl = options.fetch ?? fetch;
  }

  private assertDescriptor(object: StoredObject): void {
    assertObjectId(object.objectId);
    if (object.backingKey !== objectKey(object.objectId)) throw new Error('Object backing key does not match immutable identity');
    if (!SHA256_PATTERN.test(object.sha256)) throw new Error('Object has invalid verified checksum');
    if (!Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 0) throw new Error('Object has invalid verified size');
  }

  private checkedLegacyUrl(value: string | null | undefined): URL {
    if (!value) throw new Error('Legacy object is missing source URL');
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('Legacy source must use HTTPS');
    if (url.username || url.password || (url.port && url.port !== '443')) throw new Error('Legacy source URL is unsafe');
    if (!this.legacyHttpsHosts.has(url.hostname.toLowerCase())) throw new Error('Legacy source host is not allowlisted');
    return url;
  }

  private async fetchLegacy(value: string | null | undefined, maximumBytes: number): Promise<Buffer> {
    let url = this.checkedLegacyUrl(value);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await this.fetchImpl(url, { redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirect === 3) throw new Error('Legacy source redirect failed');
        url = this.checkedLegacyUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`Legacy source fetch failed with status ${response.status}`);
      return readBoundedResponse(response, maximumBytes);
    }
    throw new Error('Legacy source redirect limit exceeded');
  }

  private async fetchBacking(object: StoredObject): Promise<Buffer> {
    return object.backingStore === 'legacy'
      ? this.fetchLegacy(object.legacySourceUrl, object.sizeBytes)
      : (await this.backend.get(object.backingKey)).body;
  }

  private async materialize(
    entry: CacheEntry,
    displayName: string | undefined,
  ): Promise<Pick<HydratedObject, 'agentPath' | 'sandboxPath'>> {
    const name = sanitizedDisplayName(displayName);
    const agentPath = `/workspace/media/${entry.objectId}/${name}`;
    if (!this.sandboxRoot) return { agentPath };
    await mkdir(this.sandboxRoot, { recursive: true });
    const rootReal = await realpath(this.sandboxRoot);
    let parent = this.sandboxRoot;
    for (const segment of ['media', entry.objectId]) {
      parent = path.join(parent, segment);
      await mkdir(parent, { recursive: false }).catch((error: unknown) => {
        if (!isNodeError(error, 'EEXIST')) throw error;
      });
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Sandbox media path is unsafe');
      const parentReal = await realpath(parent);
      if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
        throw new Error('Sandbox media path escaped root');
      }
    }
    const sandboxPath = path.join(this.sandboxRoot, 'media', entry.objectId, name);
    if (!sandboxPath.startsWith(`${this.sandboxRoot}${path.sep}`)) throw new Error('Sandbox path escaped root');
    await copyAtomic(entry.localPath, sandboxPath);
    return { agentPath, sandboxPath };
  }

  async hydrate(object: StoredObject, destination: HydrationDestination = {}): Promise<HydratedObject> {
    this.assertDescriptor(object);
    if (object.state !== 'available') throw new Error(`Object is not available (state=${object.state})`);
    let entry = await this.cache.acquire(object.objectId, object.sha256, object.sizeBytes);
    let lastError: Error | undefined;
    if (!entry) {
      for (let attempt = 1; attempt <= this.hydrationAttempts; attempt += 1) {
        try {
          const bytes = await this.fetchBacking(object);
          const actual = digestBytes(bytes);
          if (bytes.length !== object.sizeBytes || actual !== object.sha256) {
            throw new Error(`Hydration checksum mismatch on attempt ${attempt}`);
          }
          entry = await this.cache.publish(object.objectId, bytes, actual);
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }
    if (!entry) throw lastError ?? new Error('Hydration failed');
    try {
      const projection = await this.materialize(entry, destination.displayName);
      let released = false;
      return {
        objectId: object.objectId,
        localPath: entry.localPath,
        sha256: entry.sha256,
        sizeBytes: entry.sizeBytes,
        ...projection,
        release: async () => {
          if (released) return;
          released = true;
          await this.cache.release(object.objectId);
        },
      };
    } catch (error) {
      await this.cache.release(object.objectId);
      throw error;
    }
  }

  async prefetch(manifest: ObjectManifest): Promise<HydratedObject[]> {
    const acquired: HydratedObject[] = [];
    try {
      for (const item of manifest.entries) {
        acquired.push(await this.hydrate(item.object, { displayName: item.displayName }));
      }
      return acquired;
    } catch (error) {
      await Promise.all(acquired.map((entry) => entry.release()));
      throw error;
    }
  }

  /** Proves a legacy source and the candidate backend resolve to identical verified bytes. */
  async verifyLegacyCutover(object: StoredObject): Promise<boolean> {
    this.assertDescriptor(object);
    if (object.backingStore !== 'legacy') throw new Error('Cutover proof requires a legacy object');
    const [legacy, target] = await Promise.all([
      this.fetchLegacy(object.legacySourceUrl, object.sizeBytes),
      this.backend.get(object.backingKey).then((result) => result.body),
    ]);
    if (
      legacy.length !== object.sizeBytes ||
      target.length !== object.sizeBytes ||
      digestBytes(legacy) !== object.sha256 ||
      digestBytes(target) !== object.sha256 ||
      !legacy.equals(target)
    ) {
      throw new Error('Legacy cutover checksum/byte identity verification failed');
    }
    return true;
  }
}

/** Conservative magic-byte detection used at the upload verification boundary. */
export function detectContentType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    const brand = bytes.toString('latin1', 8, 12);
    return brand === 'M4A ' ? 'audio/mp4' : 'video/mp4';
  }
  if (bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.length >= 3 && bytes.toString('latin1', 0, 3) === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav';
  return null;
}
