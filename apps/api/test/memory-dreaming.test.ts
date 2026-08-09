import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { pg } from '@eden3/db';
import { describe, expect, it } from 'vitest';

import {
  EdenMemoryDreamAgentRunner,
  MemoryDreamRecoveryPendingError,
  MemoryDreamSkippedError,
  MemoryDreamOrchestrator,
  MemoryDreamScheduler,
  MEMORY_DREAM_CLAIM_STALE_MS,
  PostgresMemoryDreamStore,
  ensureMemoryDreamSession,
  isSettledPartialOutputDreamFailure,
  materializeMemoryRemResponse,
  parseMemoryRemResponse,
  renderMemoryRemPrompt,
  selectActiveMemoryDreamAgents,
  type ActiveMemoryDreamCandidate,
  type ClaimMemoryDreamSweepParams,
  type CompleteMemoryDreamRunParams,
  type MemoryDreamCandidate,
  type MemoryDreamCheckpoint,
  type MemoryDreamDurability,
  type MemoryDreamDurableEvidence,
  type MemoryDreamExecutionResult,
  type MemoryDreamRunClaim,
  type MemoryDreamStore,
  type MemoryDreamSweepClaim,
} from '../src/services/memory-dreaming';
import { memorySha256 } from '../src/services/memory-distillation';
import { deleteFixturesByMarker, insertAgentAccount, insertUserAccount, makeMarker } from './fixtures';

function candidate(index: number, active: boolean): MemoryDreamCandidate {
  return {
    agentAccountId: `agent-${index}`,
    openclawId: `agent-${index}`,
    username: `agent-${index}`,
    name: `Agent ${index}`,
    persona: null,
    workspacePath: `/tmp/workspace-${index}`,
    provisionStatus: 'ready',
    ownerAccountId: `owner-${index}`,
    ownerUsername: `owner-${index}`,
    lastActivityAt: active
      ? new Date('2026-07-31T05:00:00.000Z')
      : new Date('2026-07-29T05:00:00.000Z'),
    lastSuccessfulDreamActivityAt: null,
    recoveryPending: false,
  };
}

class FakeStore implements MemoryDreamStore {
  claim: ClaimMemoryDreamSweepParams | null = null;
  started: string[] = [];
  completed: CompleteMemoryDreamRunParams[] = [];
  failed: string[] = [];
  skipped: string[] = [];
  failureStatuses: Array<string | undefined> = [];
  reconciledSweeps: string[] = [];
  finished = false;

  constructor(
    readonly candidates: MemoryDreamCandidate[],
    readonly claimedId: string | null = 'sweep-1',
  ) {}

  async listCandidates(): Promise<MemoryDreamCandidate[]> {
    return this.candidates;
  }

  async claimSweep(params: ClaimMemoryDreamSweepParams): Promise<MemoryDreamSweepClaim | null> {
    this.claim = params;
    return this.claimedId ? { id: this.claimedId, claimToken: 'sweep-token' } : null;
  }

  async heartbeatSweep(): Promise<boolean> {
    return true;
  }

  async startRun(
    sweep: MemoryDreamSweepClaim,
    row: ActiveMemoryDreamCandidate,
  ): Promise<MemoryDreamRunClaim> {
    this.started.push(row.agentAccountId);
    return {
      id: `run-${row.agentAccountId}`,
      sweepId: sweep.id,
      claimToken: `token-${row.agentAccountId}`,
      lastActivityAt: row.lastActivityAt,
      isRecovery: row.recoveryPending,
    };
  }

  async heartbeatRun(): Promise<boolean> {
    return true;
  }

  async completeRun(params: CompleteMemoryDreamRunParams): Promise<boolean> {
    this.completed.push(params);
    return true;
  }

  async failRun(params: { runId: string; status?: 'error' | 'recovery_pending' }): Promise<boolean> {
    this.failed.push(params.runId);
    this.failureStatuses.push(params.status);
    return true;
  }

  async skipRun(params: { runId: string }): Promise<boolean> {
    this.skipped.push(params.runId);
    return true;
  }

  async reconcileAbandonedSweep(sweepId: string): Promise<boolean> {
    this.reconciledSweeps.push(sweepId);
    return true;
  }

  async finishSweep(): Promise<boolean> {
    this.finished = true;
    return true;
  }
}

const execution: MemoryDreamExecutionResult = {
  agentRuntime: 'claude-cli',
  pricingBasis: 'notional-subscription',
  promotion: {
    agentId: 'agent',
    candidates: 1,
    promoted: 1,
    policy: {
      limit: 10,
      minScore: 0.55,
      minRecallCount: 1,
      minUniqueQueries: 1,
      apply: true,
    },
  },
  usageEventId: 'usage-1',
  previousSha256: null,
  sha256: 'hash',
  provenance: {},
};

