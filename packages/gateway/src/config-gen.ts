import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { promises as fs, readFileSync, statSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  AGENT_MODEL_OPTIONS,
  AGENT_RUNTIME_OPTIONS,
  DEFAULT_AGENT_RUNTIME_BY_MODEL,
  agentModelSchema,
  agentRuntimeSchema,
  type AgentModel,
  type AgentRuntime,
  type ModelRuntimeDto,
} from '@eden3/shared';

/**
 * Read-merge-write helpers for the gateway's `openclaw.json` (host path
 * `<dataDir>/openclaw.json`, container path `/home/node/.openclaw/openclaw.json`).
 *
 * Writes are atomic (tmp file in the same directory + rename) and preserve the
 * live file's 0600 mode. The gateway itself also rewrites this file (it keeps
 * `.bak` siblings and hot-reloads on change), so helpers here re-read
 * immediately before writing under a same-host advisory lock and only touch
 * the specific keys they own — everything else passes through byte-identically
 * at the JSON level. Config-mutating OpenClaw CLI calls use the same lock.
 *
 * CAUTION: the gateway validates the config schema strictly — unknown/invalid
 * keys make it reject the WHOLE file (e.g. `enabled` on an agents.list entry).
 * Only write keys source-verified against the pinned OpenClaw 2026.7.1 schema.
 */

export class ConfigGenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigGenError';
  }
}

/** Parsed openclaw.json — opaque beyond the keys we manage. */
export type OpenClawConfig = Record<string, unknown>;

export type OpenClawConfigValidator = (configPath: string) => Promise<void>;

export interface ConfigWriteOptions {
  /**
   * Override runtime validation. `undefined` auto-enables it for the repo's
   * live OpenClaw data dir; `null` is reserved for isolated tests/tools.
   */
  validator?: OpenClawConfigValidator | null;
  /** Override lock timing for diagnostics/tests. Production callers omit it. */
  lock?: OpenClawConfigLockOptions;
}

export interface OpenClawConfigLockOptions {
  /** Maximum time to wait for another local writer. Default: 120 seconds. */
  timeoutMs?: number;
  /** Poll interval while another writer owns the lock. Default: 25ms. */
  retryDelayMs?: number;
}

export interface OpenClawConfigMutationResult<T> {
  changed: boolean;
  config: OpenClawConfig;
  result: T;
}

const execFileAsync = promisify(execFile);
const MODULE_REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OPENCLAW_CONFIG_LOCK_FILENAME = '.openclaw.json.eden3.lock';
const DEFAULT_CONFIG_LOCK_TIMEOUT_MS = 120_000;
const DEFAULT_CONFIG_LOCK_RETRY_DELAY_MS = 25;
const INCOMPLETE_CONFIG_LOCK_STALE_MS = 30_000;
interface HeldConfigLock {
  active: boolean;
}
const heldConfigLocks = new AsyncLocalStorage<ReadonlyMap<string, HeldConfigLock>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRuntimeValidate(dataDir: string): boolean {
  return path.resolve(dataDir) === path.resolve(REPO_OPENCLAW_DATA_DIR);
}

/** Validate a candidate through the exact pinned OpenClaw schema. */
async function validateWithOpenClaw(dataDir: string, configPath: string): Promise<void> {
  const relative = path.relative(path.resolve(dataDir), path.resolve(configPath));
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new ConfigGenError(`config preflight path escaped data dir: ${configPath}`);
  }
  const container = process.env.OPENCLAW_CONTAINER?.trim() || 'eden3-openclaw';
  const containerPath = `/home/node/.openclaw/${relative}`;
  try {
    await execFileAsync(
      'docker',
      [
        'exec',
        '-u',
        'node',
        '-e',
        `OPENCLAW_CONFIG_PATH=${containerPath}`,
        container,
        'openclaw',
        'config',
        'validate',
        '--json',
      ],
      { timeout: 20_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
    );
  } catch (err) {
    const failure = err as Error & { stdout?: string; stderr?: string };
    const detail = (failure.stderr?.trim() || failure.stdout?.trim() || failure.message).slice(0, 2_000);
    throw new ConfigGenError(`OpenClaw rejected candidate config: ${detail}`);
  }
}

/** OpenClaw 2026.7.1's schema-valid reference to a container env secret. */
export interface OpenClawEnvSecretRef {
  source: 'env';
  provider: 'default';
  id: string;
}

const OPENCLAW_ENV_SECRET_ID = /^[A-Z][A-Z0-9_]{0,127}$/;

/**
 * Build a schema-valid OpenClaw env SecretRef without ever accepting or
 * persisting the secret value itself.
 */
export function openClawEnvSecretRef(envVar: string): OpenClawEnvSecretRef {
  if (!OPENCLAW_ENV_SECRET_ID.test(envVar)) {
    throw new ConfigGenError(
      'OpenClaw env SecretRef id must match ^[A-Z][A-Z0-9_]{0,127}$',
    );
  }
  return { source: 'env', provider: 'default', id: envVar };
}

/** Resolve a linked worktree to the checkout that owns its common `.git` dir. */
function resolveMainCheckoutRoot(repoRoot: string): string {
  const absoluteRoot = path.resolve(repoRoot);
  const dotGit = path.join(absoluteRoot, '.git');
  try {
    const dotGitStat = statSync(dotGit);
    if (dotGitStat.isDirectory()) return absoluteRoot;
    if (!dotGitStat.isFile()) return absoluteRoot;

    const pointer = readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(.+)$/);
    if (pointer?.[1] === undefined) return absoluteRoot;
    const worktreeGitDir = path.resolve(absoluteRoot, pointer[1].trim());
    const commonDir = readFileSync(path.join(worktreeGitDir, 'commondir'), 'utf8').trim();
    if (commonDir === '') return absoluteRoot;
    const commonGitDir = path.resolve(worktreeGitDir, commonDir);
    return path.basename(commonGitDir) === '.git' ? path.dirname(commonGitDir) : absoluteRoot;
  } catch {
    // Tarballs and installed packages have no Git metadata. Keep their own
    // repository root as the deterministic fallback in that case.
    return absoluteRoot;
  }
}

/**
 * Host directory bind-mounted at `/home/node/.openclaw` in the gateway
 * container. An explicit `OPENCLAW_DATA_DIR` wins. Otherwise linked worktrees
 * use the main checkout's data dir, which is the source mounted by the shared
 * OpenClaw container; a normal checkout keeps its existing repo-local path.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot: string = MODULE_REPO_ROOT,
): string {
  const fromEnv = env.OPENCLAW_DATA_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  return path.join(resolveMainCheckoutRoot(repoRoot), 'infra', 'openclaw', 'data');
}

const REPO_OPENCLAW_DATA_DIR = resolveDataDir({}, MODULE_REPO_ROOT);

export function openclawConfigPath(dataDir: string): string {
  return path.join(dataDir, 'openclaw.json');
}

/** Eden's same-host advisory lock beside openclaw.json. */
export function openclawConfigLockPath(dataDir: string): string {
  return path.join(dataDir, OPENCLAW_CONFIG_LOCK_FILENAME);
}

interface ConfigLockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

