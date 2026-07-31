import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { pg } from '@eden3/db';
import type { MemorySearchResult } from '@eden3/gateway';

import type { MemoryRuntimeLike } from '../gateway-glue';

export const MEMORY_RETRIEVAL_P95_BUDGET_MS = 1_500;

export function memoryQuerySha256(query: string): string {
  return createHash('sha256').update(query).digest('hex');
}

export function retrievalP95(latenciesMs: readonly number[]): number {
  if (latenciesMs.length === 0) throw new RangeError('retrieval p95 needs at least one sample');
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

export interface MemoryRetrievalProbeRecord {
  agentAccountId: string;
  openclawId: string;
  querySha256: string;
  status: 'done' | 'error';
  latencyMs: number;
  resultCount: number;
  topScore: number | null;
  error: string | null;
}

export interface MemoryRetrievalRecorder {
  record(row: MemoryRetrievalProbeRecord): Promise<void>;
}

const postgresRecorder: MemoryRetrievalRecorder = {
  async record(row) {
    await pg`
      insert into memory_retrieval_probes (
        agent_account_id, openclaw_id, query_sha256, status, latency_ms,
        result_count, top_score, error
      ) values (
        ${row.agentAccountId}, ${row.openclawId}, ${row.querySha256}, ${row.status},
        ${row.latencyMs}, ${row.resultCount}, ${row.topScore}, ${row.error}
      )
    `;
  },
};

export async function runMemoryRetrievalProbe(params: {
  memoryRuntime: MemoryRuntimeLike;
  agentAccountId: string;
  openclawId: string;
  query: string;
  maxResults?: number;
  recorder?: MemoryRetrievalRecorder;
  now?: () => number;
}): Promise<MemorySearchResult & { withinBudget: boolean }> {
  const query = params.query.trim();
  if (query === '') throw new TypeError('memory retrieval query must not be empty');
  const recorder = params.recorder ?? postgresRecorder;
  const now = params.now ?? (() => performance.now());
  const started = now();
  const querySha256 = memoryQuerySha256(query);
  try {
    const result = await params.memoryRuntime.searchAgent(
      params.openclawId,
      query,
      params.maxResults ?? 5,
    );
    const latencyMs = Math.max(0, Math.round(result.latencyMs));
    const scores = result.results
      .map((item) => item.score)
      .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
    await recorder.record({
      agentAccountId: params.agentAccountId,
      openclawId: params.openclawId,
      querySha256,
      status: 'done',
      latencyMs,
      resultCount: result.results.length,
      topScore: scores.length > 0 ? Math.max(...scores) : null,
      error: null,
    });
    return { ...result, latencyMs, withinBudget: latencyMs <= MEMORY_RETRIEVAL_P95_BUDGET_MS };
  } catch (err) {
    const latencyMs = Math.max(0, Math.round(now() - started));
    await recorder.record({
      agentAccountId: params.agentAccountId,
      openclawId: params.openclawId,
      querySha256,
      status: 'error',
      latencyMs,
      resultCount: 0,
      topScore: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
    throw err;
  }
}
