import { ApiError } from '../errors';
import { crc32 as nativeCrc32, inflateSync } from 'node:zlib';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87 = Buffer.from('GIF87a', 'ascii');
const GIF89 = Buffer.from('GIF89a', 'ascii');
const PDF = Buffer.from('%PDF-', 'ascii');
const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const SEGMENT = Buffer.from([0x18, 0x53, 0x80, 0x67]);
const WEBM_DOCTYPE = Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
const WEAK_DECLARATIONS = new Set(['', 'application/octet-stream']);
const SUPPORTED_MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ']);
const UNSUPPORTED_IMAGE_BRANDS = new Set([
  'avif',
  'avis',
  'heic',
  'heix',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
]);

export interface VerificationResult {
  detectedMime: string;
  quarantineReason: string | null;
}

interface Detection {
  mime: string;
  ambiguous: boolean;
  malformed: boolean;
  unsupported: boolean;
}

function normalizeMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

function crc32(bytes: Buffer): number {
  return nativeCrc32(bytes);
}

function completePng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, PNG.length).equals(PNG)) return false;
  let offset = PNG.length;
  let first = true;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) return false;
    if (
      bytes.readUInt32BE(offset + 8 + length) !==
      crc32(bytes.subarray(offset + 4, offset + 8 + length))
    ) return false;
    if (first) {
      if (type !== 'IHDR' || length !== 13) return false;
      if (bytes.readUInt32BE(offset + 8) === 0 || bytes.readUInt32BE(offset + 12) === 0) return false;
      first = false;
    }
    if (type === 'IDAT' && length > 0) imageData = true;
    if (type === 'IEND') return imageData && length === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}

function completeJpeg(bytes: Buffer): boolean {
  if (bytes.length < 4 || !bytes.subarray(0, JPEG.length).equals(JPEG)) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++]!;
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length;
    if (marker === 0x00) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (frameMarkers.has(marker)) {
      if (length < 8 || bytes.readUInt16BE(offset + 3) === 0 || bytes.readUInt16BE(offset + 5) === 0) {
        return false;
      }
      sawFrame = true;
    }
    if (marker === 0xda) {
      sawScan = true;
      offset += length;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        if (offset + 1 >= bytes.length) return false;
        const next = bytes[offset + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        if (next === 0xd9) return sawFrame && sawScan && offset + 2 === bytes.length;
        break;
      }
      if (offset >= bytes.length) return false;
      continue;
    }
    offset += length;
  }
  return false;
}

function completeGif(bytes: Buffer): boolean {
  if (bytes.length < 14) return false;
  const header = bytes.toString('ascii', 0, 6);
  if (
    (header !== 'GIF87a' && header !== 'GIF89a') ||
    bytes.readUInt16LE(6) === 0 ||
    bytes.readUInt16LE(8) === 0
  ) return false;
  const packed = bytes[10]!;
  let offset = 13 + ((packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1));
  let sawImage = false;
  const subBlocks = (): boolean => {
    while (offset < bytes.length) {
      const length = bytes[offset++]!;
      if (length === 0) return true;
      if (offset + length > bytes.length) return false;
      offset += length;
    }
    return false;
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) return sawImage && offset === bytes.length;
    if (marker === 0x21) {
      if (offset >= bytes.length) return false;
      offset += 1;
      if (!subBlocks()) return false;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return false;
    if (bytes.readUInt16LE(offset + 4) === 0 || bytes.readUInt16LE(offset + 6) === 0) return false;
    const imagePacked = bytes[offset + 8]!;
    offset += 9;
    if ((imagePacked & 0x80) !== 0) offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
    if (offset >= bytes.length) return false;
    offset += 1;
    if (!subBlocks()) return false;
    sawImage = true;
  }
  return false;
}

interface PdfIndirectObject {
  number: number;
  generation: number;
  body: string;
  dictionary: string | null;
  stream: Buffer | null;
}

