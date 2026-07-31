import path from 'node:path';

import { loadRootEnv, pg } from '@eden3/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AgentRuntimeSyncScheduler,
  reconcileAgentRuntime,
} from '../src/services/agent-runtime-sync';
import {
  deleteFixturesByMarker,
  insertAgentAccount,
  insertUserAccount,
  makeFakeProvisioner,
  makeFakeToolSync,
  makeMarker,
} from './fixtures';

loadRootEnv();

const marker = makeMarker('runtime_sync');
const dataDir = '/tmp/eden3-runtime-sync-test';
let ownerId = '';

beforeAll(async () => {
  ownerId = await insertUserAccount(`${marker}_owner`);
});

afterAll(async () => {
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

async function pendingAgent(suffix: string): Promise<{ id: string; username: string }> {
  const username = `${marker}_${suffix}`;
  const id = await insertAgentAccount(username, {
    ownerId,
    name: `Runtime ${suffix}`,
    persona: `persona ${suffix}`,
    greeting: `hello ${suffix}`,
    openclawId: username,
    workspacePath: path.join(dataDir, `workspace-${username}`),
    provisionStatus: 'ready',
  });
  await pg`
    update agents
    set runtime_sync_version = 1, runtime_synced_version = 0
    where account_id = ${id}
  `;
  return { id, username };
}

describe('durable agent runtime convergence', () => {
  it('repairs a committed revision left pending by process death', async () => {
    const agent = await pendingAgent('crash');
    const provisioner = makeFakeProvisioner();
    const toolSync = makeFakeToolSync();

    await expect(
      reconcileAgentRuntime(agent.id, { provisioner, toolSync, dataDir }),
    ).resolves.toEqual({ status: 'synced', version: 1 });
    expect(provisioner.personaUpdates.at(-1)).toMatchObject({
      openclawId: agent.username,
      persona: 'persona crash',
      greeting: 'hello crash',
    });
    expect(provisioner.provisions.at(-1)).toMatchObject({ openclawId: agent.username });
    expect(toolSync.calls.at(-1)).toMatchObject({ openclawId: agent.username });
    const [row] = await pg<{
      runtime_sync_version: number;
      runtime_synced_version: number;
      runtime_sync_claim_token: string | null;
    }[]>`
      select runtime_sync_version, runtime_synced_version, runtime_sync_claim_token
      from agents where account_id = ${agent.id}
    `;
    expect(row).toEqual({
      runtime_sync_version: 1,
      runtime_synced_version: 1,
      runtime_sync_claim_token: null,
    });
  });

  it('keeps a partial failed write pending and later renders the newest DB winner', async () => {
    const agent = await pendingAgent('retry');
    const provisioner = makeFakeProvisioner();
    const basePersonaUpdate = provisioner.updateAgentPersona.bind(provisioner);
    let failOnce = true;
    provisioner.updateAgentPersona = async (params) => {
      const result = await basePersonaUpdate(params);
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated restore failure after partial mutation');
      }
      return result;
    };
    const toolSync = makeFakeToolSync();

    await expect(
      reconcileAgentRuntime(agent.id, { provisioner, toolSync, dataDir }),
    ).resolves.toMatchObject({ status: 'pending', version: 1 });
    const [failed] = await pg<{
      runtime_synced_version: number;
      runtime_sync_claim_token: string | null;
      runtime_sync_error: string | null;
    }[]>`
      select runtime_synced_version, runtime_sync_claim_token, runtime_sync_error
      from agents where account_id = ${agent.id}
    `;
    expect(failed!.runtime_synced_version).toBe(0);
    expect(failed!.runtime_sync_claim_token).toBeNull();
    expect(failed!.runtime_sync_error).toContain('retry pending');

    await pg`
      update agents
      set persona = 'newest database persona',
          greeting = 'newest database greeting',
          runtime_sync_version = runtime_sync_version + 1,
          runtime_sync_lease_expires_at = null
      where account_id = ${agent.id}
    `;
    const scheduler = new AgentRuntimeSyncScheduler(
      { provisioner, toolSync, dataDir },
      0,
      10,
    );
    await expect(scheduler.tick()).resolves.toBe(1);
    expect(provisioner.personaUpdates.at(-1)).toMatchObject({
      persona: 'newest database persona',
      greeting: 'newest database greeting',
    });
    const [recovered] = await pg<{
      runtime_sync_version: number;
      runtime_synced_version: number;
      runtime_sync_error: string | null;
    }[]>`
      select runtime_sync_version, runtime_synced_version, runtime_sync_error
      from agents where account_id = ${agent.id}
    `;
    expect(recovered).toEqual({
      runtime_sync_version: 2,
      runtime_synced_version: 2,
      runtime_sync_error: null,
    });
  });

  it('serializes expired claimants so an older external write cannot land after the winner', async () => {
    const agent = await pendingAgent('fenced');
    const provisioner = makeFakeProvisioner();
    const basePersonaUpdate = provisioner.updateAgentPersona.bind(provisioner);
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const writes: string[] = [];
    provisioner.updateAgentPersona = async (params) => {
      writes.push(`start:${params.persona}`);
      if (params.persona === 'persona fenced') {
        enteredFirst();
        await firstGate;
      }
      const result = await basePersonaUpdate(params);
      writes.push(`finish:${params.persona}`);
      return result;
    };
    const toolSync = makeFakeToolSync();

    const first = reconcileAgentRuntime(agent.id, { provisioner, toolSync, dataDir });
    await firstEntered;
    await pg`
      update agents
      set persona = 'authoritative v2',
          runtime_sync_version = runtime_sync_version + 1,
          runtime_sync_lease_expires_at = now() - interval '1 second'
      where account_id = ${agent.id}
    `;
    const second = reconcileAgentRuntime(agent.id, { provisioner, toolSync, dataDir });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writes).toEqual(['start:persona fenced']);

    releaseFirst();
    const results = await Promise.all([first, second]);
    expect(results).toContainEqual({ status: 'synced', version: 2 });
    expect(writes.at(-1)).toBe('finish:authoritative v2');
    expect(provisioner.personaUpdates.at(-1)).toMatchObject({ persona: 'authoritative v2' });
    const [row] = await pg<{
      runtime_sync_version: number;
      runtime_synced_version: number;
      runtime_sync_claim_token: string | null;
    }[]>`
      select runtime_sync_version, runtime_synced_version, runtime_sync_claim_token
      from agents where account_id = ${agent.id}
    `;
    expect(row).toEqual({
      runtime_sync_version: 2,
      runtime_synced_version: 2,
      runtime_sync_claim_token: null,
    });
  });

  it('backs off a failing row so a small batch cannot starve later agents', async () => {
    const first = await pendingAgent('backoff_a');
    const second = await pendingAgent('backoff_b');
    const provisioner = makeFakeProvisioner({ failPersonaUpdate: true });
    const scheduler = new AgentRuntimeSyncScheduler(
      { provisioner, toolSync: makeFakeToolSync(), dataDir },
      0,
      1,
    );

    await expect(scheduler.tick()).resolves.toBe(1);
    const [afterFirst] = await pg<{ count: number }[]>`
      select count(*)::int as count from agents
      where account_id in (${first.id}, ${second.id}) and runtime_sync_error is not null
    `;
    expect(afterFirst!.count).toBe(1);

    await expect(scheduler.tick()).resolves.toBe(1);
    const [afterSecond] = await pg<{ count: number }[]>`
      select count(*)::int as count from agents
      where account_id in (${first.id}, ${second.id}) and runtime_sync_error is not null
    `;
    expect(afterSecond!.count).toBe(2);
  });

  it('never calls runtime seams for a noncanonical workspace', async () => {
    const username = `${marker}_noncanonical`;
    const id = await insertAgentAccount(username, {
      ownerId,
      openclawId: username,
      workspacePath: `/tmp/wrong-${username}`,
      provisionStatus: 'ready',
    });
    await pg`
      update agents set runtime_sync_version = 1 where account_id = ${id}
    `;
    const provisioner = makeFakeProvisioner();
    const toolSync = makeFakeToolSync();
    await expect(
      reconcileAgentRuntime(id, { provisioner, toolSync, dataDir }),
    ).resolves.toEqual({ status: 'ineligible' });
    expect(provisioner.personaUpdates).toHaveLength(0);
    expect(provisioner.provisions).toHaveLength(0);
    expect(toolSync.calls).toHaveLength(0);
  });
});
