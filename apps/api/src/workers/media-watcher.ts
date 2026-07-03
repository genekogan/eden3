import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import {
  attachmentKindForMime,
  mimeForPath,
  type AttachmentKind,
  type IngestFileResult,
  type MediaLogger,
  type MediaPipeline,
} from '../services/media-pipeline';

/**
 * Media watcher — picks up files the OpenClaw gateway writes to its data dirs
 * and routes them into the {@link MediaPipeline}.
 *
 * Watches (polling — the dirs sit on an sshfs bind out of the colima VM, so
 * fs events are unreliable): `$OPENCLAW_DATA_DIR/media/**` and
 * `$OPENCLAW_TMP_DIR/**` (defaults: `<repo>/infra/openclaw/data/media`,
 * `<repo>/infra/openclaw/data-tmp`). A file is processed once its size has
 * been stable for {@link MediaWatcherOptions.stablePolls} consecutive polls.
 *
 * ## Correlation — honest limits
 *
 * Gateway media paths carry NO agent/session identity (spike probe #4: the
 * filename uuid is unrelated to the task id; the directory only names the
 * tool, e.g. `tool-image-generation`). Correlation is therefore heuristic,
 * in strict priority order:
 *
 *   1. **Claims** (studio flow): a caller that just invoked a tool claims the
 *      next stable file of a matching kind ({@link MediaWatcher.claimNext}).
 *      Registered before the invoke, so it wins over everything else.
 *   2. **Turn registry** (services/turn-registry.ts): the most recently
 *      active chat turn window. If several sessions are mid-turn at once we
 *      pick the newest — with N concurrent media-generating turns this CAN
 *      mis-attribute files across them (and a claim can grab a file whose
 *      write began before the claim was registered). Acceptable at current
 *      scale (single box, low concurrency); a real fix needs gateway-side
 *      task→file correlation, which does not exist (spike probe #4).
 *   3. **History sync** (injected callback): resolve the file against synced
 *      gateway transcripts. The production wiring is the PUSH direction —
 *      services/history-sync.ts reports `MEDIA:<path>` sightings on synced
 *      completion messages to {@link createAttachmentSightingHandler}, which
 *      ingests in attach mode. This pull hook exists for a watcher-initiated
 *      lookup and defaults to null.
 *   4. **Park**: ingest with no session/user — a bare `media_assets` row. A
 *      later history-sync sighting re-ingests it with a session (the
 *      pipeline fills the null correlation columns in), so parking is a
 *      recoverable state, not a dead end.
 *
 * Double-observation of the same file by different paths (watcher + sighting
 * handler) is harmless: the pipeline dedupes on sha256 per session and the
 * media manna debit key is `media:<sha256>:<sessionId>`.
 */

// ---------------------------------------------------------------------------
// OpenClaw directories (host ↔ container)
// ---------------------------------------------------------------------------

/** Container mount points (see infra/docker-compose.yml). */
export const CONTAINER_DATA_ROOT = '/home/node/.openclaw';
export const CONTAINER_TMP_ROOT = '/tmp/openclaw';

export interface OpenclawDirs {
  /** Host path bind-mounted at /home/node/.openclaw (media lives under <dataDir>/media). */
  dataDir: string;
  /** Host path bind-mounted at /tmp/openclaw (tts & friends). */
  tmpDir: string;
}

/** Walk upward looking for the pnpm workspace root (fallback: `from`). */
function findRepoRoot(from: string): string {
  let dir = path.resolve(from);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(from);
}

/** Resolve the gateway data dirs from env (OPENCLAW_DATA_DIR / OPENCLAW_TMP_DIR). */
export function resolveOpenclawDirs(env: NodeJS.ProcessEnv = process.env): OpenclawDirs {
  const root = findRepoRoot(process.cwd());
  return {
    dataDir: env.OPENCLAW_DATA_DIR?.trim()
      ? path.resolve(env.OPENCLAW_DATA_DIR)
      : path.join(root, 'infra', 'openclaw', 'data'),
    tmpDir: env.OPENCLAW_TMP_DIR?.trim()
      ? path.resolve(env.OPENCLAW_TMP_DIR)
      : path.join(root, 'infra', 'openclaw', 'data-tmp'),
  };
}

