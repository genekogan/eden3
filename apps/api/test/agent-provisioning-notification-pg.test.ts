import { randomUUID } from 'node:crypto';

import type { PgClient } from '@eden3/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

let pg: PgClient;
let EventsBus: typeof import('../src/events-bus').EventsBus;
let AgentProvisioningWorker: typeof import('../src/services/agent-provisioning').AgentProvisioningWorker;

async function fixture(preseedKind?: 'agent_build_ready' | 'agent_build_failed') {
  const ownerId = randomUUID();
  const agentId = randomUUID();
  const username = `notice-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await pg.begin(async (tx) => {
    await tx`
      insert into accounts (id, type, username)
      values (${ownerId}, 'user', ${`${username}-owner`}), (${agentId}, 'agent', ${username})
    `;
    await tx`
      insert into agents (
        account_id, owner_id, name, description, persona, greeting, openclaw_id,
        provision_status
      ) values (
        ${agentId}, ${ownerId}, 'Notification Probe', '', '', '', ${username},
        'provisioning'
      )
    `;
    await tx`
      insert into agent_provision_jobs (agent_account_id, state, attempt_count, next_attempt_at)
      values (${agentId}, 'pending', 0, now())
    `;
    if (preseedKind) {
      await tx`
        insert into app_notifications (account_id, kind, source_agent_id, target_path)
        values (${ownerId}, ${preseedKind}, ${agentId}, ${`/agents/${username}`})
      `;
    }
  });
  return { ownerId, agentId, username };
}

function worker(options: {
  fail: boolean;
  maxAttempts: number;
  bus?: InstanceType<typeof EventsBus>;
  onProvision?: () => Promise<void> | void;
}) {
  const bus = options.bus ?? new EventsBus();
  return new AgentProvisioningWorker({
    bus,
    batchSize: 1,
    maxAttempts: options.maxAttempts,
    installSkills: async () => ({ skills: [], openclaw: { changed: false } }),
    provisioner: {
      provisionAgent: async (params) => {
        await options.onProvision?.();
        if (options.fail) throw new Error('deterministic provisioning failure');
        return {
          openclawId: params.openclawId,
          hostWorkspaceDir: `/tmp/${params.openclawId}`,
          containerWorkspaceDir: `/tmp/${params.openclawId}`,
          filesWritten: [],
          filesSkipped: [],
          registration: 'existing' as const,
          modelUpdated: false,
          bootstrapSuppressed: true as const,
        };
      },
      updateAgentPersona: async () => ({ filesWritten: [], bootstrapSuppressed: true as const }),
    },
    skillSync: { syncAgentSkills: async () => ({ changed: false }) },
    toolSync: { syncAgentToolGroups: async () => ({ changed: false }) },
  });
}

async function state(agentId: string, kind: string) {
  const [row] = await pg<
    { jobState: string; provisionStatus: string; notificationCount: number }[]
  >`
    select j.state as "jobState", g.provision_status as "provisionStatus",
           (select count(*)::int from app_notifications n
            where n.source_agent_id = ${agentId} and n.kind = ${kind}) as "notificationCount"
    from agent_provision_jobs j
    join agents g on g.account_id = j.agent_account_id
    where j.agent_account_id = ${agentId}
  `;
  return row;
}

describe('agent provisioning notifications (disposable Postgres)', () => {
  beforeAll(async () => {
    [{ pg }, { EventsBus }, { AgentProvisioningWorker }] = await Promise.all([
      import('@eden3/db'),
      import('../src/events-bus'),
      import('../src/services/agent-provisioning'),
    ]);
  });

  afterAll(async () => {
    await pg.end({ timeout: 5 });
  });

  afterEach(async () => {
    // This suite is lease-bound to an explicitly disposable database. TRUNCATE
    // is the only truthful teardown for the retained erasure-job fixture:
    // production DELETE intentionally refuses to remove those replay records.
    // CASCADE restores the exact empty migrated baseline required by the next
    // gated PostgreSQL evidence suite in `test:full`.
    await pg.unsafe('truncate table accounts cascade');
  });

  it('finishes ready, publishes once, and makes stale replay a no-op', async () => {
    const probe = await fixture();
    const bus = new EventsBus();
    const frames: string[] = [];
    bus.subscribe(`account:${probe.ownerId}`, { write: (frame) => frames.push(frame) });
    const subject = worker({ fail: false, maxAttempts: 1, bus });
    await expect(subject.tick()).resolves.toBe(1);
    expect(await state(probe.agentId, 'agent_build_ready')).toEqual({
      jobState: 'succeeded',
      provisionStatus: 'ready',
      notificationCount: 1,
    });
    expect(frames).toHaveLength(1);
    await expect(subject.tick()).resolves.toBe(0);
    expect(await state(probe.agentId, 'agent_build_ready')).toEqual({
      jobState: 'succeeded',
      provisionStatus: 'ready',
      notificationCount: 1,
    });
    expect(frames).toHaveLength(1);
  });

  it('finishes max-attempt failure and publishes once', async () => {
    const probe = await fixture();
    const bus = new EventsBus();
    const frames: string[] = [];
    bus.subscribe(`account:${probe.ownerId}`, { write: (frame) => frames.push(frame) });
    await expect(worker({ fail: true, maxAttempts: 1, bus }).tick()).resolves.toBe(1);
    expect(await state(probe.agentId, 'agent_build_failed')).toEqual({
      jobState: 'failed',
      provisionStatus: 'failed',
      notificationCount: 1,
    });
    expect(frames).toHaveLength(1);
  });

  it('commits against a preseeded duplicate without republishing or replay mutation', async () => {
    const probe = await fixture('agent_build_ready');
    const bus = new EventsBus();
    const frames: string[] = [];
    bus.subscribe(`account:${probe.ownerId}`, { write: (frame) => frames.push(frame) });
    const subject = worker({ fail: false, maxAttempts: 1, bus });
    await expect(subject.tick()).resolves.toBe(1);
    expect(await state(probe.agentId, 'agent_build_ready')).toEqual({
      jobState: 'succeeded',
      provisionStatus: 'ready',
      notificationCount: 1,
    });
    expect(frames).toEqual([]);
    await expect(subject.tick()).resolves.toBe(0);
    expect(frames).toEqual([]);
  });

  it('makes two production workers converge on one provision and one notification', async () => {
    const probe = await fixture();
    let provisions = 0;
    const onProvision = async () => {
      provisions += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    const [first, second] = await Promise.all([
      worker({ fail: false, maxAttempts: 1, onProvision }).tick(),
      worker({ fail: false, maxAttempts: 1, onProvision }).tick(),
    ]);
    expect(first + second).toBe(1);
    expect(provisions).toBe(1);
    expect(await state(probe.agentId, 'agent_build_ready')).toEqual({
      jobState: 'succeeded',
      provisionStatus: 'ready',
      notificationCount: 1,
    });
  });

  it('keeps terminalization and direct notification writes fenced during owner erasure', async () => {
    const probe = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed!: () => void;
    const provisionClaimed = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const ticking = worker({
      fail: false,
      maxAttempts: 1,
      onProvision: async () => {
        claimed();
        await blocked;
      },
    }).tick();
    await provisionClaimed;
    await pg`
      insert into account_erasure_jobs (account_id, state)
      values (${probe.ownerId}, 'intent_pending')
    `;
    release();
    await expect(ticking).rejects.toMatchObject({ code: '55000' });
    expect(await state(probe.agentId, 'agent_build_ready')).toEqual({
      jobState: 'running',
      provisionStatus: 'provisioning',
      notificationCount: 0,
    });
    await expect(
      pg`
        insert into app_notifications (account_id, kind, source_agent_id, target_path)
        values (
          ${probe.ownerId}, 'agent_build_ready', ${probe.agentId},
          ${`/agents/${probe.username}`}
        )
      `,
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('pins the exact valid, ready, unique partial-index predicate', async () => {
    const [index] = await pg<
      { predicate: string; valid: boolean; ready: boolean; unique: boolean }[]
    >`
      select pg_get_expr(i.indpred, i.indrelid, true) as predicate,
             i.indisvalid as valid, i.indisready as ready, i.indisunique as unique
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname = 'app_notifications_build_once_uq'
    `;
    expect(index).toEqual({
      predicate:
        "kind = ANY (ARRAY['agent_build_ready'::text, 'agent_build_failed'::text])",
      valid: true,
      ready: true,
      unique: true,
    });
  });
});