function parseConfigLockOwner(raw: string): ConfigLockOwner | undefined {
  try {
    const value = JSON.parse(raw) as Partial<ConfigLockOwner>;
    if (
      Number.isSafeInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.token === 'string' &&
      /^[0-9a-f]{32}$/.test(value.token) &&
      typeof value.createdAt === 'string'
    ) {
      return value as ConfigLockOwner;
    }
  } catch {
    // An owner can die between O_EXCL creation and its metadata write. The
    // incomplete-file age guard below makes that tiny window recoverable.
  }
  return undefined;
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Remove a lock abandoned by a dead local process. A live PID is never
 * evicted: waiting out the configured timeout is safer than concurrent config
 * replacement. Invalid/incomplete owner files receive a generous local-I/O
 * grace period before recovery.
 */
async function reclaimAbandonedConfigLock(lockPath: string): Promise<boolean> {
  let raw: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    const handle = await fs.open(lockPath, 'r');
    try {
      [raw, stat] = await Promise.all([handle.readFile('utf8'), handle.stat()]);
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }

  const owner = parseConfigLockOwner(raw);
  const abandoned =
    owner !== undefined
      ? !localProcessIsAlive(owner.pid)
      : Date.now() - stat.mtimeMs >= INCOMPLETE_CONFIG_LOCK_STALE_MS;
  if (!abandoned) return false;

  // A cooperative live owner cannot replace its own lock metadata. Recheck
  // the bytes immediately before unlink so we never remove a newly acquired
  // lock after observing a stale predecessor.
  try {
    if ((await fs.readFile(lockPath, 'utf8')) !== raw) return false;
    await fs.unlink(lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}

async function acquireOpenClawConfigLock(
  dataDir: string,
  options: OpenClawConfigLockOptions,
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONFIG_LOCK_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_CONFIG_LOCK_RETRY_DELAY_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new ConfigGenError('OpenClaw config lock timeoutMs must be a non-negative number');
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
    throw new ConfigGenError('OpenClaw config lock retryDelayMs must be a positive number');
  }

  await fs.mkdir(dataDir, { recursive: true });
  const lockPath = openclawConfigLockPath(dataDir);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let handle: FileHandle;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (await reclaimAbandonedConfigLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new ConfigGenError(
          `timed out after ${timeoutMs}ms waiting for OpenClaw config lock ${lockPath}`,
        );
      }
      const remaining = deadline - Date.now();
      await sleep(Math.min(remaining, retryDelayMs + Math.floor(Math.random() * retryDelayMs)));
      continue;
    }

    const owner: ConfigLockOwner = {
      pid: process.pid,
      token: randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
      throw err;
    }

    return async () => {
      let current: ConfigLockOwner | undefined;
      try {
        current = parseConfigLockOwner(await fs.readFile(lockPath, 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ConfigGenError(`OpenClaw config lock disappeared while owned: ${lockPath}`);
        }
        throw err;
      }
      if (current?.token !== owner.token || current.pid !== owner.pid) {
        throw new ConfigGenError(`OpenClaw config lock ownership changed unexpectedly: ${lockPath}`);
      }
      await fs.unlink(lockPath);
    };
  }
}

/**
 * Serialize an operation that may cause OpenClaw itself to rewrite
 * openclaw.json (for example `openclaw agents add`). This lock is advisory:
 * every Eden-owned config mutation uses it, and config-mutating CLI calls must
 * be wrapped in it too. Nested acquisition is rejected immediately instead of
 * waiting on the caller's own lock.
 */
export async function withOpenClawConfigLock<T>(
  dataDir: string,
  operation: () => T | Promise<T>,
  options: OpenClawConfigLockOptions = {},
): Promise<T> {
  const absoluteDataDir = path.resolve(dataDir);
  await fs.mkdir(absoluteDataDir, { recursive: true });
  // Canonicalize symlink aliases so nested acquisition detection and the
  // filesystem lock identify the same directory the same way.
  const resolvedDataDir = await fs.realpath(absoluteDataDir);
  const lockPath = openclawConfigLockPath(resolvedDataDir);
  const held = heldConfigLocks.getStore();
  if (held?.get(lockPath)?.active === true) {
    throw new ConfigGenError(
      `nested OpenClaw config lock acquisition for ${lockPath}; use one mutation callback`,
    );
  }

  const release = await acquireOpenClawConfigLock(resolvedDataDir, options);
  const nextHeld = new Map(held ?? []);
  const lockContext: HeldConfigLock = { active: true };
  nextHeld.set(lockPath, lockContext);

  let result!: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await heldConfigLocks.run(nextHeld, operation);
  } catch (err) {
    operationFailed = true;
    operationError = err;
  }
  lockContext.active = false;

  let releaseError: unknown;
  try {
    await release();
  } catch (err) {
    releaseError = err;
  }
  if (operationFailed) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return result;
}

/** Read + parse openclaw.json. Missing file → `{}`; malformed JSON → throws. */
export async function readOpenClawConfig(dataDir: string): Promise<OpenClawConfig> {
  const file = openclawConfigPath(dataDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigGenError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigGenError(`${file} must contain a JSON object`);
  }
  return parsed as OpenClawConfig;
}

/**
 * Atomically replace openclaw.json (tmp in same dir + rename, mode 0600).
 * Live writes are schema-validated against the pinned OpenClaw binary BEFORE
 * rename, then observed again afterward. The second check absorbs the brief
 * SSHFS watcher lag seen on Docker Desktop/Colima without exposing callers to
 * a transient half-observed config.
 */
