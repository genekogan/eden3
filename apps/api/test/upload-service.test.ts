import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  InMemoryUploadRepository,
  type UploadInspection,
} from '../src/services/upload-repository';
import {
  UploadService,
  type MultipartUploadBackend,
  type UploadedPartResult,
} from '../src/services/upload-service';
import { UploadPolicyEventWorker } from '../src/services/upload-policy-events';

const OWNER_A = '00000000-0000-4000-8000-00000000000a';
const OWNER_B = '00000000-0000-4000-8000-00000000000b';
const CAPABILITY_KEY = Buffer.alloc(32, 7);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

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

function benignPng(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.from([0])),
    pngChunk('IEND'),
  ]);
}

class MemoryMultipartBackend implements MultipartUploadBackend {
  readonly parts = new Map<string, Map<number, Buffer>>();
  readonly objects = new Map<string, Buffer>();
  completeCalls = 0;
  signedInputs: Array<{ partNumber: number; sizeBytes: number; checksumSha256?: string }> = [];

  async createMultipart(input: { key: string }): Promise<{ backendUploadId: string }> {
    const id = `backend:${input.key}`;
    this.parts.set(id, new Map());
    return { backendUploadId: id };
  }

  async signPart(input: { partNumber: number; sizeBytes: number; checksumSha256?: string }): Promise<{ url: string; headers: Record<string, string> }> {
    this.signedInputs.push(input);
    return { url: `https://objects.invalid/part/${input.partNumber}`, headers: {} };
  }

  async putPart(input: {
    key: string;
    backendUploadId: string;
    partNumber: number;
    bytes: Buffer;
  }): Promise<UploadedPartResult> {
    this.parts.get(input.backendUploadId)!.set(input.partNumber, Buffer.from(input.bytes));
    return {
      etag: `etag-${input.partNumber}-${sha256(input.bytes).slice(0, 8)}`,
      checksumSha256: sha256(input.bytes),
      sizeBytes: input.bytes.length,
    };
  }

  async completeMultipart(input: {
    key: string;
    backendUploadId: string;
    parts: Array<{ partNumber: number }>;
  }): Promise<void> {
    this.completeCalls += 1;
    const stored = this.parts.get(input.backendUploadId)!;
    this.objects.set(
      input.key,
      Buffer.concat(input.parts.map(({ partNumber }) => stored.get(partNumber)!)),
    );
  }

  async inspectObject(input: { key: string }): Promise<UploadInspection | null> {
    const bytes = this.objects.get(input.key);
    if (!bytes) return null;
    return {
      sizeBytes: bytes.length,
      checksumSha256: sha256(bytes),
      header: bytes.subarray(0, 512 * 1024),
      policyBytes: bytes,
    };
  }

  async listParts(input: { backendUploadId: string }) {
    return [...(this.parts.get(input.backendUploadId)?.entries() ?? [])].map(([partNumber, bytes]) => ({
      partNumber,
      etag: `etag-${partNumber}-${sha256(bytes).slice(0, 8)}`,
      checksumSha256: sha256(bytes),
      sizeBytes: bytes.length,
    }));
  }

  async abortMultipart(): Promise<void> {}
}

function service(
  now = () => new Date('2026-08-08T12:00:00.000Z'),
  options: Partial<ConstructorParameters<typeof UploadService>[0]> = {},
) {
  const repository = new InMemoryUploadRepository();
  const backend = new MemoryMultipartBackend();
  return {
    repository,
    backend,
    service: new UploadService({
      repository,
      backend,
      capabilityKey: CAPABILITY_KEY,
      now,
      backingStore: 'local',
      securityMode: 'test',
      ...options,
    }),
  };
}

async function reserveAndPut(
  uploadService: UploadService,
  ownerAccountId: string,
  bytes: Buffer,
  mime = 'text/plain',
) {
  const reservation = await uploadService.initiate(ownerAccountId, {
    displayName: 'fixture.txt',
    purpose: 'chat',
    declaredSizeBytes: bytes.length,
    declaredMime: mime,
    declaredSha256: sha256(bytes),
    partSizeBytes: Math.max(1, bytes.length),
  });
  const signed = await uploadService.signPart(ownerAccountId, reservation.uploadId, 1, {
    checksumSha256: sha256(bytes),
  });
  await uploadService.putLocalPart(signed.requiredHeaders['x-eden-upload-capability']!, bytes);
  return reservation;
}

