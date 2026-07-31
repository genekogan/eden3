import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeTranscriptUsageCapture,
  parseClaudeTranscriptUsage,
} from '../src/claude-transcript';

const startedAtMs = Date.parse('2026-07-31T12:00:00.000Z');

function line(value: unknown): string {
  return JSON.stringify(value);
}

function assistant(
  id: string,
  usage: Record<string, number>,
  timestamp = '2026-07-31T12:00:01.000Z',
) {
  return {
    type: 'assistant',
    timestamp,
    message: { id, model: 'claude-sonnet-4-6', usage, content: [{ type: 'text', text: 'ok' }] },
  };
}

describe('parseClaudeTranscriptUsage', () => {
  it('matches a hand-computed sample and dedupes repeated message.id records', () => {
    const first = assistant('msg_1', {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40,
    });
    const second = assistant('msg_2', {
      input_tokens: 7,
      output_tokens: 3,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 11,
    });
    const parsed = parseClaudeTranscriptUsage(
      [line(first), line(first), line(second), '{malformed'].join('\n'),
      { claudeSessionId: 'session-12345678', startedAtMs },
    );

    expect(parsed).toEqual({
      usage: {
        promptTokens: 158, // input 107 + cache-read 51
        completionTokens: 23,
        cachedTokens: 51,
        cacheWriteTokens: 35,
        totalTokens: 216,
      },
      claudeSessionId: 'session-12345678',
      providerMessageIds: ['msg_1', 'msg_2'],
      models: ['claude-sonnet-4-6'],
    });
  });

  it('excludes earlier/error rows and returns undefined without a usable message id', () => {
    const before = assistant(
      'msg_before',
      { input_tokens: 999 },
      '2026-07-31T11:59:59.999Z',
    );
    const error = { ...assistant('msg_error', { input_tokens: 999 }), isApiErrorMessage: true };
    const missingId = {
      type: 'assistant',
      timestamp: '2026-07-31T12:00:02.000Z',
      message: { usage: { input_tokens: 10 } },
    };
    expect(
      parseClaudeTranscriptUsage([line(before), line(error), line(missingId)].join('\n'), {
        claudeSessionId: 'session-12345678',
        startedAtMs,
      }),
    ).toBeUndefined();
  });

  it('ignores structural zero-usage rows and accepts a later populated duplicate', () => {
    const empty = assistant('msg_reused', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    const populated = assistant('msg_reused', {
      input_tokens: 12,
      output_tokens: 3,
    });

    expect(
      parseClaudeTranscriptUsage(line(empty), {
        claudeSessionId: 'session-12345678',
        startedAtMs,
      }),
    ).toBeUndefined();
    expect(
      parseClaudeTranscriptUsage([line(empty), line(populated)].join('\n'), {
        claudeSessionId: 'session-12345678',
        startedAtMs,
      }),
    ).toMatchObject({
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
      providerMessageIds: ['msg_reused'],
    });
  });

  it('derives prompt usage from a total-only transcript without double-counting cache writes', () => {
    const parsed = parseClaudeTranscriptUsage(
      line(
        assistant('msg_total', {
          output_tokens: 5,
          cache_creation_input_tokens: 7,
          total_tokens: 32,
        }),
      ),
      { claudeSessionId: 'session-12345678', startedAtMs },
    );

    expect(parsed?.usage).toEqual({
      promptTokens: 20,
      completionTokens: 5,
      cachedTokens: 0,
      cacheWriteTokens: 7,
      totalTokens: 32,
    });
  });
});

describe('ClaudeTranscriptUsageCapture', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('resolves the OpenClaw cliSessionBinding and reads the exact Claude transcript', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-claude-usage-'));
    dirs.push(dataDir);
    const sessionsDir = path.join(dataDir, 'agents', 'bot', 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:bot:eden3:s:test': {
          cliSessionBindings: { 'claude-cli': { sessionId: 'claude-session-1234' } },
        },
      }),
    );
    const calls: string[][] = [];
    const capture = new ClaudeTranscriptUsageCapture({
      dataDir,
      container: 'test-openclaw',
      runner: async (_file, args) => {
        calls.push([...args]);
        return {
          stdout: line(assistant('msg_exact', { input_tokens: 2, output_tokens: 1 })),
          stderr: '',
          exitCode: 0,
        };
      },
    });

    const result = await capture.capture({
      agentId: 'bot',
      sessionKey: 'eden3:s:test',
      startedAtMs,
    });
    expect(result?.providerMessageIds).toEqual(['msg_exact']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['test-openclaw', 'claude-session-1234']));
  });
});
