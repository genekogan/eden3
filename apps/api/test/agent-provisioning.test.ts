import { describe, expect, it } from 'vitest';

import { EventsBus, type SseSink } from '../src/events-bus';
import {
  AgentProvisioningWorker,
  type AgentProvisioningStore,
  type ClaimedProvisionJob,
} from '../src/services/agent-provisioning';

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const NOTICE = '44444444-4444-4444-8444-444444444444';

function claim(attemptCount = 1): ClaimedProvisionJob {
  return {
    agentAccountId: AGENT,
    ownerAccountId: OWNER,
    claimToken: '55555555-5555-4555-8555-555555555555',
    attemptCount,
    username: 'async-agent',
    name: 'Async Agent',
    description: '',
    persona: '',
    greeting: '',
    voice: '',
    model: 'anthropic/claude-haiku-4-5',
    thinkingLevel: 'balanced',
    toolGroups: ['group:runtime'],
  };
}

function deps(store: AgentProvisioningStore, provision: () => Promise<{ hostWorkspaceDir: string }>) {
  const bus = new EventsBus();
  return {
    bus,
    worker: new AgentProvisioningWorker({
      store,
      bus,
      installSkills: async () => ({ skills: [], openclaw: { changed: false } }),
      batchSize: 1,
      maxAttempts: 2,
      provisioner: {
        provisionAgent: async () => {
          const result = await provision();
          return {
            openclawId: 'async-agent',
            hostWorkspaceDir: result.hostWorkspaceDir,
            containerWorkspaceDir: '/home/node/.openclaw/workspace-async-agent',
            filesWritten: [],
            filesSkipped: [],
            registration: 'existing' as const,
            modelUpdated: false,
            bootstrapSuppressed: true,
          };
        },
        updateAgentPersona: async () => ({ filesWritten: [], bootstrapSuppressed: true }),
      },
      skillSync: { syncAgentSkills: async () => ({ changed: false }) },
      toolSync: { syncAgentToolGroups: async () => ({ changed: false }) },
    }),
  };
}

describe('durable async agent provisioning worker', () => {
  it('single-flights concurrent ticks and emits only to the owner channel after commit', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let provisionCalls = 0;
    let claimed = false;
    const store: AgentProvisioningStore = {
      claimNext: async () => {
        if (claimed) return null;
        claimed = true;
        return claim();
      },
      finishReady: async () => NOTICE,
      finishFailure: async () => null,
    };
    const { bus, worker } = deps(store, async () => {
      provisionCalls += 1;
      await blocked;
      return { hostWorkspaceDir: '/tmp/workspace-async-agent' };
    });
    const ownerFrames: string[] = [];
    const strangerFrames: string[] = [];
    bus.subscribe(`account:${OWNER}`, { write: (frame) => ownerFrames.push(frame) } as SseSink);
    bus.subscribe(`account:${STRANGER}`, {
      write: (frame) => strangerFrames.push(frame),
    } as SseSink);

    const first = worker.tick();
    await Promise.resolve();
    expect(await worker.tick()).toBe(0);
    release();
    expect(await first).toBe(1);
    expect(provisionCalls).toBe(1);
    expect(ownerFrames).toHaveLength(1);
    expect(ownerFrames[0]).toContain('notification.created');
    expect(ownerFrames[0]).toContain(NOTICE);
    expect(strangerFrames).toEqual([]);
  });

  it('a fresh worker retries a durable failed attempt and notifies exactly once', async () => {
    const claims = [claim(1), claim(2)];
    let attempt = 0;
    let readyFinishes = 0;
    let failedFinishes = 0;
    const store: AgentProvisioningStore = {
      claimNext: async () => claims.shift() ?? null,
      finishReady: async () => {
        readyFinishes += 1;
        return NOTICE;
      },
      finishFailure: async ({ terminal }) => {
        failedFinishes += 1;
        expect(terminal).toBe(false);
        return null;
      },
    };
    const first = deps(store, async () => {
      attempt += 1;
      throw new Error('transient');
    });
    expect(await first.worker.tick()).toBe(1);

    const restarted = deps(store, async () => {
      attempt += 1;
      return { hostWorkspaceDir: '/tmp/workspace-async-agent' };
    });
    const frames: string[] = [];
    restarted.bus.subscribe(`account:${OWNER}`, { write: (frame) => frames.push(frame) });
    expect(await restarted.worker.tick()).toBe(1);
    expect(attempt).toBe(2);
    expect(failedFinishes).toBe(1);
    expect(readyFinishes).toBe(1);
    expect(frames).toHaveLength(1);
  });

  it('does not publish when a stale claimant loses the fenced completion', async () => {
    const store: AgentProvisioningStore = {
      claimNext: async () => claim(),
      finishReady: async () => null,
      finishFailure: async () => null,
    };
    const { bus, worker } = deps(store, async () => ({
      hostWorkspaceDir: '/tmp/workspace-async-agent',
    }));
    const frames: string[] = [];
    bus.subscribe(`account:${OWNER}`, { write: (frame) => frames.push(frame) });
    expect(await worker.tick()).toBe(1);
    expect(frames).toEqual([]);
  });

  it('emits one failed notification only after the terminal attempt is fenced', async () => {
    let finished = false;
    const store: AgentProvisioningStore = {
      claimNext: async () => (finished ? null : claim(2)),
      finishReady: async () => null,
      finishFailure: async ({ terminal }) => {
        expect(terminal).toBe(true);
        finished = true;
        return NOTICE;
      },
    };
    const { bus, worker } = deps(store, async () => {
      throw new Error('permanent');
    });
    const frames: string[] = [];
    bus.subscribe(`account:${OWNER}`, { write: (frame) => frames.push(frame) });
    expect(await worker.tick()).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('agent_build_failed');
  });
});
