import { execFile } from 'node:child_process';

/**
 * Tiny wrapper around `docker exec -u node <container> openclaw <args...>` with lenient
 * `--json` output parsing.
 *
 * Two invocation modes (originally live-probed 2026-07-03 on OpenClaw
 * 2026.6.10; source-reverified 2026-07-31 against OpenClaw 2026.7.1):
 *
 *   - Config-file commands (`agents add|list|delete`, `config …`) run as plain
 *     `docker exec -u node <container> openclaw <args>` — they do not take `--token`.
 *   - Gateway-WS commands (`cron …`, `devices …`) authenticate per call. We
 *     pass the gateway bearer token via the CONTAINER's own environment
 *     (`OPENCLAW_GATEWAY_TOKEN` is set on eden3-openclaw), wrapped in
 *     `sh -c '… --token "$OPENCLAW_GATEWAY_TOKEN"'` so the token never appears
 *     on the host command line, in host process listings, or in error objects.
 *
 * Output parsing is lenient because the CLI intermixes human noise with JSON
 * (e.g. a `gateway connect failed: …` warning line printed before the JSON
 * body of a succeeding `agents delete`). See {@link extractJson}.
 */

/** Result of a CLI invocation that exited 0. */
export interface OpenClawCliResult {
  stdout: string;
  stderr: string;
}

/** Non-zero exit, spawn failure, timeout, or unparseable JSON output. */
export class OpenClawCliError extends Error {
  constructor(
    message: string,
    /** The openclaw-level args (never contains the token). */
    readonly args: readonly string[],
    /** Process exit code; null on spawn failure/timeout. */
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'OpenClawCliError';
  }
}

/**
 * Injectable process runner (tests). Must RESOLVE with the exit code (null for
 * spawn failure or timeout, with the failure described in stderr) — never
 * reject for a non-zero exit.
 */
export type ProcessRunner = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

const defaultRunner: ProcessRunner = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      file,
      args as string[],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        // execFile sets a numeric `code` for non-zero exits and a string code
        // ("ENOENT") / killed flag (timeout) for spawn-level failures.
        const code = (error as NodeJS.ErrnoException).code;
        const exitCode = typeof code === 'number' ? code : null;
        const extra = exitCode === null ? `${stderr === '' ? '' : '\n'}${error.message}` : '';
        resolve({ stdout, stderr: `${stderr}${extra}`, exitCode });
      },
    );
  });

const MEMORY_INDEX_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MEMORY_INDEX_ROOT = '/home/node/.openclaw/state/agent-memory';
const PREPARE_MEMORY_INDEX_SCRIPT =
  'set -eu; install -d -m 0755 "$1"; if [ ! -e "$2" ]; then install -m 0644 /dev/null "$2"; elif [ ! -f "$2" ]; then echo "memory index target is not a regular file" >&2; exit 65; fi';

export interface PrepareAgentMemoryIndexTargetOptions {
  container?: string;
  timeoutMs?: number;
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
}

/**
 * Ensure the target of an agent's host-visible SQLite symlink exists inside
 * the gateway's VM-native named volume. A fresh dangling symlink would make
 * OpenClaw fall back to checking its SSHFS parent and correctly refuse it.
 */
export async function prepareAgentMemoryIndexTarget(
  openclawId: string,
  options: PrepareAgentMemoryIndexTargetOptions = {},
): Promise<void> {
  if (!MEMORY_INDEX_ID_PATTERN.test(openclawId)) {
    throw new TypeError(`invalid OpenClaw agent id ${JSON.stringify(openclawId)}`);
  }
  const env = options.env ?? process.env;
  const fromEnv = env.OPENCLAW_CONTAINER;
  const container =
    options.container ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : DEFAULT_CONTAINER);
  const target = `${MEMORY_INDEX_ROOT}/${openclawId}.sqlite`;
  const runner = options.runner ?? defaultRunner;
  const { stdout, stderr, exitCode } = await runner(
    'docker',
    [
      'exec',
      '-u',
      'node',
      container,
      'sh',
      '-c',
      PREPARE_MEMORY_INDEX_SCRIPT,
      'prepare-memory-index',
      MEMORY_INDEX_ROOT,
      target,
    ],
    { timeoutMs: options.timeoutMs ?? 10_000 },
  );
  if (exitCode !== 0) {
    const detail = (stderr.trim() !== '' ? stderr : stdout).trim().slice(0, 400);
    throw new OpenClawCliError(
      `prepare memory index target failed (exit ${exitCode ?? 'spawn/timeout'})${detail !== '' ? `: ${detail}` : ''}`,
      ['memory-index', 'prepare', openclawId],
      exitCode,
      stdout,
      stderr,
    );
  }
}

