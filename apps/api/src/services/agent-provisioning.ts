import { randomUUID } from 'node:crypto';

import { pg } from '@eden3/db';
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_THINKING_LEVEL,
  DEFAULT_AGENT_TOOL_GROUPS,
  type AgentModel,
  type AgentThinkingLevel,
} from '@eden3/shared';

import type { EventsBus } from '../events-bus';
import type { ProvisionerLike, SkillSyncLike, ToolSyncLike } from '../gateway-glue';
import { installDefaultAgentSkills } from './agent-skills';
import { publishBuildNotification } from './app-notifications';

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const PROVISION_LOCK_SEED = 117;

interface ProvisioningLogger {
  info(obj: unknown, message?: string): void;
  warn(obj: unknown, message?: string): void;
  error(obj: unknown, message?: string): void;
}

export interface ClaimedProvisionJob {
  agentAccountId: string;
  ownerAccountId: string;
  claimToken: string;
  attemptCount: number;
  username: string;
  name: string;
  description: string;
  persona: string;
  greeting: string;
  voice: string;
  model: AgentModel;
  thinkingLevel: AgentThinkingLevel;
  toolGroups: string[];
}

export interface AgentProvisioningStore {
  claimNext(input: { claimToken: string; leaseMs: number }): Promise<ClaimedProvisionJob | null>;
  finishReady(claim: ClaimedProvisionJob, workspacePath: string): Promise<string | null>;
  finishFailure(input: {
    claim: ClaimedProvisionJob;
    terminal: boolean;
    retryMs: number;
  }): Promise<string | null>;
}

export interface AgentProvisioningWorkerOptions {
  provisioner: ProvisionerLike;
  skillSync: SkillSyncLike;
  toolSync: ToolSyncLike;
  bus: EventsBus;
  logger?: ProvisioningLogger | null;
  intervalMs?: number;
  leaseMs?: number;
  retryMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  installSkills?: typeof installDefaultAgentSkills;
  /** Deterministic test seam; production uses the PostgreSQL implementation. */
  store?: AgentProvisioningStore;
}

function safeToolGroups(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : [...DEFAULT_AGENT_TOOL_GROUPS];
}

/**
 * Serialize filesystem/OpenClaw mutations per agent across API processes.
 * A lease fences database completion; this session advisory lock additionally
 * prevents an expired-but-resumed claimant from mutating alongside its
 * replacement. PostgreSQL releases it automatically on process/connection
 * loss. The claim is revalidated after a potentially blocking lock wait.
 */
async function withAgentProvisionLock(
  claim: ClaimedProvisionJob,
  run: () => Promise<void>,
): Promise<void> {
  const connection = await pg.reserve();
  const lockKey = `eden3:agent-provision:${claim.agentAccountId}`;
  let locked = false;
  try {
    await connection.unsafe(
      `select pg_advisory_lock(hashtextextended($1::text, ${PROVISION_LOCK_SEED}))`,
      [lockKey],
    );
    locked = true;
    const current = await connection.unsafe(
      `select 1 from agent_provision_jobs
       where agent_account_id = $1::uuid and state = 'running' and claim_token = $2::uuid`,
      [claim.agentAccountId, claim.claimToken],
    );
    if (current.length === 0) return;
    await run();
  } finally {
    try {
      if (locked) {
        await connection.unsafe(
          `select pg_advisory_unlock(hashtextextended($1::text, ${PROVISION_LOCK_SEED}))`,
          [lockKey],
        );
      }
    } finally {
      connection.release();
    }
  }
}

export class AgentProvisioningWorker {
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private wakeQueued = false;

  constructor(private readonly options: AgentProvisioningWorkerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.batchSize = options.batchSize ?? 5;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref();
    this.wake();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wake a started worker without making the request path await provisioning. */
  wake(): void {
    if (!this.timer || this.wakeQueued) return;
    this.wakeQueued = true;
    setImmediate(() => {
      this.wakeQueued = false;
      this.kick();
    });
  }

  private kick(): void {
    void this.tick().catch((error) => {
      this.options.logger?.error({ err: error }, 'agent provisioning tick failed');
    });
  }

  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let processed = 0;
    try {
      for (; processed < this.batchSize; processed += 1) {
        const claim = this.options.store
          ? await this.options.store.claimNext({ claimToken: randomUUID(), leaseMs: this.leaseMs })
          : await this.claimNext();
        if (!claim) break;
        await this.process(claim);
      }
      return processed;
    } finally {
      this.ticking = false;
    }
  }