function pdfNumber(dictionary: string, name: string): number | null {
  const match = new RegExp(`/${name}\\s+(\\d+)\\b`).exec(dictionary);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function pdfIndirectObject(
  bytes: Buffer,
  offset: number,
  decodeStream = false,
  hardEnd = bytes.length,
): PdfIndirectObject | null {
  if (hardEnd <= offset || hardEnd > bytes.length) return null;
  const tail = bytes.toString('latin1', offset, Math.min(offset + 128, hardEnd));
  const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(tail);
  if (!header) return null;
  const bodyStart = offset + header[0].length;
  const relativeEndObject = bytes.subarray(bodyStart, hardEnd).indexOf(Buffer.from('endobj', 'ascii'));
  if (relativeEndObject < 0) return null;
  const endObject = bodyStart + relativeEndObject;
  const body = bytes.toString('latin1', bodyStart, endObject);
  const dictionaryMatch = /<<([\s\S]*?)>>/.exec(body);
  const dictionary = dictionaryMatch?.[1] ?? null;
  let stream: Buffer | null = null;
  if (decodeStream && dictionary !== null && /\bstream(?:\r\n|\n|\r)/.test(body)) {
    const length = pdfNumber(dictionary, 'Length');
    if (length === null || length < 0 || length > 64 * 1024 * 1024) return null;
    const streamMarker = /\bstream(\r\n|\n|\r)/.exec(body);
    if (!streamMarker) return null;
    const streamStart = bodyStart + streamMarker.index + streamMarker[0].length;
    const streamEnd = streamStart + length;
    if (streamEnd > endObject) return null;
    const terminator = bytes.toString('latin1', streamEnd, endObject);
    if (!/^(?:\r\n|\n|\r)?endstream\s*$/.test(terminator)) return null;
    stream = bytes.subarray(streamStart, streamEnd);
    if (/\/Filter\s*\/FlateDecode\b/.test(dictionary)) {
      try {
        stream = inflateSync(stream, { maxOutputLength: 64 * 1024 * 1024 });
      } catch {
        return null;
      }
    } else if (/\/Filter\b/.test(dictionary)) return null;
  }
  return {
    number: Number(header[1]),
    generation: Number(header[2]),
    body,
    dictionary,
    stream,
  };
}

interface PdfXrefEntry {
  objectNumber: number;
  generation: number;
  type: 0 | 1 | 2;
  field: number;
  objectStreamIndex?: number;
}

function completePdf(bytes: Buffer): boolean {
  const text = bytes.toString('latin1');
  if (!/^%PDF-[12]\.[0-9](?:\r?\n|\r)/.test(text)) return false;
  const terminal = /startxref\s+(\d+)\s+%%EOF[\t\r\n ]*$/.exec(text);
  if (!terminal || terminal.index < 1) return false;
  const xrefOffset = Number(terminal[1]);
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 1 || xrefOffset >= bytes.length) return false;
  const xrefEntries = new Map<number, PdfXrefEntry>();
  let rootReference: [number, number] | null = null;
  let declaredSize = 0;
  if (text.slice(xrefOffset, xrefOffset + 4) !== 'xref') {
    const xrefObject = pdfIndirectObject(bytes, xrefOffset, true, terminal.index);
    if (!xrefObject?.dictionary || !xrefObject.stream || !/\/Type\s*\/XRef\b/.test(xrefObject.dictionary)) {
      return false;
    }
    if (/\/(?:Encrypt|Prev|XRefStm)\b/.test(xrefObject.dictionary)) return false;
    const size = pdfNumber(xrefObject.dictionary, 'Size');
    const root = /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(xrefObject.dictionary);
    const widths = /\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(xrefObject.dictionary);
    if (!size || !root || !widths || size > 100_000) return false;
    declaredSize = size;
    rootReference = [Number(root[1]), Number(root[2])];
    const width = widths.slice(1).map(Number);
    if (width.some((value) => value < 0 || value > 8) || width.reduce((sum, value) => sum + value, 0) < 1) return false;
    const indexMatch = /\/Index\s*\[([\s\d]+)\]/.exec(xrefObject.dictionary);
    const indexValues = indexMatch ? indexMatch[1]!.trim().split(/\s+/).map(Number) : [0, size];
    if (indexValues.length === 0 || indexValues.length % 2 !== 0) return false;
    const recordWidth = width.reduce((sum, value) => sum + value, 0);
    const expectedRecords = indexValues.reduce((sum, value, position) => position % 2 === 1 ? sum + value : sum, 0);
    if (expectedRecords > 100_000 || xrefObject.stream.length !== expectedRecords * recordWidth) return false;
    let cursor = 0;
    for (let range = 0; range < indexValues.length; range += 2) {
      const first = indexValues[range]!;
      const count = indexValues[range + 1]!;
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        first < 0 ||
        first + count > size
      ) return false;
      for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
        const fields: number[] = [];
        for (const fieldWidth of width) {
          let value = 0n;
          for (let byte = 0; byte < fieldWidth; byte += 1) value = (value << 8n) | BigInt(xrefObject.stream[cursor++]!);
          if (value > BigInt(Number.MAX_SAFE_INTEGER)) return false;
          fields.push(Number(value));
        }
        const type = (width[0] === 0 ? 1 : fields[0]) as 0 | 1 | 2;
        if (![0, 1, 2].includes(type)) return false;
        const objectNumber = first + entryIndex;
        if (xrefEntries.has(objectNumber)) return false;
        xrefEntries.set(objectNumber, {
          objectNumber,
          generation: type === 1 ? fields[2]! : 0,
          type,
          field: fields[1]!,
          objectStreamIndex: type === 2 ? fields[2]! : undefined,
        });
      }
    }
  } else {
    const trailerOffset = text.indexOf('trailer', xrefOffset + 4);
    if (trailerOffset < 0 || trailerOffset >= terminal.index) return false;
    const trailer = /^trailer\s*<<([\s\S]*?)>>\s*$/.exec(text.slice(trailerOffset, terminal.index));
    if (!trailer || /\/(?:Encrypt|Prev|XRefStm)\b/.test(trailer[1]!)) return false;
    const size = /\/Size\s+(\d+)\b/.exec(trailer[1]!);
    const root = /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(trailer[1]!);
    if (!size || !root) return false;
    declaredSize = Number(size[1]);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > 100_000) return false;
    rootReference = [Number(root[1]), Number(root[2])];

    let cursor = xrefOffset + 4;
    let cumulativeEntries = 0;
    const readLine = (): string | null => {
      while (cursor < trailerOffset && (text[cursor] === '\r' || text[cursor] === '\n')) cursor += 1;
      if (cursor >= trailerOffset) return null;
      let end = text.indexOf('\n', cursor);
      if (end < 0 || end > trailerOffset) end = trailerOffset;
      if (end - cursor > 64) return null;
      const line = text.slice(cursor, end).replace(/\r$/, '').trim();
      cursor = end + 1;
      return line;
    };
    while (cursor < trailerOffset) {
      const subsection = /^(\d+)\s+(\d+)$/.exec(readLine() ?? '');
      if (!subsection) return false;
      const firstObject = Number(subsection[1]);
      const count = Number(subsection[2]);
      if (
        !Number.isSafeInteger(firstObject) ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        firstObject < 0 ||
        firstObject + count > declaredSize ||
        cumulativeEntries + count > 100_000
      ) return false;
      cumulativeEntries += count;
      for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
        const entry = /^(\d{10})\s(\d{5})\s([nf])\s?$/.exec(readLine() ?? '');
        if (!entry) return false;
        const objectNumber = firstObject + entryIndex;
        const generation = Number(entry[2]);
        const field = Number(entry[1]);
        if (xrefEntries.has(objectNumber) || !Number.isSafeInteger(field)) return false;
        xrefEntries.set(objectNumber, {
          objectNumber,
          generation,
          type: entry[3] === 'n' ? 1 : 0,
          field,
        });
      }
    }
  }

  const objects = new Map<string, string>();
  let maximumObject = 0;
  const typeOneEntries = [...xrefEntries.values()]
    .filter((entry) => entry.type === 1)
    .sort((left, right) => left.field - right.field);
  const hardEnds = new Map<number, number>();
  for (let index = 0; index < typeOneEntries.length; index += 1) {
    const entry = typeOneEntries[index]!;
    const next = typeOneEntries[index + 1];
    if (next && next.field === entry.field) return false;
    hardEnds.set(entry.field, next?.field ?? (entry.field === xrefOffset ? terminal.index : xrefOffset));
  }
  for (const entry of xrefEntries.values()) {
    maximumObject = Math.max(maximumObject, entry.objectNumber);
    if (entry.type !== 1) continue;
    if (entry.field <= 0 || entry.field > xrefOffset) return false;
    const object = pdfIndirectObject(bytes, entry.field, false, hardEnds.get(entry.field));
    if (!object || object.number !== entry.objectNumber || object.generation !== entry.generation) return false;
    objects.set(`${entry.objectNumber}:${entry.generation}`, object.body);
  }
  if (declaredSize <= maximumObject || !rootReference) return false;

  const objectStreamCache = new Map<number, {
    count: number;
    first: number;
    header: number[];
    stream: Buffer;
  }>();
  for (const entry of xrefEntries.values()) {
    if (entry.type !== 2) continue;
    const objectStreamEntry = xrefEntries.get(entry.field);
    if (!objectStreamEntry || objectStreamEntry.type !== 1) return false;
    let parsed = objectStreamCache.get(entry.field);
    if (!parsed) {
      const objectStream = pdfIndirectObject(
        bytes,
        objectStreamEntry.field,
        true,
        hardEnds.get(objectStreamEntry.field),
      );
      if (!objectStream?.dictionary || !objectStream.stream || !/\/Type\s*\/ObjStm\b/.test(objectStream.dictionary)) return false;
      const count = pdfNumber(objectStream.dictionary, 'N');
      const first = pdfNumber(objectStream.dictionary, 'First');
      if (count === null || first === null || count < 1 || count > 100_000 || first > objectStream.stream.length) return false;
      const header = objectStream.stream.toString('ascii', 0, first).trim().split(/\s+/).map(Number);
      parsed = { count, first, header, stream: objectStream.stream };
      objectStreamCache.set(entry.field, parsed);
    }
    const { count, first, header, stream } = parsed;
    const objectStreamIndex = entry.objectStreamIndex;
    if (header.length !== count * 2 || objectStreamIndex === undefined || objectStreamIndex >= count) return false;
    const listedNumber = header[objectStreamIndex * 2]!;
    const relativeStart = header[objectStreamIndex * 2 + 1]!;
    const relativeEnd = objectStreamIndex + 1 < count ? header[objectStreamIndex * 2 + 3]! : stream.length - first;
    if (listedNumber !== entry.objectNumber || relativeStart < 0 || relativeEnd <= relativeStart) return false;
    objects.set(`${entry.objectNumber}:0`, stream.toString('latin1', first + relativeStart, first + relativeEnd));
  }

  const rootBody = objects.get(`${rootReference[0]}:${rootReference[1]}`);
  if (!rootBody || !/\/Type\s*\/Catalog\b/.test(rootBody)) return false;
  const pagesReference = /\/Pages\s+(\d+)\s+(\d+)\s+R\b/.exec(rootBody);
  if (!pagesReference) return false;
  const pagesBody = objects.get(`${pagesReference[1]}:${pagesReference[2]}`);
  return Boolean(
    pagesBody &&
    /\/Type\s*\/Pages\b/.test(pagesBody) &&
    /\/Count\s+\d+\b/.test(pagesBody) &&
    /\/Kids\s*\[[\s\S]*?\]/.test(pagesBody),
  );
}

