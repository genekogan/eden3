import { describe, expect, it } from 'vitest';

import {
  OpenClawCli,
  OpenClawCliError,
  extractJson,
  prepareAgentMemoryIndexTarget,
  type ProcessRunner,
} from '../src/docker';

type RunnerCall = { file: string; args: readonly string[]; timeoutMs: number };

function makeRunner(result: { stdout?: string; stderr?: string; exitCode?: number | null }): {
  runner: ProcessRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const runner: ProcessRunner = async (file, args, { timeoutMs }) => {
    calls.push({ file, args, timeoutMs });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
    };
  };
  return { runner, calls };
}

describe('OpenClawCli.exec', () => {
  it('runs plain openclaw commands through docker exec', async () => {
    const { runner, calls } = makeRunner({ stdout: 'ok' });
    const cli = new OpenClawCli({ runner, env: {} });
    const result = await cli.exec(['agents', 'list']);
    expect(result.stdout).toBe('ok');
    expect(calls[0]!.file).toBe('docker');
    expect(calls[0]!.args).toEqual([
      'exec',
      '-u',
      'node',
      'eden3-openclaw',
      'openclaw',
      'agents',
      'list',
    ]);
  });

  it('honors container overrides (option beats env beats default)', async () => {
    const { runner, calls } = makeRunner({});
    await new OpenClawCli({ runner, env: { OPENCLAW_CONTAINER: 'from-env' } }).exec(['x']);
    expect(calls[0]!.args[3]).toBe('from-env');
    await new OpenClawCli({ runner, container: 'explicit', env: { OPENCLAW_CONTAINER: 'from-env' } }).exec(['x']);
    expect(calls[1]!.args[3]).toBe('explicit');
  });

  it('wraps gateway-token commands in sh -c with in-container env expansion', async () => {
    const { runner, calls } = makeRunner({ stdout: '{}' });
    const cli = new OpenClawCli({ runner, env: {} });
    await cli.exec(['cron', 'list', '--json'], { gatewayToken: true });
    const args = calls[0]!.args;
    expect(args.slice(0, 6)).toEqual(['exec', '-u', 'node', 'eden3-openclaw', 'sh', '-c']);
    const script = args[6]!;
    // token comes from the CONTAINER env, never the host argv
    expect(script).toContain('--token "${OPENCLAW_GATEWAY_TOKEN:?');
    expect(script).toContain('exec openclaw "$@"');
    // $0 placeholder then the openclaw args verbatim
    expect(args.slice(7)).toEqual(['openclaw', 'cron', 'list', '--json']);
  });

  it('throws OpenClawCliError with exit code and detail on failure', async () => {
    const { runner } = makeRunner({ exitCode: 1, stderr: 'gateway connect failed: nope' });
    const cli = new OpenClawCli({ runner, env: {} });
    const err = await cli.exec(['cron', 'add']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenClawCliError);
    const cliErr = err as OpenClawCliError;
    expect(cliErr.exitCode).toBe(1);
    expect(cliErr.message).toContain('cron add');
    expect(cliErr.message).toContain('gateway connect failed');
    expect(cliErr.args).toEqual(['cron', 'add']);
  });

  it('passes per-call timeout to the runner', async () => {
    const { runner, calls } = makeRunner({});
    const cli = new OpenClawCli({ runner, env: {}, timeoutMs: 1000 });
    await cli.exec(['x']);
    await cli.exec(['x'], { timeoutMs: 5 });
    expect(calls[0]!.timeoutMs).toBe(1000);
    expect(calls[1]!.timeoutMs).toBe(5);
  });
});

