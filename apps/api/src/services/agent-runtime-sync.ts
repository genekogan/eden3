import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { pg } from '@eden3/db';
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_THINKING_LEVEL,
  DEFAULT_AGENT_TOOL_GROUPS,
} from '@eden3/shared';

import { ApiError, logSafeRequestWarning } from '../errors';
import {
  defaultOpenclawDataDir,
  type ProvisionerLike,
  type SkillSyncLike,
  type ToolSyncLike,
} from '../gateway-glue';
import {
  AGENT_RUNTIME_SYNC_LOCK_SEED,
  agentRuntimeSyncLockKey,
} from './agent-runtime-lock';
import { projectApprovedAgentSkills } from './agent-skills';

export { AGENT_RUNTIME_SYNC_LOCK_SEED, agentRuntimeSyncLockKey } from './agent-runtime-lock';

const CLAIM_HEARTBEAT_MS = 60_000;
const CLAIM_LEASE_MINUTES = 35;
const FAILURE_RETRY_MS = 5 * 60_000;
const MAX_IMMEDIATE_REVISIONS = 3;

interface RuntimeSyncLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

interface RuntimeSyncRow {
  account_id: string;
  username: string;
  name: string | null;
  description: string | null;
  persona: string | null;
  greeting: string | null;
  voice: string | null;
  thinking_level: string | null;
  model: string | null;
  tool_groups: unknown;
  openclaw_id: string | null;
  workspace_path: string | null;
  provision_status: string;
  runtime_sync_version: number;
  runtime_synced_version: number;
}

interface ClaimedRuntimeSync extends RuntimeSyncRow {
  claimToken: string;
}

export interface AgentRuntimeSyncDeps {
  provisioner: ProvisionerLike;
  toolSync: ToolSyncLike;
  /** Repair operations also reassert the approved/default skill manifest. */
  skillSync?: SkillSyncLike;
  logger?: RuntimeSyncLogger | null;
  dataDir?: string;
}

export type AgentRuntimeSyncResult =
  | { status: 'synced'; version: number }
  | { status: 'pending'; version: number; reason: 'runtime_error' }
  | { status: 'idle' | 'ineligible' };

type PgTransaction = Parameters<Parameters<typeof pg.begin>[1]>[0];

export class AgentRuntimePublicationRefusedError extends ApiError {
  constructor(code: 'account_erasure_active' | 'runtime_unavailable', message: string) {
    super(409, code, message);
    this.name = 'AgentRuntimePublicationRefusedError';
  }
}

/**
 * Keep the exact human owner protected from erasure while runtime bytes and
 * OpenClaw configuration are being published. The owner row is the first
 * durable row lock, matching account erasure's coordinate. Erasure-first is
 * refused before the callback; writer-first holds deletion until the claim
 * and all external effects have settled.
 */
export async function withAgentRuntimePublicationFence<T>(
  agentAccountId: string,
  publish: (ownerAccountId: string) => Promise<T>,
  client: typeof pg = pg,
): Promise<T> {
  return await (client.begin(async (tx: PgTransaction) => {
    const [current] = await tx<{ owner_account_id: string }[]>`
      select owner_account.id as owner_account_id
      from agents ag
      join accounts agent_account on agent_account.id=ag.account_id
      join accounts owner_account on owner_account.id=coalesce(ag.owner_id,ag.account_id)
      where ag.account_id=${agentAccountId}
        and agent_account.deleted=false
        and owner_account.deleted=false
      for key share of owner_account`;
    if (!current) {
      throw new AgentRuntimePublicationRefusedError(
        'runtime_unavailable',
        'current agent runtime is unavailable',
      );
    }
    const activeErasure = await tx`
      select 1 from account_erasure_jobs
      where account_id=${current.owner_account_id} and state<>'succeeded'
      limit 1`;
    if (activeErasure.length > 0) {
      throw new AgentRuntimePublicationRefusedError(
        'account_erasure_active',
        'account erasure is active',
      );
    }
    return await publish(current.owner_account_id);
  }) as unknown as Promise<T>);
}

function canonicalWorkspace(row: RuntimeSyncRow, dataDir: string): boolean {
  if (
    row.provision_status !== 'ready' ||
    row.openclaw_id === null ||
    row.workspace_path === null
  ) {
    return false;
  }
  return path.resolve(row.workspace_path) === path.resolve(path.join(dataDir, `workspace-${row.openclaw_id}`));
}

function normalizedToolGroups(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return [...DEFAULT_AGENT_TOOL_GROUPS];
  }
  return [...value];
}

/**
 * Serialize every external runtime mutation for one agent across API
 * processes. A DB lease alone can fence the final checkpoint but cannot undo
 * a stale filesystem/OpenClaw write that resumes after a newer claimant. The
 * session advisory lock is released automatically if the process/connection
 * dies, while the durable claim lease remains the crash-recovery signal.
 */