/** Directories the watcher observes: `<dataDir>/media` and `<tmpDir>`. */
export function defaultWatchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const { dataDir, tmpDir } = resolveOpenclawDirs(env);
  return [path.join(dataDir, 'media'), tmpDir];
}

/** True when `child` resolves strictly inside `root` (path-traversal proof). */
function isContainedIn(child: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(child);
  return (
    resolvedChild === resolvedRoot ||
    resolvedChild.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

/**
 * Map a container path from a gateway transcript (`MEDIA:/home/node/...`)
 * onto the host filesystem. Host paths already under the mapped dirs pass
 * through unchanged; anything else returns null.
 *
 * SECURITY: the transcript is attacker-controlled (an agent's completion text
 * — personas are agent-authored). A `..` sequence like
 * `/home/node/.openclaw/../../../../etc/passwd` must NOT escape the mapped
 * root, or ingestFile would content-address an arbitrary host file into
 * MEDIA_DIR and serve it publicly. Every branch therefore path.resolve()s the
 * mapped result and asserts containment in the target root, returning null on
 * any escape.
 */
export function containerPathToHost(
  containerPath: string,
  dirs: OpenclawDirs = resolveOpenclawDirs(),
): string | null {
  const p = containerPath.trim();
  if (p.startsWith(`${CONTAINER_DATA_ROOT}/`)) {
    const mapped = path.resolve(dirs.dataDir, p.slice(CONTAINER_DATA_ROOT.length + 1));
    return isContainedIn(mapped, dirs.dataDir) ? mapped : null;
  }
  if (p.startsWith(`${CONTAINER_TMP_ROOT}/`)) {
    const mapped = path.resolve(dirs.tmpDir, p.slice(CONTAINER_TMP_ROOT.length + 1));
    return isContainedIn(mapped, dirs.tmpDir) ? mapped : null;
  }
  const resolved = path.resolve(p);
  if (isContainedIn(resolved, dirs.dataDir) || isContainedIn(resolved, dirs.tmpDir)) {
    return resolved; // already a host path
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turn registry seam (owned by services/turn-registry.ts)
// ---------------------------------------------------------------------------

/** Structural slice of services/turn-registry.ts ActiveTurn. */
export interface ActiveTurnLike {
  sessionId: string;
  agentAccountId?: string | null;
  /** Epoch ms the window stays active until (recency ranking). */
  windowUntil?: number;
}

/** Structural slice of services/turn-registry.ts TurnRegistry. */
export interface TurnRegistryLike {
  /** Live entries as `[sessionKey, turn]` pairs (already pruned). */
  active(): Array<[string, ActiveTurnLike]>;
}

const EMPTY_REGISTRY: TurnRegistryLike = { active: () => [] };

/** Most recently (re)registered live turn, or null. */
export function mostRecentActiveTurn(registry: TurnRegistryLike): ActiveTurnLike | null {
  let best: ActiveTurnLike | null = null;
  for (const [, turn] of registry.active()) {
    if (!best || (turn.windowUntil ?? 0) > (best.windowUntil ?? 0)) best = turn;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Claims (studio flow) + pull-direction history sync
// ---------------------------------------------------------------------------

export interface MediaFileEvent {
  /** Absolute host path of the stable file. */
  path: string;
  basename: string;
  mime: string;
  kind: AttachmentKind;
}

/**
 * Injected pull-direction fallback: correlate a file the watcher could not
 * place. Return null when nothing matches — the file is parked.
 */
export type MediaHistorySync = (
  file: MediaFileEvent,
) => Promise<{ sessionId: string; agentAccountId?: string | null; tool?: string | null } | null>;

export class MediaClaimTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`no matching media file landed within ${timeoutMs}ms`);
    this.name = 'MediaClaimTimeoutError';
  }
}

export interface MediaClaimOptions {
  /** Restrict the claim to these attachment kinds (default: any). */
  kinds?: AttachmentKind[];
  timeoutMs: number;
}

export interface MediaClaim {
  /** Resolves with the stable file; rejects with {@link MediaClaimTimeoutError}. */
  promise: Promise<MediaFileEvent>;
  /**
   * Withdraw the claim (e.g. the tool invoke failed). The promise never
   * settles after cancel — do not await it past cancellation.
   */
  cancel(): void;
}

interface PendingClaim {
  kinds: Set<AttachmentKind> | null;
  resolve: (file: MediaFileEvent) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

/** How a stable file was routed (observability + tests). */
export interface MediaWatcherOutcome {
  file: MediaFileEvent;
  via: 'claim' | 'live-window' | 'history-sync' | 'parked';
  sessionId?: string | null;
  result?: IngestFileResult;
  error?: unknown;
}

export interface MediaWatcherOptions {
  pipeline: MediaPipeline;
  /** Directories to watch (default: {@link defaultWatchDirs}). */
  dirs?: string[];
  /** Poll interval for both chokidar and the stability loop (default 1500ms). */
  pollIntervalMs?: number;
  /** Consecutive polls the size must be unchanged before ingest (default 2). */
  stablePolls?: number;
  /** Live chat windows (services/turn-registry.ts); default: none. */
  turnRegistry?: TurnRegistryLike;
  historySync?: MediaHistorySync | null;
  logger?: MediaLogger;
  /** Test hook: called after every routed file. */
  onOutcome?: (outcome: MediaWatcherOutcome) => void;
}

const IGNORED_SUFFIXES = ['.tmp', '.part', '.partial', '.crdownload'];

function isIgnoredPath(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base.startsWith('.')) return true;
  const lower = base.toLowerCase();
  return IGNORED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Guess the generating tool from the gateway's `tool-*` directory names. */
export function toolFromPath(filePath: string, kind: AttachmentKind): string | null {
  for (const segment of filePath.split(path.sep)) {
    const s = segment.toLowerCase();
    if (!s.startsWith('tool-')) continue;
    if (s.includes('image')) return 'image_generate';
    if (s.includes('video')) return 'video_generate';
    if (s.includes('music') || s.includes('song')) return 'music_generate';
    if (s.includes('tts') || s.includes('speech') || s.includes('voice')) return 'tts';
  }
  if (kind === 'image') return 'image_generate';
  if (kind === 'video') return 'video_generate';
  return null; // audio without a tool dir is ambiguous (music vs tts) — don't guess
}

export class MediaWatcher {
  private readonly pipeline: MediaPipeline;
  private readonly dirs: string[];
  private readonly pollIntervalMs: number;
  private readonly stablePolls: number;
  private readonly log: MediaLogger;
  private readonly turnRegistry: TurnRegistryLike;
  private readonly historySync: MediaHistorySync | null;
  private readonly onOutcome: ((outcome: MediaWatcherOutcome) => void) | null;

  private watcher: FSWatcher | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  /** path → stability tracking state. */
  private readonly pending = new Map<string, { size: number; stable: number }>();
  /** Paths already handed off (claim/ingest/sighting) this process lifetime. */
  private readonly processed = new Set<string>();
  private readonly claims: PendingClaim[] = [];

  constructor(opts: MediaWatcherOptions) {
    this.pipeline = opts.pipeline;
    this.dirs = opts.dirs ?? defaultWatchDirs();
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
    this.stablePolls = opts.stablePolls ?? 2;
    this.turnRegistry = opts.turnRegistry ?? EMPTY_REGISTRY;
    this.historySync = opts.historySync ?? null;
    this.log = opts.logger ?? console;
    this.onOutcome = opts.onOutcome ?? null;
  }

  /** Start watching (idempotent; resolves after the initial scan). */
  async start(): Promise<void> {
    if (this.watcher) return this.starting ?? undefined;
    this.starting = new Promise<void>((resolve, reject) => {
      const watcher = chokidar.watch(this.dirs, {
        usePolling: true,
        interval: this.pollIntervalMs,
        ignoreInitial: true, // pre-existing files are someone else's history
        ignored: (p: string) => isIgnoredPath(p),
      });
      this.watcher = watcher;
      watcher.on('add', (p) => this.enqueue(p));
      watcher.on('change', (p) => this.enqueue(p));
      watcher.on('error', (err) => this.log.error(`media-watcher: watch error: ${String(err)}`));
      watcher.once('ready', () => resolve());
      watcher.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
    });
    this.tickTimer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.tickTimer.unref();
    return this.starting;
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    const watcher = this.watcher;
    this.watcher = null;
    this.starting = null;
    this.pending.clear();
    for (const claim of this.claims.splice(0)) clearTimeout(claim.timer);
    if (watcher) await watcher.close();
  }

  /**
   * Claim the next stable file (of an optionally restricted kind) that lands
   * AFTER this call. Claims queue FIFO and take priority over turn-registry
   * correlation; a claimed file is handed to the claimant, NOT auto-ingested.
   */
  claimNext(opts: MediaClaimOptions): MediaClaim {
    let entry: PendingClaim | null = null;
    const promise = new Promise<MediaFileEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeClaim(entry);
        reject(new MediaClaimTimeoutError(opts.timeoutMs));
      }, opts.timeoutMs);
      timer.unref();
      entry = { kinds: opts.kinds ? new Set(opts.kinds) : null, resolve, reject, timer };
      this.claims.push(entry);
    });
    return {
      promise,
      cancel: () => {
        if (!entry) return;
        clearTimeout(entry.timer);
        this.removeClaim(entry);
        entry = null;
      },
    };
  }

  /**
   * Mark a host path as handled outside the watcher (attachment sighting) so
   * the stability loop won't route it a second time.
   */
  markProcessed(hostPath: string): void {
    const abs = path.resolve(hostPath);
    this.processed.add(abs);
    this.pending.delete(abs);
  }

  // -- internals ----------------------------------------------------------

  private removeClaim(claim: PendingClaim | null): void {
    if (!claim) return;
    const idx = this.claims.indexOf(claim);
    if (idx >= 0) this.claims.splice(idx, 1);
  }

  private enqueue(filePath: string): void {
    const abs = path.resolve(filePath);
    if (isIgnoredPath(abs) || this.processed.has(abs)) return;
    if (!this.pending.has(abs)) this.pending.set(abs, { size: -1, stable: 0 });
  }

  /** Stability loop: a file is ready once its size held for N polls. */
  private async tick(): Promise<void> {
    for (const [filePath, state] of [...this.pending]) {
      if (this.processed.has(filePath)) {
        this.pending.delete(filePath); // claimed by a sighting mid-wait
        continue;
      }
      let size: number;
      try {
        const stats = await stat(filePath);
        if (!stats.isFile()) {
          this.pending.delete(filePath);
          continue;
        }
        size = stats.size;
      } catch {
        this.pending.delete(filePath); // vanished mid-write
        continue;
      }
      if (size > 0 && size === state.size) {
        state.stable += 1;
      } else {
        state.size = size;
        state.stable = 0;
      }
      if (state.stable >= this.stablePolls) {
        this.pending.delete(filePath);
        this.processed.add(filePath);
        try {
          await this.handleStableFile(filePath);
        } catch (err) {
          this.log.error(`media-watcher: failed to handle ${filePath}: ${String(err)}`);
        }
      }
    }
  }

  private async handleStableFile(filePath: string): Promise<void> {
    const mime = mimeForPath(filePath);
    const file: MediaFileEvent = {
      path: filePath,
      basename: path.basename(filePath),
      mime,
      kind: attachmentKindForMime(mime),
    };

    // 1. Claims (studio) — FIFO, first kind-match wins.
    const claimIdx = this.claims.findIndex((c) => !c.kinds || c.kinds.has(file.kind));
    if (claimIdx >= 0) {
      const [claim] = this.claims.splice(claimIdx, 1);
      if (claim) {
        clearTimeout(claim.timer);
        claim.resolve(file);
        this.emit({ file, via: 'claim' });
        return;
      }
    }

    // 2. Most recently active turn window (path carries no agent identity).
    const turn = mostRecentActiveTurn(this.turnRegistry);
    if (turn) {
      await this.ingest(file, 'live-window', {
        sessionId: turn.sessionId,
        agentAccountId: turn.agentAccountId ?? null,
        tool: toolFromPath(file.path, file.kind),
      });
      return;
    }

    // 3. Injected pull-direction history-sync lookup.
    if (this.historySync) {
      try {
        const match = await this.historySync(file);
        if (match) {
          await this.ingest(file, 'history-sync', {
            sessionId: match.sessionId,
            agentAccountId: match.agentAccountId ?? null,
            tool: match.tool ?? toolFromPath(file.path, file.kind),
          });
          return;
        }
      } catch (err) {
        this.log.warn(`media-watcher: history-sync failed for ${filePath}: ${String(err)}`);
      }
    }

    // 4. Park — asset row only; a later sighting may correlate it.
    await this.ingest(file, 'parked', { tool: toolFromPath(file.path, file.kind) });
  }

  private async ingest(
    file: MediaFileEvent,
    via: Exclude<MediaWatcherOutcome['via'], 'claim'>,
    opts: { sessionId?: string | null; agentAccountId?: string | null; tool?: string | null },
  ): Promise<void> {
    try {
      const result = await this.pipeline.ingestFile(file.path, opts);
      this.emit({ file, via, sessionId: opts.sessionId ?? null, result });
      this.log.info(
        `media-watcher: ingested ${file.basename} via ${via}` +
          (opts.sessionId ? ` into session ${opts.sessionId}` : ' (no session)'),
      );
    } catch (err) {
      this.emit({ file, via, sessionId: opts.sessionId ?? null, error: err });
      this.log.error(`media-watcher: ingest failed for ${file.path}: ${String(err)}`);
    }
  }

  private emit(outcome: MediaWatcherOutcome): void {
    try {
      this.onOutcome?.(outcome);
    } catch {
      // observer must never break the loop
    }
  }
}