export interface OpenClawCliOptions {
  /** Docker container name; default `OPENCLAW_CONTAINER` env or "eden3-openclaw". */
  container?: string;
  /** Default per-invocation timeout (host side). */
  timeoutMs?: number;
  /** Injectable runner for unit tests. */
  runner?: ProcessRunner;
  /** Env source for the container-name default (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface CliExecOptions {
  /**
   * Authenticate to the gateway WS with the container's own
   * `$OPENCLAW_GATEWAY_TOKEN` (needed by `cron`/`devices` commands; NOT
   * accepted by config-file commands like `agents add`).
   */
  gatewayToken?: boolean;
  timeoutMs?: number;
}

/**
 * Structural interface for consumers ({@link OpenClawCli} implements it) so
 * tests can inject fakes without subclassing.
 */
export interface OpenClawCliLike {
  exec(args: readonly string[], options?: CliExecOptions): Promise<OpenClawCliResult>;
  execJson<T = unknown>(args: readonly string[], options?: CliExecOptions): Promise<T>;
}

/**
 * `sh -c` body for token-authenticated commands. `"$@"` receives the openclaw
 * args verbatim (passed as positional params after the `$0` placeholder), so
 * no shell-quoting of user content ever happens on the host.
 */
const TOKEN_WRAPPER_SCRIPT =
  'exec openclaw "$@" --token "${OPENCLAW_GATEWAY_TOKEN:?OPENCLAW_GATEWAY_TOKEN not set in container}"';

export const DEFAULT_CONTAINER = 'eden3-openclaw';

export class OpenClawCli implements OpenClawCliLike {
  readonly container: string;
  private readonly timeoutMs: number;
  private readonly runner: ProcessRunner;

  constructor(options: OpenClawCliOptions = {}) {
    const env = options.env ?? process.env;
    const fromEnv = env.OPENCLAW_CONTAINER;
    this.container =
      options.container ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : DEFAULT_CONTAINER);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.runner = options.runner ?? defaultRunner;
  }

  /** The argv passed to `docker` (exposed for unit tests). */
  dockerArgs(args: readonly string[], gatewayToken: boolean): string[] {
    return gatewayToken
      ? ['exec', '-u', 'node', this.container, 'sh', '-c', TOKEN_WRAPPER_SCRIPT, 'openclaw', ...args]
      : ['exec', '-u', 'node', this.container, 'openclaw', ...args];
  }

  /** Run `openclaw <args>`; throws {@link OpenClawCliError} on non-zero exit. */
  async exec(args: readonly string[], options: CliExecOptions = {}): Promise<OpenClawCliResult> {
    const dockerArgs = this.dockerArgs(args, options.gatewayToken === true);
    const { stdout, stderr, exitCode } = await this.runner('docker', dockerArgs, {
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    });
    if (exitCode !== 0) {
      const summary = args.slice(0, 2).join(' ');
      const detail = (stderr.trim() !== '' ? stderr : stdout).trim().slice(0, 400);
      throw new OpenClawCliError(
        `openclaw ${summary} failed (exit ${exitCode ?? 'spawn/timeout'})${detail !== '' ? `: ${detail}` : ''}`,
        args,
        exitCode,
        stdout,
        stderr,
      );
    }
    return { stdout, stderr };
  }

  /**
   * Run `openclaw <args> --json` (flag appended when absent) and parse the
   * JSON out of the possibly-noisy output.
   */
  async execJson<T = unknown>(args: readonly string[], options: CliExecOptions = {}): Promise<T> {
    const withJson = args.includes('--json') ? args : [...args, '--json'];
    const { stdout, stderr } = await this.exec(withJson, options);
    try {
      return extractJson(stdout.trim() !== '' ? stdout : stderr) as T;
    } catch {
      throw new OpenClawCliError(
        `openclaw ${args.slice(0, 2).join(' ')} produced no parseable JSON`,
        args,
        0,
        stdout,
        stderr,
      );
    }
  }
}

/**
 * Extract the JSON document from CLI output that may carry human-readable
 * noise before it (and occasionally after it). Tries, in order: the whole
 * trimmed text; the slice from the first `{`/`[`; the slice from the first
 * LINE starting with `{`/`[`; and finally first-open → last-close bracket.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const openIndexes = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter((i) => i >= 0);
  const firstOpen = openIndexes.length > 0 ? Math.min(...openIndexes) : -1;
  if (firstOpen > 0) candidates.push(trimmed.slice(firstOpen));

  const lines = trimmed.split('\n');
  const lineIdx = lines.findIndex((line) => /^[[{]/.test(line.trim()));
  if (lineIdx > 0) candidates.push(lines.slice(lineIdx).join('\n'));

  if (firstOpen >= 0) {
    const lastClose = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (lastClose > firstOpen) candidates.push(trimmed.slice(firstOpen, lastClose + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new SyntaxError('no JSON document found in CLI output');
}
