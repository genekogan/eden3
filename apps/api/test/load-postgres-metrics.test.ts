import { describe, expect, it } from 'vitest';

import {
  resolveLoadPostgresMetricsOutput,
  summarizeLoadPostgresSamples,
} from '../src/testing/load-postgres-metrics';

describe('load PostgreSQL metrics', () => {
  it('reports bounded pool/wait peaks and monotonic database-stat deltas', () => {
    expect(summarizeLoadPostgresSamples([
      {
        atMs: 1,
        sessions: 2,
        activeSessions: 1,
        waitingSessions: 0,
        oldestTransactionMs: 10,
        commits: 100,
        rollbacks: 5,
        blockReads: 20,
        blockHits: 1000,
        tempBytes: 0,
        deadlocks: 0,
      },
      {
        atMs: 2,
        sessions: 10,
        activeSessions: 8,
        waitingSessions: 2,
        oldestTransactionMs: 250,
        commits: 140,
        rollbacks: 7,
        blockReads: 25,
        blockHits: 1400,
        tempBytes: 4096,
        deadlocks: 1,
      },
    ])).toEqual({
      samples: 2,
      sessions: { average: 6, max: 10 },
      activeSessions: { average: 4.5, max: 8 },
      waitingSessions: { average: 1, max: 2 },
      maxOldestTransactionMs: 250,
      deltas: {
        commits: 40,
        rollbacks: 2,
        blockReads: 5,
        blockHits: 400,
        tempBytes: 4096,
        deadlocks: 1,
      },
    });
  });

  it('refuses empty evidence rather than reporting a false zero', () => {
    expect(() => summarizeLoadPostgresSamples([])).toThrow(/at least one sample/);
  });

  it('resolves documented relative receipts from the repository root, not the package cwd', () => {
    const root = '/workspace/eden3';
    expect(resolveLoadPostgresMetricsOutput(root, 'var/acceptance/load/postgres.json'))
      .toBe('/workspace/eden3/var/acceptance/load/postgres.json');
    expect(resolveLoadPostgresMetricsOutput(root, '/workspace/eden3/var/acceptance/load/postgres.json'))
      .toBe('/workspace/eden3/var/acceptance/load/postgres.json');
    expect(() => resolveLoadPostgresMetricsOutput(root, '../outside.json')).toThrow(/under var\/acceptance/);
    expect(() => resolveLoadPostgresMetricsOutput(root, 'var/acceptance/load/postgres.txt')).toThrow(/JSON file/);
  });
});