function completeRiff(bytes: Buffer, kind: 'WEBP' | 'WAVE'): boolean {
  if (
    bytes.length < 20 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== kind ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) return false;
  let offset = 12;
  let hasPrimary = false;
  let hasFormat = false;
  let hasData = false;
  let waveBlockAlign = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return false;
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > bytes.length) return false;
    if (kind === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(type)) {
      if (hasPrimary || length === 0) return false;
      hasPrimary = true;
    }
    if (
      kind === 'WAVE' &&
      type === 'fmt ' &&
      !hasFormat &&
      length === 16 &&
      [1, 3].includes(bytes.readUInt16LE(offset + 8)) &&
      bytes.readUInt16LE(offset + 10) > 0 &&
      bytes.readUInt32LE(offset + 12) > 0 &&
      bytes.readUInt32LE(offset + 16) > 0 &&
      bytes.readUInt16LE(offset + 20) > 0 &&
      bytes.readUInt16LE(offset + 22) > 0
    ) {
      const channels = bytes.readUInt16LE(offset + 10);
      const sampleRate = bytes.readUInt32LE(offset + 12);
      const byteRate = bytes.readUInt32LE(offset + 16);
      const blockAlign = bytes.readUInt16LE(offset + 20);
      const bitsPerSample = bytes.readUInt16LE(offset + 22);
      if (bitsPerSample % 8 !== 0 || blockAlign !== channels * (bitsPerSample / 8)) return false;
      if (byteRate !== sampleRate * blockAlign) return false;
      waveBlockAlign = blockAlign;
      hasFormat = true;
    } else if (kind === 'WAVE' && type === 'fmt ') return false;
    if (kind === 'WAVE' && type === 'data') {
      if (!hasFormat || hasData || length === 0 || length % waveBlockAlign !== 0) return false;
      hasData = true;
    }
    offset = end + (length % 2);
  }
  return offset === bytes.length && (kind === 'WEBP' ? hasPrimary : hasFormat && hasData);
}

