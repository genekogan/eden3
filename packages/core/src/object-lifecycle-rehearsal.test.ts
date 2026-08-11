import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalObjectBackend,
  objectKey,
  type ObjectBackend,
  type ObjectGetResult,
  type ObjectHead,
} from './media-store';
import {
  OBJECT_LIFECYCLE_REHEARSAL_SCHEMA,
  ObjectLifecycleRehearsalError,
  runObjectLifecycleRehearsal,
} from './object-lifecycle-rehearsal';

const roots: string[] = [];
const objectId = '018f5e2d-4c3b-7a89-8def-0123456789ab';

async function root(label: string): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), `eden3-${label}-`));
  roots.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function splitAuthorities(delegate: LocalObjectBackend) {
  const calls = { puts: 0, deletes: 0, gets: 0, heads: 0 };
  const writer = {
    put: async (...args: Parameters<ObjectBackend['put']>) => {
      calls.puts += 1;
      return delegate.put(...args);
    },
    delete: async (...args: Parameters<ObjectBackend['delete']>) => {
      calls.deletes += 1;
      return delegate.delete(...args);
    },
  };
  const reader: ObjectBackend = {
    put: async () => { throw new Error('reader mutation forbidden'); },
    delete: async () => { throw new Error('reader mutation forbidden'); },
    get: async (key: string): Promise<ObjectGetResult> => {
      calls.gets += 1;
      return delegate.get(key);
    },
    head: async (key: string): Promise<ObjectHead | null> => {
      calls.heads += 1;
      return delegate.head(key);
    },
    createMultipart: async () => { throw new Error('reader mutation forbidden'); },
    uploadPart: async () => { throw new Error('reader mutation forbidden'); },
    listParts: async () => { throw new Error('reader mutation forbidden'); },
    presignUploadPart: async () => { throw new Error('reader mutation forbidden'); },
    completeMultipart: async () => { throw new Error('reader mutation forbidden'); },
    abortMultipart: async () => { throw new Error('reader mutation forbidden'); },
  };
  return { writer, reader, calls };
}

describe('object lifecycle rehearsal', () => {
  it('uses split authorities and proves remote, cache, and sandbox terminal absence', async () => {
    const objectRoot = await root('object-root');
    const cacheRoot = await root('object-cache');
    const sandboxRoot = await root('object-sandbox');
    const backend = new LocalObjectBackend({ root: objectRoot });
    const { writer, reader, calls } = splitAuthorities(backend);
    const bytes = Buffer.from('split-authority hydration rehearsal');

    const receipt = await runObjectLifecycleRehearsal({
      writer,
      reader,
      objectId,
      body: bytes,
      cacheRoot,
      sandboxRoot,
    });

    expect(receipt).toMatchObject({
      schemaVersion: OBJECT_LIFECYCLE_REHEARSAL_SCHEMA,
      status: 'passed',
      sizeBytes: bytes.length,
      terminalRemoteAbsent: true,
      terminalCacheAbsent: true,
      terminalSandboxAbsent: true,
    });
    expect(calls).toEqual({ puts: 1, deletes: 1, gets: 1, heads: 2 });
    await expect(backend.head(objectKey(objectId))).resolves.toBeNull();
    await expect(access(path.join(cacheRoot, objectId.slice(0, 2), objectId))).rejects.toThrow();
    await expect(access(path.join(sandboxRoot, 'media', objectId))).rejects.toThrow();
  });

  it('removes a possibly written object when hydration returns corrupt bytes', async () => {
    const objectRoot = await root('object-root');
    const cacheRoot = await root('object-cache');
    const sandboxRoot = await root('object-sandbox');
    const backend = new LocalObjectBackend({ root: objectRoot });
    const { writer, reader, calls } = splitAuthorities(backend);
    reader.get = async (key: string) => {
      calls.gets += 1;
      const result = await backend.get(key);
      return { ...result, body: Buffer.from('corrupt') };
    };

    await expect(runObjectLifecycleRehearsal({
      writer,
      reader,
      objectId,
      body: Buffer.from('expected'),
      cacheRoot,
      sandboxRoot,
    })).rejects.toThrow(/checksum/i);

    expect(calls.puts).toBe(1);
    expect(calls.deletes).toBe(1);
    await expect(backend.head(objectKey(objectId))).resolves.toBeNull();
    await expect(readFile(path.join(cacheRoot, objectId.slice(0, 2), objectId))).rejects.toThrow();
  });

  it('surfaces cleanup failure as the terminal fail-closed result', async () => {
    const objectRoot = await root('object-root');
    const backend = new LocalObjectBackend({ root: objectRoot });
    const { writer, reader } = splitAuthorities(backend);
    writer.delete = async () => { throw new Error('synthetic secret cleanup detail'); };
    reader.get = async () => { throw new Error('primary hydration failure'); };

    await expect(runObjectLifecycleRehearsal({
      writer,
      reader,
      objectId,
      cacheRoot: await root('object-cache'),
      sandboxRoot: await root('object-sandbox'),
    })).rejects.toEqual(new ObjectLifecycleRehearsalError('r2_object_cleanup_failed'));
  });
});
