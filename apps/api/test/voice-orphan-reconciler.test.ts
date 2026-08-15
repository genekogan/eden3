import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

import { VoiceKernel } from '../src/services/voice-kernel';

const roots: string[] = [];
const dialect = new PgDialect();
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function kernel(root: string, referenced = false) {
  const execute = vi.fn(async (statement: unknown) => {
    const query = dialect.sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]).sql;
    return query.includes('select exists') ? [{ referenced }] : [];
  });
  const transaction = vi.fn(async (callback: (tx: { execute: typeof execute }) => unknown) => callback({ execute }));
  return new VoiceKernel({
    db: { execute, transaction } as never,
    mediaStore: { put: vi.fn() } as never,
    audio: {} as never,
    providers: {},
    cleanupArtifact: vi.fn(),
    voiceOutputRoot: root,
  });
}

const synthInput = {
  ownerAccountId: '11111111-1111-4111-8111-111111111111',
  operation: 'preview' as const,
  voiceId: 'deepinfra:kokoro:af_bella:v1',
  quoteId: '22222222-2222-4222-8222-222222222222',
  text: 'hello',
  idempotencyKey: '33333333-3333-4333-8333-333333333333',
};

describe('private voice orphan reconciliation', () => {
  it('removes canonical and crash-temp files only when no execution references them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-voice-orphans-'));
    roots.push(root);
    const sha = 'a'.repeat(64);
    const canonical = path.join(root, `${sha}.ogg`);
    const temporary = path.join(root, `.${sha}.ogg.123.${randomUUID()}.tmp`);
    await Promise.all([writeFile(canonical, 'orphan'), writeFile(temporary, 'partial')]);
    const first = kernel(root);
    await expect(first.reconcileOrphanedOutputs()).resolves.toBe(2);
    await expect(readFile(canonical)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves every referenced execution status and is idempotent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-voice-orphans-'));
    roots.push(root);
    const file = path.join(root, `${'b'.repeat(64)}.mp3`);
    await writeFile(file, 'referenced');
    await expect(kernel(root, true).reconcileOrphanedOutputs()).resolves.toBe(0);
    expect(await readFile(file, 'utf8')).toBe('referenced');
    await expect(kernel(root).reconcileOrphanedOutputs()).resolves.toBe(1);
    await expect(kernel(root).reconcileOrphanedOutputs()).resolves.toBe(0);
  });

  it('deletes a crash temp even when the same digest has a live canonical execution', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-voice-orphans-'));
    roots.push(root);
    const sha = 'c'.repeat(64);
    const canonical = path.join(root, `${sha}.ogg`);
    const temporary = path.join(root, `.${sha}.ogg.456.${randomUUID()}.tmp`);
    await Promise.all([writeFile(canonical, 'live'), writeFile(temporary, 'stale temp')]);
    const execute = vi.fn(async (statement: unknown) => {
      const query = dialect.sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]).sql;
      if (!query.includes('select exists')) return [];
      return [{ referenced: query.includes('output_sha256') }];
    });
    const transaction = vi.fn(async (callback: (tx: { execute: typeof execute }) => unknown) => callback({ execute }));
    const subject = new VoiceKernel({
      db: { execute, transaction } as never,
      mediaStore: { put: vi.fn() } as never,
      audio: {} as never,
      providers: {},
      cleanupArtifact: vi.fn(),
      voiceOutputRoot: root,
    });
    await expect(subject.reconcileOrphanedOutputs()).resolves.toBe(1);
    expect(await readFile(canonical, 'utf8')).toBe('live');
    await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let stale failed execution metadata retain a later orphan with the same digest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-voice-orphans-'));
    roots.push(root);
    const sha = 'e'.repeat(64);
    const canonical = path.join(root, `${sha}.ogg`);
    await writeFile(canonical, 'rolled back publication');
    const execute = vi.fn(async (statement: unknown) => {
      const query = dialect.sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]).sql;
      if (query.includes('select output_local_path')) {
        expect(query).toContain("status<>'failed'");
        return [];
      }
      if (query.includes('select exists')) {
        expect(query).toContain("status<>'failed'");
        return [{ referenced: false }];
      }
      return [];
    });
    const transaction = vi.fn(async (callback: (tx: { execute: typeof execute }) => unknown) => callback({ execute }));
    const subject = new VoiceKernel({
      db: { execute, transaction } as never,
      mediaStore: { put: vi.fn() } as never,
      audio: {} as never,
      providers: {},
      cleanupArtifact: vi.fn(),
      voiceOutputRoot: root,
    });
    await expect(subject.reconcileOrphanedOutputs()).resolves.toBe(1);
    await expect(readFile(canonical)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on unknown files instead of silently ignoring private custody', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-voice-orphans-'));
    roots.push(root);
    await writeFile(path.join(root, 'unknown.txt'), 'unexpected');
    await expect(kernel(root).reconcileOrphanedOutputs()).rejects.toThrow(/unknown file/);
  });

  it('runs orphan custody even when refund and row cleanup both fail', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-voice-orphans-'));
    roots.push(root);
    const subject = kernel(root);
    const fail = vi.spyOn(subject as never, 'failExecution' as never).mockRejectedValue(new Error('database unavailable') as never);
    const cleanup = vi.spyOn(subject as never, 'cleanupFailedArtifact' as never).mockRejectedValue(new Error('row unavailable') as never);
    const reconcile = vi.spyOn(subject, 'reconcileOrphanedOutputs').mockResolvedValue(1);

    await expect((subject as unknown as {
      recoverFailedExecution(executionId: string, reservationKey: string, code: string): Promise<void>;
    }).recoverFailedExecution('execution', 'reservation', 'publication_failed')).resolves.toBeUndefined();
    expect(fail).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('keeps a failed writer dirty even when an unrelated writer succeeds afterward', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-voice-orphans-'));
    roots.push(root);
    const transaction = vi.fn(async () => { throw new Error('admission reached'); });
    const provider = { provider: 'deepinfra' as const, synthesize: vi.fn() };
    const subject = new VoiceKernel({
      db: { execute: vi.fn(async () => []), transaction } as never,
      mediaStore: { put: vi.fn() } as never,
      audio: {} as never,
      providers: { deepinfra: provider },
      cleanupArtifact: vi.fn(),
      voiceOutputRoot: root,
    });
    await subject.reconcileOrphanedOutputs();
    const state = subject as unknown as {
      privateOutputDirty: boolean;
      withPrivateOutputCustody<T>(work: () => Promise<T>): Promise<T>;
    };
    let releaseFailedWriter!: () => void;
    const failedWriter = state.withPrivateOutputCustody(async () => {
      await new Promise<void>((resolve) => { releaseFailedWriter = resolve; });
      state.privateOutputDirty = true;
    });
    const successfulWriter = state.withPrivateOutputCustody(async () => undefined);
    await vi.waitFor(() => expect(releaseFailedWriter).toBeTypeOf('function'));
    releaseFailedWriter();
    await Promise.all([failedWriter, successfulWriter]);
    const reconcile = vi.spyOn(subject, 'reconcileOrphanedOutputs');

    await expect(subject.synthesize(synthInput)).rejects.toThrow('admission reached');
    expect(reconcile).toHaveBeenCalledOnce();
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('does not rescan a healthy retained library on every synthesis admission', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-voice-orphans-'));
    roots.push(root);
    const canonicalRoot = await realpath(root);
    const retained = Array.from({ length: 24 }, (_, index) => ({
      output_local_path: path.join(canonicalRoot, `${index.toString(16).padStart(64, '0')}.ogg`),
      output_sha256: index.toString(16).padStart(64, '0'),
      output_mime: 'audio/ogg',
    }));
    await Promise.all(retained.map((entry, index) => writeFile(entry.output_local_path, `voice-${index}`)));
    let rejectAdmission = false;
    const execute = vi.fn(async () => retained);
    const transaction = vi.fn(async (callback: (tx: { execute: typeof execute }) => unknown) => {
      if (rejectAdmission) throw new Error('admission reached');
      return await callback({ execute });
    });
    const subject = new VoiceKernel({
      db: { execute, transaction } as never,
      mediaStore: { put: vi.fn() } as never,
      audio: {} as never,
      providers: {},
      cleanupArtifact: vi.fn(),
      voiceOutputRoot: root,
    });
    await expect(subject.reconcileOrphanedOutputs()).resolves.toBe(0);
    expect(transaction).not.toHaveBeenCalled();
    execute.mockClear();
    await expect(subject.reconcileOrphanedOutputs()).resolves.toBe(0);
    expect(execute).not.toHaveBeenCalled();
    const reconcile = vi.spyOn(subject, 'reconcileOrphanedOutputs');
    rejectAdmission = true;
    await expect(subject.synthesize(synthInput)).rejects.toThrow('admission reached');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('requires a fresh successful scan after an aborted scan before admission', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden3-voice-orphans-'));
    roots.push(root);
    const file = path.join(root, `${'d'.repeat(64)}.ogg`);
    await writeFile(file, 'orphan');
    let rejectAdmission = false;
    let scannerTransactionsRemaining = 0;
    const execute = vi.fn(async () => [{ referenced: false }]);
    const transaction = vi.fn(async (callback: (tx: { execute: typeof execute }) => unknown) => {
      if (rejectAdmission && scannerTransactionsRemaining === 0) throw new Error('admission reached');
      if (scannerTransactionsRemaining > 0) scannerTransactionsRemaining -= 1;
      return await callback({ execute });
    });
    const subject = new VoiceKernel({
      db: { execute, transaction } as never,
      mediaStore: { put: vi.fn() } as never,
      audio: {} as never,
      providers: {},
      cleanupArtifact: vi.fn(),
      voiceOutputRoot: root,
    });
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    await expect(subject.reconcileOrphanedOutputs(controller.signal)).rejects.toThrow();
    const reconcile = vi.spyOn(subject, 'reconcileOrphanedOutputs');
    rejectAdmission = true;
    scannerTransactionsRemaining = 1;
    await expect(subject.synthesize(synthInput)).rejects.toThrow('admission reached');
    expect(reconcile).toHaveBeenCalledOnce();
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