interface EbmlElement {
  id: string;
  dataStart: number;
  end: number | null;
}

function ebmlElement(bytes: Buffer, offset: number): EbmlElement | null {
  if (offset >= bytes.length || bytes[offset] === 0) return null;
  let idLength = 1;
  while (idLength <= 4 && (bytes[offset]! & (0x80 >> (idLength - 1))) === 0) idLength += 1;
  if (idLength > 4 || offset + idLength >= bytes.length) return null;
  const id = bytes.subarray(offset, offset + idLength).toString('hex');
  const sizeOffset = offset + idLength;
  let sizeLength = 1;
  while (sizeLength <= 8 && (bytes[sizeOffset]! & (0x80 >> (sizeLength - 1))) === 0) {
    sizeLength += 1;
  }
  if (sizeLength > 8 || sizeOffset + sizeLength > bytes.length) return null;
  let size = BigInt(bytes[sizeOffset]! & (0xff >> sizeLength));
  for (let index = 1; index < sizeLength; index += 1) {
    size = (size << 8n) | BigInt(bytes[sizeOffset + index]!);
  }
  const unknown = size === (1n << BigInt(7 * sizeLength)) - 1n;
  const dataStart = sizeOffset + sizeLength;
  if (unknown) return { id, dataStart, end: null };
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const end = dataStart + Number(size);
  return end <= bytes.length ? { id, dataStart, end } : null;
}