describe('upload.resumable@v1 security boundary', () => {
  it('refuses production construction without both policy scanning and durable delivery', () => {
    expect(() => new UploadService({
      repository: new InMemoryUploadRepository(),
      backend: new MemoryMultipartBackend(),
      capabilityKey: CAPABILITY_KEY,
    })).toThrow('Production uploads require');
  });

  it('accepts a benign control, verifies full bytes, and completes exactly once', async () => {
    const { service: uploadService, backend } = service();
    const bytes = Buffer.from('a harmless text upload\n');
    const reservation = await reserveAndPut(uploadService, OWNER_A, bytes);

    const completed = await uploadService.complete(OWNER_A, reservation.uploadId);
    const replay = await uploadService.complete(OWNER_A, reservation.uploadId);

    expect(completed.object).toMatchObject({
      id: reservation.objectId,
      state: 'available',
      verifiedSizeBytes: bytes.length,
      verifiedSha256: sha256(bytes),
      verifiedMime: 'text/plain',
      url: `/media/${reservation.objectId}`,
    });
    expect(replay).toEqual(completed);
    expect(backend.completeCalls).toBe(1);
  });

  it('promotes a generic browser declaration only with its canonical byte-verified MIME', async () => {
    let scannedMime: string | null = null;
    const { service: uploadService } = service(
      () => new Date('2026-08-08T12:00:00.000Z'),
      {
        policyScanner: async ({ mime }) => {
          scannedMime = mime;
          return { quarantineReason: null };
        },
      },
    );
    const bytes = benignPng();
    const reservation = await reserveAndPut(
      uploadService,
      OWNER_A,
      bytes,
      'application/octet-stream',
    );
    const completed = await uploadService.complete(OWNER_A, reservation.uploadId);
    expect(completed.object).toMatchObject({
      state: 'available',
      verifiedMime: 'image/png',
      verifiedSizeBytes: bytes.length,
      verifiedSha256: sha256(bytes),
    });
    expect(scannedMime).toBe('image/png');
    expect((await uploadService.status(OWNER_A, reservation.uploadId)).declaredMime).toBe(
      'application/octet-stream',
    );
  });

  it('recovers after provider completion succeeds but the process dies before the DB terminal write', async () => {
    const repository = new InMemoryUploadRepository();
    const backend = new MemoryMultipartBackend();
    const first = new UploadService({ repository, backend, capabilityKey: CAPABILITY_KEY, backingStore: 'local', securityMode: 'test' });
    const bytes = Buffer.from('restart-safe');
    const reservation = await reserveAndPut(first, OWNER_A, bytes);
    const originalMark = repository.markAssemblyCompleted.bind(repository);
    let crashOnce = true;
    repository.markAssemblyCompleted = async (...args) => {
      if (crashOnce) {
        crashOnce = false;
        throw new Error('simulated process death after provider completion');
      }
      return originalMark(...args);
    };
    await expect(first.complete(OWNER_A, reservation.uploadId)).rejects.toThrow('simulated process death');
    expect(backend.completeCalls).toBe(1);

    const restarted = new UploadService({ repository, backend, capabilityKey: CAPABILITY_KEY, backingStore: 'local', securityMode: 'test' });
    const completion = await restarted.complete(OWNER_A, reservation.uploadId);
    expect(completion.object).toMatchObject({ id: reservation.objectId, state: 'available' });
    expect(backend.completeCalls).toBe(1);
  });

  it('quarantines checksum mismatch and never exposes a serving URL', async () => {
    const { service: uploadService } = service();
    const declared = Buffer.from('expected');
    const uploaded = Buffer.from('tampered');
    const reservation = await uploadService.initiate(OWNER_A, {
      displayName: 'fixture.txt',
      purpose: 'skill-asset',
      declaredSizeBytes: uploaded.length,
      declaredMime: 'text/plain',
      declaredSha256: sha256(declared),
      partSizeBytes: uploaded.length,
    });
    const signed = await uploadService.signPart(OWNER_A, reservation.uploadId, 1, {
      checksumSha256: sha256(uploaded),
    });
    await uploadService.putLocalPart(signed.requiredHeaders['x-eden-upload-capability']!, uploaded);

    await expect(uploadService.complete(OWNER_A, reservation.uploadId)).rejects.toMatchObject({
      code: 'upload_quarantined',
    });
    const status = await uploadService.status(OWNER_A, reservation.uploadId);
    expect(status.state).toBe('completed');
    expect(status.objectState).toBe('quarantined');
    expect(status.objectUrl).toBeNull();
  });

  it.each([
    {
      name: 'declared-type mismatch',
      mime: 'image/png',
      bytes: Buffer.from('plain text wearing a png label'),
    },
    {
      name: 'polyglot signatures',
      mime: 'image/png',
      bytes: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(32),
        Buffer.from('PK\x03\x04', 'binary'),
      ]),
    },
    {
      name: 'archive expansion bomb indicator',
      mime: 'application/zip',
      bytes: (() => {
        const zip = Buffer.alloc(30);
        zip.writeUInt32LE(0x04034b50, 0);
        zip.writeUInt32LE(1, 18);
        zip.writeUInt32LE(200_000_000, 22);
        return zip;
      })(),
    },
    {
      name: 'truncated archive body',
      mime: 'application/zip',
      bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
    },
    {
      name: 'archive central-directory traversal',
      mime: 'application/zip',
      bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('../escape')]),
    },
    {
      name: 'archive symlink entry',
      mime: 'application/zip',
      bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('symlink-mode-a000')]),
    },
  ])('quarantines $name before serving', async ({ bytes, mime }) => {
    const { service: uploadService } = service();
    const reservation = await reserveAndPut(uploadService, OWNER_A, bytes, mime);
    await expect(uploadService.complete(OWNER_A, reservation.uploadId)).rejects.toMatchObject({
      code: 'upload_quarantined',
      message: 'Upload quarantined',
    });
    expect((await uploadService.status(OWNER_A, reservation.uploadId)).objectUrl).toBeNull();
  });

  it('rejects declared and actual oversize payloads', async () => {
    const { service: uploadService } = service();
    await expect(
      uploadService.initiate(OWNER_A, {
        displayName: 'huge.bin',
        purpose: 'chat',
        declaredSizeBytes: UploadService.MAX_OBJECT_BYTES + 1,
        declaredMime: 'application/octet-stream',
        declaredSha256: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'upload_too_large' });

    const reservation = await uploadService.initiate(OWNER_A, {
      displayName: 'small.txt',
      purpose: 'chat',
      declaredSizeBytes: 3,
      declaredMime: 'text/plain',
      declaredSha256: sha256(Buffer.from('abc')),
      partSizeBytes: 3,
    });
    const signed = await uploadService.signPart(OWNER_A, reservation.uploadId, 1, {
      checksumSha256: sha256(Buffer.from('abc')),
    });
    await expect(uploadService.putLocalPart(signed.requiredHeaders['x-eden-upload-capability']!, Buffer.from('abcd'))).rejects.toMatchObject({
      code: 'part_size_mismatch',
    });
  });

  it('rejects missing or inconsistent multipart completion', async () => {
    const { service: uploadService } = service();
    const bytes = Buffer.from('abcdef');
    const reservation = await uploadService.initiate(OWNER_A, {
      displayName: 'two-parts.txt',
      purpose: 'training-set',
      declaredSizeBytes: bytes.length,
      declaredMime: 'text/plain',
      declaredSha256: sha256(bytes),
      partSizeBytes: 3,
    });
    const firstPart = bytes.subarray(0, 3);
    const signed = await uploadService.signPart(OWNER_A, reservation.uploadId, 1, {
      checksumSha256: sha256(firstPart),
    });
    await uploadService.putLocalPart(signed.requiredHeaders['x-eden-upload-capability']!, firstPart);
    await expect(uploadService.complete(OWNER_A, reservation.uploadId)).rejects.toMatchObject({
      code: 'upload_incomplete',
    });
    expect((await uploadService.status(OWNER_A, reservation.uploadId)).nextOffset).toBe(3);
  });

  it('rejects expired, tampered, and replayed part capabilities', async () => {
    let now = new Date('2026-08-08T12:00:00.000Z');
    const { service: uploadService } = service(() => now);
    const bytes = Buffer.from('abc');
    const reservation = await uploadService.initiate(OWNER_A, {
      displayName: 'fixture.txt',
      purpose: 'chat',
      declaredSizeBytes: 3,
      declaredMime: 'text/plain',
      declaredSha256: sha256(bytes),
      partSizeBytes: 3,
    });
    const signed = await uploadService.signPart(OWNER_A, reservation.uploadId, 1, {
      checksumSha256: sha256(bytes),
    });
    const capability = signed.requiredHeaders['x-eden-upload-capability']!;
    await expect(uploadService.putLocalPart(`${capability}x`, bytes)).rejects.toMatchObject({
      code: 'invalid_upload_capability',
    });
    now = new Date('2026-08-08T12:10:00.000Z');
    await expect(uploadService.putLocalPart(capability, bytes)).rejects.toMatchObject({
      code: 'expired_upload_capability',
    });
    now = new Date('2026-08-08T12:00:30.000Z');
    const refreshed = await uploadService.signPart(OWNER_A, reservation.uploadId, 1, {
      checksumSha256: sha256(bytes),
    });
    const refreshedCapability = refreshed.requiredHeaders['x-eden-upload-capability']!;
    await uploadService.putLocalPart(refreshedCapability, bytes);
    await expect(uploadService.putLocalPart(refreshedCapability, bytes)).rejects.toMatchObject({
      code: 'part_already_uploaded',
    });
  });

  it('serializes concurrent local capability replay before a second backend mutation', async () => {
    const { service: uploadService, backend } = service();
    const bytes = Buffer.from('race');
    const reservation = await uploadService.initiate(OWNER_A, {
      displayName: 'race.txt',
      purpose: 'chat',
      declaredSizeBytes: bytes.length,
      declaredMime: 'text/plain',
      declaredSha256: sha256(bytes),
      partSizeBytes: bytes.length,
    });
    const signed = await uploadService.signPart(OWNER_A, reservation.uploadId, 1, {
      checksumSha256: sha256(bytes),
    });
    const capability = signed.requiredHeaders['x-eden-upload-capability']!;
    let releasesWrite!: () => void;
    let writeStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releasesWrite = resolve; });
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    const original = backend.putPart.bind(backend);
    let writes = 0;
    backend.putPart = async (input) => {
      writes += 1;
      writeStarted();
      await gate;
      return original(input);
    };
    const first = uploadService.putLocalPart(capability, bytes);
    await started;
    const second = uploadService.putLocalPart(capability, bytes);
    releasesWrite();
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(writes).toBe(1);
  });

  it('durably chooses one checksum across service instances before local bytes reach the backend', async () => {
    const repository = new InMemoryUploadRepository();
    const backend = new MemoryMultipartBackend();
    const makeService = () => new UploadService({
      repository,
      backend,
      capabilityKey: CAPABILITY_KEY,
      backingStore: 'local',
      securityMode: 'test',
    });
    const first = makeService();
    const second = makeService();
    const winnerCandidate = Buffer.from('first');
    const loserCandidate = Buffer.from('other');
    const reservation = await first.initiate(OWNER_A, {
      displayName: 'concurrent.txt',
      purpose: 'chat',
      declaredSizeBytes: winnerCandidate.length,
      declaredMime: 'text/plain',
      declaredSha256: sha256(winnerCandidate),
      partSizeBytes: winnerCandidate.length,
    });
    const attempts = await Promise.allSettled([
      first.signPart(OWNER_A, reservation.uploadId, 1, { checksumSha256: sha256(winnerCandidate) }),
      second.signPart(OWNER_A, reservation.uploadId, 1, { checksumSha256: sha256(loserCandidate) }),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(backend.signedInputs).toHaveLength(1);
    const firstWon = attempts[0]!.status === 'fulfilled';
    const signed = (firstWon ? attempts[0] : attempts[1]) as PromiseFulfilledResult<Awaited<ReturnType<UploadService['signPart']>>>;
    const capability = signed.value.requiredHeaders['x-eden-upload-capability']!;
    const acceptedBytes = firstWon ? winnerCandidate : loserCandidate;
    const rejectedBytes = firstWon ? loserCandidate : winnerCandidate;
    await expect(first.putLocalPart(capability, rejectedBytes)).rejects.toMatchObject({
      code: 'part_authorization_mismatch',
    });
    expect([...backend.parts.values()][0]).toHaveLength(0);
    await first.putLocalPart(capability, acceptedBytes);
    expect([...backend.parts.values()][0]).toHaveLength(1);
  });

  it('records direct backend parts only from provider-observed size and checksum', async () => {
    const { service: uploadService, backend } = service(undefined, { backingStore: 'r2' });
    const bytes = Buffer.from('direct');
    const reservation = await uploadService.initiate(OWNER_A, {
      displayName: 'direct.txt',
      purpose: 'chat',
      declaredSizeBytes: bytes.length,
      declaredMime: 'text/plain',
      declaredSha256: sha256(bytes),
      partSizeBytes: bytes.length,
    });
    const upload = await uploadService.status(OWNER_A, reservation.uploadId);
    const authorized = await uploadService.signPart(OWNER_A, reservation.uploadId, 1, {
      checksumSha256: sha256(bytes),
    });
    expect(authorized.url).not.toContain('token');
    expect(authorized.requiredHeaders['x-eden-upload-capability']).toBeUndefined();
    expect(backend.signedInputs.at(-1)).toMatchObject({
      partNumber: 1,
      sizeBytes: bytes.length,
      checksumSha256: sha256(bytes),
    });
    await expect(
      uploadService.signPart(OWNER_A, reservation.uploadId, 1, {
        checksumSha256: sha256(Buffer.from('changed')),
      }),
    ).rejects.toMatchObject({ code: 'part_authorization_conflict' });
    expect(backend.signedInputs).toHaveLength(1);
    await backend.putPart({
      key: `objects/${reservation.objectId.slice(0, 2)}/${reservation.objectId}`,
      backendUploadId: `backend:objects/${reservation.objectId.slice(0, 2)}/${reservation.objectId}`,
      partNumber: 1,
      bytes,
    });
    expect(upload.completedParts).toEqual([]);
    await expect(
      uploadService.confirmDirectPart(OWNER_A, reservation.uploadId, 1, sha256(Buffer.from('lie'))),
    ).rejects.toMatchObject({ code: 'part_not_authorized' });
    const confirmed = await uploadService.confirmDirectPart(
      OWNER_A,
      reservation.uploadId,
      1,
      sha256(bytes),
    );
    expect(confirmed).toMatchObject({ partNumber: 1, sizeBytes: bytes.length, checksumSha256: sha256(bytes) });
    expect((await uploadService.status(OWNER_A, reservation.uploadId)).nextOffset).toBe(bytes.length);
  });

  it('quarantines a synthetic policy flag and emits the operator/audit event without retaining a fixture', async () => {
    const repository = new InMemoryUploadRepository();
    const backend = new MemoryMultipartBackend();
    const events: Array<{ eventId: string; objectId: string; policyCode: string }> = [];
    const worker = new UploadPolicyEventWorker({
      store: repository,
      sink: { deliver: async (event) => { events.push(event); } },
    });
    const uploadService = new UploadService({
      repository,
      backend,
      capabilityKey: CAPABILITY_KEY,
      backingStore: 'local',
      policyScanner: async ({ sha256: observed }) => ({
        quarantineReason: observed ? 'synthetic_policy_match' : null,
      }),
      policyEventWorker: worker,
    });
    const bytes = Buffer.from('synthetic-safe-marker');
    const reservation = await reserveAndPut(uploadService, OWNER_A, bytes);
    await expect(uploadService.complete(OWNER_A, reservation.uploadId)).rejects.toMatchObject({
      code: 'upload_quarantined',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      objectId: reservation.objectId,
      policyCode: 'synthetic_policy_match',
    });
    expect(Object.keys(events[0]!)).toEqual(['eventId', 'objectId', 'ownerAccountId', 'policyCode']);
    expect((await uploadService.status(OWNER_A, reservation.uploadId)).objectUrl).toBeNull();
  });

  it('gives the mandatory scanner bytes beyond the bounded type header', async () => {
    const repository = new InMemoryUploadRepository();
    const backend = new MemoryMultipartBackend();
    const worker = new UploadPolicyEventWorker({
      store: repository,
      sink: { deliver: async () => undefined },
    });
    const marker = Buffer.from('tail-policy-marker');
    const bytes = Buffer.alloc(600 * 1024, 0x61);
    marker.copy(bytes, bytes.length - marker.length);
    let scannedBytes = 0;
    const uploadService = new UploadService({
      repository,
      backend,
      capabilityKey: CAPABILITY_KEY,
      backingStore: 'local',
      policyEventWorker: worker,
      policyScanner: async ({ bytes: fullBytes }) => {
        scannedBytes = fullBytes.length;
        return {
          quarantineReason: fullBytes.subarray(512 * 1024).includes(marker)
            ? 'synthetic_tail_policy_match'
            : null,
        };
      },
    });
    const reservation = await reserveAndPut(uploadService, OWNER_A, bytes);
    await expect(uploadService.complete(OWNER_A, reservation.uploadId)).rejects.toMatchObject({
      code: 'upload_quarantined',
    });
    expect(scannedBytes).toBe(bytes.length);
    expect((await uploadService.status(OWNER_A, reservation.uploadId)).objectUrl).toBeNull();
  });

  it('retries the same durable policy event after delivery failure without content in the event', async () => {
    let now = new Date('2026-08-08T12:00:00.000Z');
    const repository = new InMemoryUploadRepository();
    const backend = new MemoryMultipartBackend();
    const deliveries: string[] = [];
    let fail = true;
    const worker = new UploadPolicyEventWorker({
      store: repository,
      now: () => now,
      retryBaseMs: 1_000,
      sink: {
        deliver: async (event) => {
          deliveries.push(event.eventId);
          if (fail) throw new Error('simulated notification outage');
        },
      },
    });
    const makeService = () => new UploadService({
      repository,
      backend,
      capabilityKey: CAPABILITY_KEY,
      backingStore: 'local',
      now: () => now,
      policyScanner: async () => ({ quarantineReason: 'synthetic_policy_match' }),
      policyEventWorker: worker,
    });
    const first = makeService();
    const reservation = await reserveAndPut(first, OWNER_A, Buffer.from('synthetic-marker'));
    await expect(first.complete(OWNER_A, reservation.uploadId)).rejects.toMatchObject({
      code: 'upload_quarantined',
    });
    expect([...repository.policyEvents.values()][0]).toMatchObject({ state: 'pending', attemptCount: 1 });

    fail = false;
    now = new Date(now.getTime() + 1_000);
    await expect(makeService().complete(OWNER_A, reservation.uploadId)).rejects.toMatchObject({
      code: 'upload_quarantined',
    });
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries).size).toBe(1);
    expect([...repository.policyEvents.values()][0]).toMatchObject({ state: 'delivered', attemptCount: 2 });
  });

  it('makes tenant B unable to inspect, sign, complete, abort, or overwrite tenant A', async () => {
    const { service: uploadService } = service();
    const bytes = Buffer.from('private');
    const reservation = await uploadService.initiate(OWNER_A, {
      displayName: 'private.txt',
      purpose: 'chat',
      declaredSizeBytes: bytes.length,
      declaredMime: 'text/plain',
      declaredSha256: sha256(bytes),
      partSizeBytes: bytes.length,
    });
    const signed = await uploadService.signPart(OWNER_A, reservation.uploadId, 1, {
      checksumSha256: sha256(bytes),
    });

    for (const action of [
      () => uploadService.status(OWNER_B, reservation.uploadId),
      () => uploadService.signPart(OWNER_B, reservation.uploadId, 1, { checksumSha256: sha256(bytes) }),
      () => uploadService.complete(OWNER_B, reservation.uploadId),
      () => uploadService.abort(OWNER_B, reservation.uploadId),
      () => uploadService.confirmDirectPart(OWNER_B, reservation.uploadId, 1, sha256(bytes)),
    ]) {
      await expect(action()).rejects.toMatchObject({ code: 'upload_not_found' });
    }
    await expect(
      uploadService.putLocalPart(signed.requiredHeaders['x-eden-upload-capability']!, bytes, { authenticatedAccountId: OWNER_B }),
    ).rejects.toMatchObject({ code: 'upload_not_found' });
  });
});
