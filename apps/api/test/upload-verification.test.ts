import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';

import { verifyUploadHeader } from '../src/services/upload-verification';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function png(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.from([0])),
    pngChunk('IEND'),
  ]);
}

function jpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x02,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00,
    0xff, 0xc4, 0x00, 0x02,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00,
    0xff, 0xd9,
  ]);
}

function pdf(): Buffer {
  let document = '%PDF-1.7\n';
  const objectOffsets = [0];
  objectOffsets[1] = Buffer.byteLength(document, 'latin1');
  document += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  objectOffsets[2] = Buffer.byteLength(document, 'latin1');
  document += '2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n';
  const xrefOffset = Buffer.byteLength(document, 'latin1');
  document += 'xref\n0 3\n0000000000 65535 f \n';
  document += `${String(objectOffsets[1]).padStart(10, '0')} 00000 n \n`;
  document += `${String(objectOffsets[2]).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'latin1');
}

function pdfWithXrefStream(): Buffer {
  let prefix = '%PDF-1.7\n';
  const offsets = [0];
  offsets[1] = Buffer.byteLength(prefix, 'latin1');
  prefix += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  offsets[2] = Buffer.byteLength(prefix, 'latin1');
  prefix += '2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n';
  offsets[3] = Buffer.byteLength(prefix, 'latin1');
  const records = Buffer.alloc(4 * 7);
  const entry = (index: number, type: number, field: number, generation: number) => {
    records[index * 7] = type;
    records.writeUInt32BE(field, index * 7 + 1);
    records.writeUInt16BE(generation, index * 7 + 5);
  };
  entry(0, 0, 0, 65_535);
  entry(1, 1, offsets[1], 0);
  entry(2, 1, offsets[2], 0);
  entry(3, 1, offsets[3], 0);
  const compressed = deflateSync(records);
  const suffix = Buffer.concat([
    Buffer.from(
      `3 0 obj\n<< /Type /XRef /Size 4 /Root 1 0 R /W [1 4 2] /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
      'ascii',
    ),
    compressed,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${offsets[3]}\n%%EOF\n`, 'ascii'),
  ]);
  return Buffer.concat([Buffer.from(prefix, 'latin1'), suffix]);
}

function pdfWithCompressedObjects(): Buffer {
  const catalog = '<< /Type /Catalog /Pages 2 0 R >>';
  const pages = '<< /Type /Pages /Count 0 /Kids [] >>';
  const objectHeader = `1 0 2 ${Buffer.byteLength(catalog, 'latin1')} `;
  const objectData = Buffer.from(`${objectHeader}${catalog}${pages}`, 'latin1');
  let prefix = '%PDF-1.7\n';
  const objectStreamOffset = Buffer.byteLength(prefix, 'latin1');
  const compressedObjects = deflateSync(objectData);
  prefix += `3 0 obj\n<< /Type /ObjStm /N 2 /First ${Buffer.byteLength(objectHeader, 'latin1')} /Filter /FlateDecode /Length ${compressedObjects.length} >>\nstream\n`;
  const beforeObjectStream = Buffer.from(prefix, 'latin1');
  const objectStreamSuffix = Buffer.from('\nendstream\nendobj\n', 'ascii');
  const xrefOffset = beforeObjectStream.length + compressedObjects.length + objectStreamSuffix.length;
  const records = Buffer.alloc(5 * 7);
  const entry = (index: number, type: number, field: number, third: number) => {
    records[index * 7] = type;
    records.writeUInt32BE(field, index * 7 + 1);
    records.writeUInt16BE(third, index * 7 + 5);
  };
  entry(0, 0, 0, 65_535);
  entry(1, 2, 3, 0);
  entry(2, 2, 3, 1);
  entry(3, 1, objectStreamOffset, 0);
  entry(4, 1, xrefOffset, 0);
  const compressedXref = deflateSync(records);
  return Buffer.concat([
    beforeObjectStream,
    compressedObjects,
    objectStreamSuffix,
    Buffer.from(
      `4 0 obj\n<< /Type /XRef /Size 5 /Root 1 0 R /W [1 4 2] /Filter /FlateDecode /Length ${compressedXref.length} >>\nstream\n`,
      'ascii',
    ),
    compressedXref,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'ascii'),
  ]);
}

function pdfWithCompressedObjectPayloads(payloadSizes: number[]): Buffer {
  const streamObjectNumbers = payloadSizes.map((_, index) => 10 + index);
  const payloadObjectNumbers = payloadSizes.map((_, index) => 20 + index);
  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
  const streamOffsets = new Map<number, number>();
  let length = chunks[0]!.length;

  payloadSizes.forEach((payloadSize, index) => {
    const objectNumbers = index === 0
      ? [1, 2, payloadObjectNumbers[index]!]
      : [payloadObjectNumbers[index]!];
    const bodies = index === 0
      ? [
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Count 0 /Kids [] >>',
          `<< /Padding (${'.'.repeat(payloadSize)}) >>`,
        ]
      : [`<< /Padding (${'.'.repeat(payloadSize)}) >>`];
    let bodyOffset = 0;
    const header = objectNumbers.map((objectNumber, bodyIndex) => {
      const entry = `${objectNumber} ${bodyOffset}`;
      bodyOffset += Buffer.byteLength(bodies[bodyIndex]!, 'latin1');
      return entry;
    }).join(' ') + ' ';
    const decoded = Buffer.from(`${header}${bodies.join('')}`, 'latin1');
    const compressed = deflateSync(decoded);
    const streamObjectNumber = streamObjectNumbers[index]!;
    streamOffsets.set(streamObjectNumber, length);
    const prefix = Buffer.from(
      `${streamObjectNumber} 0 obj\n<< /Type /ObjStm /N ${objectNumbers.length} /First ${Buffer.byteLength(header, 'latin1')} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
      'latin1',
    );
    const suffix = Buffer.from('\nendstream\nendobj\n', 'latin1');
    chunks.push(prefix, compressed, suffix);
    length += prefix.length + compressed.length + suffix.length;
  });

  const xrefOffset = length;
  const xrefObjectNumber = 30;
  const declaredSize = xrefObjectNumber + 1;
  const records = Buffer.alloc(declaredSize * 7);
  const entry = (objectNumber: number, type: number, field: number, third: number) => {
    records[objectNumber * 7] = type;
    records.writeUInt32BE(field, objectNumber * 7 + 1);
    records.writeUInt16BE(third, objectNumber * 7 + 5);
  };
  entry(0, 0, 0, 65_535);
  streamObjectNumbers.forEach((streamObjectNumber, index) => {
    entry(streamObjectNumber, 1, streamOffsets.get(streamObjectNumber)!, 0);
    if (index === 0) {
      entry(1, 2, streamObjectNumber, 0);
      entry(2, 2, streamObjectNumber, 1);
      entry(payloadObjectNumbers[index]!, 2, streamObjectNumber, 2);
    } else {
      entry(payloadObjectNumbers[index]!, 2, streamObjectNumber, 0);
    }
  });
  entry(xrefObjectNumber, 1, xrefOffset, 0);
  const compressedXref = deflateSync(records);
  return Buffer.concat([
    ...chunks,
    Buffer.from(
      `${xrefObjectNumber} 0 obj\n<< /Type /XRef /Size ${declaredSize} /Root 1 0 R /W [1 4 2] /Filter /FlateDecode /Length ${compressedXref.length} >>\nstream\n`,
      'latin1',
    ),
    compressedXref,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'),
  ]);
}