function completeWebm(bytes: Buffer): boolean {
  const header = ebmlElement(bytes, 0);
  if (!header || header.id !== EBML.toString('hex') || header.end === null) return false;
  let offset = header.dataStart;
  let webm = false;
  while (offset < header.end) {
    const child = ebmlElement(bytes, offset);
    if (!child || child.end === null || child.end > header.end) return false;
    if (child.id === '4282' && bytes.toString('ascii', child.dataStart, child.end) === 'webm') webm = true;
    offset = child.end;
  }
  if (!webm || offset !== header.end) return false;
  const segment = ebmlElement(bytes, header.end);
  if (!segment || segment.id !== SEGMENT.toString('hex')) return false;
  const segmentEnd = segment.end ?? bytes.length;
  if (segmentEnd !== bytes.length || segment.dataStart >= segmentEnd) return false;
  offset = segment.dataStart;
  let info = false;
  let supportedTrack = false;
  let mediaBlock = false;
  while (offset < segmentEnd) {
    const child = ebmlElement(bytes, offset);
    if (!child || child.end === null) return false;
    if (child.end > segmentEnd) return false;
    if (child.id === '1549a966') {
      if (info) return false;
      let nestedOffset = child.dataStart;
      while (nestedOffset < child.end) {
        const nested = ebmlElement(bytes, nestedOffset);
        if (!nested || nested.end === null || nested.end > child.end) return false;
        if (nested.id === '2ad7b1' && nested.end > nested.dataStart) info = true;
        nestedOffset = nested.end;
      }
    } else if (child.id === '1654ae6b') {
      let trackOffset = child.dataStart;
      while (trackOffset < child.end) {
        const track = ebmlElement(bytes, trackOffset);
        if (!track || track.end === null || track.end > child.end || track.id !== 'ae') return false;
        let fieldOffset = track.dataStart;
        let trackType = 0;
        let codec = '';
        while (fieldOffset < track.end) {
          const field = ebmlElement(bytes, fieldOffset);
          if (!field || field.end === null || field.end > track.end) return false;
          if (field.id === '83' && field.end - field.dataStart === 1) trackType = bytes[field.dataStart]!;
          if (field.id === '86') codec = bytes.toString('ascii', field.dataStart, field.end);
          fieldOffset = field.end;
        }
        if (
          [1, 2].includes(trackType) &&
          ['V_VP8', 'V_VP9', 'V_AV1', 'A_VORBIS', 'A_OPUS'].includes(codec)
        ) supportedTrack = true;
        trackOffset = track.end;
      }
    } else if (child.id === '1f43b675') {
      let clusterOffset = child.dataStart;
      while (clusterOffset < child.end) {
        const block = ebmlElement(bytes, clusterOffset);
        if (!block || block.end === null || block.end > child.end) return false;
        if (block.id === 'a3' && block.end - block.dataStart >= 5) mediaBlock = true;
        clusterOffset = block.end;
      }
    }
    offset = child.end;
  }
  return info && supportedTrack && mediaBlock && offset === segmentEnd;
}

