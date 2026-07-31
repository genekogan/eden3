import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONTAINER } from './docker';
import { resolveDataDir } from './config-gen';
import type { GatewayUsage } from './types';

const OPENCLAW_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CLAUDE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
const TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;

export interface ClaudeTranscriptUsageResult {
  usage: GatewayUsage;
  claudeSessionId: string;
  providerMessageIds: string[];
  models: string[];
}

export interface ClaudeTranscriptCaptureParams {
  agentId: string;
  /** Scoped or unscoped Eden/OpenClaw session key. */
  sessionKey: string;
  /** Only provider messages at or after this instant belong to the turn. */
  startedAtMs: number;
}

export interface ClaudeTranscriptUsageCaptureLike {
  capture(
    params: ClaudeTranscriptCaptureParams,
  ): Promise<ClaudeTranscriptUsageResult | undefined>;
}

interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse Claude Code JSONL and aggregate one turn's provider calls. Claude
 * repeats one assistant message on multiple content-block lines, so the
 * identity is deliberately `(claudeSessionId, message.id)`.
 * Dedupe pattern ported from ~/Dev/claw/AGENTS.md "Plan-usage forensics",
 * 2026-07-31; transcript discovery and attribution are eden3-owned here.
 */
export function parseClaudeTranscriptUsage(
  jsonl: string,
  options: { claudeSessionId: string; startedAtMs: number },
): ClaudeTranscriptUsageResult | undefined {
  const seen = new Set<string>();
  const providerMessageIds: string[] = [];
  const models = new Set<string>();
  const aggregate: TranscriptUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };

  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
    const row = record as Record<string, unknown>;
    if (row.type !== 'assistant' || row.isApiErrorMessage === true) continue;
    const at = timestampMs(row.timestamp);
    if (at === undefined || at < options.startedAtMs) continue;
    if (typeof row.message !== 'object' || row.message === null || Array.isArray(row.message)) {
      continue;
    }
    const message = row.message as Record<string, unknown>;
    if (typeof message.id !== 'string' || message.id === '') continue;
    const dedupeKey = `${options.claudeSessionId}\u0000${message.id}`;
    if (seen.has(dedupeKey)) continue;
    if (typeof message.usage !== 'object' || message.usage === null || Array.isArray(message.usage)) {
      continue;
    }
    const usage = message.usage as Record<string, unknown>;
    const inputTokens = finiteTokenCount(usage.input_tokens);
    const outputTokens = finiteTokenCount(usage.output_tokens);
    const cacheReadTokens = finiteTokenCount(usage.cache_read_input_tokens);
    const cacheWriteTokens = finiteTokenCount(usage.cache_creation_input_tokens);
    const componentTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    const reportedTotal = finiteTokenCount(usage.total_tokens);
    // Claude occasionally writes structural assistant rows whose `usage`
    // object is present but empty/all-zero. They are not provider calls and
    // must not make an otherwise-valid compat tail look like a zero-token
    // success. Keep the id eligible for a later, populated duplicate record.
    if (componentTotal === 0 && reportedTotal === 0) continue;
    seen.add(dedupeKey);
    providerMessageIds.push(message.id);
    if (typeof message.model === 'string' && message.model !== '') models.add(message.model);
    aggregate.inputTokens += inputTokens;
    aggregate.outputTokens += outputTokens;
    aggregate.cacheReadTokens += cacheReadTokens;
    aggregate.cacheWriteTokens += cacheWriteTokens;
    aggregate.totalTokens += Math.max(componentTotal, reportedTotal);
  }

  if (providerMessageIds.length === 0) return undefined;
  const knownPromptTokens = aggregate.inputTokens + aggregate.cacheReadTokens;
  // `total_tokens` is only a fallback when a transcript producer omits one of
  // the prompt components. Cache writes are billed separately and therefore
  // must be removed before deriving the prompt quantity.
  const derivedPromptTokens = Math.max(
    0,
    aggregate.totalTokens - aggregate.outputTokens - aggregate.cacheWriteTokens,
  );
  return {
    usage: {
      // Match OpenClaw's compat convention: prompt = uncached input + cache
      // reads; cache writes stay separate so pricing never double-counts them.
      promptTokens: Math.max(knownPromptTokens, derivedPromptTokens),
      completionTokens: aggregate.outputTokens,
      cachedTokens: aggregate.cacheReadTokens,
      cacheWriteTokens: aggregate.cacheWriteTokens,
      totalTokens: aggregate.totalTokens,
    },
    claudeSessionId: options.claudeSessionId,
    providerMessageIds,
    models: [...models],
  };
}

type ProcessRunner = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

const defaultRunner: ProcessRunner = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      file,
      args as string[],
      { timeout: timeoutMs, maxBuffer: TRANSCRIPT_MAX_BYTES + 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : (error as NodeJS.ErrnoException).code;
        resolve({
          stdout,
          stderr,
          exitCode: error === null ? 0 : typeof code === 'number' ? code : null,
        });
      },
    );
  });