function mp4(brand = 'isom'): Buffer {
  const box = (type: string, data: Buffer): Buffer => {
    const output = Buffer.alloc(8 + data.length);
    output.writeUInt32BE(output.length, 0);
    output.write(type, 4, 'ascii');
    data.copy(output, 8);
    return output;
  };
  const ftypData = Buffer.alloc(8);
  ftypData.write(brand, 0, 'ascii');
  const ftyp = box('ftyp', ftypData);
  if (brand !== 'isom') return ftyp;
  const media = box('mdat', Buffer.from([1, 2, 3, 4]));
  const sampleSize = Buffer.alloc(12);
  sampleSize.writeUInt32BE(4, 4);
  sampleSize.writeUInt32BE(1, 8);
  const chunkOffset = Buffer.alloc(12);
  chunkOffset.writeUInt32BE(1, 4);
  chunkOffset.writeUInt32BE(ftyp.length + 8, 8);
  const sampleTable = box('stbl', Buffer.concat([box('stsz', sampleSize), box('stco', chunkOffset)]));
  const movie = box('moov', box('trak', box('mdia', box('minf', sampleTable))));
  return Buffer.concat([ftyp, media, movie]);
}

function gif(): Buffer {
  return Buffer.from([
    ...Buffer.from('GIF89a', 'ascii'),
    1, 0, 1, 0, 0, 0, 0,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0,
    2, 2, 0x4c, 0x01, 0,
    0x3b,
  ]);
}