describe('prepareAgentMemoryIndexTarget', () => {
  it('creates the fixed target inside the gateway volume without shell interpolation', async () => {
    const { runner, calls } = makeRunner({});
    await prepareAgentMemoryIndexTarget('banny', { runner, env: {} });
    expect(calls[0]!.file).toBe('docker');
    expect(calls[0]!.args.slice(0, 7)).toEqual([
      'exec',
      '-u',
      'node',
      'eden3-openclaw',
      'sh',
      '-c',
      expect.stringContaining('install -d'),
    ]);
    expect(calls[0]!.args.slice(7)).toEqual([
      'prepare-memory-index',
      '/home/node/.openclaw/state/agent-memory',
      '/home/node/.openclaw/state/agent-memory/banny.sqlite',
    ]);
  });

  it('rejects unsafe ids before spawning and reports container failures', async () => {
    const first = makeRunner({});
    await expect(
      prepareAgentMemoryIndexTarget('../escape', { runner: first.runner, env: {} }),
    ).rejects.toThrow('invalid OpenClaw agent id');
    expect(first.calls).toHaveLength(0);

    const failed = makeRunner({ exitCode: 65, stderr: 'target conflict' });
    await expect(
      prepareAgentMemoryIndexTarget('banny', { runner: failed.runner, env: {} }),
    ).rejects.toThrow('target conflict');
  });
});

describe('OpenClawCli.execJson', () => {
  it('appends --json when absent and parses stdout', async () => {
    const { runner, calls } = makeRunner({ stdout: '{"jobs":[]}' });
    const cli = new OpenClawCli({ runner, env: {} });
    const parsed = await cli.execJson<{ jobs: unknown[] }>(['cron', 'list']);
    expect(parsed.jobs).toEqual([]);
    expect(calls[0]!.args.at(-1)).toBe('--json');
  });

  it('does not duplicate an existing --json flag', async () => {
    const { runner, calls } = makeRunner({ stdout: '[]' });
    const cli = new OpenClawCli({ runner, env: {} });
    await cli.execJson(['agents', 'list', '--json']);
    expect(calls[0]!.args.filter((a) => a === '--json')).toHaveLength(1);
  });

  it('parses JSON preceded by warning noise (observed agents delete output)', async () => {
    // real output shape observed live 2026-07-03 (warning + JSON on success)
    const noisy =
      'gateway connect failed: GatewayClientRequestError: scope upgrade pending approval (requestId: 0e60abca)\n' +
      '{\n  "agentId": "scope-probe",\n  "removedBindings": 0\n}\n';
    const { runner } = makeRunner({ stdout: noisy });
    const cli = new OpenClawCli({ runner, env: {} });
    const parsed = await cli.execJson<{ agentId: string }>(['agents', 'delete', 'scope-probe']);
    expect(parsed.agentId).toBe('scope-probe');
  });

  it('falls back to stderr when stdout is empty', async () => {
    const { runner } = makeRunner({ stdout: '', stderr: 'note\n{"ok":true}' });
    const cli = new OpenClawCli({ runner, env: {} });
    expect(await cli.execJson(['x'])).toEqual({ ok: true });
  });

  it('throws OpenClawCliError when no JSON is present', async () => {
    const { runner } = makeRunner({ stdout: 'not json at all' });
    const cli = new OpenClawCli({ runner, env: {} });
    await expect(cli.execJson(['agents', 'list'])).rejects.toBeInstanceOf(OpenClawCliError);
  });
});

describe('extractJson', () => {
  it('parses clean objects and arrays', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson(' [1,2] ')).toEqual([1, 2]);
  });

  it('skips leading noise lines (with digits and parens)', () => {
    const text = 'GatewayTransportError: gateway closed (1008): pairing required\n{"ok":true}';
    expect(extractJson(text)).toEqual({ ok: true });
  });

  it('handles noise on the same line before the JSON', () => {
    expect(extractJson('warning: things happened {"ok":1}')).toEqual({ ok: 1 });
  });

  it('handles trailing noise after the JSON document', () => {
    expect(extractJson('{"ok":1}\nexit status 0')).toEqual({ ok: 1 });
  });

  it('throws on JSON-free text', () => {
    expect(() => extractJson('nothing here')).toThrow(SyntaxError);
  });
});