async function writeOpenClawConfigUnlocked(
  dataDir: string,
  config: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const file = openclawConfigPath(dataDir);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const body = `${JSON.stringify(config, null, 2)}\n`;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(tmp, 'w', 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    const validator =
      options.validator === undefined && shouldRuntimeValidate(dataDir)
        ? (candidate: string) => validateWithOpenClaw(dataDir, candidate)
        : options.validator;
    if (validator !== undefined && validator !== null) await validator(tmp);
    await fs.rename(tmp, file);
    if (validator !== undefined && validator !== null) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          await validator(file);
          return;
        } catch (err) {
          lastError = err;
          await sleep(500);
        }
      }
      throw new ConfigGenError(
        `OpenClaw did not accept the installed config after 6s: ${(lastError as Error)?.message ?? String(lastError)}`,
      );
    }
  } catch (err) {
    await handle?.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Atomically replace the full config while excluding Eden's other writers.
 * This does not rebase a snapshot prepared before lock acquisition; production
 * read-modify-write callers must use {@link mutateOpenClawConfig}.
 */
export async function writeOpenClawConfig(
  dataDir: string,
  config: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<void> {
  await withOpenClawConfigLock(
    dataDir,
    () => writeOpenClawConfigUnlocked(dataDir, config, options),
    options.lock,
  );
}

/**
 * Run one fresh read-modify-write transaction under the cross-process lock.
 * The callback may be async, but must not call another lock-taking config API;
 * nested acquisition fails immediately. A byte-equivalent JSON result is a
 * true no-op, preserving the live file's mtime and ensureBaseline contract.
 */
export async function mutateOpenClawConfig<T>(
  dataDir: string,
  mutation: (config: OpenClawConfig) => T | Promise<T>,
  options: ConfigWriteOptions = {},
): Promise<OpenClawConfigMutationResult<T>> {
  return withOpenClawConfigLock(
    dataDir,
    async () => {
      const config = await readOpenClawConfig(dataDir);
      const before = JSON.stringify(config);
      const result = await mutation(config);
      const changed = JSON.stringify(config) !== before;
      if (changed) await writeOpenClawConfigUnlocked(dataDir, config, options);
      return { changed, config, result };
    },
    options.lock,
  );
}

// ---------------------------------------------------------------------------
// Deep path helpers (internal)
// ---------------------------------------------------------------------------

function getPath(obj: OpenClawConfig, keys: readonly string[]): unknown {
  let node: unknown = obj;
  for (const key of keys) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Set `keys` to `value`, creating intermediate objects. Returns changed?. */
function setPath(obj: OpenClawConfig, keys: readonly string[], value: unknown): boolean {
  let node: Record<string, unknown> = obj;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (next === undefined || next === null) {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
      continue;
    }
    if (typeof next !== 'object' || Array.isArray(next)) {
      throw new ConfigGenError(
        `openclaw.json: cannot set ${keys.join('.')} — ${key} is not an object`,
      );
    }
    node = next as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  if (jsonEqual(node[last], value)) return false;
  node[last] = value;
  return true;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function deletePath(obj: OpenClawConfig, keys: readonly string[]): boolean {
  let node: unknown = obj;
  for (const key of keys.slice(0, -1)) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
  const last = keys[keys.length - 1]!;
  if (!Object.prototype.hasOwnProperty.call(node, last)) return false;
  delete (node as Record<string, unknown>)[last];
  return true;
}

// ---------------------------------------------------------------------------
// ensureBaseline
// ---------------------------------------------------------------------------

export const SANDBOX_EGRESS_NETWORK = 'eden3-sandbox-egress';
export const SANDBOX_EGRESS_PROXY_URL = 'http://eden3-egress-proxy:8080';
export const SANDBOX_NO_PROXY = 'localhost,127.0.0.1,::1';
export const SANDBOX_MEDIA_IMAGE = 'eden3-openclaw-sandbox-media:2026.7.1';
export const SANDBOX_MEMORY_LIMIT = '768m';
export const SANDBOX_PIDS_LIMIT = 128;
export const SANDBOX_USER = '1000:1000';
export const SANDBOX_SHARED_ASSETS_CONTAINER_DIR = '/shared-assets';
export const SANDBOX_PRUNE_IDLE_HOURS = 1;
export const SANDBOX_PRUNE_MAX_AGE_DAYS = 1;
export const AGENT_TURN_TIMEOUT_SECONDS = 1_800;
export const CLAUDE_CLI_FRESH_WATCHDOG_MAX_MS = 900_000;
/** Native Claude install path inside the persistent `/home/node` volume. */
export const CLAUDE_CLI_COMMAND = '/home/node/.local/bin/claude';
export const MEMORY_DREAM_MODEL = 'anthropic/claude-sonnet-4-6';
export const REQUIRED_SANDBOX_MEMORY_TOOLS = ['memory_search', 'memory_get'] as const;
export const EDEN_CRON_PLUGIN_ID = 'eden3-cron';
export const EDEN_CRON_PLUGIN_PATH = '/opt/eden3/openclaw-plugins/eden3-cron';
export const EDEN_CRON_TOOL = 'eden_cron';
export const EDEN_CHANNEL_RUNTIME_PLUGIN_ID = 'eden3-channel-runtime';
export const EDEN_CHANNEL_RUNTIME_PLUGIN_PATH =
  '/opt/eden3/openclaw-plugins/eden3-channel-runtime';
export type HostedChannelRuntimeKind = 'discord' | 'telegram';
export interface HostedChannelRuntimeGroup {
  conversationId: string;
  guildId: string | null;
  allowFrom: string[];
  mentionRequired: true;
}
export interface HostedChannelRuntimeMapping {
  channel: HostedChannelRuntimeKind;
  accountId: string;
  connectionId: string;
  agentId: string;
  bindingId?: string;
  model: string;
  agentRuntime: AgentRuntime;
  groups?: HostedChannelRuntimeGroup[];
}
export const REQUIRED_PLUGIN_ALLOWLIST = [
  'discord',
  'telegram',
  'anthropic',
  'openai',
  'memory-core',
  'fal',
  'google',
  'elevenlabs',
  EDEN_CRON_PLUGIN_ID,
  EDEN_CHANNEL_RUNTIME_PLUGIN_ID,
] as const;
export const REQUIRED_PLUGIN_LOAD_PATHS = [
  EDEN_CRON_PLUGIN_PATH,
  EDEN_CHANNEL_RUNTIME_PLUGIN_PATH,
] as const;

const HOSTED_CHANNEL_CONNECTION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOSTED_CHANNEL_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hostedRuntimePluginConfig(config: OpenClawConfig): Record<string, unknown> {
  const entry = requireObjectAtPath(config, [
    'plugins',
    'entries',
    EDEN_CHANNEL_RUNTIME_PLUGIN_ID,
  ]);
  const raw = entry.config;
  // Older Eden baselines could leave an explicit `null` placeholder here.
  // OpenClaw 2026.7.1 validates plugin schemas before boot and requires the
  // accounts array, so treat null like an absent optional config and converge
  // it to the canonical empty mapping set.
  if (raw === undefined || raw === null) {
    const created = { accounts: [] };
    entry.config = created;
    return created;
  }
  const pluginConfig = objectRecord(raw);
  if (!pluginConfig) {
    throw new ConfigGenError(
      `openclaw.json: plugins.entries.${EDEN_CHANNEL_RUNTIME_PLUGIN_ID}.config must be an object`,
    );
  }
  for (const key of Object.keys(pluginConfig)) {
    if (key !== 'accounts') {
      throw new ConfigGenError(
        `openclaw.json: plugins.entries.${EDEN_CHANNEL_RUNTIME_PLUGIN_ID}.config contains an unsupported key`,
      );
    }
  }
  if (pluginConfig.accounts === undefined) pluginConfig.accounts = [];
  if (!Array.isArray(pluginConfig.accounts)) {
    throw new ConfigGenError(
      `openclaw.json: plugins.entries.${EDEN_CHANNEL_RUNTIME_PLUGIN_ID}.config.accounts must be an array`,
    );
  }
  return pluginConfig;
}

function configuredHostedAgentModel(config: OpenClawConfig, agentId: string): string | undefined {
  const agents = objectRecord(config.agents);
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const matches = list.filter((candidate) => objectRecord(candidate)?.id === agentId);
  if (matches.length !== 1) return undefined;
  const agent = objectRecord(matches[0]);
  const defaults = objectRecord(agents?.defaults);
  const raw = agent?.model ?? defaults?.model;
  if (typeof raw === 'string') return raw.trim() || undefined;
  const primary = objectRecord(raw)?.primary;
  return typeof primary === 'string' && primary.trim() ? primary.trim() : undefined;
}

function configuredHostedAgentRuntime(
  config: OpenClawConfig,
  agentId: string,
  model: string,
): AgentRuntime {
  const agents = objectRecord(config.agents);
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const agent = objectRecord(list.find((candidate) => objectRecord(candidate)?.id === agentId));
  const defaults = objectRecord(agents?.defaults);
  const agentModel = objectRecord(objectRecord(agent?.models)?.[model]);
  const defaultModel = objectRecord(objectRecord(defaults?.models)?.[model]);
  const runtime = objectRecord(agentModel?.agentRuntime)?.id ??
    objectRecord(defaultModel?.agentRuntime)?.id;
  return runtime === 'claude-cli' ? 'claude-cli' : 'openclaw';
}

function resolveHostedRuntimeRoute(
  config: OpenClawConfig,
  channel: HostedChannelRuntimeKind,
  accountId: string,
  expectedAgentId?: string,
  groups: HostedChannelRuntimeGroup[] = [],
): { agentId: string; model: string; agentRuntime: AgentRuntime } {
  const channelConfig = objectRecord(objectRecord(config.channels)?.[channel]);
  const account = objectRecord(objectRecord(channelConfig?.accounts)?.[accountId]);
  if (!channelConfig || channelConfig.enabled === false || !account || account.enabled === false) {
    throw new ConfigGenError(`hosted channel runtime mapping has no enabled account`);
  }
  if (account.groupPolicy !== (groups.length > 0 ? 'allowlist' : 'disabled')) {
    throw new ConfigGenError(`hosted channel runtime account group policy does not match mapping`);
  }
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  const matches = bindings.filter((candidate) => {
    const binding = objectRecord(candidate);
    const match = objectRecord(binding?.match);
    return match?.channel === channel && match?.accountId === accountId;
  });
  const binding = objectRecord(matches[0]);
  const agentId = binding?.agentId;
  if (
    matches.length !== 1 ||
    typeof agentId !== 'string' ||
    !agentId ||
    (expectedAgentId !== undefined && agentId !== expectedAgentId)
  ) {
    throw new ConfigGenError(`hosted channel runtime mapping requires one exact account binding`);
  }
  const model = configuredHostedAgentModel(config, agentId);
  if (!model || !model.includes('/') || /\s/.test(model)) {
    throw new ConfigGenError(`hosted channel runtime mapping requires a configured agent model`);
  }
  return {
    agentId,
    model,
    agentRuntime: configuredHostedAgentRuntime(config, agentId, model),
  };
}

function normalizeHostedRuntimeGroups(raw: unknown): HostedChannelRuntimeGroup[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new ConfigGenError('hosted channel runtime groups must be an array of at most 100 entries');
  }
  const seen = new Set<string>();
  return raw.map((candidate) => {
    const group = objectRecord(candidate);
    if (
      !group ||
      !jsonEqual(Object.keys(group).sort(), ['allowFrom', 'conversationId', 'guildId', 'mentionRequired']) ||
      typeof group.conversationId !== 'string' ||
      !/^-?[0-9]{3,25}$/.test(group.conversationId) ||
      (group.guildId !== null &&
        (typeof group.guildId !== 'string' || !/^\d{3,25}$/.test(group.guildId))) ||
      group.mentionRequired !== true ||
      !Array.isArray(group.allowFrom) ||
      group.allowFrom.length === 0 ||
      group.allowFrom.length > 100 ||
      group.allowFrom.some((id) => typeof id !== 'string' || !/^-?\d{3,25}$/.test(id)) ||
      new Set(group.allowFrom).size !== group.allowFrom.length
    ) {
      throw new ConfigGenError('hosted channel runtime group has an invalid shape');
    }
    const key = `${group.guildId ?? ''}\0${group.conversationId}`;
    if (seen.has(key)) throw new ConfigGenError('hosted channel runtime groups must be unique');
    seen.add(key);
    return {
      conversationId: group.conversationId,
      guildId: group.guildId,
      allowFrom: [...group.allowFrom],
      mentionRequired: true as const,
    };
  });
}

function normalizeHostedRuntimeMapping(
  config: OpenClawConfig,
  raw: unknown,
): HostedChannelRuntimeMapping {
  const value = objectRecord(raw);
  const keys = value ? Object.keys(value).sort() : [];
  const expectedKeys = [
    'accountId',
    'agentId',
    'agentRuntime',
    'channel',
    'connectionId',
    'model',
  ];
  if (!value || keys.some((key) => ![...expectedKeys, 'bindingId', 'groups'].includes(key)) || expectedKeys.some((key) => !keys.includes(key))) {
    throw new ConfigGenError(`hosted channel runtime mapping has an invalid shape`);
  }
  const { channel, accountId, connectionId } = value;
  if (
    (channel !== 'discord' && channel !== 'telegram') ||
    typeof accountId !== 'string' ||
    !HOSTED_CHANNEL_ACCOUNT_ID.test(accountId) ||
    typeof connectionId !== 'string' ||
    !HOSTED_CHANNEL_CONNECTION_UUID.test(connectionId) ||
    (value.bindingId !== undefined &&
      (typeof value.bindingId !== 'string' ||
        !HOSTED_CHANNEL_CONNECTION_UUID.test(value.bindingId)))
  ) {
    throw new ConfigGenError(`hosted channel runtime mapping has an invalid identity`);
  }
  const groups = normalizeHostedRuntimeGroups(value.groups);
  const route = resolveHostedRuntimeRoute(config, channel, accountId, undefined, groups);
  return {
    channel,
    accountId,
    connectionId: connectionId.toLowerCase(),
    ...route,
    ...(typeof value.bindingId === 'string'
      ? { bindingId: value.bindingId.toLowerCase() }
      : {}),
    ...(groups.length > 0 ? { groups } : {}),
  };
}

/** Re-attest model/runtime fields without ever inspecting a channel credential. */
export function reconcileHostedChannelRuntimeMappings(config: OpenClawConfig): boolean {
  const pluginConfig = hostedRuntimePluginConfig(config);
  const raw = pluginConfig.accounts as unknown[];
  const normalized = raw.map((entry) => normalizeHostedRuntimeMapping(config, entry));
  const routeKeys = new Set<string>();
  const connectionIds = new Set<string>();
  for (const entry of normalized) {
    const routeKey = `${entry.channel}\0${entry.accountId}`;
    if (routeKeys.has(routeKey) || connectionIds.has(entry.connectionId)) {
      throw new ConfigGenError(`hosted channel runtime mappings must be one-to-one`);
    }
    routeKeys.add(routeKey);
    connectionIds.add(entry.connectionId);
  }
  normalized.sort((left, right) =>
    `${left.channel}\0${left.accountId}`.localeCompare(`${right.channel}\0${right.accountId}`),
  );
  if (jsonEqual(raw, normalized)) return false;
  pluginConfig.accounts = normalized;
  return true;
}

export function upsertHostedChannelRuntimeMapping(
  config: OpenClawConfig,
  identity: {
    channel: HostedChannelRuntimeKind;
    accountId: string;
    connectionId: string;
    agentId: string;
    bindingId?: string;
    groups?: HostedChannelRuntimeGroup[];
  },
): boolean {
  if (
    !HOSTED_CHANNEL_ACCOUNT_ID.test(identity.accountId) ||
    !HOSTED_CHANNEL_CONNECTION_UUID.test(identity.connectionId) ||
    (identity.bindingId !== undefined &&
      !HOSTED_CHANNEL_CONNECTION_UUID.test(identity.bindingId))
  ) {
    throw new ConfigGenError(`hosted channel runtime mapping has an invalid identity`);
  }
  const pluginConfig = hostedRuntimePluginConfig(config);
  const raw = pluginConfig.accounts as unknown[];
  const groups = normalizeHostedRuntimeGroups(identity.groups);
  const route = resolveHostedRuntimeRoute(
    config,
    identity.channel,
    identity.accountId,
    identity.agentId,
    groups,
  );
  const desired: HostedChannelRuntimeMapping = {
    channel: identity.channel,
    accountId: identity.accountId,
    connectionId: identity.connectionId.toLowerCase(),
    ...route,
    ...(identity.bindingId ? { bindingId: identity.bindingId.toLowerCase() } : {}),
    ...(groups.length > 0 ? { groups } : {}),
  };
  const index = raw.findIndex((candidate) => {
    const mapping = objectRecord(candidate);
    return mapping?.channel === identity.channel && mapping?.accountId === identity.accountId;
  });
  const changed = index === -1 || !jsonEqual(raw[index], desired);
  if (index === -1) raw.push(desired);
  else if (changed) raw[index] = desired;
  return reconcileHostedChannelRuntimeMappings(config) || changed;
}

export function removeHostedChannelRuntimeMapping(
  config: OpenClawConfig,
  channel: HostedChannelRuntimeKind,
  accountId: string,
): boolean {
  const pluginConfig = hostedRuntimePluginConfig(config);
  const raw = pluginConfig.accounts as unknown[];
  const kept = raw.filter((candidate) => {
    const mapping = objectRecord(candidate);
    return mapping?.channel !== channel || mapping?.accountId !== accountId;
  });
  if (kept.length === raw.length) return false;
  pluginConfig.accounts = kept;
  return true;
}

/**
 * Keys eden3 requires of the gateway config (source-verified against 2026.7.1):
 * local mode (REQUIRED — spike config gotcha), token auth, and the OpenAI
 * compat HTTP endpoints we call. Deploy-specific keys (port/bind) are NOT
 * asserted here.
 */
const BASELINE: readonly (readonly [readonly string[], unknown])[] = [
  [['gateway', 'mode'], 'local'],
  [['gateway', 'auth', 'mode'], 'token'],
  [['gateway', 'auth', 'rateLimit', 'maxAttempts'], 10],
  [['gateway', 'auth', 'rateLimit', 'windowMs'], 60_000],
  [['gateway', 'auth', 'rateLimit', 'lockoutMs'], 300_000],
  [['gateway', 'auth', 'rateLimit', 'exemptLoopback'], false],
  [['gateway', 'http', 'endpoints', 'chatCompletions', 'enabled'], true],
  [['gateway', 'http', 'endpoints', 'responses', 'enabled'], true],
  [['gateway', 'controlUi', 'allowedOrigins'], [
    'http://127.0.0.1:18789',
    'http://localhost:18789',
  ]],
  // Discord's native gateway supervisor already reconnects/resumes the socket.
  // The outer 2026.7.1 channel health monitor replaces the whole provider and
  // caused the R3.8 disconnect storm, so keep that second restart loop off.
  [['channels', 'discord', 'healthMonitor', 'enabled'], false],
  // Eden3 is a multi-user hosted surface, so it tightens OpenClaw's
  // personal-assistant defaults: all sessions run in a session-scoped sandbox.
  // Exec is allowed only because the host is pinned to that sandbox; elevated
  // host escape hatches stay disabled. Sandboxes join only an internal Docker
  // network and receive proxy env; direct internet stays blocked while the
  // eden3 egress proxy enforces provider-host allowlisting.
  [['agents', 'defaults', 'timeoutSeconds'], AGENT_TURN_TIMEOUT_SECONDS],
  [['agents', 'defaults', 'cliBackends', 'claude-cli', 'command'], CLAUDE_CLI_COMMAND],
  [['agents', 'defaults', 'sandbox', 'mode'], 'all'],
  [['agents', 'defaults', 'sandbox', 'scope'], 'session'],
  // Source-verified 2026.7.1 pruning bounds prevent abandoned per-session
  // siblings from accumulating indefinitely and slowing Docker inspection.
  [['agents', 'defaults', 'sandbox', 'prune', 'idleHours'], SANDBOX_PRUNE_IDLE_HOURS],
  [['agents', 'defaults', 'sandbox', 'prune', 'maxAgeDays'], SANDBOX_PRUNE_MAX_AGE_DAYS],
  // Mount only the routed agent's canonical workspace at /workspace. The
  // gateway mirrors dataDir at the same Docker-host-visible absolute path, so
  // sibling sandboxes receive the real files rather than an empty bind.
  [['agents', 'defaults', 'sandbox', 'workspaceAccess'], 'rw'],
  [['agents', 'defaults', 'sandbox', 'docker', 'image'], SANDBOX_MEDIA_IMAGE],
  [['agents', 'defaults', 'sandbox', 'docker', 'network'], SANDBOX_EGRESS_NETWORK],
  [['agents', 'defaults', 'sandbox', 'docker', 'memory'], SANDBOX_MEMORY_LIMIT],
  [['agents', 'defaults', 'sandbox', 'docker', 'memorySwap'], SANDBOX_MEMORY_LIMIT],
  [['agents', 'defaults', 'sandbox', 'docker', 'pidsLimit'], SANDBOX_PIDS_LIMIT],
  [['agents', 'defaults', 'sandbox', 'docker', 'user'], SANDBOX_USER],
  // The one global bind is assembled from an absolute host path at runtime.
  // OpenClaw's validator requires this opt-in because the reviewed repo asset
  // tree intentionally sits outside each individual agent workspace.
  [['agents', 'defaults', 'sandbox', 'docker', 'dangerouslyAllowExternalBindSources'], true],
  [['agents', 'defaults', 'sandbox', 'docker', 'env'], {
    HTTP_PROXY: SANDBOX_EGRESS_PROXY_URL,
    HTTPS_PROXY: SANDBOX_EGRESS_PROXY_URL,
    http_proxy: SANDBOX_EGRESS_PROXY_URL,
    https_proxy: SANDBOX_EGRESS_PROXY_URL,
    NO_PROXY: SANDBOX_NO_PROXY,
    no_proxy: SANDBOX_NO_PROXY,
  }],
  // OpenClaw 2026.7.1 applies named profiles before explicit allowlists. The
  // `coding` profile removes plugin tools (including eden_cron) before our
  // narrow allowlist can grant them. `full` delegates the final decision to
  // the explicit allowlist below; the global cron deny still retires native
  // OpenClaw scheduling while the Eden bridge tool remains available.
  [['tools', 'profile'], 'full'],
  [['tools', 'allow'], [
    'group:runtime',
    'group:fs',
    'group:web',
    'group:sessions',
    'group:memory',
    'group:media',
    'tts',
    'group:ui',
    'group:automation',
    EDEN_CRON_TOOL,
    'group:agents',
    'group:plugins',
  ]],
  [['tools', 'sandbox', 'tools', 'allow'], [
    'group:runtime',
    'group:fs',
    'group:web',
    'group:sessions',
    'group:memory',
    'group:media',
    'tts',
    'group:ui',
    'group:automation',
    EDEN_CRON_TOOL,
    'group:agents',
    'group:plugins',
    ...REQUIRED_SANDBOX_MEMORY_TOOLS,
  ]],
  [['tools', 'exec', 'host'], 'sandbox'],
  [['tools', 'exec', 'security'], 'full'],
  [['tools', 'exec', 'ask'], 'off'],
  [['tools', 'exec', 'strictInlineEval'], true],
  [['tools', 'elevated', 'enabled'], false],
  // Media routes are exact because Eden authorizes their quoted cost before
  // provider execution. Cross-provider fallback is deliberately deferred:
  // silently falling from Flux to a premium route would exceed the committed
  // authorization. The before_tool_call hook also rewrites each call to these
  // canonical model refs.
  [['agents', 'defaults', 'imageGenerationModel'], {
    primary: 'fal/fal-ai/flux/dev',
    fallbacks: [],
  }],
  [['agents', 'defaults', 'videoGenerationModel'], {
    primary: 'fal/fal-ai/kling-video/v3/pro/text-to-video',
    fallbacks: [],
  }],
  [['agents', 'defaults', 'musicGenerationModel'], {
    primary: 'google/lyria-3-clip-preview',
    fallbacks: [],
  }],
  [['agents', 'defaults', 'mediaGenerationAutoProviderFallback'], false],
  // Native OpenClaw memory retrieval (2026-07-10): give every agent the
  // memory_search / memory_get tools over its memory files + transcripts
  // (builtin SQLite backend, hybrid vector+keyword). Embeddings via OpenAI
  // (OPENAI_API_KEY is already in the gateway container env). This upgrades
  // agents from the static MEMORY.md bootstrap to on-demand recall of
  // specifics. Proactive (active-memory) and dreaming are intentionally NOT
  // enabled here — active-memory adds a blocking model call before every
  // reply (per-turn cost across all agents), and dreaming would compete with
  // the eden distiller for ownership of MEMORY.md until that is repointed.
  [['agents', 'defaults', 'memorySearch', 'enabled'], true],
  [['agents', 'defaults', 'memorySearch', 'provider'], 'openai'],
  [['agents', 'defaults', 'memorySearch', 'sync', 'embeddingBatchTimeoutSeconds'], 600],
  [['agents', 'defaults', 'memorySearch', 'query', 'hybrid', 'mmr', 'enabled'], true],
  [['agents', 'defaults', 'memorySearch', 'query', 'hybrid', 'temporalDecay', 'enabled'], true],
  [['agents', 'defaults', 'memorySearch', 'query', 'hybrid', 'temporalDecay', 'halfLifeDays'], 30],
  [['memory', 'backend'], 'builtin'],
  [['memory', 'citations'], 'auto'],
  // OpenClaw 2026.7.1 has no managedSchedule switch. Enabling this flag would
  // make memory-core register one global cron that fans out across every
  // configured agent. Eden instead runs an activity-gated per-agent sweep and
  // invokes native promotion itself, so the upstream scheduler must stay off.
  [['plugins', 'entries', 'memory-core', 'subagent', 'allowModelOverride'], true],
  [['plugins', 'entries', 'memory-core', 'subagent', 'allowedModels'], [MEMORY_DREAM_MODEL]],
  [['plugins', 'entries', 'memory-core', 'config', 'dreaming', 'enabled'], false],
  [['plugins', 'entries', 'memory-core', 'config', 'dreaming', 'model'], MEMORY_DREAM_MODEL],
  [['plugins', 'entries', 'memory-core', 'config', 'dreaming', 'phases', 'light', 'enabled'], false],
  [['plugins', 'entries', 'memory-core', 'config', 'dreaming', 'phases', 'deep', 'enabled'], true],
  [['plugins', 'entries', 'memory-core', 'config', 'dreaming', 'phases', 'deep', 'minScore'], 0.55],
  [['plugins', 'entries', 'memory-core', 'config', 'dreaming', 'phases', 'deep', 'minRecallCount'], 1],
  [['plugins', 'entries', 'memory-core', 'config', 'dreaming', 'phases', 'deep', 'minUniqueQueries'], 1],
  [['plugins', 'entries', 'memory-core', 'config', 'dreaming', 'phases', 'deep', 'recencyHalfLifeDays'], 30],
  [['plugins', 'entries', 'memory-core', 'config', 'dreaming', 'phases', 'deep', 'limit'], 10],
  [['plugins', 'entries', 'memory-core', 'config', 'dreaming', 'phases', 'rem', 'enabled'], true],
  [['plugins', 'entries', EDEN_CRON_PLUGIN_ID, 'enabled'], true],
  [['plugins', 'entries', EDEN_CHANNEL_RUNTIME_PLUGIN_ID, 'enabled'], true],
  [
    ['plugins', 'entries', EDEN_CHANNEL_RUNTIME_PLUGIN_ID, 'hooks', 'allowConversationAccess'],
    true,
  ],
  [
    ['plugins', 'entries', EDEN_CHANNEL_RUNTIME_PLUGIN_ID, 'hooks', 'allowPromptInjection'],
    true,
  ],
];

const BASELINE_REMOVALS: readonly (readonly string[])[] = [
  // This belongs to exec-approvals storage, not openclaw.json's tools.exec
  // schema. Remove it if an older Eden3 baseline attempt or manual edit left it
  // behind, because one invalid key makes OpenClaw reject the whole config.
  ['tools', 'exec', 'askFallback'],
];

/** Merge required plugins without deleting or reordering operator additions. */
function mergeRequiredPluginAllowlist(config: OpenClawConfig): boolean {
  const pluginsRaw = config.plugins;
  let plugins: Record<string, unknown>;
  if (pluginsRaw === undefined) {
    plugins = {};
    config.plugins = plugins;
  } else {
    if (typeof pluginsRaw !== 'object' || pluginsRaw === null || Array.isArray(pluginsRaw)) {
      throw new ConfigGenError('openclaw.json: plugins must be an object');
    }
    plugins = pluginsRaw as Record<string, unknown>;
  }

  const allowRaw = plugins.allow;
  if (
    allowRaw !== undefined &&
    (!Array.isArray(allowRaw) || !allowRaw.every((id) => typeof id === 'string'))
  ) {
    throw new ConfigGenError('openclaw.json: plugins.allow must be an array of strings');
  }
  const allow = allowRaw === undefined ? [] : [...(allowRaw as string[])];
  const present = new Set(allow);
  for (const pluginId of REQUIRED_PLUGIN_ALLOWLIST) {
    if (!present.has(pluginId)) {
      allow.push(pluginId);
      present.add(pluginId);
    }
  }
  if (jsonEqual(allowRaw, allow)) return false;
  plugins.allow = allow;
  return true;
}

/** Load image-baked Eden plugins while preserving operator plugin paths. */
function mergeRequiredPluginLoadPaths(config: OpenClawConfig): boolean {
  const load = requireObjectAtPath(config, ['plugins', 'load']);
  const raw = load.paths;
  if (raw !== undefined && (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string'))) {
    throw new ConfigGenError('openclaw.json: plugins.load.paths must be an array of strings');
  }
  const paths = raw === undefined ? [] : [...raw];
  for (const requiredPath of REQUIRED_PLUGIN_LOAD_PATHS) {
    if (!paths.includes(requiredPath)) paths.push(requiredPath);
  }
  if (jsonEqual(raw, paths)) return false;
  load.paths = paths;
  return true;
}

/**
 * D8 retires OpenClaw's native cron control plane. `group:automation`
 * includes the built-in `cron` tool, so deny that exact id globally (deny
 * wins) while leaving the separate `eden_cron` plugin tool available.
 */
function mergeRetiredGatewayCronDeny(config: OpenClawConfig): boolean {
  const tools = requireObjectAtPath(config, ['tools']);
  const raw = tools.deny;
  if (raw !== undefined && (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string'))) {
    throw new ConfigGenError('openclaw.json: tools.deny must be an array of strings');
  }
  const deny = raw === undefined ? [] : [...raw];
  if (!deny.includes('cron')) deny.push('cron');
  if (jsonEqual(raw, deny)) return false;
  tools.deny = deny;
  return true;
}

/**
 * OpenClaw 2026.7.1 rejects tools.sandbox.tools when `allow` and `alsoAllow`
 * coexist. Converge legacy additions plus the load-bearing memory tools into
 * the one canonical `allow` list, then remove `alsoAllow`.
 */
function mergeRequiredSandboxMemoryTools(config: OpenClawConfig): boolean {
  const tools = requireObjectAtPath(config, ['tools', 'sandbox', 'tools']);
  const allowRaw = tools.allow;
  const alsoAllowRaw = tools.alsoAllow;
  if (
    allowRaw !== undefined &&
    (!Array.isArray(allowRaw) || !allowRaw.every((id) => typeof id === 'string'))
  ) {
    throw new ConfigGenError('openclaw.json: tools.sandbox.tools.allow must be an array of strings');
  }
  if (
    alsoAllowRaw !== undefined &&
    (!Array.isArray(alsoAllowRaw) || !alsoAllowRaw.every((id) => typeof id === 'string'))
  ) {
    throw new ConfigGenError('openclaw.json: tools.sandbox.tools.alsoAllow must be an array of strings');
  }
  const allow = allowRaw === undefined ? [] : [...allowRaw];
  const present = new Set(allow);
  for (const tool of [
    ...((alsoAllowRaw as string[] | undefined) ?? []),
    ...REQUIRED_SANDBOX_MEMORY_TOOLS,
  ]) {
    if (!present.has(tool)) {
      allow.push(tool);
      present.add(tool);
    }
  }
  let changed = false;
  if (!jsonEqual(allowRaw, allow)) {
    tools.allow = allow;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(tools, 'alsoAllow')) {
    delete tools.alsoAllow;
    changed = true;
  }
  return changed;
}

function requireObjectAtPath(
  config: OpenClawConfig,
  keys: readonly string[],
): Record<string, unknown> {
  const existing = getPath(config, keys);
  if (existing === undefined) {
    setPath(config, keys, {});
    return getPath(config, keys) as Record<string, unknown>;
  }
  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
    throw new ConfigGenError(`openclaw.json: ${keys.join('.')} must be an object`);
  }
  return existing as Record<string, unknown>;
}

/**
 * OpenClaw's provider catalog is a protected list. Merge Eden's required
 * Anthropic entries by id while preserving every operator/upstream entry and
 * its order.
 */
function mergeAnthropicModelCatalog(config: OpenClawConfig): boolean {
  const provider = requireObjectAtPath(config, ['models', 'providers', 'anthropic']);
  const raw = provider.models;
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new ConfigGenError('openclaw.json: models.providers.anthropic.models must be an array');
  }
  const models = raw === undefined ? [] : [...raw];
  if (
    !models.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).id === 'string',
    )
  ) {
    throw new ConfigGenError(
      'openclaw.json: models.providers.anthropic.models entries must be objects with string ids',
    );
  }
  const requiredIds = new Set(
    AGENT_MODEL_OPTIONS.map((model) => model.slice(model.indexOf('/') + 1)),
  );
  for (let index = 0; index < models.length; index += 1) {
    const entry = models[index] as Record<string, unknown>;
    if (!requiredIds.has(entry.id as string)) continue;
    const rawInput = entry.input;
    if (rawInput !== undefined && (!Array.isArray(rawInput) || !rawInput.every((value) => typeof value === 'string'))) {
      throw new ConfigGenError(`openclaw.json: Anthropic model ${entry.id as string} input must be an array of strings`);
    }
    const input = [...((rawInput as string[] | undefined) ?? [])];
    for (const modality of ['text', 'image']) {
      if (!input.includes(modality)) input.push(modality);
    }
    if (!jsonEqual(rawInput, input)) models[index] = { ...entry, input };
  }
  const present = new Set(
    models.map((entry) => (entry as Record<string, unknown>).id as string),
  );
  for (const model of AGENT_MODEL_OPTIONS) {
    const id = model.slice(model.indexOf('/') + 1);
    if (!present.has(id)) {
      models.push({ id, name: id, input: ['text', 'image'] });
      present.add(id);
    }
  }
  if (jsonEqual(raw, models)) return false;
  provider.models = models;
  return true;
}

/**
 * Complete the model-level four-spot registration: provider catalog entry,
 * explicit runtime, thinking policy, and a pinnable Eden model option. Missing
 * runtime keys get the catalog default; explicit operator toggles survive
 * future ensureBaseline calls.
 * Pattern ported from ~/Dev/claw/AGENTS.md "Claude subscription runtime",
 * 2026-07-31; this implementation remains eden3-owned and config-gen-only.
 */
function mergeModelRuntimeRegistrations(config: OpenClawConfig): boolean {
  let changed = mergeAnthropicModelCatalog(config);
  const modelConfigs = requireObjectAtPath(config, ['agents', 'defaults', 'models']);
  for (const model of AGENT_MODEL_OPTIONS) {
    const raw = modelConfigs[model];
    let modelConfig: Record<string, unknown>;
    if (raw === undefined) {
      modelConfig = {};
      modelConfigs[model] = modelConfig;
      changed = true;
    } else if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      modelConfig = raw as Record<string, unknown>;
    } else {
      throw new ConfigGenError(
        `openclaw.json: agents.defaults.models.${model} must be an object`,
      );
    }

    const paramsRaw = modelConfig.params;
    let params: Record<string, unknown>;
    if (paramsRaw === undefined) {
      params = {};
      modelConfig.params = params;
      changed = true;
    } else if (typeof paramsRaw === 'object' && paramsRaw !== null && !Array.isArray(paramsRaw)) {
      params = paramsRaw as Record<string, unknown>;
    } else {
      throw new ConfigGenError(
        `openclaw.json: agents.defaults.models.${model}.params must be an object`,
      );
    }
    if (params.thinking === undefined) {
      params.thinking = 'off';
      changed = true;
    }

    const runtimeRaw = modelConfig.agentRuntime;
    if (runtimeRaw === undefined) {
      modelConfig.agentRuntime = { id: DEFAULT_AGENT_RUNTIME_BY_MODEL[model] };
      changed = true;
      continue;
    }
    if (
      typeof runtimeRaw !== 'object' ||
      runtimeRaw === null ||
      Array.isArray(runtimeRaw) ||
      !agentRuntimeSchema.safeParse((runtimeRaw as Record<string, unknown>).id).success
    ) {
      throw new ConfigGenError(
        `openclaw.json: agents.defaults.models.${model}.agentRuntime.id must be one of ${AGENT_RUNTIME_OPTIONS.join(', ')}`,
      );
    }
  }
  return changed;
}