  private async claimNext(): Promise<ClaimedProvisionJob | null> {
    const claimToken = randomUUID();
    return pg.begin(async (tx) => {
      const claimed = await tx<{ agent_account_id: string; attempt_count: number }[]>`
        with candidate as (
          select agent_account_id
          from agent_provision_jobs
          where (state = 'pending' and next_attempt_at <= now())
             or (state = 'running' and claim_expires_at <= now())
          order by created_at, agent_account_id
          for update skip locked
          limit 1
        )
        update agent_provision_jobs j
        set state = 'running',
            attempt_count = j.attempt_count + 1,
            next_attempt_at = null,
            claim_token = ${claimToken}::uuid,
            claim_expires_at = now() + ${this.leaseMs} * interval '1 millisecond',
            last_error_code = null,
            updated_at = now()
        from candidate c
        where j.agent_account_id = c.agent_account_id
        returning j.agent_account_id, j.attempt_count
      `;
      const job = claimed[0];
      if (!job) return null;

      const rows = await tx<
        Array<{
          account_id: string;
          owner_id: string;
          username: string;
          name: string | null;
          description: string | null;
          persona: string | null;
          greeting: string | null;
          voice: string | null;
          model: string | null;
          thinking_level: string | null;
          tool_groups: unknown;
        }>
      >`
        select g.account_id, g.owner_id, a.username::text, g.name, g.description,
               g.persona, g.greeting, g.voice, g.model, g.thinking_level, g.tool_groups
        from agents g
        join accounts a on a.id = g.account_id
        where g.account_id = ${job.agent_account_id}
          and g.owner_id is not null
          and g.provision_status = 'provisioning'
      `;
      const row = rows[0];
      if (!row) {
        await tx`
          update agent_provision_jobs
          set state = 'failed', claim_token = null, claim_expires_at = null,
              completed_at = now(), last_error_code = 'invalid_agent_state', updated_at = now()
          where agent_account_id = ${job.agent_account_id}
            and claim_token = ${claimToken}::uuid
        `;
        return null;
      }
      return {
        agentAccountId: row.account_id,
        ownerAccountId: row.owner_id,
        claimToken,
        attemptCount: job.attempt_count,
        username: row.username,
        name: row.name ?? row.username,
        description: row.description ?? '',
        persona: row.persona ?? '',
        greeting: row.greeting ?? '',
        voice: row.voice ?? '',
        model: (row.model ?? DEFAULT_AGENT_MODEL) as AgentModel,
        thinkingLevel: (row.thinking_level ?? DEFAULT_AGENT_THINKING_LEVEL) as AgentThinkingLevel,
        toolGroups: safeToolGroups(row.tool_groups),
      };
    });
  }