describe('activity-gated memory dreaming', () => {
  it('invokes exactly k active agents out of N=200 and durably lists every skip', async () => {
    const candidates = Array.from({ length: 200 }, (_, index) => candidate(index, index < 5));
    const store = new FakeStore(candidates);
    const calls: string[] = [];
    const orchestrator = new MemoryDreamOrchestrator(store, {
      async run(row) {
        calls.push(row.agentAccountId);
        return { ...execution, promotion: { ...execution.promotion, agentId: row.openclawId } };
      },
    });

    const started = performance.now();
    const result = await orchestrator.run(
      'memory-dream:2026-07-31',
      new Date('2026-07-30T07:00:00.000Z'),
    );
    const elapsedMs = performance.now() - started;

    expect(result).toMatchObject({ claimed: true, eligible: 200, active: 5, succeeded: 5, failed: 0 });
    expect(calls).toEqual(['agent-0', 'agent-1', 'agent-2', 'agent-3', 'agent-4']);
    expect(store.started).toEqual(calls);
    expect(store.claim?.skipped).toHaveLength(195);
    expect(new Set(store.claim?.skipped.map((item) => item.reason))).toEqual(new Set(['inactive']));
    expect(store.completed).toHaveLength(5);
    expect(store.finished).toBe(true);
    expect(elapsedMs).toBeLessThan(10 * 60 * 1000);
  });

  it('cannot reclaim a valid provider turn at or before the 30-minute ceiling', () => {
    const providerCeilingMs = 30 * 60 * 1000;
    expect(MEMORY_DREAM_CLAIM_STALE_MS).toBeGreaterThan(providerCeilingMs);
    const claimedAt = new Date('2026-07-31T08:00:00.000Z').getTime();
    const leaseExpiresAt = claimedAt + MEMORY_DREAM_CLAIM_STALE_MS;
    expect(claimedAt + providerCeilingMs).toBeLessThan(leaseExpiresAt);
    expect(
      () => new PostgresMemoryDreamStore({ staleAfterMs: providerCeilingMs }),
    ).toThrow('must exceed');
  });

  it('uses recovery-pending reclaim, preserved activity watermarks, and fenced SQL writes', async () => {
    const statements: string[] = [];
    let liveAgentClaimed = false;
    const fakeClient = (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<Array<{
      id: string;
      sweep_id?: string;
      claim_token?: string;
      last_activity_at?: string;
      is_recovery?: boolean;
    }>> => {
      const statement = strings.join('?');
      statements.push(statement);
      if (statement.includes('insert into memory_dream_sweeps')) {
        return [{ id: 'sweep-1', claim_token: 'sweep-token' }];
      }
      if (statement.includes('insert into memory_dream_runs')) {
        if (values.includes('stale-sweep-token')) return [];
        if (liveAgentClaimed) return [];
        liveAgentClaimed = true;
        return [{
          id: 'run-1',
          sweep_id: 'sweep-1',
          claim_token: 'run-token',
          last_activity_at: '2026-07-31T05:00:00.000Z',
          is_recovery: false,
        }];
      }
      return [];
    }) as unknown as typeof pg;
    const store = new PostgresMemoryDreamStore({
      client: fakeClient,
      now: () => new Date('2026-07-31T08:00:00.000Z'),
    });
    await store.listCandidates(
      new Date('2026-07-30T08:00:00.000Z'),
      'memory-dream:2026-07-31',
    );
    const sweep = await store.claimSweep({
      sweepKey: 'memory-dream:2026-07-31',
      windowStart: new Date('2026-07-30T08:00:00.000Z'),
      eligibleCount: 1,
      activeCount: 1,
      skipped: [],
    });
    expect(sweep).toEqual({ id: 'sweep-1', claimToken: 'sweep-token' });
    await store.heartbeatSweep(sweep!);
    const run = await store.startRun(sweep!, candidate(1, true) as ActiveMemoryDreamCandidate);
    expect(run).toEqual({
      id: 'run-1',
      sweepId: 'sweep-1',
      claimToken: 'run-token',
      lastActivityAt: new Date('2026-07-31T05:00:00.000Z'),
      isRecovery: false,
    });
    await expect(
      store.startRun(
        { id: 'sweep-1', claimToken: 'stale-sweep-token' },
        candidate(2, true) as ActiveMemoryDreamCandidate,
      ),
    ).resolves.toBeNull();
    await expect(
      store.startRun(
        { id: 'sweep-2', claimToken: 'sweep-2-token' },
        candidate(1, true) as ActiveMemoryDreamCandidate,
      ),
    ).resolves.toBeNull();
    await store.heartbeatRun(run!);
    await store.completeRun({
      runId: 'run-1',
      claimToken: 'run-token',
      result: execution,
      durationMs: 1,
    });
    await store.failRun({
      runId: 'run-1',
      claimToken: 'run-token',
      error: 'retry',
      durationMs: 1,
      status: 'recovery_pending',
    });
    await store.finishSweep({
      sweepId: 'sweep-1',
      claimToken: 'sweep-token',
      succeeded: 0,
      failed: 1,
      durationMs: 1,
    });

    const sweepSql = statements.find((value) => value.includes('insert into memory_dream_sweeps'))!;
    const runSql = statements.find((value) => value.includes('insert into memory_dream_runs'))!;
    const candidatesSql = statements.find((value) => value.includes('pending_recovery as'))!;
    expect(candidatesSql).toContain("r.status = 'recovery_pending'");
    expect(candidatesSql).not.toContain('s.sweep_key =');
    expect(sweepSql).toContain("memory_dream_sweeps.status = 'partial'");
    expect(sweepSql).toContain("pending.status = 'recovery_pending'");
    expect(runSql).toContain("existing.status = 'recovery_pending'");
    expect(runSql).toContain('on conflict do nothing');
    expect(runSql).toContain('parent_claim as materialized');
    expect(runSql).toContain('update memory_dream_sweeps set');
    expect(runSql).toContain('greatest(');
    expect(runSql).toContain('claim_token =');
    expect(runSql).toContain('lease_expires_at >');
    expect(runSql).not.toContain('last_activity_at = excluded.last_activity_at');
    const heartbeatSql = statements.filter((value) => value.includes('greatest(lease_expires_at'));
    expect(heartbeatSql).toHaveLength(2);
    for (const statement of heartbeatSql) {
      expect(statement).toContain('lease_expires_at >');
    }
    for (const statement of statements.filter((value) => value.startsWith('\n      update'))) {
      expect(statement).toContain('claim_token =');
    }
  });

  it('does no per-agent work when the durable daily sweep key is already claimed', async () => {
    const store = new FakeStore([candidate(1, true)], null);
    let calls = 0;
    const result = await new MemoryDreamOrchestrator(store, {
      async run() {
        calls += 1;
        return execution;
      },
    }).run('memory-dream:2026-07-31', new Date('2026-07-30T07:00:00.000Z'));
    expect(result.claimed).toBe(false);
    expect(calls).toBe(0);
  });

  it('persists indeterminate execution as recovery_pending rather than replayable error', async () => {
    const store = new FakeStore([candidate(1, true)]);
    const result = await new MemoryDreamOrchestrator(store, {
      async run() {
        throw new MemoryDreamRecoveryPendingError('refund retry required');
      },
    }).run('memory-dream:2026-07-31', new Date('2026-07-30T07:00:00.000Z'));
    expect(result).toMatchObject({ claimed: true, succeeded: 0, failed: 1 });
    expect(store.failureStatuses).toEqual(['recovery_pending']);
  });

  it('durably skips an active agent whose seed has too little history without failing the sweep', async () => {
    const store = new FakeStore([candidate(1, true)]);
    const result = await new MemoryDreamOrchestrator(store, {
      async run() {
        throw new MemoryDreamSkippedError(
          'seed-too-little-history',
          'not enough transcript history',
        );
      },
    }).run('memory-dream:2026-07-31', new Date('2026-07-30T07:00:00.000Z'));

    expect(result).toMatchObject({
      claimed: true,
      succeeded: 0,
      failed: 0,
      skipped: [{ reason: 'seed-too-little-history' }],
    });
    expect(store.skipped).toEqual(['run-agent-1']);
    expect(store.failed).toEqual([]);
  });

  it('retries a same-sweep recovery-pending run after its activity ages outside the window', async () => {
    const row = candidate(1, false);
    row.recoveryPending = true;
    row.lastSuccessfulDreamActivityAt = new Date('2026-07-30T06:00:00.000Z');
    row.ownerAccountId = null;
    row.ownerUsername = null;
    row.workspacePath = null;
    row.provisionStatus = 'deprovisioned';
    const store = new FakeStore([row]);
    const calls: string[] = [];
    const result = await new MemoryDreamOrchestrator(store, {
      async run(active) {
        calls.push(active.agentAccountId);
        return execution;
      },
    }).run('memory-dream:2026-07-31', new Date('2026-07-30T07:00:00.000Z'));

    expect(result).toMatchObject({ claimed: true, active: 1, succeeded: 1 });
    expect(calls).toEqual([row.agentAccountId]);
    expect(store.started).toEqual([row.agentAccountId]);
    expect(store.claim?.skipped).toEqual([]);
  });

  it('resolves an old-sweep run, finalizes its owner, then preserves newer current activity', async () => {
    const row = candidate(1, true);
    row.recoveryPending = true;
    const store = new FakeStore([row]);
    let claims = 0;
    store.startRun = async (sweep, current) => {
      claims += 1;
      if (claims === 1) {
        return {
          id: 'old-run',
          sweepId: 'old-sweep',
          claimToken: 'old-token',
          lastActivityAt: new Date('2026-07-31T04:00:00.000Z'),
          isRecovery: true,
        };
      }
      expect(sweep.id).toBe('sweep-1');
      expect(current.recoveryPending).toBe(false);
      return {
        id: 'current-run',
        sweepId: sweep.id,
        claimToken: 'current-token',
        lastActivityAt: current.lastActivityAt,
        isRecovery: false,
      };
    };
    const runnerSweeps: string[] = [];
    const result = await new MemoryDreamOrchestrator(store, {
      async run(_candidate, sweepId) {
        runnerSweeps.push(sweepId);
        return execution;
      },
    }).run('memory-dream:2026-07-31', new Date('2026-07-30T07:00:00.000Z'));

    expect(result).toMatchObject({ claimed: true, succeeded: 2, failed: 0 });
    expect(runnerSweeps).toEqual(['old-sweep', 'sweep-1']);
    expect(store.completed.map((item) => item.runId)).toEqual(['old-run', 'current-run']);
    expect(store.reconciledSweeps).toEqual(['old-sweep']);
    expect(claims).toBe(2);
  });

  it('skips already-dreamed activity and encodes the disclosure boundary in REM', () => {
    const row = candidate(1, true);
    row.lastSuccessfulDreamActivityAt = new Date('2026-07-31T06:00:00.000Z');
    const selected = selectActiveMemoryDreamAgents([row], new Date('2026-07-30T07:00:00.000Z'));
    expect(selected).toMatchObject({ active: [], skipped: [{ reason: 'already-dreamed' }] });
    const prompt = renderMemoryRemPrompt('2026-07-31');
    expect(prompt).toContain('never quote, reveal, confirm, deny, or imply');
    expect(prompt).toContain('Do not call tools');
    expect(prompt).toContain('<DREAM_ENTRY>');
    expect(prompt).toContain('<REM_REPORT>');
  });

  it('parses and idempotently materializes one tool-free REM response', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'eden3-memory-rem-output-'));
    const runId = randomUUID();
    const response = [
      '<DREAM_ENTRY>',
      'A compact dream fragment.',
      '</DREAM_ENTRY>',
      '<REM_REPORT>',
      '## Pattern\n\nA detailed durable pattern with uncertainty.',
      '</REM_REPORT>',
    ].join('\n');
    try {
      await writeFile(path.join(workspace, 'DREAMS.md'), '# Dreams\n', 'utf8');
      expect(parseMemoryRemResponse(response)).toEqual({
        dreamEntry: 'A compact dream fragment.',
        remReport: '## Pattern\n\nA detailed durable pattern with uncertainty.',
      });
      await materializeMemoryRemResponse(workspace, '2026-07-31', runId, response);
      await materializeMemoryRemResponse(workspace, '2026-07-31', runId, response);
      const diary = await readFile(path.join(workspace, 'DREAMS.md'), 'utf8');
      const report = await readFile(
        path.join(workspace, 'memory', 'dreaming', 'rem', '2026-07-31.md'),
        'utf8',
      );
      expect(diary.match(new RegExp(`eden-memory-dream:${runId}`, 'g'))).toHaveLength(1);
      expect(diary).toContain('A compact dream fragment.');
      expect(report).toContain('A detailed durable pattern with uncertainty.');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('does not hide activity that arrived after a successful run captured its watermark', () => {
    const row = candidate(1, true);
    row.lastSuccessfulDreamActivityAt = new Date('2026-07-31T04:00:00.000Z');
    row.lastActivityAt = new Date('2026-07-31T05:00:00.000Z');
    expect(
      selectActiveMemoryDreamAgents([row], new Date('2026-07-30T07:00:00.000Z')).active,
    ).toHaveLength(1);
  });

  it('does not claim before the configured UTC hour', async () => {
    const store = new FakeStore([candidate(1, true)]);
    const orchestrator = new MemoryDreamOrchestrator(store, { async run() { return execution; } });
    const scheduler = new MemoryDreamScheduler(orchestrator, {
      intervalMs: 1_000,
      hourUtc: 7,
      now: () => new Date('2026-07-31T06:59:00.000Z'),
    });
    expect(await scheduler.tick()).toBeNull();
    expect(store.claim).toBeNull();
  });
});