interface IsoBox {
  type: string;
  start: number;
  dataStart: number;
  end: number;
}

function isoBoxes(bytes: Buffer, start: number, end: number): IsoBox[] | null {
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset < end) {
    if (boxes.length >= 4096 || offset + 8 > end) return null;
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      const extended = bytes.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return null;
    boxes.push({ type, start: offset, dataStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return offset === end ? boxes : null;
}

function mp4Status(bytes: Buffer): 'complete' | 'malformed' | 'unsupported' {
  if (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp') return 'malformed';
  const topLevel = isoBoxes(bytes, 0, bytes.length);
  if (!topLevel || topLevel.length < 1 || topLevel[0]!.type !== 'ftyp') return 'malformed';
  const ftyp = topLevel[0]!;
  const ftypSize = ftyp.end - ftyp.start;
  if (ftypSize < 16 || ftypSize > 256 || (ftypSize - 16) % 4 !== 0) return 'malformed';
  let supportedBrand = false;
  let unsupportedBrand = false;
  for (let offset = ftyp.dataStart; offset + 4 <= ftyp.end; offset += 4) {
    if (offset === ftyp.dataStart + 4) continue; // minor version
    const brand = bytes.toString('ascii', offset, offset + 4);
    supportedBrand ||= SUPPORTED_MP4_BRANDS.has(brand);
    unsupportedBrand ||= UNSUPPORTED_IMAGE_BRANDS.has(brand);
  }
  if (unsupportedBrand || !supportedBrand) return 'unsupported';
  if (topLevel.length < 3) return 'malformed';

  const moovBoxes = topLevel.filter((box) => box.type === 'moov');
  const mdatBoxes = topLevel.filter((box) => box.type === 'mdat' && box.end > box.dataStart);
  if (moovBoxes.length !== 1 || mdatBoxes.length < 1) return 'malformed';
  const moovChildren = isoBoxes(bytes, moovBoxes[0]!.dataStart, moovBoxes[0]!.end);
  if (!moovChildren) return 'malformed';
  const mediaRanges = mdatBoxes.map((box) => [box.dataStart, box.end] as const);
  let validTrack = false;
  for (const trak of moovChildren.filter((box) => box.type === 'trak')) {
    const trakChildren = isoBoxes(bytes, trak.dataStart, trak.end);
    const mdia = trakChildren?.find((box) => box.type === 'mdia');
    const mdiaChildren = mdia ? isoBoxes(bytes, mdia.dataStart, mdia.end) : null;
    const minf = mdiaChildren?.find((box) => box.type === 'minf');
    const minfChildren = minf ? isoBoxes(bytes, minf.dataStart, minf.end) : null;
    const stbl = minfChildren?.find((box) => box.type === 'stbl');
    const sampleBoxes = stbl ? isoBoxes(bytes, stbl.dataStart, stbl.end) : null;
    const stsz = sampleBoxes?.find((box) => box.type === 'stsz');
    const offsetBox = sampleBoxes?.find((box) => box.type === 'stco' || box.type === 'co64');
    if (!stsz || !offsetBox || stsz.end - stsz.dataStart < 12 || offsetBox.end - offsetBox.dataStart < 8) continue;
    const sampleSize = bytes.readUInt32BE(stsz.dataStart + 4);
    const sampleCount = bytes.readUInt32BE(stsz.dataStart + 8);
    if (sampleCount < 1 || sampleCount > 1_000_000) continue;
    let totalSampleBytes = sampleSize * sampleCount;
    if (sampleSize === 0) {
      if (stsz.dataStart + 12 + sampleCount * 4 !== stsz.end) continue;
      totalSampleBytes = 0;
      for (let sample = 0; sample < sampleCount; sample += 1) {
        totalSampleBytes += bytes.readUInt32BE(stsz.dataStart + 12 + sample * 4);
        if (!Number.isSafeInteger(totalSampleBytes)) break;
      }
    } else if (stsz.dataStart + 12 !== stsz.end) continue;
    const chunkCount = bytes.readUInt32BE(offsetBox.dataStart + 4);
    const width = offsetBox.type === 'co64' ? 8 : 4;
    if (chunkCount < 1 || chunkCount > 1_000_000 || offsetBox.dataStart + 8 + chunkCount * width !== offsetBox.end) continue;
    let validOffsets = true;
    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      const position = offsetBox.dataStart + 8 + chunk * width;
      const value = width === 8 ? bytes.readBigUInt64BE(position) : BigInt(bytes.readUInt32BE(position));
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) { validOffsets = false; break; }
      const numeric = Number(value);
      if (!mediaRanges.some(([start, end]) => numeric >= start && numeric < end)) { validOffsets = false; break; }
    }
    const mediaBytes = mediaRanges.reduce((total, [start, end]) => total + end - start, 0);
    if (validOffsets && totalSampleBytes > 0 && totalSampleBytes <= mediaBytes) validTrack = true;
  }
  return validTrack ? 'complete' : 'malformed';
}

function mp3FrameLength(bytes: Buffer, offset: number): number | null {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) {
    return null;
  }
  const version = (bytes[offset + 1]! >> 3) & 0x03;
  const layer = (bytes[offset + 1]! >> 1) & 0x03;
  const bitrateIndex = (bytes[offset + 2]! >> 4) & 0x0f;
  const sampleIndex = (bytes[offset + 2]! >> 2) & 0x03;
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 0x0f || sampleIndex === 3) {
    return null;
  }
  const mpeg1 = version === 3;
  const bitrateTables = mpeg1
    ? {
        3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
        2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
        1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
      }
    : {
        3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
        2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
        1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
      };
  const bitrate = bitrateTables[layer as 1 | 2 | 3][bitrateIndex]! * 1000;
  const baseSampleRate = [44_100, 48_000, 32_000][sampleIndex]!;
  const sampleRate = version === 3 ? baseSampleRate : version === 2 ? baseSampleRate / 2 : baseSampleRate / 4;
  const padding = (bytes[offset + 2]! >> 1) & 1;
  if (layer === 3) return Math.floor((12 * bitrate) / sampleRate + padding) * 4;
  return Math.floor(((layer === 1 && !mpeg1 ? 72 : 144) * bitrate) / sampleRate + padding);
}