/**
 * Raise claude-cli's no-output watchdog only after WS2 has installed a valid
 * backend definition. Creating a reliability-only backend would violate
 * OpenClaw 2026.7.1's required `command` field and reject the whole config.
 */
function mergeClaudeCliFreshWatchdog(config: OpenClawConfig): boolean {
  const cliBackendsRaw = getPath(config, ['agents', 'defaults', 'cliBackends']);
  if (cliBackendsRaw === undefined) return false;
  if (
    typeof cliBackendsRaw !== 'object' ||
    cliBackendsRaw === null ||
    Array.isArray(cliBackendsRaw)
  ) {
    throw new ConfigGenError('openclaw.json: agents.defaults.cliBackends must be an object');
  }
  const claudeCli = (cliBackendsRaw as Record<string, unknown>)['claude-cli'];
  if (claudeCli === undefined) return false;
  if (
    typeof claudeCli !== 'object' ||
    claudeCli === null ||
    Array.isArray(claudeCli) ||
    typeof (claudeCli as Record<string, unknown>).command !== 'string'
  ) {
    throw new ConfigGenError(
      'openclaw.json: agents.defaults.cliBackends.claude-cli must define command before its watchdog can be managed',
    );
  }
  return setPath(
    config,
    [
      'agents',
      'defaults',
      'cliBackends',
      'claude-cli',
      'reliability',
      'watchdog',
      'fresh',
      'maxMs',
    ],
    CLAUDE_CLI_FRESH_WATCHDOG_MAX_MS,
  );
}

