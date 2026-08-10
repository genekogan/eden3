export interface LoadPostgresSample {
  atMs: number;
  sessions: number;
  activeSessions: number;
  waitingSessions: number;
  oldestTransactionMs: number;
  commits: number;
  rollbacks: number;
  blockReads: number;
  blockHits: number;
  tempBytes: number;
  deadlocks: number;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

export function summarizeLoadPostgresSamples(samples: readonly LoadPostgresSample[]): {
  samples: number;
  sessions: { average: number; max: number };
  activeSessions: { average: number; max: number };
  waitingSessions: { average: number; max: number };
  maxOldestTransactionMs: number;
  deltas: {
    commits: number;
    rollbacks: number;
    blockReads: number;
    blockHits: number;
    tempBytes: number;
    deadlocks: number;
  };
} {
  if (samples.length === 0) throw new Error('PostgreSQL load metrics require at least one sample');
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const delta = (field: keyof LoadPostgresSample): number => Math.max(0, last[field] - first[field]);
  const summary = (field: keyof LoadPostgresSample) => {
    const values = samples.map((sample) => sample[field]);
    return {
      average: Number(average(values).toFixed(2)),
      max: Math.max(...values),
    };
  };
  return {
    samples: samples.length,
    sessions: summary('sessions'),
    activeSessions: summary('activeSessions'),
    waitingSessions: summary('waitingSessions'),
    maxOldestTransactionMs: Math.max(...samples.map((sample) => sample.oldestTransactionMs)),
    deltas: {
      commits: delta('commits'),
      rollbacks: delta('rollbacks'),
      blockReads: delta('blockReads'),
      blockHits: delta('blockHits'),
      tempBytes: delta('tempBytes'),
      deadlocks: delta('deadlocks'),
    },
  };
}