function completeMp3(bytes: Buffer): boolean {
  let offset = 0;
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    if (bytes.length < 14 || [...bytes.subarray(6, 10)].some((value) => value > 0x7f)) return false;
    const tagSize = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!;
    offset = 10 + tagSize;
  }
  const audioEnd = bytes.length >= 128 && bytes.toString('ascii', bytes.length - 128, bytes.length - 125) === 'TAG'
    ? bytes.length - 128
    : bytes.length;
  let frames = 0;
  while (offset < audioEnd) {
    const length = mp3FrameLength(bytes, offset);
    if (length === null || length <= 4 || offset + length > audioEnd) return false;
    offset += length;
    frames += 1;
  }
  return frames > 0 && offset === audioEnd;
}

function decodedText(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

function strongSignatures(bytes: Buffer): string[] {
  const found = new Set<string>();
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
    if (bytes.indexOf(signature) >= 0) found.add(mime);
  }
  for (let offset = bytes.indexOf('RIFF', 0, 'ascii'); offset >= 0; offset = bytes.indexOf('RIFF', offset + 1, 'ascii')) {
    const kind = bytes.toString('ascii', offset + 8, offset + 12);
    if (kind === 'WEBP') found.add('image/webp');
    if (kind === 'WAVE') found.add('audio/wav');
  }
  if (bytes.indexOf('ftyp', 0, 'ascii') >= 4) found.add('video/mp4');
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3' || mp3FrameLength(bytes, 0) !== null) {
    found.add('audio/mpeg');
  }
  return [...found];
}