/** Resolve the repo-managed, host-visible asset tree used by sandbox binds. */
export function resolveSandboxAssetsDir(
  _dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.EDEN3_SANDBOX_ASSETS_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  // OPENCLAW_DATA_DIR is deliberately relocatable for isolated reviews and
  // staging clones. Assets belong to the checkout, not to a guessed number of
  // parent directories above that runtime path. The old derivation produced
  // `var/assets/sandbox` for review runtimes, which the Docker policy guard
  // correctly rejected and surfaced to users as an opaque internal error.
  return path.join(resolveMainCheckoutRoot(MODULE_REPO_ROOT), 'assets', 'sandbox');
}

export interface ConfigGenOptions {
  dataDir?: string;
  sharedAssetsDir?: string;
}

/**
 * Assert the eden3 gateway baseline into openclaw.json, writing only when
 * something actually changed. Idempotent — safe to call on every API boot.
 */
export async function ensureBaseline(
  options: ConfigGenOptions = {},
): Promise<{ changed: boolean; config: OpenClawConfig }> {
  const dataDir = options.dataDir ?? resolveDataDir();
  const mutation = await mutateOpenClawConfig(dataDir, (config) => {
    let changed = false;
    for (const [keys, value] of BASELINE) {
      if (setPath(config, keys, value)) changed = true;
    }
    const sharedAssetsDir = path.resolve(
      options.sharedAssetsDir ?? resolveSandboxAssetsDir(dataDir),
    );
    if (
      setPath(config, ['agents', 'defaults', 'sandbox', 'docker', 'binds'], [
        `${sharedAssetsDir}:${SANDBOX_SHARED_ASSETS_CONTAINER_DIR}:ro`,
      ])
    ) {
      changed = true;
    }
    for (const keys of BASELINE_REMOVALS) {
      if (deletePath(config, keys)) changed = true;
    }
    if (mergeRequiredPluginAllowlist(config)) changed = true;
    if (mergeRequiredPluginLoadPaths(config)) changed = true;
    if (mergeRetiredGatewayCronDeny(config)) changed = true;
    if (mergeRequiredSandboxMemoryTools(config)) changed = true;
    if (mergeModelRuntimeRegistrations(config)) changed = true;
    if (reconcileHostedChannelRuntimeMappings(config)) changed = true;
    if (mergeClaudeCliFreshWatchdog(config)) changed = true;
    // Older registrations point at `/home/node/.openclaw`, a path that exists
    // only inside the gateway. The host Docker daemon creates sibling sandbox
    // mounts, so converge every workspace onto dataDir's host-visible mirror.
    const list = getPath(config, ['agents', 'list']);
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const entry = item as Record<string, unknown>;
        if (typeof entry.id !== 'string' || entry.id.trim() === '') continue;
        const expected = path.join(
          dataDir,
          entry.id === 'main' ? 'workspace' : `workspace-${entry.id}`,
        );
        if (entry.workspace !== expected) {
          entry.workspace = expected;
          changed = true;
        }
      }
    }
    return changed;
  });
  return { changed: mutation.changed, config: mutation.config };
}

