import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { IngestFileOptions, IngestFileResult, MediaPipeline } from '../src/services/media-pipeline';
import {
  MediaClaimTimeoutError,
  MediaWatcher,
  containerPathToHost,
  createAttachmentSightingHandler,
  mostRecentActiveTurn,
  toolFromPath,
  trustedGatewayMediaUrl,
  type MediaWatcherOutcome,
} from '../src/workers/media-watcher';

/**
 * MediaWatcher tests: real (temp) filesystems + fast polling + a recording
 * fake pipeline. No database, no gateway.
 */

const silent = { info() {}, warn() {}, error() {} };

interface IngestCall {
  path: string;
  opts: IngestFileOptions;
  /** File size at the moment ingestFile was invoked (stability proof). */
  sizeAtCall: number;
}

function fakePipeline(): { pipeline: MediaPipeline; calls: IngestCall[] } {
  const calls: IngestCall[] = [];
  const pipeline = {
    async ingestFile(p: string, opts: IngestFileOptions = {}): Promise<IngestFileResult> {
      calls.push({ path: p, opts, sizeAtCall: statSync(p).size });
      return { deduped: false } as IngestFileResult;
    },
  } as unknown as MediaPipeline;
  return { pipeline, calls };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000, everyMs = 10): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const watchers: MediaWatcher[] = [];

function makeWatcher(
  dir: string,
  extra: Partial<ConstructorParameters<typeof MediaWatcher>[0]> = {},
): { watcher: MediaWatcher; calls: IngestCall[]; outcomes: MediaWatcherOutcome[] } {
  const { pipeline, calls } = fakePipeline();
  const outcomes: MediaWatcherOutcome[] = [];
  const watcher = new MediaWatcher({
    pipeline,
    dirs: [dir],
    pollIntervalMs: 25,
    stablePolls: 2,
    logger: silent,
    onOutcome: (o) => outcomes.push(o),
    ...extra,
  });
  watchers.push(watcher);
  return { watcher, calls, outcomes };
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'eden3-watch-'));
}

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((w) => w.stop()));
});

describe('pure helpers', () => {
  it('toolFromPath prefers the tool-* directory, falls back by kind', () => {
    expect(toolFromPath('/d/media/tool-image-generation/a.bin', 'file')).toBe('image_generate');
    expect(toolFromPath('/d/media/tool-video-generation/a.mp4', 'video')).toBe('video_generate');
    expect(toolFromPath('/d/media/tool-music-generation/a.mp3', 'audio')).toBe('music_generate');
    expect(toolFromPath('/d/media/tool-tts-generation/a.mp3', 'audio')).toBe('tts');
    expect(toolFromPath('/d/media/misc/a.png', 'image')).toBe('image_generate');
    expect(toolFromPath('/d/media/misc/a.mp3', 'audio')).toBeNull(); // ambiguous — no guess
  });

  it('containerPathToHost maps the media/tmp output roots and passes host paths through', () => {
    const dirs = { dataDir: '/host/data', tmpDir: '/host/tmp' };
    expect(containerPathToHost('/home/node/.openclaw/media/tool-image-generation/a.jpg', dirs)).toBe(
      '/host/data/media/tool-image-generation/a.jpg',
    );
    expect(containerPathToHost('/tmp/openclaw/tts/a.mp3', dirs)).toBe('/host/tmp/tts/a.mp3');
    expect(containerPathToHost('/host/data/media/a.jpg', dirs)).toBe('/host/data/media/a.jpg');
    expect(containerPathToHost('/somewhere/else/a.jpg', dirs)).toBeNull();
  });

  it('containerPathToHost refuses ../ path traversal out of the mapped roots', () => {
    const dirs = { dataDir: '/host/data', tmpDir: '/host/tmp' };
    // The classic escape: `..` sequences under a valid container prefix that
    // would otherwise resolve to an arbitrary host file (agent-controlled).
    expect(
      containerPathToHost('/home/node/.openclaw/../../../../etc/passwd.jpg', dirs),
    ).toBeNull();
    expect(containerPathToHost('/tmp/openclaw/../../../etc/shadow.mp3', dirs)).toBeNull();
    // A host path that climbs out with `..` is also rejected.
    expect(containerPathToHost('/host/data/../../etc/passwd.jpg', dirs)).toBeNull();
    // A legit nested path with an INTERNAL `..` that stays contained still maps.
    expect(containerPathToHost('/home/node/.openclaw/media/sub/../a.jpg', dirs)).toBe(
      '/host/data/media/a.jpg',
    );
    // Sanity: the two known-good vectors from the mapping test still pass.
    expect(containerPathToHost('/tmp/openclaw/tts/a.mp3', dirs)).toBe('/host/tmp/tts/a.mp3');
  });

  it('containerPathToHost refuses non-media files inside the data root (exfiltration)', () => {
    // No `..` needed: these are legitimate, traversal-free paths that live
    // under the mounted data root. Publishing them would leak gateway secrets
    // or another user's private memory. The media-subdir restriction must
    // reject anything outside <dataDir>/media even without a bad extension.
    const dirs = { dataDir: '/host/data', tmpDir: '/host/tmp' };
    expect(containerPathToHost('/home/node/.openclaw/openclaw.json', dirs)).toBeNull();
    expect(containerPathToHost('/home/node/.openclaw/identity/device-auth.json', dirs)).toBeNull();
    expect(
      containerPathToHost('/home/node/.openclaw/workspace-victim/memory/users/alex.md', dirs),
    ).toBeNull();
    // Even renamed with a media extension it stays outside <dataDir>/media.
    expect(containerPathToHost('/home/node/.openclaw/openclaw.json.png', dirs)).toBeNull();
    // And a host-path passthrough that points at the config is rejected too.
    expect(containerPathToHost('/host/data/openclaw.json', dirs)).toBeNull();
  });

  it('containerPathToHost enforces a media-extension allowlist', () => {
    const dirs = { dataDir: '/host/data', tmpDir: '/host/tmp' };
    // A non-media file that somehow lands INSIDE the media dir is still refused.
    expect(containerPathToHost('/home/node/.openclaw/media/secret.md', dirs)).toBeNull();
    expect(containerPathToHost('/home/node/.openclaw/media/creds.json', dirs)).toBeNull();
    // Real media extensions inside the media dir pass.
    expect(containerPathToHost('/home/node/.openclaw/media/a.webp', dirs)).toBe(
      '/host/data/media/a.webp',
    );
  });

  it('mostRecentActiveTurn picks the largest windowUntil', () => {
    expect(mostRecentActiveTurn({ active: () => [] })).toBeNull();
    const turn = mostRecentActiveTurn({
      active: () => [
        ['k1', { sessionId: 'old', windowUntil: 100 }],
        ['k2', { sessionId: 'new', windowUntil: 200 }],
        ['k3', { sessionId: 'mid', windowUntil: 150 }],
      ],
    });
    expect(turn?.sessionId).toBe('new');
  });
});

