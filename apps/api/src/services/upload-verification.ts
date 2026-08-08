import { ApiError } from '../errors';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87 = Buffer.from('GIF87a', 'ascii');
const GIF89 = Buffer.from('GIF89a', 'ascii');
const PDF = Buffer.from('%PDF-', 'ascii');
const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

export interface VerificationResult {
  detectedMime: string;
  quarantineReason: string | null;
}

function normalizeMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

function isProbablyText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  return !bytes.toString('utf8').includes('\ufffd');
}

function strongSignatures(bytes: Buffer): string[] {
  const found = new Set<string>();
  const probe = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  const signatures: Array<[string, Buffer]> = [
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF87],
    ['image/gif', GIF89],
    ['application/pdf', PDF],
    ['application/zip', ZIP_LOCAL],
    ['video/webm', EBML],
  ];
  for (const [mime, signature] of signatures) {
    if (probe.indexOf(signature) >= 0) found.add(mime);
  }
  if (probe.length >= 12 && probe.subarray(0, 4).toString('ascii') === 'RIFF') {
    const kind = probe.subarray(8, 12).toString('ascii');
    if (kind === 'WEBP') found.add('image/webp');
    if (kind === 'WAVE') found.add('audio/wav');
  }
  if (probe.length >= 12 && probe.subarray(4, 8).toString('ascii') === 'ftyp') {
    found.add('video/mp4');
  }
  if (probe.subarray(0, 3).toString('ascii') === 'ID3' || (probe[0] === 0xff && (probe[1]! & 0xe0) === 0xe0)) {
    found.add('audio/mpeg');
  }
  return [...found];
}

function detectMime(bytes: Buffer): { mime: string; ambiguous: boolean } {
  const signatures = strongSignatures(bytes);
  if (signatures.length > 1) return { mime: signatures[0]!, ambiguous: true };
  if (signatures.length === 1) return { mime: signatures[0]!, ambiguous: false };
  if (isProbablyText(bytes)) {
    const text = bytes.toString('utf8').trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        JSON.parse(text);
        return { mime: 'application/json', ambiguous: false };
      } catch {
        // It is still text, but cannot honestly be called JSON.
      }
    }
    return { mime: 'text/plain', ambiguous: false };
  }
  return { mime: 'application/octet-stream', ambiguous: false };
}

/**
 * Verify declared type against a bounded server-read header. This deliberately
 * fails closed: an unknown or ambiguous type is quarantined, never served.
 */
export function verifyUploadHeader(header: Buffer, declaredMime: string): VerificationResult {
  const declared = normalizeMime(declaredMime);
  const { mime: detectedMime, ambiguous } = detectMime(header);
  if (ambiguous) return { detectedMime, quarantineReason: 'ambiguous_polyglot_content' };
  if (detectedMime === 'application/octet-stream') {
    return { detectedMime, quarantineReason: 'unknown_content_type' };
  }
  if (declared !== detectedMime) {
    return { detectedMime, quarantineReason: 'declared_content_type_mismatch' };
  }
  if (detectedMime === 'application/zip') {
    // Closed-cohort kernel ruling: archives require a later streaming scanner
    // with central-directory/local-header agreement and expansion controls.
    // Until then every archive is quarantined, including structurally benign
    // ZIPs; no archive parser is treated as a serving authorization boundary.
    return { detectedMime, quarantineReason: 'archives_not_allowed' };
  }
  return { detectedMime, quarantineReason: null };
}

export function quarantineError(_reason: string): ApiError {
  // The stable reason is intentionally generic at the HTTP boundary. Detailed
  // policy reasons remain in the owner-scoped durable row/operator audit.
  return new ApiError(422, 'upload_quarantined', 'Upload quarantined');
}