/** Read the effective model-scoped runtimes without mutating openclaw.json. */
export async function getModelRuntimeCatalog(
  options: ConfigGenOptions = {},
): Promise<ModelRuntimeDto[]> {
  const dataDir = options.dataDir ?? resolveDataDir();
  const config = await readOpenClawConfig(dataDir);
  return AGENT_MODEL_OPTIONS.map((model) => {
    const raw = getPath(config, [
      'agents',
      'defaults',
      'models',
      model,
      'agentRuntime',
      'id',
    ]);
    if (raw === undefined) {
      return { model, agentRuntime: DEFAULT_AGENT_RUNTIME_BY_MODEL[model] };
    }
    const parsed = agentRuntimeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigGenError(
        `openclaw.json: agents.defaults.models.${model}.agentRuntime.id must be one of ${AGENT_RUNTIME_OPTIONS.join(', ')}`,
      );
    }
    return { model, agentRuntime: parsed.data };
  });
}

/** Resolve one model's effective runtime from the canonical config catalog. */
export async function getModelAgentRuntime(
  model: string,
  options: ConfigGenOptions = {},
): Promise<AgentRuntime> {
  const parsedModel = agentModelSchema.safeParse(model);
  if (!parsedModel.success) {
    throw new ConfigGenError(`unsupported Eden agent model \"${model}\"`);
  }
  const catalog = await getModelRuntimeCatalog(options);
  return catalog.find((entry) => entry.model === parsedModel.data)!.agentRuntime;
}