describe('MediaWatcher (temp fs, fast polling)', () => {
  it('waits for size stability, then parks an uncorrelated file exactly once', async () => {
    const dir = tempDir();
    const { watcher, calls } = makeWatcher(dir);
    await watcher.start();

    const file = path.join(dir, 'grow.jpg');
    writeFileSync(file, Buffer.alloc(100, 1));
    await sleep(30); // let a poll observe the partial file
    appendFileSync(file, Buffer.alloc(150, 2)); // still being written

    await waitFor(() => calls.length > 0);
    await sleep(150); // would double-fire here if processed tracking failed
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(file);
    expect(calls[0]!.sizeAtCall).toBe(250); // saw the COMPLETE file
    expect(calls[0]!.opts.sessionId).toBeUndefined(); // parked
    expect(calls[0]!.opts.tool).toBe('image_generate'); // .jpg fallback
  });

  it('ignores pre-existing files, dotfiles, and .tmp suffixes', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'preexisting.jpg'), Buffer.alloc(64, 1));
    const { watcher, calls } = makeWatcher(dir);
    await watcher.start();

    writeFileSync(path.join(dir, '.hidden.jpg'), Buffer.alloc(64, 1));
    writeFileSync(path.join(dir, 'partial.jpg.tmp'), Buffer.alloc(64, 1));
    await sleep(300);
    expect(calls).toHaveLength(0);
  });

  it('hands a matching file to a claim instead of ingesting it', async () => {
    const dir = tempDir();
    const { watcher, calls, outcomes } = makeWatcher(dir);
    await watcher.start();

    const claim = watcher.claimNext({ kinds: ['image'], timeoutMs: 5000 });
    const file = path.join(dir, 'claimed.png');
    writeFileSync(file, Buffer.alloc(80, 3));

    const claimed = await claim.promise;
    expect(claimed.path).toBe(file);
    expect(claimed.kind).toBe('image');
    await sleep(120);
    expect(calls).toHaveLength(0); // claimant owns it — no auto-ingest
    expect(outcomes.map((o) => o.via)).toEqual(['claim']);
  });

  it('parks a late same-kind file while Studio output is durably quarantined', async () => {
    const dir = tempDir();
    const { watcher, calls, outcomes } = makeWatcher(dir, {
      isStudioKindQuarantined: async (kind) => kind === 'image',
    });
    await watcher.start();

    const claim = watcher.claimNext({ kinds: ['image'], timeoutMs: 5000 });
    const file = path.join(dir, 'late-provider-output.png');
    writeFileSync(file, Buffer.alloc(80, 3));

    await waitFor(() => calls.length === 1);
    claim.cancel();
    expect(calls[0]!.path).toBe(file);
    expect(calls[0]!.opts.sessionId).toBeUndefined();
    expect(calls[0]!.opts.userId).toBeUndefined();
    expect(outcomes.map((outcome) => outcome.via)).toEqual(['parked']);
  });

  it('kind-mismatched claims time out while the file is still processed normally', async () => {
    const dir = tempDir();
    const { watcher, calls } = makeWatcher(dir);
    await watcher.start();

    const claim = watcher.claimNext({ kinds: ['video'], timeoutMs: 400 });
    writeFileSync(path.join(dir, 'not-a-video.png'), Buffer.alloc(80, 3));

    await expect(claim.promise).rejects.toBeInstanceOf(MediaClaimTimeoutError);
    await waitFor(() => calls.length === 1);
    expect(calls[0]!.opts.sessionId).toBeUndefined(); // parked, not claimed
  });

  it('never attributes a file from a live turn window without exact history evidence', async () => {
    const dir = tempDir();
    const registry = {
      active: (): Array<[string, { sessionId: string; agentAccountId: string; windowUntil: number }]> => [
        ['k-old', { sessionId: 'session-old', agentAccountId: 'agent-old', windowUntil: Date.now() + 10_000 }],
        ['k-new', { sessionId: 'session-new', agentAccountId: 'agent-new', windowUntil: Date.now() + 60_000 }],
      ],
    };
    const { watcher, calls, outcomes } = makeWatcher(dir, { turnRegistry: registry });
    await watcher.start();

    writeFileSync(path.join(dir, 'chat.png'), Buffer.alloc(90, 4));
    await waitFor(() => calls.length === 1);
    expect(calls[0]!.opts.sessionId).toBeUndefined();
    expect(calls[0]!.opts.agentAccountId).toBeUndefined();
    expect(calls[0]!.opts.tool).toBe('image_generate');
    expect(outcomes[0]!.via).toBe('parked');
  });

  it('falls back to the injected history-sync lookup, then parks on null', async () => {
    const dir = tempDir();
    const seen: string[] = [];
    let answer: { sessionId: string } | null = { sessionId: 'via-history' };
    const { watcher, calls, outcomes } = makeWatcher(dir, {
      historySync: async (file) => {
        seen.push(file.basename);
        return answer;
      },
    });
    await watcher.start();

    writeFileSync(path.join(dir, 'synced.png'), Buffer.alloc(70, 5));
    await waitFor(() => calls.length === 1);
    expect(seen).toEqual(['synced.png']);
    expect(calls[0]!.opts.sessionId).toBe('via-history');
    expect(outcomes[0]!.via).toBe('history-sync');

    answer = null;
    writeFileSync(path.join(dir, 'unmatched.png'), Buffer.alloc(71, 6));
    await waitFor(() => calls.length === 2);
    expect(calls[1]!.opts.sessionId).toBeUndefined();
    expect(outcomes[1]!.via).toBe('parked');
  });

  it('markProcessed suppresses watcher routing for externally-handled paths', async () => {
    const dir = tempDir();
    const { watcher, calls } = makeWatcher(dir);
    await watcher.start();

    const file = path.join(dir, 'external.png');
    writeFileSync(file, Buffer.alloc(60, 7));
    watcher.markProcessed(file);
    await sleep(300);
    expect(calls).toHaveLength(0);
  });
});

