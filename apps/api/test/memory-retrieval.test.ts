import { describe, expect, it } from 'vitest';

import {
  MEMORY_RETRIEVAL_P95_BUDGET_MS,
  memoryQuerySha256,
  retrievalP95,
  runMemoryRetrievalProbe,
  type MemoryRetrievalProbeRecord,
} from '../src/services/memory-retrieval';

describe('memory retrieval instrumentation', () => {
  it('computes the nearest-rank p95 over the required 20-query battery', () => {
    const latencies = [
      80, 90, 100, 110, 120, 130, 140, 150, 160, 170,
      180, 190, 200, 210, 220, 230, 240, 250, 260, 2_000,
    ];
    expect(retrievalP95(latencies)).toBe(260);
    expect(retrievalP95(latencies)).toBeLessThanOrEqual(MEMORY_RETRIEVAL_P95_BUDGET_MS);
  });

  it('records only a query hash plus latency/result metrics, never raw query text', async () => {
    const records: MemoryRetrievalProbeRecord[] = [];
    const query = 'private cobalt lighthouse preference';
    const result = await runMemoryRetrievalProbe({
      memoryRuntime: {
        async promoteAgent() { throw new Error('not used'); },
        async searchAgent(agentId) {
          return {
            agentId,
            latencyMs: 123.4,
            results: [{ path: 'MEMORY.md', score: 0.9, snippet: 'cobalt' }],
          };
        },
      },
      agentAccountId: 'agent-account',
      openclawId: 'agent-one',
      query,
      recorder: { async record(row) { records.push(row); } },
    });

    expect(result).toMatchObject({ latencyMs: 123, withinBudget: true });
    expect(records).toEqual([
      expect.objectContaining({
        querySha256: memoryQuerySha256(query),
        status: 'done',
        resultCount: 1,
        topScore: 0.9,
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain(query);
  });
});
