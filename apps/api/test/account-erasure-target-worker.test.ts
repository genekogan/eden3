import { describe, expect, it, vi } from 'vitest';

import {
  AccountErasureTargetWorker,
  attestAccountErasureLegacyMediaBoundary,
  attestAccountErasureVoiceOutputBoundary,
  CartesiaVoiceCloneErasureExecutor,
  LocalLegacyErasureExecutor,
  type AccountErasureTargetClaim,
  type AccountErasureTargetStore,
} from '../src/services/account-erasure-postgres';

const claim: AccountErasureTargetClaim = {
  targetId: '11111111-1111-4111-8111-111111111111',
  jobId: '22222222-2222-4222-8222-222222222222',
  accountId: '33333333-3333-4333-8333-333333333333',
  kind: 'storage_object',
  resourceId: '44444444-4444-4444-8444-444444444444',
  claimToken: '55555555-5555-4555-8555-555555555555',
  claimExpiresAt: '2026-08-08T20:01:00.000Z',
  locator: '{"backingStore":"local","backingKey":"objects/44/id"}',
};

function storeWith(claimed: AccountErasureTargetStore['claimTarget'] extends () => Promise<infer T> ? T : never) {
  let returned = false;
  const store: AccountErasureTargetStore = {
    claimTarget: vi.fn(async () => {
      if (returned) return null;
      returned = true;
      return claimed;
    }),
    completeTarget: vi.fn(async () => 'completed' as const),
    failTarget: vi.fn(async () => 'retried' as const),
  };
  return store;
}