describe('createAttachmentSightingHandler', () => {
  it('accepts only frozen FAL HTTPS media authorities', () => {
    expect(trustedGatewayMediaUrl('https://v3b.fal.media/files/output.mp4')?.hostname).toBe(
      'v3b.fal.media',
    );
    for (const refused of [
      'http://v3b.fal.media/files/output.mp4',
      'https://fal.media.attacker.invalid/output.mp4',
      'https://user:pass@v3b.fal.media/output.mp4',
      'https://127.0.0.1/output.mp4',
      'https://v3b.fal.media/output.exe',
      'https://v3b.fal.media/output.mp4#fragment',
    ]) {
      expect(trustedGatewayMediaUrl(refused)).toBeNull();
    }
  });

  it('downloads a bounded FAL completion without redirects, attaches it, then removes temp bytes', async () => {
    const root = tempDir();
    const { pipeline, calls } = fakePipeline();
    const fetchCalls: Array<{ url: string; redirect: string | undefined }> = [];
    const handler = createAttachmentSightingHandler({
      pipeline,
      dirs: { dataDir: path.join(root, 'data'), tmpDir: path.join(root, 'data-tmp') },
      logger: silent,
      remoteTempRoot: root,
      fetchImpl: (async (input, init) => {
        fetchCalls.push({ url: String(input), redirect: init?.redirect });
        return new Response(Buffer.alloc(256, 7), {
          status: 200,
          headers: { 'content-length': '256', 'content-type': 'video/mp4' },
        });
      }) as typeof fetch,
    });

    await handler({
      sessionId: 'sess-video',
      messageId: 'msg-video',
      path: 'https://v3b.fal.media/files/run/video-1.mp4',
      role: 'assistant',
    });

    expect(fetchCalls).toEqual([
      { url: 'https://v3b.fal.media/files/run/video-1.mp4', redirect: 'error' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toMatchObject({
      sessionId: 'sess-video',
      messageId: 'msg-video',
      tool: 'video_generate',
    });
    expect(calls[0]!.sizeAtCall).toBe(256);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses an oversized remote completion before pipeline ingest', async () => {
    const root = tempDir();
    const { pipeline, calls } = fakePipeline();
    const errors: string[] = [];
    const handler = createAttachmentSightingHandler({
      pipeline,
      dirs: { dataDir: path.join(root, 'data'), tmpDir: path.join(root, 'data-tmp') },
      logger: { ...silent, error: (message) => errors.push(message) },
      remoteTempRoot: root,
      remoteDownloadLimitBytes: 32,
      fetchImpl: (async () =>
        new Response(Buffer.alloc(64), {
          status: 200,
          headers: { 'content-length': '64', 'content-type': 'video/mp4' },
        })) as typeof fetch,
    });

    await handler({
      sessionId: 'sess-video',
      messageId: 'msg-video',
      path: 'https://v3b.fal.media/files/run/video-1.mp4',
    });

    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(readdirSync(root)).toEqual([]);
  });

  it('maps the container path, marks it processed, and ingests in attach mode', async () => {
    const root = tempDir();
    const dirs = { dataDir: path.join(root, 'data'), tmpDir: path.join(root, 'data-tmp') };
    const mediaDir = path.join(dirs.dataDir, 'media', 'tool-image-generation');
    mkdirSync(mediaDir, { recursive: true });
    const name = `img-${randomUUID().slice(0, 8)}.jpg`;
    writeFileSync(path.join(mediaDir, name), Buffer.alloc(120, 8));

    const { pipeline, calls } = fakePipeline();
    const { watcher } = makeWatcher(path.join(root, 'unused'));
    const handler = createAttachmentSightingHandler({
      pipeline,
      watcher,
      dirs,
      logger: silent,
      statRetries: 2,
      statRetryDelayMs: 20,
    });

    handler({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      path: `/home/node/.openclaw/media/tool-image-generation/${name}`,
      role: 'assistant',
    });
    await handler.lastRun;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(path.join(mediaDir, name));
    expect(calls[0]!.opts).toMatchObject({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      tool: 'image_generate',
    });
  });

  it('parks a quarantined sighting instead of attaching it to a later session', async () => {
    const root = tempDir();
    const dirs = { dataDir: path.join(root, 'data'), tmpDir: path.join(root, 'data-tmp') };
    const mediaDir = path.join(dirs.dataDir, 'media', 'tool-image-generation');
    mkdirSync(mediaDir, { recursive: true });
    const name = `late-${randomUUID().slice(0, 8)}.jpg`;
    writeFileSync(path.join(mediaDir, name), Buffer.alloc(120, 8));

    const { pipeline, calls } = fakePipeline();
    const handler = createAttachmentSightingHandler({
      pipeline,
      dirs,
      logger: silent,
      isStudioKindQuarantined: async (kind) => kind === 'image',
      statRetries: 2,
      statRetryDelayMs: 20,
    });
    handler({
      sessionId: 'later-tenant-session',
      messageId: 'later-tenant-message',
      path: `/home/node/.openclaw/media/tool-image-generation/${name}`,
      role: 'assistant',
    });
    await handler.lastRun;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.sessionId).toBeUndefined();
    expect(calls[0]!.opts.messageId).toBeUndefined();
    expect(calls[0]!.opts.userId).toBeUndefined();
    expect(calls[0]!.opts.tool).toBe('image_generate');
  });

  it('skips unmappable paths and files that never appear', async () => {
    const root = tempDir();
    const dirs = { dataDir: path.join(root, 'data'), tmpDir: path.join(root, 'data-tmp') };
    const { pipeline, calls } = fakePipeline();
    const handler = createAttachmentSightingHandler({
      pipeline,
      dirs,
      logger: silent,
      statRetries: 2,
      statRetryDelayMs: 10,
    });

    handler({ sessionId: 's', messageId: 'm', path: '/etc/passwd' });
    await handler.lastRun;
    handler({ sessionId: 's', messageId: 'm', path: '/home/node/.openclaw/media/gone.jpg' });
    await handler.lastRun;

    expect(calls).toHaveLength(0);
  });
});
