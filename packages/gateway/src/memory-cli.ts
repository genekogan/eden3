import { performance } from 'node:perf_hooks';

import type { OpenClawCliLike } from './docker';

const OPENCLAW_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface MemoryPromotionSummary {
  agentId: string;
  candidates: number;
  promoted: number;
  /** Exact non-secret argv policy used for durable provenance. */
  policy: {
    limit: 10;
    minScore: 0.55;
    minRecallCount: 1;
    minUniqueQueries: 1;
    apply: true;
  };
}

export interface MemorySearchHit {
  path?: string;
  startLine?: number;
  endLine?: number;
  score?: number;
  snippet?: string;
}

export interface MemorySearchResult {
  agentId: string;
  latencyMs: number;
  results: MemorySearchHit[];
}

export interface OpenClawMemoryCliOptions {
  now?: () => number;
}

/**
 * Narrow, per-agent adapter over OpenClaw 2026.7.1's native memory CLI.
 * Eden owns scheduling; this class never lists agents and therefore cannot
 * accidentally turn one active-agent run into an all-agent fan-out.
 */
export class OpenClawMemoryCli {
  private readonly now: () => number;

  constructor(
    private readonly cli: OpenClawCliLike,
    options: OpenClawMemoryCliOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  async promoteAgent(agentId: string): Promise<MemoryPromotionSummary> {
    assertAgentId(agentId);
    const raw = await this.cli.execJson<unknown>([
      'memory',
      'promote',
      '--agent',
      agentId,
      '--limit',
      '10',
      '--min-score',
      '0.55',
      '--min-recall-count',
      '1',
      '--min-unique-queries',
      '1',
      '--apply',
      '--json',
    ]);
    const candidates = resultArray(raw, ['candidates', 'results', 'items']);
    return {
      agentId,
      candidates: numberField(raw, ['candidateCount', 'candidatesCount']) ?? candidates.length,
      promoted:
        numberField(raw, ['promotedCount', 'appliedCount', 'promoted']) ??
        candidates.filter(isPromotedCandidate).length,
      policy: {
        limit: 10,
        minScore: 0.55,
        minRecallCount: 1,
        minUniqueQueries: 1,
        apply: true,
      },
    };
  }

  async searchAgent(agentId: string, query: string, maxResults = 5): Promise<MemorySearchResult> {
    assertAgentId(agentId);
    const normalizedQuery = query.trim();
    if (normalizedQuery === '') throw new TypeError('memory search query must not be empty');
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
      throw new TypeError('memory search maxResults must be an integer from 1 to 20');
    }
    const started = this.now();
    const raw = await this.cli.execJson<unknown>([
      'memory',
      'search',
      '--agent',
      agentId,
      '--query',
      normalizedQuery,
      '--max-results',
      String(maxResults),
      '--json',
    ]);
    const latencyMs = Math.max(0, Math.round((this.now() - started) * 1000) / 1000);
    return {
      agentId,
      latencyMs,
      results: resultArray(raw, ['results', 'matches', 'items']).map(normalizeSearchHit),
    };
  }
}

function assertAgentId(agentId: string): void {
  if (!OPENCLAW_AGENT_ID_RE.test(agentId)) {
    throw new TypeError(`invalid OpenClaw agent id ${JSON.stringify(agentId)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resultArray(raw: unknown, fields: readonly string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  const record = asRecord(raw);
  if (record === undefined) return [];
  for (const field of fields) {
    if (Array.isArray(record[field])) return record[field] as unknown[];
  }
  return [];
}

function numberField(raw: unknown, fields: readonly string[]): number | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function isPromotedCandidate(value: unknown): boolean {
  const record = asRecord(value);
  return record?.promoted === true || record?.applied === true || record?.status === 'promoted';
}

function normalizeSearchHit(value: unknown): MemorySearchHit {
  const record = asRecord(value) ?? {};
  const hit: MemorySearchHit = {};
  if (typeof record.path === 'string') hit.path = record.path;
  if (typeof record.startLine === 'number') hit.startLine = record.startLine;
  if (typeof record.endLine === 'number') hit.endLine = record.endLine;
  if (typeof record.score === 'number') hit.score = record.score;
  const snippet = record.snippet ?? record.text ?? record.content;
  if (typeof snippet === 'string') hit.snippet = snippet;
  return hit;
}