// Claude projects are one directory below this root. Return at most the last
// 16 MiB; the host parser discards an initial partial JSONL record.
const READ_TRANSCRIPT_SCRIPT = String.raw`
const fs=require('node:fs'),path=require('node:path');
const root='/home/node/.claude/projects',sid=process.argv[1],limit=16777216;
let found='';
for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  if(!entry.isDirectory()) continue;
  const candidate=path.join(root,entry.name,sid+'.jsonl');
  if(fs.existsSync(candidate)){found=candidate;break;}
}
if(!found) process.exit(4);
const stat=fs.statSync(found),start=Math.max(0,stat.size-limit),length=stat.size-start;
const buffer=Buffer.alloc(length),fd=fs.openSync(found,'r');
fs.readSync(fd,buffer,0,length,start);fs.closeSync(fd);
let text=buffer.toString('utf8');
if(start>0){const newline=text.indexOf('\n');text=newline<0?'':text.slice(newline+1);}
process.stdout.write(text);
`;

export interface ClaudeTranscriptUsageCaptureOptions {
  dataDir?: string;
  container?: string;
  timeoutMs?: number;
  runner?: ProcessRunner;
}

/** Production reader for Claude transcripts in the persistent home volume. */
export class ClaudeTranscriptUsageCapture implements ClaudeTranscriptUsageCaptureLike {
  private readonly dataDir: string;
  private readonly container: string;
  private readonly timeoutMs: number;
  private readonly runner: ProcessRunner;

  constructor(options: ClaudeTranscriptUsageCaptureOptions = {}) {
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.container = options.container ?? process.env.OPENCLAW_CONTAINER ?? DEFAULT_CONTAINER;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.runner = options.runner ?? defaultRunner;
  }

  async capture(
    params: ClaudeTranscriptCaptureParams,
  ): Promise<ClaudeTranscriptUsageResult | undefined> {
    if (!OPENCLAW_ID_PATTERN.test(params.agentId)) {
      throw new Error(`invalid OpenClaw agent id \"${params.agentId}\" for Claude usage capture`);
    }
    const scoped = params.sessionKey.startsWith(`agent:${params.agentId}:`)
      ? params.sessionKey
      : `agent:${params.agentId}:${params.sessionKey}`;
    const storePath = path.join(
      this.dataDir,
      'agents',
      params.agentId,
      'sessions',
      'sessions.json',
    );
    let store: unknown;
    try {
      store = JSON.parse(await fs.readFile(storePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (typeof store !== 'object' || store === null || Array.isArray(store)) return undefined;
    const entries = store as Record<string, unknown>;
    const rawEntry =
      entries[scoped] ??
      Object.entries(entries).find(([key]) => key.toLowerCase() === scoped.toLowerCase())?.[1];
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      return undefined;
    }
    const entry = rawEntry as Record<string, unknown>;
    const bindings = entry.cliSessionBindings;
    const claudeBinding =
      typeof bindings === 'object' && bindings !== null && !Array.isArray(bindings)
        ? (bindings as Record<string, unknown>)['claude-cli']
        : undefined;
    const bindingSessionId =
      typeof claudeBinding === 'object' && claudeBinding !== null && !Array.isArray(claudeBinding)
        ? (claudeBinding as Record<string, unknown>).sessionId
        : undefined;
    const legacyIds = entry.cliSessionIds;
    const legacySessionId =
      typeof legacyIds === 'object' && legacyIds !== null && !Array.isArray(legacyIds)
        ? (legacyIds as Record<string, unknown>)['claude-cli']
        : undefined;
    const claudeSessionId =
      typeof bindingSessionId === 'string'
        ? bindingSessionId
        : typeof legacySessionId === 'string'
          ? legacySessionId
          : typeof entry.claudeCliSessionId === 'string'
            ? entry.claudeCliSessionId
            : undefined;
    if (!claudeSessionId || !CLAUDE_SESSION_ID_PATTERN.test(claudeSessionId)) return undefined;

    const result = await this.runner(
      'docker',
      [
        'exec',
        '-u',
        'node',
        this.container,
        'node',
        '-e',
        READ_TRANSCRIPT_SCRIPT,
        claudeSessionId,
      ],
      { timeoutMs: this.timeoutMs },
    );
    if (result.exitCode === 4) return undefined;
    if (result.exitCode !== 0) {
      throw new Error(
        `Claude transcript read failed (exit ${result.exitCode ?? 'spawn/timeout'}): ${result.stderr.trim().slice(0, 240)}`,
      );
    }
    return parseClaudeTranscriptUsage(result.stdout, {
      claudeSessionId,
      startedAtMs: params.startedAtMs,
    });
  }
}