/**
 * Hot-toggle a model between direct provider API and the subscription-backed
 * Claude CLI. No fallbacks are written: a CLI auth/runtime failure must surface
 * loudly so Eden can refund the turn instead of silently spending API credit.
 */
export async function setModelAgentRuntime(
  model: AgentModel,
  agentRuntime: AgentRuntime,
  options: ConfigGenOptions = {},
): Promise<{ changed: boolean; model: AgentModel; agentRuntime: AgentRuntime }> {
  const parsedModel = agentModelSchema.parse(model);
  const parsedRuntime = agentRuntimeSchema.parse(agentRuntime);
  const dataDir = options.dataDir ?? resolveDataDir();
  const mutation = await mutateOpenClawConfig(dataDir, (config) => {
    setPath(
      config,
      ['agents', 'defaults', 'cliBackends', 'claude-cli', 'command'],
      CLAUDE_CLI_COMMAND,
    );
    mergeModelRuntimeRegistrations(config);
    mergeClaudeCliFreshWatchdog(config);
    setPath(
      config,
      ['agents', 'defaults', 'models', parsedModel, 'agentRuntime'],
      { id: parsedRuntime },
    );
    if (
      getPath(config, ['plugins', 'entries', EDEN_CHANNEL_RUNTIME_PLUGIN_ID]) !== undefined
    ) {
      reconcileHostedChannelRuntimeMappings(config);
    }
  });
  return { changed: mutation.changed, model: parsedModel, agentRuntime: parsedRuntime };
}