function riff(kind: 'WEBP' | 'WAVE'): Buffer {
  let body: Buffer;
  if (kind === 'WEBP') {
    body = Buffer.concat([Buffer.from('VP8 ', 'ascii'), Buffer.from([1, 0, 0, 0]), Buffer.from([0, 0])]);
  } else {
    const format = Buffer.alloc(24);
    format.write('fmt ', 0, 'ascii');
    format.writeUInt32LE(16, 4);
    format.writeUInt16LE(1, 8);
    format.writeUInt16LE(1, 10);
    format.writeUInt32LE(8_000, 12);
    format.writeUInt32LE(8_000, 16);
    format.writeUInt16LE(1, 20);
    format.writeUInt16LE(8, 22);
    body = Buffer.concat([
      format,
      Buffer.from('data', 'ascii'),
      Buffer.from([2, 0, 0, 0]),
      Buffer.from([0, 0]),
    ]);
  }
  const output = Buffer.alloc(12);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(4 + body.length, 4);
  output.write(kind, 8, 'ascii');
  return Buffer.concat([output, body]);
}

function webm(): Buffer {
  return Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x87,
    0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
    0x18, 0x53, 0x80, 0x67, 0xac,
    0x15, 0x49, 0xa9, 0x66, 0x87,
    0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40,
    0x16, 0x54, 0xae, 0x6b, 0x8c,
    0xae, 0x8a, 0x83, 0x81, 0x01, 0x86, 0x85, 0x56, 0x5f, 0x56, 0x50, 0x38,
    0x1f, 0x43, 0xb6, 0x75, 0x8a,
    0xe7, 0x81, 0x00, 0xa3, 0x85, 0x81, 0x00, 0x00, 0x80, 0x00,
  ]);
}

function mp3(): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00], 0);
  return frame;
}