  private async process(claim: ClaimedProvisionJob): Promise<void> {
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void pg`
        update agent_provision_jobs
        set claim_expires_at = now() + ${this.leaseMs} * interval '1 millisecond',
            updated_at = now()
        where agent_account_id = ${claim.agentAccountId}
          and state = 'running'
          and claim_token = ${claim.claimToken}::uuid
      `.catch((error) => {
        this.options.logger?.warn(
          { err: error, agentAccountId: claim.agentAccountId },
          'agent provisioning heartbeat failed',
        );
      }).finally(() => {
        heartbeatBusy = false;
      });
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();

    try {
      const build = async () => {
        const result = await this.options.provisioner.provisionAgent({
          openclawId: claim.username,
          name: claim.name,
          username: claim.username,
          description: claim.description,
          persona: claim.persona,
          greeting: claim.greeting,
          voice: claim.voice,
          thinkingLevel: claim.thinkingLevel,
          model: claim.model,
        });
        await (this.options.installSkills ?? installDefaultAgentSkills)({
          agentId: claim.agentAccountId,
          openclawId: claim.username,
          workspacePath: result.hostWorkspaceDir,
          skillSync: this.options.skillSync,
        });
        await this.options.toolSync.syncAgentToolGroups({
          openclawId: claim.username,
          toolGroups: claim.toolGroups,
        });
        const notificationId = this.options.store
          ? await this.options.store.finishReady(claim, result.hostWorkspaceDir)
          : await this.finishReady(claim, result.hostWorkspaceDir);
        if (notificationId) {
          await publishBuildNotification(
            this.options.bus,
            claim.ownerAccountId,
            'agent_build_ready',
            notificationId,
          );
        }
      };
      if (this.options.store) await build();
      else await withAgentProvisionLock(claim, build);
    } catch (error) {
      this.options.logger?.error(
        { err: error, agentAccountId: claim.agentAccountId },
        'agent provisioning attempt failed',
      );
      const notificationId = this.options.store
        ? await this.options.store.finishFailure({
            claim,
            terminal: claim.attemptCount >= this.maxAttempts,
            retryMs: this.retryMs,
          })
        : await this.finishFailure(claim);
      if (notificationId) {
        await publishBuildNotification(
          this.options.bus,
          claim.ownerAccountId,
          'agent_build_failed',
          notificationId,
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async finishReady(claim: ClaimedProvisionJob, workspacePath: string): Promise<string | null> {
    return pg.begin(async (tx) => {
      const fenced = await tx<{ agent_account_id: string }[]>`
        update agent_provision_jobs
        set state = 'succeeded', next_attempt_at = null, claim_token = null,
            claim_expires_at = null, completed_at = now(), last_error_code = null,
            updated_at = now()
        where agent_account_id = ${claim.agentAccountId}
          and state = 'running'
          and claim_token = ${claim.claimToken}::uuid
        returning agent_account_id
      `;
      if (!fenced[0]) return null;
      const updated = await tx<{ account_id: string }[]>`
        update agents
        set provision_status = 'ready', provisioned_at = now(),
            workspace_path = ${workspacePath}
        where account_id = ${claim.agentAccountId}
          and provision_status = 'provisioning'
        returning account_id
      `;
      if (!updated[0]) throw new Error('agent provisioning state changed before completion');
      const inserted = await tx<{ id: string }[]>`
        insert into app_notifications (account_id, kind, source_agent_id, target_path)
        values (
          ${claim.ownerAccountId}, 'agent_build_ready', ${claim.agentAccountId},
          ${`/agents/${claim.username}`}
        )
        on conflict (account_id, kind, source_agent_id)
        where kind in ('agent_build_ready', 'agent_build_failed')
        do nothing
        returning id
      `;
      return inserted[0]?.id ?? null;
    });
  }

  private async finishFailure(claim: ClaimedProvisionJob): Promise<string | null> {
    if (claim.attemptCount < this.maxAttempts) {
      await pg`
        update agent_provision_jobs
        set state = 'pending', next_attempt_at = now() + ${this.retryMs} * interval '1 millisecond',
            claim_token = null, claim_expires_at = null,
            last_error_code = 'provision_failed', updated_at = now()
        where agent_account_id = ${claim.agentAccountId}
          and state = 'running'
          and claim_token = ${claim.claimToken}::uuid
      `;
      return null;
    }
    return pg.begin(async (tx) => {
      const fenced = await tx<{ agent_account_id: string }[]>`
        update agent_provision_jobs
        set state = 'failed', next_attempt_at = null, claim_token = null,
            claim_expires_at = null, completed_at = now(),
            last_error_code = 'provision_failed', updated_at = now()
        where agent_account_id = ${claim.agentAccountId}
          and state = 'running'
          and claim_token = ${claim.claimToken}::uuid
        returning agent_account_id
      `;
      if (!fenced[0]) return null;
      const updated = await tx<{ account_id: string }[]>`
        update agents
        set provision_status = 'failed'
        where account_id = ${claim.agentAccountId}
          and provision_status = 'provisioning'
        returning account_id
      `;
      if (!updated[0]) throw new Error('agent provisioning state changed before failure');
      const inserted = await tx<{ id: string }[]>`
        insert into app_notifications (account_id, kind, source_agent_id, target_path)
        values (
          ${claim.ownerAccountId}, 'agent_build_failed', ${claim.agentAccountId},
          ${`/agents/${claim.username}`}
        )
        on conflict (account_id, kind, source_agent_id)
        where kind in ('agent_build_ready', 'agent_build_failed')
        do nothing
        returning id
      `;
      return inserted[0]?.id ?? null;
    });
  }
}
