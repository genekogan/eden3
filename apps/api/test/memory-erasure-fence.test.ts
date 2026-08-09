import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { withAgentMemoryPublicationFence } from '../src/services/memory-distillation';

const source = readFileSync(
  new URL('../src/services/memory-distillation.ts', import.meta.url),
  'utf8',
);

const identity = {
  agentAccountId: '11111111-1111-4111-8111-111111111111',
  openclawId: 'memory-fence-agent',
  workspacePath: '/tmp/eden3-memory-fence-agent',
};

function fakeClient(options: { current?: boolean; erasing?: boolean } = {}) {
  const events: string[] = [];
  const transaction = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const sql = strings.join(' ').replace(/\s+/g, ' ').trim();
    if (sql.includes('coalesce(ag.owner_id,ag.account_id)')) {
      events.push('owner-lock');
      return options.current === false ? [] : [{ owner_account_id: 'owner-account' }];
    }
    if (sql.includes('from account_erasure_jobs')) {
      events.push('erasure-check');
      return options.erasing ? [{ exists: 1 }] : [];
    }
    throw new Error(`unexpected memory fence query: ${sql}`);
  };
  const client = {
    begin: async <T>(callback: (tx: typeof transaction) => Promise<T>): Promise<T> => {
      events.push('begin');
      const result = await callback(transaction);
      events.push('commit');
      return result;
    },
  };
  return { client, events };
}

describe('agent memory publication erasure fence', () => {
  it('locks and revalidates the human owner before the first filesystem publication', async () => {
    const { client, events } = fakeClient();
    const publish = vi.fn(async () => {
      events.push('write');
      return 'published';
    });

    await expect(withAgentMemoryPublicationFence(identity, publish, client as never))
      .resolves.toBe('published');
    expect(events).toEqual(['begin', 'owner-lock', 'erasure-check', 'write', 'commit']);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('refuses erasure-first and stale runtime identities before any write callback', async () => {
    for (const [options, code] of [
      [{ erasing: true }, 'account_erasure_active'],
      [{ current: false }, 'memory_unavailable'],
    ] as const) {
      const { client, events } = fakeClient(options);
      const publish = vi.fn();
      await expect(withAgentMemoryPublicationFence(identity, publish, client as never))
        .rejects.toMatchObject({ statusCode: 409, code });
      expect(publish).not.toHaveBeenCalled();
      expect(events).not.toContain('write');
    }
  });

  it('routes automatic/manual distillation, per-user notes, and owner correction through one fence', () => {
    expect(source).toContain('for key share of owner_account');
    expect(source).toContain('from account_erasure_jobs');
    expect(source).toContain('where ag.account_id=${params.agentAccountId}');
    expect(source).toContain('and ag.openclaw_id=${params.openclawId}');
    expect(source).toContain('and ag.workspace_path=${params.workspacePath}');
    expect(source).toContain('await withAgentMemoryPublicationFence(params, async (tx) =>');
    expect(source).toContain('await writePerUserNotes(params.workspacePath, sample)');

    const distillStart = source.indexOf('export async function distillAgentMemory');
    const saveStart = source.indexOf('export async function saveAgentMemory');
    const distill = source.slice(distillStart, saveStart);
    const save = source.slice(saveStart);
    expect(distill.indexOf('withAgentMemoryPublicationFence')).toBeLessThan(
      distill.indexOf('fs.writeFile(memoryPath'),
    );
    expect(save.indexOf('withAgentMemoryPublicationFence')).toBeLessThan(
      save.indexOf('fs.writeFile(memoryPath'),
    );
    expect(distill).toContain('recordMemoryRevision({');
    expect(save).toContain('recordMemoryRevision({');
  });
});