class FakeDurability implements MemoryDreamDurability {
  readonly saves: Array<{
    checkpoint: MemoryDreamCheckpoint;
    providerStatus: MemoryDreamDurableEvidence['providerStatus'];
  }> = [];

  constructor(readonly evidence: MemoryDreamDurableEvidence) {}

  async inspect(): Promise<MemoryDreamDurableEvidence> {
    return this.evidence;
  }

  async saveCheckpoint(
    _claim: MemoryDreamRunClaim,
    checkpoint: MemoryDreamCheckpoint,
    providerStatus: MemoryDreamDurableEvidence['providerStatus'],
  ): Promise<void> {
    this.evidence.checkpoint = checkpoint;
    this.evidence.providerStatus = providerStatus;
    this.saves.push({ checkpoint, providerStatus });
  }
}

function activeCandidate(workspacePath: string): ActiveMemoryDreamCandidate {
  return {
    agentAccountId: '00000000-0000-4000-8000-000000000101',
    openclawId: 'memory-test-agent',
    username: 'memory-test-agent',
    name: 'Memory test agent',
    persona: null,
    workspacePath,
    provisionStatus: 'ready',
    ownerAccountId: '00000000-0000-4000-8000-000000000102',
    ownerUsername: 'memory-test-owner',
    lastActivityAt: new Date('2026-07-31T05:00:00.000Z'),
    lastSuccessfulDreamActivityAt: null,
    recoveryPending: false,
  };
}