async function withAgentRuntimeSyncLock<T>(
  accountId: string,
  run: () => Promise<T>,
): Promise<T> {
  const connection = await pg.reserve();
  const lockKey = agentRuntimeSyncLockKey(accountId);
  let locked = false;
  try {
    await connection.unsafe(
      `select pg_advisory_lock(hashtextextended($1::text, ${AGENT_RUNTIME_SYNC_LOCK_SEED}))`,
      [lockKey],
    );
    locked = true;
    return await run();
  } finally {
    try {
      if (locked) {
        await connection.unsafe(
          `select pg_advisory_unlock(hashtextextended($1::text, ${AGENT_RUNTIME_SYNC_LOCK_SEED}))`,
          [lockKey],
        );
      }
    } finally {
      connection.release();
    }
  }
}

async function claimAgentRuntimeSync(
  accountId: string,
  dataDir: string,
  ownerAccountId: string,
): Promise<ClaimedRuntimeSync | null | 'ineligible'> {
  return pg.begin(async (tx) => {
    const rows = await tx<RuntimeSyncRow[]>`
      select g.account_id, a.username, g.name, g.description, g.persona,
             g.greeting, g.voice, g.thinking_level, g.model, g.tool_groups,
             g.openclaw_id, g.workspace_path, g.provision_status,
             g.runtime_sync_version, g.runtime_synced_version
      from agents g
      join accounts a on a.id = g.account_id
      where g.account_id = ${accountId}
        and coalesce(g.owner_id,g.account_id) = ${ownerAccountId}
      for update
    `;
    const row = rows[0];
    if (!row || row.runtime_sync_version <= row.runtime_synced_version) return null;
    if (!canonicalWorkspace(row, dataDir)) {
      await tx`
        update agents
        set runtime_sync_claim_token = null,
            runtime_sync_lease_expires_at = now() + ${FAILURE_RETRY_MS} * interval '1 millisecond',
            runtime_sync_error = 'runtime synchronization blocked by noncanonical workspace; retry pending'
        where account_id = ${accountId}
      `;
      return 'ineligible';
    }
    const claimToken = randomUUID();
    const claimed = await tx<{ account_id: string }[]>`
      update agents
      set runtime_sync_claim_token = ${claimToken},
          runtime_sync_lease_expires_at = now() + ${CLAIM_LEASE_MINUTES} * interval '1 minute',
          runtime_sync_error = null
      where account_id = ${accountId}
        and runtime_sync_version = ${row.runtime_sync_version}
        and runtime_sync_version > runtime_synced_version
        and (runtime_sync_lease_expires_at is null or runtime_sync_lease_expires_at <= now())
      returning account_id
    `;
    return claimed[0] ? { ...row, claimToken } : null;
  });
}

async function finishRuntimeSync(claim: ClaimedRuntimeSync): Promise<number | null> {
  const rows = await pg<{ runtime_sync_version: number }[]>`
    update agents
    set runtime_synced_version = greatest(runtime_synced_version, ${claim.runtime_sync_version}),
        runtime_sync_claim_token = null,
        runtime_sync_lease_expires_at = null,
        runtime_sync_error = null
    where account_id = ${claim.account_id}
      and runtime_sync_claim_token = ${claim.claimToken}::uuid
    returning runtime_sync_version
  `;
  return rows[0]?.runtime_sync_version ?? null;
}

async function failRuntimeSync(claim: ClaimedRuntimeSync): Promise<void> {
  await pg`
    update agents
    set runtime_sync_claim_token = null,
        runtime_sync_lease_expires_at = now() + ${FAILURE_RETRY_MS} * interval '1 millisecond',
        runtime_sync_error = 'runtime synchronization failed; retry pending'
    where account_id = ${claim.account_id}
      and runtime_sync_claim_token = ${claim.claimToken}::uuid
  `;
}

/**
 * Converge one DB-authoritative agent revision to OpenClaw. The desired row is
 * committed before this function is called; a crash at any point leaves a
 * fenced pending revision that the background scheduler can reclaim.
 */