describe('generic browser MIME verification (DEBT-019)', () => {
  it.each([
    ['empty declaration normalized at the browser boundary', '', png(), 'image/png'],
    ['generic PNG', 'application/octet-stream', png(), 'image/png'],
    ['generic JPEG', 'application/octet-stream', jpeg(), 'image/jpeg'],
    ['generic GIF', 'application/octet-stream', gif(), 'image/gif'],
    ['generic WebP', 'application/octet-stream', riff('WEBP'), 'image/webp'],
    ['generic PDF', 'application/octet-stream', pdf(), 'application/pdf'],
    ['generic PDF xref stream', 'application/octet-stream', pdfWithXrefStream(), 'application/pdf'],
    ['generic PDF compressed object stream', 'application/octet-stream', pdfWithCompressedObjects(), 'application/pdf'],
    ['generic WebM', 'application/octet-stream', webm(), 'video/webm'],
    ['generic MP4', 'application/octet-stream', mp4(), 'video/mp4'],
    ['generic WAV', 'application/octet-stream', riff('WAVE'), 'audio/wav'],
    ['generic MP3', 'application/octet-stream', mp3(), 'audio/mpeg'],
    [
      'generic MP3 with bounded ID3v1 metadata',
      'application/octet-stream',
      Buffer.concat([mp3(), Buffer.from('TAG'), Buffer.alloc(125)]),
      'audio/mpeg',
    ],
    ['generic JSON', 'application/octet-stream', Buffer.from('{"safe":true}'), 'application/json'],
    ['generic JSON containing an MP3 metadata label', 'application/octet-stream', Buffer.from('{"label":"ID3"}'), 'application/json'],
    ['generic text', 'application/octet-stream', Buffer.from('plain UTF-8 text\n'), 'text/plain'],
  ])('accepts %s only as its byte-verified canonical type', (_name, declared, bytes, mime) => {
    expect(verifyUploadHeader(bytes, declared)).toEqual({
      detectedMime: mime,
      quarantineReason: null,
    });
  });

  it.each([
    ['PNG signature only', PNG_SIGNATURE],
    ['JPEG without terminal marker', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02])],
    ['PDF without EOF', Buffer.from('%PDF-1.7\n1 0 obj\n', 'ascii')],
    ['truncated MP4 box', mp4().subarray(0, 12)],
  ])('quarantines truncated %s', (_name, bytes) => {
    expect(verifyUploadHeader(bytes, 'application/octet-stream').quarantineReason).toBe(
      'truncated_or_malformed_content',
    );
  });

  it.each([
    ['PNG', png()],
    ['JPEG', jpeg()],
    ['GIF', gif()],
    ['WebP', riff('WEBP')],
    ['WebM', webm()],
    ['MP4', mp4()],
    ['WAV', riff('WAVE')],
    ['MP3', mp3()],
  ])('rejects truncated and trailing-byte %s containers', (_name, bytes) => {
    expect(verifyUploadHeader(bytes.subarray(0, -1), 'application/octet-stream').quarantineReason)
      .not.toBeNull();
    expect(
      verifyUploadHeader(Buffer.concat([bytes, Buffer.from([0])]), 'application/octet-stream')
        .quarantineReason,
    ).not.toBeNull();
  });

  it('quarantines a generic polyglot even when its leading type is supported', () => {
    const bytes = Buffer.concat([png(), Buffer.alloc(128), Buffer.from('PK\x03\x04', 'binary')]);
    expect(verifyUploadHeader(bytes, 'application/octet-stream').quarantineReason).toBe(
      'ambiguous_polyglot_content',
    );
  });

  it.each([
    ['ZIP/archive', Buffer.from('PK\x03\x04archive', 'binary'), 'archives_not_allowed'],
    ['HEIC', mp4('heic'), 'unsupported_content_type'],
    ['unknown binary', Buffer.from([0, 1, 2, 3, 4, 5]), 'unknown_content_type'],
    ['malformed JSON', Buffer.from('{"cut":'), 'truncated_or_malformed_content'],
    ['binary-control text', Buffer.from('hello\u0001world'), 'unknown_content_type'],
    ['C1-control text', Buffer.from('hello\u0080world'), 'unknown_content_type'],
    [
      'fake PDF trailer',
      Buffer.from('%PDF-1.7\narbitrary\nstartxref\n0\n%%EOF\n', 'ascii'),
      'truncated_or_malformed_content',
    ],
  ])('keeps generic %s fail-closed', (_name, bytes, reason) => {
    expect(verifyUploadHeader(bytes, 'application/octet-stream').quarantineReason).toBe(reason);
  });

  it('does not let generic-declaration support weaken explicit mismatch rejection', () => {
    expect(verifyUploadHeader(jpeg(), 'image/png')).toMatchObject({
      detectedMime: 'image/jpeg',
      quarantineReason: 'declared_content_type_mismatch',
    });
  });

  it.each([
    ['MP4 without a sample table', Buffer.concat([
      Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(4),
      Buffer.from([0, 0, 0, 8]), Buffer.from('moov', 'ascii'),
      Buffer.from([0, 0, 0, 8]), Buffer.from('mdat', 'ascii'),
    ])],
    ['WebM containing only a Void element', Buffer.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
      0x18, 0x53, 0x80, 0x67, 0x82, 0xec, 0x80,
    ])],
  ])('rejects structurally empty %s', (_name, bytes) => {
    expect(verifyUploadHeader(bytes, 'application/octet-stream').quarantineReason).toBe(
      'truncated_or_malformed_content',
    );
  });

  it.each([
    ['encrypted PDF', Buffer.from(pdf().toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R'), 'latin1')],
    ['incremental PDF', Buffer.from(pdf().toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Prev 12'), 'latin1')],
  ])('keeps unsupported %s fail-closed', (_name, bytes) => {
    expect(verifyUploadHeader(bytes, 'application/pdf').quarantineReason).toBe(
      'truncated_or_malformed_content',
    );
  });

  it('quarantines a compressed PDF object stream whose decoded size exceeds the file budget', () => {
    const bytes = pdfWithCompressedObjectPayloads([2 * 1024 * 1024]);
    expect(bytes.length).toBeLessThan(32 * 1024);
    expect(verifyUploadHeader(bytes, 'application/pdf').quarantineReason).toBe(
      'truncated_or_malformed_content',
    );
  });

  it('shares one cumulative decode budget across distinct compressed PDF object streams', () => {
    const bytes = pdfWithCompressedObjectPayloads([700 * 1024, 700 * 1024]);
    expect(bytes.length).toBeLessThan(32 * 1024);
    expect(verifyUploadHeader(bytes, 'application/pdf').quarantineReason).toBe(
      'truncated_or_malformed_content',
    );
  });
});