function makeRunner(
  durability: MemoryDreamDurability,
  overrides: {
    promote?: () => Promise<MemoryDreamExecutionResult['promotion']>;
    distill?: () => Promise<{
      status: 'running' | 'skipped' | 'done';
      sessionsSampled: number;
      messagesSampled: number;
      memoryChars: number;
      skippedReason?: 'already_seeded' | 'too_little_history';
    }>;
    status?: () => Promise<{
      status: 'running' | 'skipped' | 'done';
      sessionsSampled: number;
      messagesSampled: number;
      memoryChars: number;
      model: string | null;
      error: string | null;
      updatedAt: string | null;
      completedAt: string | null;
      summary: string | null;
    }>;
    reverse?: (params: {
      turnId: string;
      refundType: string;
      fence?: (dbc: never) => Promise<void>;
    }) => Promise<{ reversed: boolean; balanceTotal?: number }>;
    claimFence?: (claim: MemoryDreamRunClaim) => Promise<void>;
    recordRecoveryUsage?: (claim: MemoryDreamRunClaim) => Promise<void>;
    providerCalled?: () => void;
    assistantContent?: (messageId: string, sessionId: string) => Promise<string | null>;
  } = {},
): EdenMemoryDreamAgentRunner {
  return new EdenMemoryDreamAgentRunner({
    compat: {
      async *chatTurn() {
        overrides.providerCalled?.();
      },
    },
    bus: { publish: () => 0 } as never,
    registry: { register() {}, touch() {} } as never,
    historySync: { scheduleTrailingSync() {} } as never,
    memoryRuntime: {
      promoteAgent:
        overrides.promote ??
        (async () => ({ ...execution.promotion, agentId: 'memory-test-agent' })),
    } as never,
    modelRuntime: { getRuntime: async () => 'openclaw' } as never,
    durability,
    memoryPublicationFence: async (_params, publish) =>
      await publish((async () => []) as never),
    ...(overrides.distill ? { distillMemory: overrides.distill as never } : {}),
    ...(overrides.status ? { memoryStatus: overrides.status as never } : {}),
    reverseAuthorization:
      (overrides.reverse as never) ??
      (async () => ({ reversed: true, balanceTotal: 100 })),
    claimFence: overrides.claimFence ?? (async () => {}),
    recordRecoveryUsage: overrides.recordRecoveryUsage ?? (async () => {}),
    ...(overrides.assistantContent
      ? { loadAssistantContent: overrides.assistantContent }
      : {}),
    now: () => new Date('2026-07-31T08:00:00.000Z'),
  });
}