// ---------------------------------------------------------------------------
// Attachment sightings (push direction from services/history-sync.ts)
// ---------------------------------------------------------------------------

/** Structural mirror of history-sync's AttachmentSighting. */
export interface AttachmentSightingLike {
  sessionId: string;
  /** The persisted message row carrying the MEDIA:/Attachment: line. */
  messageId: string;
  /** Path exactly as written in the transcript (container path). */
  path: string;
  role?: string;
}

export interface AttachmentSightingHandlerOptions {
  pipeline: MediaPipeline;
  /** When given, sighted paths are marked processed on the watcher. */
  watcher?: MediaWatcher | null;
  dirs?: OpenclawDirs;
  logger?: MediaLogger;
  /** stat() retries while waiting for the file to be host-visible. */
  statRetries?: number;
  statRetryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the `AttachmentCallback` that server wiring passes to
 * `HistorySync.setAttachmentCallback` (services/history-sync.ts): map the
 * container path to the host, then ingest in ATTACH mode — the attachment
 * lands on the already-persisted completion message, the creation's agent
 * defaults to that message's sender, and the session owner is debited via
 * the sha256+session idempotency key (a no-op when the watcher's live-window
 * path already ingested the same file).
 *
 * Fire-and-forget (the callback contract is synchronous); failures are
 * logged, never thrown. `lastRun` exposes the trailing task for tests.
 */
export function createAttachmentSightingHandler(opts: AttachmentSightingHandlerOptions): {
  (sighting: AttachmentSightingLike): void;
  lastRun: Promise<void>;
} {
  const dirs = opts.dirs ?? resolveOpenclawDirs();
  const log = opts.logger ?? console;
  const retries = opts.statRetries ?? 5;
  const retryDelayMs = opts.statRetryDelayMs ?? 2000;

  const run = async (sighting: AttachmentSightingLike): Promise<void> => {
    const hostPath = containerPathToHost(sighting.path, dirs);
    if (!hostPath) {
      log.warn(
        `media-sighting: path ${sighting.path} (session ${sighting.sessionId}) maps outside the gateway dirs — skipped`,
      );
      return;
    }
    // The completion message is posted AFTER the file is written, but the
    // sshfs bind can lag — retry stat briefly.
    let found = false;
    for (let attempt = 0; attempt < Math.max(1, retries); attempt += 1) {
      try {
        const stats = await stat(hostPath);
        if (stats.isFile() && stats.size > 0) {
          found = true;
          break;
        }
      } catch {
        // not visible yet
      }
      await sleep(retryDelayMs);
    }
    if (!found) {
      log.warn(`media-sighting: ${hostPath} never became visible on the host — skipped`);
      return;
    }

    opts.watcher?.markProcessed(hostPath);
    const kind = attachmentKindForMime(mimeForPath(hostPath));
    await opts.pipeline.ingestFile(hostPath, {
      sessionId: sighting.sessionId,
      messageId: sighting.messageId,
      tool: toolFromPath(hostPath, kind),
    });
    log.info(
      `media-sighting: attached ${path.basename(hostPath)} to message ${sighting.messageId} in session ${sighting.sessionId}`,
    );
  };

  const handler = (sighting: AttachmentSightingLike): void => {
    handler.lastRun = run(sighting).catch((err) => {
      log.error(`media-sighting: failed for ${sighting.path}: ${String(err)}`);
    });
  };
  handler.lastRun = Promise.resolve();
  return handler;
}