export async function reconcileAgentRuntime(
  accountId: string,
  deps: AgentRuntimeSyncDeps,
): Promise<AgentRuntimeSyncResult> {
  const dataDir = deps.dataDir ?? defaultOpenclawDataDir();
  return await withAgentRuntimeSyncLock(accountId, async () => {
    try {
      return await withAgentRuntimePublicationFence(accountId, async (ownerAccountId) => {
        for (
          let revisionRound = 0;
          revisionRound < MAX_IMMEDIATE_REVISIONS;
          revisionRound += 1
        ) {
          const claim = await claimAgentRuntimeSync(accountId, dataDir, ownerAccountId);
          if (claim === 'ineligible') return { status: 'ineligible' };
          if (!claim) return { status: 'idle' };

          let heartbeatInFlight = false;
          const heartbeat = setInterval(() => {
            if (heartbeatInFlight) return;
            heartbeatInFlight = true;
            void pg`
              update agents
              set runtime_sync_lease_expires_at = now() + ${CLAIM_LEASE_MINUTES} * interval '1 minute'
              where account_id = ${claim.account_id}
                and runtime_sync_claim_token = ${claim.claimToken}::uuid
            `
              .catch((error) => {
                if (deps.logger) {
                  logSafeRequestWarning(
                    deps.logger,
                    error,
                    { accountId: claim.account_id },
                    'agent runtime sync heartbeat failed',
                  );
                }
              })
              .finally(() => {
                heartbeatInFlight = false;
              });
          }, CLAIM_HEARTBEAT_MS);
          heartbeat.unref?.();

          try {
            await deps.provisioner.updateAgentPersona({
              openclawId: claim.openclaw_id!,
              name: claim.name ?? claim.username,
              username: claim.username,
              description: claim.description ?? '',
              persona: claim.persona ?? '',
              greeting: claim.greeting ?? '',
              voice: claim.voice ?? '',
              thinkingLevel: claim.thinking_level ?? DEFAULT_AGENT_THINKING_LEVEL,
            });
            await deps.provisioner.provisionAgent({
              openclawId: claim.openclaw_id!,
              name: claim.name ?? claim.username,
              username: claim.username,
              description: claim.description ?? '',
              persona: claim.persona ?? '',
              greeting: claim.greeting ?? '',
              voice: claim.voice ?? '',
              thinkingLevel: claim.thinking_level ?? DEFAULT_AGENT_THINKING_LEVEL,
              model: claim.model ?? DEFAULT_AGENT_MODEL,
            });
            if (deps.skillSync) {
              await projectApprovedAgentSkills({
                agentId: claim.account_id,
                openclawId: claim.openclaw_id!,
                workspacePath: claim.workspace_path!,
                skillSync: deps.skillSync,
              });
            }
            await deps.toolSync.syncAgentToolGroups({
              openclawId: claim.openclaw_id!,
              toolGroups: normalizedToolGroups(claim.tool_groups),
            });
            const currentVersion = await finishRuntimeSync(claim);
            if (currentVersion === null) {
              // No code path may mutate the runtime outside this advisory lock.
              // If an operator changed the claim row manually, leave the desired
              // revision pending instead of asserting an unsafe completion.
              return {
                status: 'pending',
                version: claim.runtime_sync_version,
                reason: 'runtime_error',
              };
            }
            if (currentVersion > claim.runtime_sync_version) {
              // Keep the same session lock while rendering the newest committed
              // winner. No older claimant can resume after the authoritative
              // revision and clobber its filesystem/config side effects.
              if (revisionRound + 1 < MAX_IMMEDIATE_REVISIONS) continue;
              return {
                status: 'pending',
                version: currentVersion,
                reason: 'runtime_error',
              };
            }
            deps.logger?.info(
              { accountId: claim.account_id, version: claim.runtime_sync_version },
              'agent runtime configuration synchronized',
            );
            return { status: 'synced', version: claim.runtime_sync_version };
          } catch (error) {
            await failRuntimeSync(claim);
            if (deps.logger) {
              logSafeRequestWarning(
                deps.logger,
                error,
                { accountId: claim.account_id, version: claim.runtime_sync_version },
                'agent runtime synchronization deferred for retry',
              );
            }
            return {
              status: 'pending',
              version: claim.runtime_sync_version,
              reason: 'runtime_error',
            };
          } finally {
            clearInterval(heartbeat);
          }
        }
        return { status: 'idle' };
      });
    } catch (error) {
      if (error instanceof AgentRuntimePublicationRefusedError) {
        return { status: 'ineligible' };
      }
      throw error;
    }
  });
}

export class AgentRuntimeSyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly deps: AgentRuntimeSyncDeps,
    private readonly intervalMs = 30_000,
    private readonly batchLimit = 25,
  ) {}

  start(): void {
    if (this.timer !== null || this.intervalMs <= 0) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const rows = await pg<{ account_id: string }[]>`
        select account_id
        from agents
        where runtime_sync_version > runtime_synced_version
          and provision_status = 'ready'
          and openclaw_id is not null
          and workspace_path is not null
          and (runtime_sync_lease_expires_at is null or runtime_sync_lease_expires_at <= now())
        order by coalesce(runtime_sync_lease_expires_at, '-infinity'::timestamptz),
                 runtime_sync_version, account_id
        limit ${Math.max(1, Math.min(100, this.batchLimit))}
      `;
      let attempted = 0;
      for (const row of rows) {
        const result = await reconcileAgentRuntime(row.account_id, this.deps);
        if (result.status === 'synced' || result.status === 'pending') attempted += 1;
      }
      return attempted;
    } catch (error) {
      this.deps.logger?.error({ err: error }, 'agent runtime sync tick failed');
      return 0;
    } finally {
      this.ticking = false;
    }
  }
}