describe('memory dream crash safety', () => {
  it('keeps a reclaimed run recovery-pending when durable inspection transiently fails', async () => {
    const row = activeCandidate('/tmp/memory-inspection-retry');
    row.recoveryPending = true;
    const store = new FakeStore([row]);
    const durability: MemoryDreamDurability = {
      async inspect() {
        throw new Error('transient database read failure');
      },
      async saveCheckpoint() {
        throw new Error('must not checkpoint after failed inspection');
      },
    };
    let providerCalls = 0;

    const result = await new MemoryDreamOrchestrator(
      store,
      makeRunner(durability, {
        providerCalled: () => {
          providerCalls += 1;
        },
      }),
    ).run('memory-dream:2026-07-31', new Date('2026-07-30T07:00:00.000Z'));

    expect(result).toMatchObject({ claimed: true, succeeded: 0, failed: 1 });
    expect(store.failureStatuses).toEqual(['recovery_pending']);
    expect(providerCalls).toBe(0);
  });

  it('does not enter deep or REM until the automatic seed is durably done', async () => {
    for (const seedStatus of ['running', 'skipped'] as const) {
      const workspace = await mkdtemp(path.join(tmpdir(), `eden3-memory-seed-${seedStatus}-`));
      try {
        const nativeOwned = '# Native-owned MEMORY\n\n- must not be dream-owned yet\n';
        await writeFile(path.join(workspace, 'MEMORY.md'), nativeOwned, 'utf8');
        const durability = new FakeDurability({
          checkpoint: null,
          providerStatus: 'not_started',
          usage: null,
          debitKeys: [],
        });
        let promotions = 0;
        let providerCalls = 0;
        const runner = makeRunner(durability, {
          promote: async () => {
            promotions += 1;
            return execution.promotion;
          },
          distill: async () => ({
            status: seedStatus,
            sessionsSampled: 0,
            messagesSampled: 0,
            memoryChars: 0,
            ...(seedStatus === 'skipped'
              ? { skippedReason: 'too_little_history' as const }
              : { skippedReason: 'already_seeded' as const }),
          }),
          status: async () => ({
            status: seedStatus,
            sessionsSampled: 0,
            messagesSampled: 0,
            memoryChars: 0,
            model: null,
            error: null,
            updatedAt: '2026-07-31T08:00:00.000Z',
            completedAt: null,
            summary: null,
          }),
          providerCalled: () => {
            providerCalls += 1;
          },
        });
        const promise = runner.run(activeCandidate(workspace), 'sweep-1', {
            id: randomUUID(),
            sweepId: 'sweep-1',
            claimToken: randomUUID(),
            lastActivityAt: new Date('2026-07-31T05:00:00.000Z'),
            isRecovery: false,
          });
        if (seedStatus === 'skipped') {
          await expect(promise).rejects.toThrow(MemoryDreamSkippedError);
        } else {
          await expect(promise).rejects.toThrow('not durably done');
        }
        expect(promotions).toBe(0);
        expect(providerCalls).toBe(0);
        expect(await readFile(path.join(workspace, 'MEMORY.md'), 'utf8')).toBe(nativeOwned);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  });

  it('recovers a matching terminal usage event and complete files without replaying provider work', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'eden3-memory-terminal-'));
    const runId = randomUUID();
    try {
      await mkdir(path.join(workspace, 'memory', 'dreaming', 'deep'), { recursive: true });
      await mkdir(path.join(workspace, 'memory', 'dreaming', 'rem'), { recursive: true });
      await writeFile(path.join(workspace, 'MEMORY.md'), '# promoted memory\n', 'utf8');
      await writeFile(path.join(workspace, 'DREAMS.md'), '# new dream diary\n', 'utf8');
      await writeFile(
        path.join(workspace, 'memory', 'dreaming', 'deep', '2026-07-31.md'),
        `# Deep\n\n- Run: ${runId}\n`,
        'utf8',
      );
      await writeFile(
        path.join(workspace, 'memory', 'dreaming', 'rem', '2026-07-31.md'),
        '# new REM report\n',
        'utf8',
      );
      const checkpoint: MemoryDreamCheckpoint = {
        schema: 'eden-memory-dream-v1',
        phase: 'provider_started',
        date: '2026-07-31',
        previousSha256: memorySha256('# seeded memory\n'),
        promotedSha256: memorySha256('# promoted memory\n'),
        promotion: { ...execution.promotion, agentId: 'memory-test-agent' },
        previousDreamDiarySha256: memorySha256('# old dream diary\n'),
        previousRemReportSha256: memorySha256('# old REM report\n'),
        agentRuntime: 'claude-cli',
      };
      const durability = new FakeDurability({
        checkpoint,
        providerStatus: 'started',
        usage: {
          id: randomUUID(),
          status: 'completed',
          pricingBasis: 'notional-subscription',
          sessionId: runId,
          agentId: activeCandidate(workspace).agentAccountId,
        },
        debitKeys: [runId],
      });
      let promotions = 0;
      let providerCalls = 0;
      const result = await makeRunner(durability, {
        promote: async () => {
          promotions += 1;
          return execution.promotion;
        },
        distill: async () => {
          throw new Error('seed must not replay');
        },
        providerCalled: () => {
          providerCalls += 1;
        },
      }).run(activeCandidate(workspace), 'sweep-1', {
        id: runId,
        sweepId: 'sweep-1',
        claimToken: randomUUID(),
        lastActivityAt: new Date('2026-07-31T05:00:00.000Z'),
        isRecovery: true,
      });
      expect(result).toMatchObject({
        usageEventId: durability.evidence.usage?.id,
        agentRuntime: 'claude-cli',
        pricingBasis: 'notional-subscription',
      });
      expect(promotions).toBe(0);
      expect(providerCalls).toBe(0);
      expect(durability.saves.at(-1)).toMatchObject({
        checkpoint: { phase: 'provider_terminal' },
        providerStatus: 'terminal',
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reconstructs missing REM files from the durable assistant message without replay', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'eden3-memory-terminal-project-'));
    const runId = randomUUID();
    const messageId = randomUUID();
    try {
      await mkdir(path.join(workspace, 'memory', 'dreaming', 'deep'), { recursive: true });
      await writeFile(path.join(workspace, 'MEMORY.md'), '# promoted memory\n', 'utf8');
      await writeFile(
        path.join(workspace, 'memory', 'dreaming', 'deep', '2026-07-31.md'),
        `# Deep\n\n- Run: ${runId}\n`,
        'utf8',
      );
      const checkpoint: MemoryDreamCheckpoint = {
        schema: 'eden-memory-dream-v1',
        phase: 'provider_started',
        date: '2026-07-31',
        previousSha256: memorySha256('# seeded memory\n'),
        promotedSha256: memorySha256('# promoted memory\n'),
        promotion: { ...execution.promotion, agentId: 'memory-test-agent' },
        previousDreamDiarySha256: null,
        previousRemReportSha256: null,
        agentRuntime: 'claude-cli',
      };
      const durability = new FakeDurability({
        checkpoint,
        providerStatus: 'terminal',
        usage: {
          id: randomUUID(),
          status: 'completed',
          pricingBasis: 'notional-subscription',
          sessionId: runId,
          agentId: activeCandidate(workspace).agentAccountId,
          messageId,
        },
        debitKeys: [runId],
      });
      let providerCalls = 0;
      const response = [
        '<DREAM_ENTRY>',
        'Recovered diary fragment.',
        '</DREAM_ENTRY>',
        '<REM_REPORT>',
        'Recovered detailed report.',
        '</REM_REPORT>',
      ].join('\n');
      const result = await makeRunner(durability, {
        providerCalled: () => {
          providerCalls += 1;
        },
        assistantContent: async (requestedMessageId, requestedSessionId) => {
          expect(requestedMessageId).toBe(messageId);
          expect(requestedSessionId).toBe(runId);
          return response;
        },
      }).run(activeCandidate(workspace), 'sweep-1', {
        id: runId,
        sweepId: 'sweep-1',
        claimToken: randomUUID(),
        lastActivityAt: new Date('2026-07-31T05:00:00.000Z'),
        isRecovery: true,
      });
      expect(result).toMatchObject({
        usageEventId: durability.evidence.usage?.id,
        agentRuntime: 'claude-cli',
      });
      expect(providerCalls).toBe(0);
      expect(await readFile(path.join(workspace, 'DREAMS.md'), 'utf8')).toContain(
        'Recovered diary fragment.',
      );
      expect(
        await readFile(
          path.join(workspace, 'memory', 'dreaming', 'rem', '2026-07-31.md'),
          'utf8',
        ),
      ).toContain('Recovered detailed report.');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects terminal usage that does not match the deterministic run session', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'eden3-memory-mismatch-'));
    const runId = randomUUID();
    try {
      const durability = new FakeDurability({
        checkpoint: {
          schema: 'eden-memory-dream-v1',
          phase: 'provider_started',
          date: '2026-07-31',
          previousSha256: null,
          promotion: { ...execution.promotion, agentId: 'memory-test-agent' },
          previousDreamDiarySha256: null,
          previousRemReportSha256: null,
          agentRuntime: 'openclaw',
        },
        providerStatus: 'started',
        usage: {
          id: randomUUID(),
          status: 'completed',
          pricingBasis: 'provider-api',
          sessionId: randomUUID(),
          agentId: activeCandidate(workspace).agentAccountId,
        },
        debitKeys: [runId],
      });
      let providerCalls = 0;
      await expect(
        makeRunner(durability, {
          providerCalled: () => {
            providerCalls += 1;
          },
        }).run(activeCandidate(workspace), 'sweep-1', {
          id: runId,
          sweepId: 'sweep-1',
          claimToken: randomUUID(),
          lastActivityAt: new Date('2026-07-31T05:00:00.000Z'),
          isRecovery: true,
        }),
      ).rejects.toThrow('does not match');
      expect(providerCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reverses a debit without terminal usage and never calls the provider again', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'eden3-memory-debit-'));
    const runId = randomUUID();
    try {
      const durability = new FakeDurability({
        checkpoint: {
          schema: 'eden-memory-dream-v1',
          phase: 'provider_started',
          date: '2026-07-31',
          previousSha256: null,
          promotedSha256: null,
          promotion: { ...execution.promotion, agentId: 'memory-test-agent' },
          previousDreamDiarySha256: null,
          previousRemReportSha256: null,
          agentRuntime: 'openclaw',
        },
        providerStatus: 'started',
        usage: null,
        debitKeys: [runId],
      });
      const reversals: string[] = [];
      const fencedClaims: string[] = [];
      let providerCalls = 0;
      const deprovisionedCandidate = {
        ...activeCandidate(workspace),
        workspacePath: null,
        ownerAccountId: null,
        ownerUsername: null,
        provisionStatus: 'deprovisioned',
        recoveryPending: true,
      };
      const runner = makeRunner(durability, {
        reverse: async ({ turnId, fence }) => {
          reversals.push(turnId);
          await fence?.(undefined as never);
          return { reversed: true, balanceTotal: 100 };
        },
        claimFence: async (claim) => {
          fencedClaims.push(claim.claimToken);
        },
        providerCalled: () => {
          providerCalls += 1;
        },
      });
      await expect(
        runner.run(deprovisionedCandidate, 'sweep-1', {
          id: runId,
          sweepId: 'sweep-1',
          claimToken: randomUUID(),
          lastActivityAt: new Date('2026-07-31T05:00:00.000Z'),
          isRecovery: true,
        }),
      ).rejects.toThrow('authorization was reversed idempotently');
      expect(reversals).toEqual([runId]);
      expect(fencedClaims).toEqual([expect.any(String)]);
      expect(providerCalls).toBe(0);
      expect(durability.saves.at(-1)?.providerStatus).toBe('indeterminate');

      // The same-day recovery-pending retry re-runs only the idempotent
      // canonical authorization reversal,
      // then fails terminally without ever replaying the provider.
      await expect(
        runner.run(deprovisionedCandidate, 'sweep-1', {
          id: runId,
          sweepId: 'sweep-1',
          claimToken: randomUUID(),
          lastActivityAt: new Date('2026-07-31T05:00:00.000Z'),
          isRecovery: true,
        }),
      ).rejects.toThrow('authorization was reversed idempotently');
      expect(reversals).toEqual([runId, runId]);
      expect(fencedClaims).toHaveLength(2);
      expect(providerCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('retries canonical reversal for terminal error usage without replaying the provider', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'eden3-memory-error-refund-'));
    const runId = randomUUID();
    try {
      const durability = new FakeDurability({
        checkpoint: {
          schema: 'eden-memory-dream-v1',
          phase: 'provider_started',
          date: '2026-07-31',
          previousSha256: null,
          promotion: { ...execution.promotion, agentId: 'memory-test-agent' },
          previousDreamDiarySha256: null,
          previousRemReportSha256: null,
          agentRuntime: 'openclaw',
        },
        providerStatus: 'started',
        usage: {
          id: randomUUID(),
          status: 'error',
          pricingBasis: 'provider-api',
          sessionId: runId,
          agentId: activeCandidate(workspace).agentAccountId,
        },
        debitKeys: [runId],
      });
      const reversals: string[] = [];
      let failFirstReversal = true;
      let providerCalls = 0;
      const runner = makeRunner(durability, {
        reverse: async ({ turnId }) => {
          reversals.push(turnId);
          if (failFirstReversal) {
            failFirstReversal = false;
            throw new Error('transient ledger failure');
          }
          return { reversed: true, balanceTotal: 100 };
        },
        providerCalled: () => {
          providerCalls += 1;
        },
      });
      const claim = {
        id: runId,
        sweepId: 'sweep-1',
        claimToken: randomUUID(),
        lastActivityAt: new Date('2026-07-31T05:00:00.000Z'),
        isRecovery: true,
      };

      await expect(
        runner.run(activeCandidate(workspace), 'sweep-1', claim),
      ).rejects.toThrow('reversal remains pending');

      await expect(
        runner.run(activeCandidate(workspace), 'sweep-1', claim),
      ).rejects.toThrow('authorization was reversed idempotently');
      expect(reversals).toEqual([runId, runId]);
      expect(durability.saves.at(-1)).toMatchObject({
        checkpoint: { phase: 'provider_terminal' },
        providerStatus: 'terminal',
      });
      expect(providerCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('accepts only exact settled full-reserve-v1 dream failures as terminal charged errors', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'eden3-memory-partial-charged-'));
    const runId = randomUUID();
    const max = 61;
    try {
      const evidence: MemoryDreamDurableEvidence = {
        checkpoint: {
          schema: 'eden-memory-dream-v1',
          phase: 'provider_started',
          date: '2026-07-31',
          previousSha256: null,
          promotion: { ...execution.promotion, agentId: 'memory-test-agent' },
          previousDreamDiarySha256: null,
          previousRemReportSha256: null,
          agentRuntime: 'openclaw',
        },
        providerStatus: 'started',
        usage: {
          id: randomUUID(),
          status: 'error',
          pricingBasis: 'provider-api',
          sessionId: runId,
          agentId: activeCandidate(workspace).agentAccountId,
          messageId: null,
          manna: max,
          errorCode: 'gateway_stream_error',
          metadata: {
            partialOutputSettlement: { rule: 'full-reserve-v1', chargedManna: max },
          },
        },
        debitKeys: [runId],
        authorization: {
          state: 'settled',
          authorizedMaxManna: max,
          chargedManna: max,
        },
      };
      expect(isSettledPartialOutputDreamFailure(evidence)).toBe(true);
      expect(
        isSettledPartialOutputDreamFailure({
          ...evidence,
          usage: { ...evidence.usage!, metadata: null },
        }),
      ).toBe(false);

      const durability = new FakeDurability(evidence);
      let reversals = 0;
      let providerCalls = 0;
      const runner = makeRunner(durability, {
        reverse: async () => {
          reversals += 1;
          throw new Error('settled partial output must never reverse');
        },
        providerCalled: () => {
          providerCalls += 1;
        },
      });
      await expect(
        runner.run(activeCandidate(workspace), 'sweep-1', {
          id: runId,
          sweepId: 'sweep-1',
          claimToken: randomUUID(),
          lastActivityAt: new Date('2026-07-31T05:00:00.000Z'),
          isRecovery: true,
        }),
      ).rejects.toThrow('full authorized reserve remains charged');
      expect(reversals).toBe(0);
      expect(providerCalls).toBe(0);
      expect(durability.saves.at(-1)).toMatchObject({
        checkpoint: { phase: 'provider_terminal' },
        providerStatus: 'terminal',
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('uses the durable run id for one idempotent hidden session', async () => {
    const marker = makeMarker('memory_deterministic_session');
    const runId = randomUUID();
    try {
      const ownerId = await insertUserAccount(`${marker}_owner`);
      const agentId = await insertAgentAccount(`${marker}_agent`, {
        ownerId,
        openclawId: `${marker}_agent`,
        workspacePath: `/tmp/${marker}`,
        provisionStatus: 'ready',
      });
      const row: ActiveMemoryDreamCandidate = {
        ...activeCandidate(`/tmp/${marker}`),
        agentAccountId: agentId,
        openclawId: `${marker}_agent`,
        username: `${marker}_agent`,
        ownerAccountId: ownerId,
        ownerUsername: `${marker}_owner`,
      };
      const owner = { accountId: ownerId, username: `${marker}_owner`, isAdmin: false };
      const first = await ensureMemoryDreamSession(row, owner, '2026-07-31', runId);
      const second = await ensureMemoryDreamSession(row, owner, '2026-07-31', runId);
      expect(first.id).toBe(runId);
      expect(second.id).toBe(runId);
      const [counts] = await pg<{ sessions: string; agents: string; users: string }[]>`
        select
          (select count(*)::text from sessions where id = ${runId}) as sessions,
          (select count(*)::text from session_agents where session_id = ${runId}) as agents,
          (select count(*)::text from session_users where session_id = ${runId}) as users
      `;
      expect(counts).toEqual({ sessions: '1', agents: '1', users: '1' });
    } finally {
      await deleteFixturesByMarker(marker);
    }
  });
});