describe('AccountErasureTargetWorker', () => {
  it('persists success only after positive absence evidence', async () => {
    const store = storeWith(claim);
    const worker = new AccountErasureTargetWorker(store, {
      erase: vi.fn(async () => ({ confirmedAbsent: true as const })),
    });

    await expect(worker.tick()).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      attention: 0,
      stale: 0,
    });
    expect(store.completeTarget).toHaveBeenCalledWith(claim);
    expect(store.failTarget).not.toHaveBeenCalled();
  });

  it('surfaces source-missing attention without invoking an external executor', async () => {
    const store = storeWith({ targetId: claim.targetId, status: 'attention' });
    const erase = vi.fn();
    const worker = new AccountErasureTargetWorker(store, { erase });

    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, attention: 1 });
    expect(erase).not.toHaveBeenCalled();
  });

  it('bounds a stuck external delete and durably retries the exact claim', async () => {
    vi.useFakeTimers();
    const store = storeWith(claim);
    const worker = new AccountErasureTargetWorker(store, {
      // A provider SDK is allowed to ignore AbortSignal; the worker deadline
      // must still release tick/shutdown and durably resolve the exact lease.
      erase: () => new Promise(() => undefined),
    }, 1, 1_000);
    const tick = worker.tick();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(tick).resolves.toMatchObject({ claimed: 1, retried: 1 });
    expect(store.failTarget).toHaveBeenCalledWith(claim, 'target_cleanup_failed');
    vi.useRealTimers();
  });

  it('coalesces overlapping ticks within one worker', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = storeWith(claim);
    const worker = new AccountErasureTargetWorker(store, {
      erase: async () => {
        await gate;
        return { confirmedAbsent: true };
      },
    });
    const first = worker.tick();
    await vi.waitFor(() => expect(store.claimTarget).toHaveBeenCalledTimes(1));
    await expect(worker.tick()).resolves.toEqual({
      claimed: 0, completed: 0, retried: 0, attention: 0, stale: 0,
    });
    release();
    await first;
  });

  it('rejects unsafe lease, attempt, batch, and timeout geometry', () => {
    expect(() => new AccountErasureTargetWorker(storeWith(null), { erase: vi.fn() }, 0)).toThrow();
    expect(() => new AccountErasureTargetWorker(storeWith(null), { erase: vi.fn() }, 1, 999)).toThrow();
  });

  it('confirms Cartesia clone absence and never clears an ambiguous create without identity', async () => {
    const deleteClone = vi.fn(async () => undefined);
    const fallback = { erase: vi.fn(async () => ({ confirmedAbsent: true as const })) };
    const executor = new CartesiaVoiceCloneErasureExecutor({
      provider: 'cartesia',
      synthesize: vi.fn(),
      deleteClone,
    }, fallback);
    await expect(executor.erase({
      ...claim, kind: 'voice_clone', signal: new AbortController().signal,
      locator: JSON.stringify({ kind: 'voice_clone', provider: 'cartesia', providerVoiceId: 'voice_123', status: 'ready' }),
    })).resolves.toEqual({ confirmedAbsent: true });
    expect(deleteClone).toHaveBeenCalledOnce();
    await expect(executor.erase({
      ...claim, kind: 'voice_clone', signal: new AbortController().signal,
      locator: JSON.stringify({ kind: 'voice_clone', provider: 'cartesia', providerVoiceId: null, status: 'provider_create_ambiguous' }),
    })).rejects.toThrow(/reconciliation/);
    expect(fallback.erase).not.toHaveBeenCalled();
  });

  it('unlinks only canonical regular content-addressed files and rejects symlinks/escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eden3-erasure-media-'));
    const voiceRoot = await mkdtemp(join(tmpdir(), 'eden3-erasure-voice-'));
    const sha256 = 'a'.repeat(64);
    const canonical = join(root, `${sha256}.png`);
    await writeFile(canonical, 'private bytes');
    const external = { erase: vi.fn(async () => ({ confirmedAbsent: true as const })) };
    const executor = new LocalLegacyErasureExecutor(
      attestAccountErasureLegacyMediaBoundary(root),
      attestAccountErasureVoiceOutputBoundary(voiceRoot),
      external,
    );
    const nestedVoice = join(root, 'nested-voice');
    await mkdir(nestedVoice);
    expect(() => new LocalLegacyErasureExecutor(
      attestAccountErasureLegacyMediaBoundary(root),
      attestAccountErasureVoiceOutputBoundary(nestedVoice),
      external,
    )).toThrow(/distinct attested voice output boundary/);
    const voiceAlias = join(root, 'voice-alias');
    await symlink(voiceRoot, voiceAlias);
    expect(() => attestAccountErasureVoiceOutputBoundary(voiceAlias)).toThrow(/must not be a symlink/);
    const localClaim = {
      ...claim,
      kind: 'legacy_media_asset' as const,
      locator: JSON.stringify({ localPath: canonical, sha256, deletePhysical: true }),
    };
    await expect(executor.erase({ ...localClaim, signal: new AbortController().signal }))
      .resolves.toEqual({ confirmedAbsent: true });
    await expect(readFile(canonical)).rejects.toMatchObject({ code: 'ENOENT' });

    const urlSha = 'c'.repeat(64);
    const urlOnly = join(root, `${urlSha}.jpg`);
    await writeFile(urlOnly, 'url-only private bytes');
    await expect(executor.erase({
      ...localClaim,
      signal: new AbortController().signal,
      locator: JSON.stringify({ url: `/media/${urlSha}.jpg`, sha256: urlSha, deletePhysical: true }),
    })).resolves.toEqual({ confirmedAbsent: true });
    await expect(readFile(urlOnly)).rejects.toMatchObject({ code: 'ENOENT' });

    const avatarSha = 'e'.repeat(64);
    const avatar = join(root, `${avatarSha}.webp`);
    await writeFile(avatar, 'avatar private bytes');
    await expect(executor.erase({
      ...localClaim,
      kind: 'legacy_avatar_asset',
      signal: new AbortController().signal,
      locator: JSON.stringify({
        localPath: avatar,
        url: `/media/${avatarSha}.webp`,
        sha256: avatarSha,
        deletePhysical: true,
      }),
    })).resolves.toEqual({ confirmedAbsent: true });
    await expect(readFile(avatar)).rejects.toMatchObject({ code: 'ENOENT' });

    const voiceSha = 'f'.repeat(64);
    const voice = join(voiceRoot, `${voiceSha}.ogg`);
    await writeFile(voice, 'private voice bytes');
    await expect(executor.erase({
      ...localClaim,
      kind: 'voice_output',
      signal: new AbortController().signal,
      locator: JSON.stringify({ localPath: voice, sha256: voiceSha, deletePhysical: true }),
    })).resolves.toEqual({ confirmedAbsent: true });
    await expect(readFile(voice)).rejects.toMatchObject({ code: 'ENOENT' });
    const wrongRootVoice = join(root, `${voiceSha}.ogg`);
    await writeFile(wrongRootVoice, 'must survive');
    await expect(executor.erase({
      ...localClaim,
      kind: 'voice_output',
      signal: new AbortController().signal,
      locator: JSON.stringify({ localPath: wrongRootVoice, sha256: voiceSha, deletePhysical: true }),
    })).rejects.toThrow(/flat media root/);
    expect(await readFile(wrongRootVoice, 'utf8')).toBe('must survive');

    await expect(executor.erase({
      ...localClaim,
      signal: new AbortController().signal,
      locator: JSON.stringify({
        url: 'https://provider.invalid/private', sha256: urlSha,
        deletePhysical: false, externalDisposition: true,
      }),
    })).resolves.toEqual({ confirmedAbsent: true });
    expect(external.erase).toHaveBeenCalledTimes(1);
    for (const url of [
      `/media/%2e%2e/${urlSha}.jpg`,
      `/media/${'d'.repeat(64)}.jpg`,
    ]) {
      await expect(executor.erase({
        ...localClaim,
        signal: new AbortController().signal,
        locator: JSON.stringify({ url, sha256: urlSha, deletePhysical: true }),
      })).rejects.toThrow('legacy erasure locator is invalid');
    }

    const outsideRoot = await mkdtemp(join(tmpdir(), 'eden3-erasure-outside-'));
    const outside = join(outsideRoot, `${sha256}.png`);
    await writeFile(outside, 'foreign bytes');
    const link = join(root, `${'b'.repeat(64)}.png`);
    await symlink(outside, link);
    await expect(executor.erase({
      ...localClaim,
      signal: new AbortController().signal,
      locator: JSON.stringify({ localPath: link, sha256: 'b'.repeat(64), deletePhysical: true }),
    })).rejects.toThrow(/regular file|escaped/);
    expect(await readFile(outside, 'utf8')).toBe('foreign bytes');
    await rm(root, { recursive: true, force: true });
    await rm(voiceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });
});
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
