import { describe, expect, it } from 'vitest';

import type { CliExecOptions, OpenClawCliLike, OpenClawCliResult } from '../src/docker';
import { OpenClawMemoryCli } from '../src/memory-cli';

class FakeCli implements OpenClawCliLike {
  readonly calls: readonly string[][] = [];

  constructor(private readonly response: unknown) {}

  async exec(_args: readonly string[], _options?: CliExecOptions): Promise<OpenClawCliResult> {
    throw new Error('not used');
  }

  async execJson<T>(args: readonly string[], _options?: CliExecOptions): Promise<T> {
    (this.calls as string[][]).push([...args]);
    return this.response as T;
  }
}

describe('OpenClawMemoryCli', () => {
  it('applies the exact Eden deep-promotion policy to one explicit agent', async () => {
    const cli = new FakeCli({
      candidates: [{ promoted: true }, { applied: true }, { promoted: false }],
    });
    const result = await new OpenClawMemoryCli(cli).promoteAgent('agent-1');

    expect(cli.calls).toEqual([
      [
        'memory', 'promote', '--agent', 'agent-1', '--limit', '10', '--min-score', '0.55',
        '--min-recall-count', '1', '--min-unique-queries', '1', '--apply', '--json',
      ],
    ]);
    expect(result).toEqual({
      agentId: 'agent-1',
      candidates: 3,
      promoted: 2,
      policy: {
        limit: 10,
        minScore: 0.55,
        minRecallCount: 1,
        minUniqueQueries: 1,
        apply: true,
      },
    });
  });

  it('measures a bounded per-agent search and normalizes the 7.1 JSON envelope', async () => {
    const cli = new FakeCli({
      results: [{ path: 'MEMORY.md', startLine: 2, endLine: 4, score: 0.91, snippet: 'red' }],
    });
    const ticks = [100, 101.234];
    const result = await new OpenClawMemoryCli(cli, { now: () => ticks.shift()! }).searchAgent(
      'agent-1',
      ' favorite color ',
      5,
    );

    expect(cli.calls).toEqual([
      ['memory', 'search', '--agent', 'agent-1', '--query', 'favorite color', '--max-results', '5', '--json'],
    ]);
    expect(result).toEqual({
      agentId: 'agent-1',
      latencyMs: 1.234,
      results: [{ path: 'MEMORY.md', startLine: 2, endLine: 4, score: 0.91, snippet: 'red' }],
    });
  });

  it('rejects unsafe ids and invalid search bounds before invoking the CLI', async () => {
    const cli = new FakeCli([]);
    const memory = new OpenClawMemoryCli(cli);
    await expect(memory.promoteAgent('../all')).rejects.toThrow('invalid OpenClaw agent id');
    await expect(memory.searchAgent('safe', ' ', 5)).rejects.toThrow('must not be empty');
    await expect(memory.searchAgent('safe', 'query', 21)).rejects.toThrow('1 to 20');
    expect(cli.calls).toHaveLength(0);
  });
});