function detectMime(bytes: Buffer): Detection {
  const signatures = strongSignatures(bytes);
  if (signatures.length > 1) {
    return { mime: signatures[0]!, ambiguous: true, malformed: false, unsupported: false };
  }
  if (signatures.length === 1) {
    const mime = signatures[0]!;
    if (mime === 'application/zip') {
      return { mime, ambiguous: false, malformed: false, unsupported: false };
    }
    let complete = false;
    let unsupported = false;
    if (mime === 'image/png') complete = completePng(bytes);
    else if (mime === 'image/jpeg') complete = completeJpeg(bytes);
    else if (mime === 'image/gif') complete = completeGif(bytes);
    else if (mime === 'application/pdf') complete = completePdf(bytes);
    else if (mime === 'image/webp') complete = completeRiff(bytes, 'WEBP');
    else if (mime === 'audio/wav') complete = completeRiff(bytes, 'WAVE');
    else if (mime === 'video/webm') complete = completeWebm(bytes);
    else if (mime === 'audio/mpeg') complete = completeMp3(bytes);
    else if (mime === 'video/mp4') {
      const status = mp4Status(bytes);
      complete = status === 'complete';
      unsupported = status === 'unsupported';
    }
    return { mime, ambiguous: false, malformed: !complete && !unsupported, unsupported };
  }

  const text = decodedText(bytes);
  if (text !== null) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed);
        return {
          mime: 'application/json',
          ambiguous: false,
          malformed: false,
          unsupported: false,
        };
      } catch {
        return {
          mime: 'application/json',
          ambiguous: false,
          malformed: true,
          unsupported: false,
        };
      }
    }
    return { mime: 'text/plain', ambiguous: false, malformed: false, unsupported: false };
  }
  return {
    mime: 'application/octet-stream',
    ambiguous: false,
    malformed: false,
    unsupported: false,
  };
}

/**
 * Verify the complete server-observed payload, not a filename or client type.
 * Unknown, malformed, unsupported, or multi-signature content fails closed.
 */
export function verifyUploadHeader(bytes: Buffer, declaredMime: string): VerificationResult {
  const declared = normalizeMime(declaredMime);
  const detection = detectMime(bytes);
  if (detection.ambiguous) {
    return { detectedMime: detection.mime, quarantineReason: 'ambiguous_polyglot_content' };
  }
  if (detection.mime === 'application/zip') {
    return { detectedMime: detection.mime, quarantineReason: 'archives_not_allowed' };
  }
  if (detection.unsupported) {
    return { detectedMime: detection.mime, quarantineReason: 'unsupported_content_type' };
  }
  if (detection.malformed) {
    return { detectedMime: detection.mime, quarantineReason: 'truncated_or_malformed_content' };
  }
  if (detection.mime === 'application/octet-stream') {
    return { detectedMime: detection.mime, quarantineReason: 'unknown_content_type' };
  }
  if (!WEAK_DECLARATIONS.has(declared) && declared !== detection.mime) {
    return { detectedMime: detection.mime, quarantineReason: 'declared_content_type_mismatch' };
  }
  return { detectedMime: detection.mime, quarantineReason: null };
}

export function quarantineError(_reason: string): ApiError {
  // The stable reason is intentionally generic at the HTTP boundary. Detailed
  // policy reasons remain in the owner-scoped durable row/operator audit.
  return new ApiError(422, 'upload_quarantined', 'Upload quarantined');
}