// ---------------------------------------------------------------------------
// registerAgentConfig
// ---------------------------------------------------------------------------

/**
 * Register one agent through Eden's atomic, preflight-validated config writer.
 *
 * OpenClaw's `agents add` command performs the same small `agents.list` edit,
 * but starting a second full CLI runtime becomes slower than the UI request
 * budget once the migrated registry contains hundreds of agents. Eden renders
 * the complete workspace itself, so it does not need the CLI's starter-file
 * side effect. The pinned OpenClaw validator still checks the candidate before
 * it can replace the live config.
 */
export async function registerAgentConfig(
  openclawId: string,
  model: string,
  workspace: string,
  options: ConfigGenOptions = {},
): Promise<{ changed: boolean; added: boolean }> {
  const parsedModel = agentModelSchema.parse(model);
  const dataDir = options.dataDir ?? resolveDataDir();
  const mutation = await mutateOpenClawConfig(dataDir, (config) => {
    const agents = objectRecord(config.agents) ?? {};
    if (config.agents === undefined) config.agents = agents;
    else if (!objectRecord(config.agents)) {
      throw new ConfigGenError('openclaw.json: agents must be an object');
    }

    const existing = agents.list;
    if (existing === undefined) agents.list = [];
    else if (!Array.isArray(existing)) {
      throw new ConfigGenError('openclaw.json: agents.list must be an array');
    }
    const list = agents.list as unknown[];
    const matches = list.filter(
      (item) => objectRecord(item)?.id === openclawId,
    );
    if (matches.length > 1) {
      throw new ConfigGenError(`openclaw.json contains duplicate agent "${openclawId}"`);
    }
    if (matches.length === 1) return false;

    list.push({
      id: openclawId,
      name: openclawId,
      workspace: path.resolve(workspace),
      agentDir: `/home/node/.openclaw/agents/${openclawId}/agent`,
      model: parsedModel,
    });
    return true;
  });
  return { changed: mutation.changed, added: mutation.result };
}

// ---------------------------------------------------------------------------
// setAgentModel
// ---------------------------------------------------------------------------

/**
 * Point an existing `agents.list` entry at a different model (e.g.
 * "anthropic/claude-haiku-4-5"). The gateway hot-reloads the file. Throws
 * {@link ConfigGenError} when the agent is not registered — registration is
 * the provisioner's job (`openclaw agents add`), not a config edit.
 */
export async function setAgentModel(
  openclawId: string,
  model: string,
  options: ConfigGenOptions = {},
): Promise<{ changed: boolean }> {
  const dataDir = options.dataDir ?? resolveDataDir();
  const mutation = await mutateOpenClawConfig(dataDir, (config) => {
    const list = getPath(config, ['agents', 'list']);
    if (!Array.isArray(list)) {
      throw new ConfigGenError(
        `openclaw.json has no agents.list — agent "${openclawId}" is not registered`,
      );
    }
    const entry = list.find(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>).id === openclawId,
    );
    if (entry === undefined) {
      throw new ConfigGenError(
        `agent "${openclawId}" not found in agents.list — provision it first (openclaw agents add)`,
      );
    }
    if (entry.model !== model) entry.model = model;
    if (
      getPath(config, ['plugins', 'entries', EDEN_CHANNEL_RUNTIME_PLUGIN_ID]) !== undefined
    ) {
      reconcileHostedChannelRuntimeMappings(config);
    }
  });
  return { changed: mutation.changed };
}

/**
 * Set the final skill allowlist for a registered agent. OpenClaw treats
 * `agents.list[].skills` as a replacement list, not a merge with defaults.
 * Passing [] explicitly exposes no skills.
 */
export async function setAgentSkills(
  openclawId: string,
  skills: string[],
  options: ConfigGenOptions = {},
): Promise<{ changed: boolean }> {
  const dataDir = options.dataDir ?? resolveDataDir();
  const mutation = await mutateOpenClawConfig(dataDir, (config) => {
    const list = getPath(config, ['agents', 'list']);
    if (!Array.isArray(list)) {
      throw new ConfigGenError(
        `openclaw.json has no agents.list — agent "${openclawId}" is not registered`,
      );
    }
    const entry = list.find(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>).id === openclawId,
    );
    if (entry === undefined) {
      throw new ConfigGenError(
        `agent "${openclawId}" not found in agents.list — provision it first (openclaw agents add)`,
      );
    }
    const normalized = [...new Set(skills.map((skill) => skill.trim()).filter(Boolean))].sort();
    if (!Array.isArray(entry.skills) || !jsonEqual(entry.skills, normalized)) {
      entry.skills = normalized;
    }
  });
  return { changed: mutation.changed };
}

/**
 * Set the final per-agent OpenClaw tool allowlist. This writes only
 * `agents.list[].tools.allow` and preserves neighboring agent tool policy
 * (`tools.exec`, `tools.sandbox`, `tools.deny`, etc.). Passing [] explicitly
 * exposes no normal tools for that agent.
 */
export async function setAgentToolGroups(
  openclawId: string,
  toolGroups: string[],
  options: ConfigGenOptions = {},
): Promise<{ changed: boolean }> {
  const dataDir = options.dataDir ?? resolveDataDir();
  const mutation = await mutateOpenClawConfig(dataDir, (config) => {
    const list = getPath(config, ['agents', 'list']);
    if (!Array.isArray(list)) {
      throw new ConfigGenError(
        `openclaw.json has no agents.list — agent "${openclawId}" is not registered`,
      );
    }
    const entry = list.find(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>).id === openclawId,
    );
    if (entry === undefined) {
      throw new ConfigGenError(
        `agent "${openclawId}" not found in agents.list — provision it first (openclaw agents add)`,
      );
    }

    const normalized = normalizeToolAllowlist(toolGroups);
    const currentTools = entry.tools;
    let tools: Record<string, unknown>;
    if (currentTools === undefined || currentTools === null) {
      tools = {};
      entry.tools = tools;
    } else if (typeof currentTools === 'object' && !Array.isArray(currentTools)) {
      tools = currentTools as Record<string, unknown>;
    } else {
      throw new ConfigGenError(`agents.list.${openclawId}.tools is not an object`);
    }

    if (!Array.isArray(tools.allow) || !jsonEqual(tools.allow, normalized)) {
      tools.allow = normalized;
    }
  });
  return { changed: mutation.changed };
}

function normalizeToolAllowlist(toolGroups: string[]): string[] {
  const normalized = [...new Set(toolGroups.map((tool) => tool.trim()).filter(Boolean))];
  if (normalized.includes('group:media') && !normalized.includes('tts')) {
    normalized.splice(normalized.indexOf('group:media') + 1, 0, 'tts');
  }
  if (normalized.includes('group:automation') && !normalized.includes(EDEN_CRON_TOOL)) {
    normalized.splice(normalized.indexOf('group:automation') + 1, 0, EDEN_CRON_TOOL);
  }
  return normalized;
}
