import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { gatewaySessionKey, type AuthSession, type DbHandle } from '@eden3/core';
import {
  db,
  memoryDreamRuns,
  messages,
  pg,
  sessionAgents,
  sessionUsers,
  sessions,
  type Session,
} from '@eden3/db';
import { MEMORY_DREAM_MODEL, type MemoryPromotionSummary } from '@eden3/gateway';
import type { AgentRuntime } from '@eden3/shared';
import { and, eq, sql } from 'drizzle-orm';

import type { EventsBus } from '../events-bus';
import type { MemoryRuntimeLike, ModelRuntimeCatalogLike } from '../gateway-glue';
import {
  agentMemoryStatus,
  distillAgentMemory,
  memorySha256,
  recordMemoryRevision,
} from './memory-distillation';
import type { HistorySync } from './history-sync';
import type { TurnRegistry } from './turn-registry';
import {
  runTurn,
  type CompatClientLike,
  TurnClaimLostError,
  type TurnSink,
} from './turns';
import {
  reverseTurnAuthorization,
  type ReverseTurnAuthorizationResult,
} from './turn-authorization';
import { MAX_PROVIDER_TURN_MS } from './subscription-turn-claims';

export type MemoryDreamSkipReason =
  | 'inactive'
  | 'already-dreamed'
  | 'seed-too-little-history'
  | 'missing-owner'
  | 'missing-workspace'
  | 'not-ready';

/** A non-heartbeating owner cannot be stolen during a valid provider turn. */
export const MEMORY_DREAM_CLAIM_STALE_MS = 35 * 60 * 1000;
export const MEMORY_DREAM_HEARTBEAT_MS = 60 * 1000;

if (MEMORY_DREAM_CLAIM_STALE_MS <= MAX_PROVIDER_TURN_MS) {
  throw new Error('memory dream lease must exceed the provider turn ceiling');
}

export interface MemoryDreamCandidate {
  agentAccountId: string;
  openclawId: string | null;
  username: string;
  name: string | null;
  persona: string | null;
  workspacePath: string | null;
  provisionStatus: string;
  ownerAccountId: string | null;
  ownerUsername: string | null;
  lastActivityAt: Date | null;
  /** Activity watermark captured by the newest successful dream run. */
  lastSuccessfulDreamActivityAt: Date | null;
  /** An unfinished same-sweep run must be recovered even after its activity ages out. */
  recoveryPending: boolean;
}

/** Minimal durable identity needed to reclaim an existing run. */
export interface RunnableMemoryDreamCandidate extends MemoryDreamCandidate {
  openclawId: string;
  lastActivityAt: Date;
}

export interface ActiveMemoryDreamCandidate extends RunnableMemoryDreamCandidate {
  workspacePath: string;
  ownerAccountId: string;
  ownerUsername: string;
}

export interface MemoryDreamSkippedAgent {
  agentAccountId: string;
  openclawId: string | null;
  reason: MemoryDreamSkipReason;
  lastActivityAt: string | null;
}

export function selectActiveMemoryDreamAgents(
  candidates: readonly MemoryDreamCandidate[],
  windowStart: Date,
): { active: RunnableMemoryDreamCandidate[]; skipped: MemoryDreamSkippedAgent[] } {
  const active: RunnableMemoryDreamCandidate[] = [];
  const skipped: MemoryDreamSkippedAgent[] = [];
  for (const candidate of candidates) {
    let reason: MemoryDreamSkipReason | null = null;
    // Recovery owns already-durable external/ledger state. It must not be
    // stranded because current agent eligibility changed after the turn.
    if (candidate.recoveryPending) {
      if (!candidate.openclawId || !candidate.lastActivityAt) reason = 'not-ready';
    } else {
      if (!candidate.ownerAccountId || !candidate.ownerUsername) reason = 'missing-owner';
      else if (!candidate.openclawId || candidate.provisionStatus !== 'ready') reason = 'not-ready';
      else if (!candidate.workspacePath) reason = 'missing-workspace';
      else if (!candidate.lastActivityAt || candidate.lastActivityAt < windowStart) reason = 'inactive';
      else if (
        candidate.lastSuccessfulDreamActivityAt &&
        candidate.lastSuccessfulDreamActivityAt >= candidate.lastActivityAt
      ) reason = 'already-dreamed';
    }

    if (reason !== null) {
      skipped.push({
        agentAccountId: candidate.agentAccountId,
        openclawId: candidate.openclawId,
        reason,
        lastActivityAt: candidate.lastActivityAt?.toISOString() ?? null,
      });
      continue;
    }
    active.push(candidate as RunnableMemoryDreamCandidate);
  }
  return { active, skipped };
}

export interface ClaimMemoryDreamSweepParams {
  sweepKey: string;
  windowStart: Date;
  eligibleCount: number;
  activeCount: number;
  skipped: MemoryDreamSkippedAgent[];
}

export interface MemoryDreamSweepClaim {
  id: string;
  claimToken: string;
}

export interface MemoryDreamRunClaim {
  id: string;
  sweepId: string;
  claimToken: string;
  lastActivityAt: Date;
  /** Existing unfinished work; incidental failures must remain retryable. */
  isRecovery: boolean;
}

export interface CompleteMemoryDreamRunParams {
  runId: string;
  claimToken: string;
  result: MemoryDreamExecutionResult;
  durationMs: number;
}

export interface MemoryDreamStore {
  listCandidates(windowStart: Date, sweepKey: string): Promise<MemoryDreamCandidate[]>;
  claimSweep(params: ClaimMemoryDreamSweepParams): Promise<MemoryDreamSweepClaim | null>;
  heartbeatSweep(claim: MemoryDreamSweepClaim): Promise<boolean>;
  startRun(
    sweep: MemoryDreamSweepClaim,
    candidate: RunnableMemoryDreamCandidate,
  ): Promise<MemoryDreamRunClaim | null>;
  heartbeatRun(claim: MemoryDreamRunClaim): Promise<boolean>;
  completeRun(params: CompleteMemoryDreamRunParams): Promise<boolean>;
  failRun(params: {
    runId: string;
    claimToken: string;
    error: string;
    durationMs: number;
    status?: 'error' | 'recovery_pending';
  }): Promise<boolean>;
  skipRun(params: {
    runId: string;
    claimToken: string;
    candidate: RunnableMemoryDreamCandidate;
    reason: MemoryDreamSkipReason;
    durationMs: number;
  }): Promise<boolean>;
  /** Re-aggregate a prior abandoned sweep after cross-sweep recovery. */
  reconcileAbandonedSweep(sweepId: string): Promise<boolean>;
  finishSweep(params: {
    sweepId: string;
    claimToken: string;
    succeeded: number;
    failed: number;
    durationMs: number;
  }): Promise<boolean>;
}

export interface MemoryDreamExecutionResult {
  agentRuntime: AgentRuntime;
  pricingBasis: 'provider-api' | 'notional-subscription';
  promotion: MemoryPromotionSummary;
  usageEventId: string;
  previousSha256: string | null;
  sha256: string | null;
  provenance: Record<string, unknown>;
}

export interface MemoryDreamAgentRunner {
  run(
    candidate: RunnableMemoryDreamCandidate,
    sweepId: string,
    run: MemoryDreamRunClaim,
  ): Promise<MemoryDreamExecutionResult>;
}

export class MemoryDreamRecoveryPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryDreamRecoveryPendingError';
  }
}

/** The recovery path reached a deliberate no-replay terminal decision. */
class MemoryDreamRecoveryResolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryDreamRecoveryResolvedError';
  }
}

/** A currently active agent is intentionally deferred without failing its sweep. */
export class MemoryDreamSkippedError extends Error {
  constructor(
    readonly reason: MemoryDreamSkipReason,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryDreamSkippedError';
  }
}

export interface MemoryDreamSweepResult {
  claimed: boolean;
  sweepId: string | null;
  eligible: number;
  active: number;
  skipped: MemoryDreamSkippedAgent[];
  succeeded: number;
  failed: number;
}

/** Durable coordinator: only the `active` slice reaches the per-agent runner. */
export class MemoryDreamOrchestrator {
  private readonly now: () => Date;

  constructor(
    private readonly store: MemoryDreamStore,
    private readonly runner: MemoryDreamAgentRunner,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async run(sweepKey: string, windowStart: Date): Promise<MemoryDreamSweepResult> {
    const started = this.now().getTime();
    const candidates = await this.store.listCandidates(windowStart, sweepKey);
    const selected = selectActiveMemoryDreamAgents(candidates, windowStart);
    const sweepClaim = await this.store.claimSweep({
      sweepKey,
      windowStart,
      eligibleCount: candidates.length,
      activeCount: selected.active.length,
      skipped: selected.skipped,
    });
    if (sweepClaim === null) {
      return {
        claimed: false,
        sweepId: null,
        eligible: candidates.length,
        active: selected.active.length,
        skipped: selected.skipped,
        succeeded: 0,
        failed: 0,
      };
    }

    let succeeded = 0;
    let failed = 0;
    const skipped = [...selected.skipped];
    const sweepHeartbeat = setInterval(() => {
      void this.store.heartbeatSweep(sweepClaim).catch(() => {});
    }, MEMORY_DREAM_HEARTBEAT_MS);
    sweepHeartbeat.unref?.();
    try {
      for (const candidate of selected.active) {
        let runClaim = await this.store.startRun(sweepClaim, candidate);
        while (runClaim !== null) {
          const runStarted = this.now().getTime();
          let terminalCommitted = false;
          let recoveryResolved = false;
          const runHeartbeat = setInterval(() => {
            void this.store.heartbeatRun(runClaim!).catch(() => {});
          }, MEMORY_DREAM_HEARTBEAT_MS);
          runHeartbeat.unref?.();
          try {
            const result = await this.runner.run(candidate, runClaim.sweepId, runClaim);
            terminalCommitted = await this.store.completeRun({
              runId: runClaim.id,
              claimToken: runClaim.claimToken,
              result,
              durationMs: Math.max(0, this.now().getTime() - runStarted),
            });
            recoveryResolved = terminalCommitted;
            if (terminalCommitted) succeeded += 1;
          } catch (err) {
            if (err instanceof MemoryDreamSkippedError) {
              terminalCommitted = await this.store.skipRun({
                runId: runClaim.id,
                claimToken: runClaim.claimToken,
                candidate,
                reason: err.reason,
                durationMs: Math.max(0, this.now().getTime() - runStarted),
              });
              recoveryResolved = terminalCommitted;
              if (terminalCommitted) {
                skipped.push({
                  agentAccountId: candidate.agentAccountId,
                  openclawId: candidate.openclawId,
                  reason: err.reason,
                  lastActivityAt: candidate.lastActivityAt.toISOString(),
                });
              }
            } else {
              const status =
                err instanceof MemoryDreamRecoveryPendingError
                  ? 'recovery_pending'
                  : runClaim.isRecovery && !(err instanceof MemoryDreamRecoveryResolvedError)
                    ? 'recovery_pending'
                    : 'error';
              terminalCommitted = await this.store.failRun({
                runId: runClaim.id,
                claimToken: runClaim.claimToken,
                error: (err instanceof Error ? err.message : String(err)).slice(0, 2_000),
                durationMs: Math.max(0, this.now().getTime() - runStarted),
                status,
              });
              recoveryResolved = terminalCommitted && status === 'error';
              if (terminalCommitted) failed += 1;
            }
          } finally {
            clearInterval(runHeartbeat);
          }

          if (terminalCommitted && runClaim.sweepId !== sweepClaim.id) {
            await this.store.reconcileAbandonedSweep(runClaim.sweepId);
          }
          const shouldRunCurrentActivity =
            runClaim.isRecovery &&
            recoveryResolved &&
            hasActiveDreamContext(candidate) &&
            candidate.lastActivityAt >= windowStart &&
            candidate.lastActivityAt > runClaim.lastActivityAt &&
            (!candidate.lastSuccessfulDreamActivityAt ||
              candidate.lastSuccessfulDreamActivityAt < candidate.lastActivityAt);
          if (!shouldRunCurrentActivity) break;
          runClaim = await this.store.startRun(sweepClaim, {
            ...candidate,
            recoveryPending: false,
          });
        }
      }
      await this.store.finishSweep({
        sweepId: sweepClaim.id,
        claimToken: sweepClaim.claimToken,
        succeeded,
        failed,
        durationMs: Math.max(0, this.now().getTime() - started),
      });
    } finally {
      clearInterval(sweepHeartbeat);
    }
    return {
      claimed: true,
      sweepId: sweepClaim.id,
      eligible: candidates.length,
      active: selected.active.length,
      skipped,
      succeeded,
      failed,
    };
  }
}

export class PostgresMemoryDreamStore implements MemoryDreamStore {
  private readonly now: () => Date;
  private readonly staleAfterMs: number;
  private readonly client: typeof pg;

  constructor(
    options: { now?: () => Date; staleAfterMs?: number; client?: typeof pg } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.staleAfterMs = options.staleAfterMs ?? MEMORY_DREAM_CLAIM_STALE_MS;
    if (this.staleAfterMs <= MAX_PROVIDER_TURN_MS) {
      throw new RangeError('memory dream stale horizon must exceed the provider turn ceiling');
    }
    this.client = options.client ?? pg;
  }

  async listCandidates(windowStart: Date, _sweepKey: string): Promise<MemoryDreamCandidate[]> {
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.staleAfterMs);
    const rows = await this.client<{
      agent_account_id: string;
      openclaw_id: string | null;
      username: string;
      name: string | null;
      persona: string | null;
      workspace_path: string | null;
      provision_status: string;
      owner_account_id: string | null;
      owner_username: string | null;
      last_activity_at: string | Date | null;
      last_successful_dream_activity_at: string | Date | null;
      recovery_pending: boolean;
    }[]>`
      with activity_events as (
        select sa.agent_account_id, max(s.last_message_at) as activity_at
        from session_agents sa
        join sessions s on s.id = sa.session_id
        where s.deleted = false
          and s.session_type is distinct from 'memory_dream'
          and s.last_message_at >= ${windowStart.toISOString()}
        group by sa.agent_account_id
        union all
        select ue.agent_id as agent_account_id, max(ue.created_at) as activity_at
        from usage_events ue
        where ue.agent_id is not null
          and ue.event_type <> 'memory_dream'
          and ue.created_at >= ${windowStart.toISOString()}
        group by ue.agent_id
      ), latest_activity as (
        select agent_account_id, max(activity_at) as last_activity_at
        from activity_events
        group by agent_account_id
      ), latest_dream as (
        select distinct on (agent_account_id)
               agent_account_id,
               last_activity_at as last_successful_dream_activity_at
        from memory_dream_runs
        where status = 'done'
        order by agent_account_id, completed_at desc nulls last, id desc
      ), pending_recovery as (
        select r.agent_account_id, r.openclaw_id, r.last_activity_at
        from memory_dream_runs r
        where (
            r.status = 'recovery_pending'
            or (
              r.status = 'running'
              and (
                r.lease_expires_at <= ${now.toISOString()}
                or (
                  r.lease_expires_at is null
                  and r.started_at <= ${staleBefore.toISOString()}
                )
              )
            )
        )
      )
      select a.id as agent_account_id, coalesce(g.openclaw_id, pr.openclaw_id) as openclaw_id,
             a.username::text as username,
             g.name, g.persona, g.workspace_path, g.provision_status,
             owner.id as owner_account_id, owner.username::text as owner_username,
             case
               when la.last_activity_at is null then pr.last_activity_at
               when pr.last_activity_at is null then la.last_activity_at
               else greatest(la.last_activity_at, pr.last_activity_at)
             end as last_activity_at,
             ld.last_successful_dream_activity_at,
             (pr.agent_account_id is not null) as recovery_pending
      from agents g
      join accounts a on a.id = g.account_id
      left join accounts owner on owner.id = g.owner_id and owner.deleted = false
      left join latest_activity la on la.agent_account_id = g.account_id
      left join latest_dream ld on ld.agent_account_id = g.account_id
      left join pending_recovery pr on pr.agent_account_id = g.account_id
      where a.deleted = false or pr.agent_account_id is not null
      order by a.id
    `;
    return rows.map((row) => ({
      agentAccountId: row.agent_account_id,
      openclawId: row.openclaw_id,
      username: row.username,
      name: row.name,
      persona: row.persona,
      workspacePath: row.workspace_path,
      provisionStatus: row.provision_status,
      ownerAccountId: row.owner_account_id,
      ownerUsername: row.owner_username,
      lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at) : null,
      lastSuccessfulDreamActivityAt: row.last_successful_dream_activity_at
        ? new Date(row.last_successful_dream_activity_at)
        : null,
      recoveryPending: row.recovery_pending,
    }));
  }

  async claimSweep(
    params: ClaimMemoryDreamSweepParams,
  ): Promise<MemoryDreamSweepClaim | null> {
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.staleAfterMs);
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + this.staleAfterMs);
    const [row] = await this.client<{ id: string; claim_token: string }[]>`
      insert into memory_dream_sweeps (
        sweep_key, window_start, status, eligible_count, active_count,
        skipped_count, skipped_agents, claim_token, lease_expires_at, started_at
      ) values (
        ${params.sweepKey}, ${params.windowStart.toISOString()}, 'running',
        ${params.eligibleCount}, ${params.activeCount}, ${params.skipped.length},
        ${pg.json(JSON.stringify(params.skipped))}, ${claimToken},
        ${leaseExpiresAt.toISOString()}, ${now.toISOString()}
      )
      on conflict (sweep_key) do update set
        window_start = excluded.window_start,
        status = 'running',
        eligible_count = excluded.eligible_count,
        active_count = excluded.active_count,
        skipped_count = excluded.skipped_count,
        skipped_agents = excluded.skipped_agents,
        succeeded_count = 0,
        failed_count = 0,
        error = null,
        claim_token = excluded.claim_token,
        lease_expires_at = excluded.lease_expires_at,
        started_at = excluded.started_at,
        completed_at = null,
        duration_ms = null
      where (
        memory_dream_sweeps.status = 'running'
        and (
          memory_dream_sweeps.lease_expires_at <= ${now.toISOString()}
          or (
            memory_dream_sweeps.lease_expires_at is null
            and memory_dream_sweeps.started_at <= ${staleBefore.toISOString()}
          )
        )
      ) or (
        memory_dream_sweeps.status = 'partial'
        and exists (
          select 1 from memory_dream_runs pending
          where pending.sweep_id = memory_dream_sweeps.id
            and pending.status = 'recovery_pending'
        )
      )
      returning id, claim_token
    `;
    return row ? { id: row.id, claimToken: row.claim_token } : null;
  }

  async heartbeatSweep(claim: MemoryDreamSweepClaim): Promise<boolean> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + this.staleAfterMs);
    const rows = await this.client<{ id: string }[]>`
      update memory_dream_sweeps set
        lease_expires_at = greatest(lease_expires_at, ${leaseExpiresAt.toISOString()})
      where id = ${claim.id} and claim_token = ${claim.claimToken} and status = 'running'
        and lease_expires_at > ${now.toISOString()}
      returning id
    `;
    return rows.length > 0;
  }

  async startRun(
    sweep: MemoryDreamSweepClaim,
    candidate: RunnableMemoryDreamCandidate,
  ): Promise<MemoryDreamRunClaim | null> {
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.staleAfterMs);
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + this.staleAfterMs);
    const [row] = await this.client<{
      id: string;
      sweep_id: string;
      claim_token: string;
      last_activity_at: string | Date;
      is_recovery: boolean;
    }[]>`
      with parent_claim as materialized (
        update memory_dream_sweeps set
          lease_expires_at = greatest(
            lease_expires_at,
            now() + (${this.staleAfterMs} * interval '1 millisecond')
          )
        where id = ${sweep.id}
          and claim_token = ${sweep.claimToken}
          and status = 'running'
          and lease_expires_at > now()
        returning id
      ), recoverable as materialized (
        select existing.id
        from memory_dream_runs existing
        cross join parent_claim
        where existing.agent_account_id = ${candidate.agentAccountId}
          and (
            existing.status = 'recovery_pending'
            or (
              existing.status = 'running'
              and (
                existing.lease_expires_at <= ${now.toISOString()}
                or (
                  existing.lease_expires_at is null
                  and existing.started_at <= ${staleBefore.toISOString()}
                )
              )
            )
          )
        order by (existing.sweep_id = ${sweep.id}) desc, existing.created_at
        limit 1
        for update of existing
      ), reclaimed as (
        update memory_dream_runs existing set
          status = 'running',
          claim_token = ${claimToken},
          lease_expires_at = ${leaseExpiresAt.toISOString()},
          error = null,
          started_at = ${now.toISOString()},
          completed_at = null,
          duration_ms = null
        from recoverable
        where existing.id = recoverable.id
        returning existing.id, existing.sweep_id, existing.claim_token,
                  existing.last_activity_at, true as is_recovery
      ), created as (
        insert into memory_dream_runs (
          sweep_id, agent_account_id, openclaw_id, status, last_activity_at,
          claim_token, lease_expires_at, provider_status, started_at
        )
        select
          parent.id, ${candidate.agentAccountId}, ${candidate.openclawId}, 'running',
          ${candidate.lastActivityAt.toISOString()}, ${claimToken},
          ${leaseExpiresAt.toISOString()}, 'not_started', ${now.toISOString()}
        from parent_claim parent
        where not exists (select 1 from reclaimed)
        on conflict do nothing
        returning id, sweep_id, claim_token, last_activity_at, false as is_recovery
      )
      select * from reclaimed
      union all
      select * from created
    `;
    return row
      ? {
          id: row.id,
          sweepId: row.sweep_id,
          claimToken: row.claim_token,
          lastActivityAt: new Date(row.last_activity_at),
          isRecovery: row.is_recovery,
        }
      : null;
  }

  async heartbeatRun(claim: MemoryDreamRunClaim): Promise<boolean> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + this.staleAfterMs);
    const rows = await this.client<{ id: string }[]>`
      update memory_dream_runs set
        lease_expires_at = greatest(lease_expires_at, ${leaseExpiresAt.toISOString()})
      where id = ${claim.id} and claim_token = ${claim.claimToken} and status = 'running'
        and lease_expires_at > ${now.toISOString()}
      returning id
    `;
    return rows.length > 0;
  }

  async completeRun(params: CompleteMemoryDreamRunParams): Promise<boolean> {
    const rows = await this.client<{ id: string }[]>`
      update memory_dream_runs set
        status = 'done',
        agent_runtime = ${params.result.agentRuntime},
        pricing_basis = ${params.result.pricingBasis},
        deep_candidates = ${params.result.promotion.candidates},
        promoted_count = ${params.result.promotion.promoted},
        usage_event_id = ${params.result.usageEventId},
        previous_sha256 = ${params.result.previousSha256},
        sha256 = ${params.result.sha256},
        provenance = ${pg.json(JSON.stringify(params.result.provenance))},
        error = null,
        provider_status = 'terminal',
        claim_token = null,
        lease_expires_at = null,
        completed_at = now(),
        duration_ms = ${params.durationMs}
      where id = ${params.runId} and claim_token = ${params.claimToken}
        and status = 'running'
        and lease_expires_at > now()
      returning id
    `;
    return rows.length > 0;
  }

  async failRun(params: {
    runId: string;
    claimToken: string;
    error: string;
    durationMs: number;
    status?: 'error' | 'recovery_pending';
  }): Promise<boolean> {
    const rows = await this.client<{ id: string }[]>`
      update memory_dream_runs set status = ${params.status ?? 'error'},
        error = ${params.error}, claim_token = null, lease_expires_at = null,
        completed_at = now(), duration_ms = ${params.durationMs}
      where id = ${params.runId} and claim_token = ${params.claimToken}
        and status = 'running'
        and lease_expires_at > now()
      returning id
    `;
    return rows.length > 0;
  }

  async skipRun(params: {
    runId: string;
    claimToken: string;
    candidate: RunnableMemoryDreamCandidate;
    reason: MemoryDreamSkipReason;
    durationMs: number;
  }): Promise<boolean> {
    const rows = await this.client<{ id: string }[]>`
      with skipped_run as (
        update memory_dream_runs set
          status = 'skipped',
          error = null,
          provenance = ${pg.json(JSON.stringify({ skipReason: params.reason }))},
          claim_token = null,
          lease_expires_at = null,
          completed_at = now(),
          duration_ms = ${params.durationMs}
        where id = ${params.runId} and claim_token = ${params.claimToken}
          and status = 'running'
          and lease_expires_at > now()
        returning id, sweep_id
      )
      update memory_dream_sweeps set
        skipped_count = skipped_count + 1,
        skipped_agents = skipped_agents || jsonb_build_array(jsonb_build_object(
          'agentAccountId', ${params.candidate.agentAccountId},
          'openclawId', ${params.candidate.openclawId},
          'reason', ${params.reason},
          'lastActivityAt', ${params.candidate.lastActivityAt.toISOString()}
        ))
      from skipped_run
      where memory_dream_sweeps.id = skipped_run.sweep_id
      returning memory_dream_sweeps.id
    `;
    return rows.length > 0;
  }

  async reconcileAbandonedSweep(sweepId: string): Promise<boolean> {
    const rows = await this.client<{ id: string }[]>`
      with counts as (
        select
          count(*) filter (where status = 'done')::int as succeeded,
          count(*) filter (where status in ('error', 'recovery_pending'))::int as failed,
          count(*) filter (where status = 'running')::int as running
        from memory_dream_runs
        where sweep_id = ${sweepId}
      )
      update memory_dream_sweeps set
        status = case
          when counts.running > 0 then 'running'
          when counts.failed > 0 then 'partial'
          else 'done'
        end,
        succeeded_count = counts.succeeded,
        failed_count = counts.failed,
        claim_token = case when counts.running > 0 then memory_dream_sweeps.claim_token else null end,
        lease_expires_at = case when counts.running > 0 then memory_dream_sweeps.lease_expires_at else null end,
        completed_at = case when counts.running > 0 then null else now() end
      from counts
      where memory_dream_sweeps.id = ${sweepId}
        and (
          memory_dream_sweeps.status <> 'running'
          or memory_dream_sweeps.lease_expires_at is null
          or memory_dream_sweeps.lease_expires_at <= now()
        )
      returning memory_dream_sweeps.id
    `;
    return rows.length > 0;
  }

  async finishSweep(params: {
    sweepId: string;
    claimToken: string;
    succeeded: number;
    failed: number;
    durationMs: number;
  }): Promise<boolean> {
    // Aggregate durable run state rather than trusting only this process's
    // counters: a reclaimed sweep may already contain completed runs, and a
    // newer still-live per-agent claim must keep the sweep resumable.
    const rows = await this.client<{ id: string }[]>`
      with counts as (
        select
          count(*) filter (where status = 'done')::int as succeeded,
          count(*) filter (where status in ('error', 'recovery_pending'))::int as failed,
          count(*) filter (where status = 'running')::int as running
        from memory_dream_runs
        where sweep_id = ${params.sweepId}
      )
      update memory_dream_sweeps set
        status = case
          when counts.running > 0 then 'running'
          when counts.failed > 0 then 'partial'
          else 'done'
        end,
        succeeded_count = counts.succeeded,
        failed_count = counts.failed,
        claim_token = case when counts.running > 0 then memory_dream_sweeps.claim_token else null end,
        lease_expires_at = case when counts.running > 0 then memory_dream_sweeps.lease_expires_at else null end,
        completed_at = case when counts.running > 0 then null else now() end,
        duration_ms = case
          when counts.running > 0 then null::integer
          else ${params.durationMs}::integer
        end
      from counts
      where memory_dream_sweeps.id = ${params.sweepId}
        and memory_dream_sweeps.claim_token = ${params.claimToken}
        and memory_dream_sweeps.lease_expires_at > now()
      returning memory_dream_sweeps.id
    `;
    return rows.length > 0;
  }
}

interface EdenMemoryDreamAgentRunnerOptions {
  compat: CompatClientLike;
  bus: EventsBus;
  registry: TurnRegistry;
  historySync: HistorySync;
  memoryRuntime: MemoryRuntimeLike;
  modelRuntime: ModelRuntimeCatalogLike;
  durability?: MemoryDreamDurability;
  distillMemory?: typeof distillAgentMemory;
  memoryStatus?: typeof agentMemoryStatus;
  reverseAuthorization?: typeof reverseTurnAuthorization;
  claimFence?: (claim: MemoryDreamRunClaim, dbc?: DbHandle) => Promise<void>;
  recordRecoveryUsage?: (claim: MemoryDreamRunClaim, dbc?: DbHandle) => Promise<void>;
  loadAssistantContent?: (messageId: string, sessionId: string) => Promise<string | null>;
  now?: () => Date;
  onError?: (err: unknown, context: string) => void;
}

const DREAM_ENTRY_OPEN = '<DREAM_ENTRY>';
const DREAM_ENTRY_CLOSE = '</DREAM_ENTRY>';
const REM_REPORT_OPEN = '<REM_REPORT>';
const REM_REPORT_CLOSE = '</REM_REPORT>';
const MAX_DREAM_ENTRY_CHARS = 10_000;
const MAX_REM_REPORT_CHARS = 20_000;

export interface MemoryRemResponse {
  dreamEntry: string;
  remReport: string;
}

function taggedSection(
  text: string,
  open: string,
  close: string,
  maxChars: number,
): string {
  const start = text.indexOf(open);
  const end = start === -1 ? -1 : text.indexOf(close, start + open.length);
  if (start === -1 || end === -1 || text.indexOf(open, start + open.length) !== -1) {
    throw new Error('memory REM response has an invalid structured envelope');
  }
  const value = text.slice(start + open.length, end).trim().replaceAll('\0', '');
  if (value.length === 0 || value.length > maxChars) {
    throw new Error('memory REM response section is empty or exceeds its size budget');
  }
  return value;
}

/** Parse the tool-free response that Eden materializes into durable dream files. */
export function parseMemoryRemResponse(text: string): MemoryRemResponse {
  return {
    dreamEntry: taggedSection(
      text,
      DREAM_ENTRY_OPEN,
      DREAM_ENTRY_CLOSE,
      MAX_DREAM_ENTRY_CHARS,
    ),
    remReport: taggedSection(
      text,
      REM_REPORT_OPEN,
      REM_REPORT_CLOSE,
      MAX_REM_REPORT_CHARS,
    ),
  };
}

/**
 * Idempotently project one durable provider response into the human-readable
 * dream files. The run marker prevents a crash between the two writes from
 * duplicating the diary entry when recovery completes the projection.
 */
export async function materializeMemoryRemResponse(
  workspacePath: string,
  date: string,
  runId: string,
  text: string,
): Promise<void> {
  const parsed = parseMemoryRemResponse(text);
  const marker = `<!-- eden-memory-dream:${runId} -->`;
  const dreamsPath = path.join(workspacePath, 'DREAMS.md');
  const remDir = path.join(workspacePath, 'memory', 'dreaming', 'rem');
  const remPath = path.join(remDir, `${date}.md`);
  const existingDiary = await readText(dreamsPath);
  if (!existingDiary?.includes(marker)) {
    const prefix = existingDiary?.trimEnd() || '# Dreams';
    await fs.writeFile(
      dreamsPath,
      `${prefix}\n\n${marker}\n## REM — ${date}\n\n${parsed.dreamEntry}\n`,
      'utf8',
    );
  }
  await fs.mkdir(remDir, { recursive: true });
  await fs.writeFile(
    remPath,
    `${marker}\n# REM memory report — ${date}\n\n${parsed.remReport}\n`,
    'utf8',
  );
}

async function loadMemoryDreamAssistantContent(
  messageId: string,
  sessionId: string,
): Promise<string | null> {
  const [message] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'assistant'),
      ),
    )
    .limit(1);
  return message?.content ?? null;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function hasActiveDreamContext(
  candidate: RunnableMemoryDreamCandidate,
): candidate is ActiveMemoryDreamCandidate {
  return (
    candidate.provisionStatus === 'ready' &&
    candidate.workspacePath !== null &&
    candidate.ownerAccountId !== null &&
    candidate.ownerUsername !== null
  );
}

export function renderMemoryRemPrompt(date: string): string {
  return [
    'EDEN MANAGED REM MEMORY SWEEP — trusted internal maintenance turn.',
    `Date: ${date}.`,
    'Review the durable memory and agent context already present in this prompt.',
    'Do not copy private peer facts into MEMORY.md or into a different peer file.',
    'Per-user notes may inform private understanding, but never quote, reveal, confirm, deny, or imply one peer\'s private details to another.',
    'Do not call tools, shell commands, Read, Write, Edit, memory_search, or subagents. Eden will write the files after this response.',
    'Return exactly two non-empty Markdown fragments in this envelope, with no prose outside it:',
    DREAM_ENTRY_OPEN,
    'A concise, honest dream entry for the day.',
    DREAM_ENTRY_CLOSE,
    REM_REPORT_OPEN,
    'A detailed REM report of durable patterns, uncertainty, and useful follow-up.',
    REM_REPORT_CLOSE,
  ].join('\n');
}

type MemoryDreamCheckpointPhase =
  | 'seed_done'
  | 'deep_started'
  | 'deep_done'
  | 'provider_started'
  | 'provider_terminal';

export interface MemoryDreamCheckpoint {
  schema: 'eden-memory-dream-v1';
  phase: MemoryDreamCheckpointPhase;
  date: string;
  previousSha256: string | null;
  promotedSha256?: string | null;
  promotion?: MemoryPromotionSummary;
  previousDreamDiarySha256?: string | null;
  previousRemReportSha256?: string | null;
  agentRuntime?: AgentRuntime;
}

export interface MemoryDreamTerminalUsage {
  id: string;
  status: string;
  pricingBasis: MemoryDreamExecutionResult['pricingBasis'];
  sessionId: string | null;
  agentId: string | null;
  messageId?: string | null;
  manna?: number | null;
  errorCode?: string | null;
  metadata?: unknown;
}

export interface MemoryDreamDurableEvidence {
  checkpoint: MemoryDreamCheckpoint | null;
  providerStatus: 'not_started' | 'started' | 'terminal' | 'indeterminate';
  usage: MemoryDreamTerminalUsage | null;
  debitKeys: string[];
  authorization?: {
    state: string;
    authorizedMaxManna: number;
    chargedManna: number | null;
  } | null;
}

export interface MemoryDreamDurability {
  inspect(runId: string): Promise<MemoryDreamDurableEvidence>;
  saveCheckpoint(
    claim: MemoryDreamRunClaim,
    checkpoint: MemoryDreamCheckpoint,
    providerStatus: MemoryDreamDurableEvidence['providerStatus'],
  ): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Exact fail-closed classifier for a charged partial-output dream failure. */
export function isSettledPartialOutputDreamFailure(
  evidence: MemoryDreamDurableEvidence,
): boolean {
  const usage = evidence.usage;
  const authorization = evidence.authorization;
  const metadata = asRecord(usage?.metadata);
  const partial = asRecord(metadata?.['partialOutputSettlement']);
  return (
    usage?.status === 'error' &&
    usage.messageId == null &&
    typeof usage.errorCode === 'string' &&
    usage.errorCode.length > 0 &&
    typeof usage.manna === 'number' &&
    Number.isFinite(usage.manna) &&
    partial?.['rule'] === 'full-reserve-v1' &&
    partial['chargedManna'] === usage.manna &&
    authorization?.state === 'settled' &&
    authorization.chargedManna === usage.manna &&
    authorization.authorizedMaxManna === usage.manna
  );
}

function isAgentRuntime(value: unknown): value is AgentRuntime {
  return value === 'openclaw' || value === 'claude-cli';
}

function parseMemoryDreamCheckpoint(value: unknown): MemoryDreamCheckpoint | null {
  const record = asRecord(value);
  if (
    record?.['schema'] !== 'eden-memory-dream-v1' ||
    !['seed_done', 'deep_started', 'deep_done', 'provider_started', 'provider_terminal'].includes(
      String(record['phase']),
    ) ||
    typeof record['date'] !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(record['date']) ||
    !(record['previousSha256'] === null || typeof record['previousSha256'] === 'string')
  ) return null;
  const checkpoint: MemoryDreamCheckpoint = {
    schema: 'eden-memory-dream-v1',
    phase: record['phase'] as MemoryDreamCheckpointPhase,
    date: record['date'],
    previousSha256: record['previousSha256'] as string | null,
  };
  if (record['promotedSha256'] === null || typeof record['promotedSha256'] === 'string') {
    checkpoint.promotedSha256 = record['promotedSha256'];
  }
  const promotion = asRecord(record['promotion']);
  const policy = asRecord(promotion?.['policy']);
  if (
    promotion &&
    typeof promotion['agentId'] === 'string' &&
    typeof promotion['candidates'] === 'number' &&
    typeof promotion['promoted'] === 'number' &&
    policy
  ) {
    checkpoint.promotion = promotion as unknown as MemoryPromotionSummary;
  }
  if (
    record['previousDreamDiarySha256'] === null ||
    typeof record['previousDreamDiarySha256'] === 'string'
  ) checkpoint.previousDreamDiarySha256 = record['previousDreamDiarySha256'];
  if (
    record['previousRemReportSha256'] === null ||
    typeof record['previousRemReportSha256'] === 'string'
  ) checkpoint.previousRemReportSha256 = record['previousRemReportSha256'];
  if (isAgentRuntime(record['agentRuntime'])) checkpoint.agentRuntime = record['agentRuntime'];
  return checkpoint;
}

/**
 * Renew and fence the exact dream-run generation. When supplied a transaction
 * handle this update serializes with a recovery claimant and becomes part of
 * the caller's money transaction.
 */
export async function renewMemoryDreamRunClaim(
  claim: MemoryDreamRunClaim,
  dbc: DbHandle = db,
): Promise<void> {
  const renewed = await dbc
    .update(memoryDreamRuns)
    .set({
      leaseExpiresAt: sql`greatest(
        ${memoryDreamRuns.leaseExpiresAt},
        now() + (${MEMORY_DREAM_CLAIM_STALE_MS} * interval '1 millisecond')
      )`,
    })
    .where(
      and(
        eq(memoryDreamRuns.id, claim.id),
        eq(memoryDreamRuns.claimToken, claim.claimToken),
        eq(memoryDreamRuns.status, 'running'),
        sql`${memoryDreamRuns.leaseExpiresAt} > now()`,
      ),
    )
    .returning({ id: memoryDreamRuns.id });
  if (renewed.length === 0) {
    throw new TurnClaimLostError(
      `Memory dream run ${claim.id} claim was superseded before funding or settlement`,
    );
  }
}

/**
 * Persist the terminal economic truth after provider-free recovery. The row
 * is inserted (or an existing error row is corrected) only for this run's
 * exact reversed authorization and while this claim generation still owns
 * the run. Retrying is idempotent via usage_events_turn_unique.
 */
export async function recordMemoryDreamRecoveryUsage(
  claim: MemoryDreamRunClaim,
  dbc: DbHandle = db,
): Promise<void> {
  await dbc.transaction(async (tx) => {
    await renewMemoryDreamRunClaim(claim, tx);
    const rows = (await tx.execute(sql`
      insert into usage_events (
        event_type, status, user_id, agent_id, session_id, message_id, turn_id,
        provider, model, pricing_basis, table_version, manna,
        error_code, error_message, metadata
      )
      select
        'memory_dream', 'error', ta.account_id, ta.agent_account_id, ta.session_id,
        null, ta.turn_id, ta.provider, ta.model, ta.pricing_basis,
        ta.ceiling_table_version, 0,
        'memory_dream_recovered_reversal',
        'A crashed memory dream reservation was reversed before provider replay',
        jsonb_build_object(
          'recovery', jsonb_build_object(
            'kind', 'crash_reversal',
            'authorizationState', ta.state,
            'authorizedMaxManna', ta.authorized_max_manna
          )
        )
      from turn_authorizations ta
      join memory_dream_runs run
        on run.id = ${claim.id}
       and run.agent_account_id = ta.agent_account_id
      where ta.turn_id = ${claim.id}
        and ta.session_id = run.id
        and ta.state in ('reversed', 'reaped')
      on conflict (event_type, turn_id) where turn_id is not null do update set
        manna = 0,
        error_code = coalesce(usage_events.error_code, excluded.error_code),
        error_message = coalesce(usage_events.error_message, excluded.error_message),
        metadata = coalesce(usage_events.metadata, '{}'::jsonb) || excluded.metadata
      where usage_events.status = 'error'
        and usage_events.user_id = excluded.user_id
        and usage_events.agent_id = excluded.agent_id
        and usage_events.session_id = excluded.session_id
        and usage_events.provider = excluded.provider
        and usage_events.model = excluded.model
        and usage_events.pricing_basis = excluded.pricing_basis
      returning id
    `)) as unknown as { id: string }[];
    if (rows.length === 0) {
      throw new Error(
        `memory dream run ${claim.id} has no matching reversed authorization or has conflicting telemetry`,
      );
    }
  });
}

export class PostgresMemoryDreamDurability implements MemoryDreamDurability {
  async inspect(runId: string): Promise<MemoryDreamDurableEvidence> {
    const [run] = await pg<{
      provenance: unknown;
      provider_status: MemoryDreamDurableEvidence['providerStatus'];
    }[]>`
      select provenance, provider_status from memory_dream_runs where id = ${runId}
    `;
    if (!run) throw new Error(`memory dream run ${runId} does not exist`);
    const [usage] = await pg<{
      id: string;
      status: string;
      pricing_basis: MemoryDreamExecutionResult['pricingBasis'];
      session_id: string | null;
      agent_id: string | null;
      message_id: string | null;
      manna: number | null;
      error_code: string | null;
      metadata: unknown;
    }[]>`
      select id, status, pricing_basis, session_id, agent_id, message_id,
             manna, error_code, metadata
      from usage_events
      where event_type = 'memory_dream' and turn_id = ${runId}
      order by created_at desc
      limit 1
    `;
    const debits = await pg<{ idempotency_key: string }[]>`
      select idempotency_key
      from manna_transactions
      where idempotency_key in (${runId}, ${`${runId}:settle`})
        and amount < 0
    `;
    const [authorization] = await pg<{
      state: string;
      authorized_max_manna: string;
      charged_manna: string | null;
    }[]>`
      select state, authorized_max_manna, charged_manna
      from turn_authorizations where turn_id = ${runId}
    `;
    return {
      checkpoint: parseMemoryDreamCheckpoint(run.provenance),
      providerStatus: run.provider_status,
      usage: usage
        ? {
            id: usage.id,
            status: usage.status,
            pricingBasis: usage.pricing_basis,
            sessionId: usage.session_id,
            agentId: usage.agent_id,
            messageId: usage.message_id,
            manna: usage.manna,
            errorCode: usage.error_code,
            metadata: usage.metadata,
          }
        : null,
      debitKeys: debits.map((row) => row.idempotency_key),
      authorization: authorization
        ? {
            state: authorization.state,
            authorizedMaxManna: Number(authorization.authorized_max_manna),
            chargedManna:
              authorization.charged_manna === null
                ? null
                : Number(authorization.charged_manna),
          }
        : null,
    };
  }

  async saveCheckpoint(
    claim: MemoryDreamRunClaim,
    checkpoint: MemoryDreamCheckpoint,
    providerStatus: MemoryDreamDurableEvidence['providerStatus'],
  ): Promise<void> {
    const rows = await pg<{ id: string }[]>`
      update memory_dream_runs set
        provenance = ${pg.json(JSON.stringify(checkpoint))},
        provider_status = ${providerStatus},
        lease_expires_at = now() + (${MEMORY_DREAM_CLAIM_STALE_MS} * interval '1 millisecond'),
        provider_started_at = case
          when ${providerStatus} = 'started' and provider_started_at is null then now()
          else provider_started_at
        end
      where id = ${claim.id} and claim_token = ${claim.claimToken} and status = 'running'
        and lease_expires_at > now()
      returning id
    `;
    if (rows.length === 0) {
      throw new MemoryDreamRecoveryPendingError(
        `memory dream run ${claim.id} lost its fencing token`,
      );
    }
  }
}

export class EdenMemoryDreamAgentRunner implements MemoryDreamAgentRunner {
  private readonly now: () => Date;
  private readonly durability: MemoryDreamDurability;
  private readonly distillMemory: typeof distillAgentMemory;
  private readonly memoryStatus: typeof agentMemoryStatus;
  private readonly reverseAuthorization: typeof reverseTurnAuthorization;
  private readonly claimFence: (
    claim: MemoryDreamRunClaim,
    dbc?: DbHandle,
  ) => Promise<void>;
  private readonly recordRecoveryUsage: (
    claim: MemoryDreamRunClaim,
    dbc?: DbHandle,
  ) => Promise<void>;
  private readonly loadAssistantContent: (
    messageId: string,
    sessionId: string,
  ) => Promise<string | null>;

  constructor(private readonly options: EdenMemoryDreamAgentRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.durability = options.durability ?? new PostgresMemoryDreamDurability();
    this.distillMemory = options.distillMemory ?? distillAgentMemory;
    this.memoryStatus = options.memoryStatus ?? agentMemoryStatus;
    this.reverseAuthorization = options.reverseAuthorization ?? reverseTurnAuthorization;
    this.claimFence = options.claimFence ?? renewMemoryDreamRunClaim;
    this.recordRecoveryUsage = options.recordRecoveryUsage ?? recordMemoryDreamRecoveryUsage;
    this.loadAssistantContent = options.loadAssistantContent ?? loadMemoryDreamAssistantContent;
  }

  async run(
    candidate: RunnableMemoryDreamCandidate,
    sweepId: string,
    run: MemoryDreamRunClaim,
  ): Promise<MemoryDreamExecutionResult> {
    const runId = run.id;
    let evidence = await this.durability.inspect(runId);
    if (evidence.usage) {
      return await this.recoverTerminalUsage(candidate, sweepId, run, evidence);
    }
    if (evidence.debitKeys.length > 0) {
      await this.reverseIndeterminateDebits(
        run,
        evidence.checkpoint,
        evidence.providerStatus === 'indeterminate',
      );
    }
    if (evidence.providerStatus === 'indeterminate') {
      throw new MemoryDreamRecoveryResolvedError(
        `memory dream run ${runId} is indeterminate; external work will not be replayed`,
      );
    }

    let checkpoint = evidence.checkpoint;
    if (checkpoint?.phase === 'deep_started') {
      await this.durability.saveCheckpoint(run, checkpoint, 'indeterminate');
      throw new MemoryDreamRecoveryPendingError(
        `memory dream run ${runId} crashed during native deep promotion; refusing to replay it`,
      );
    }

    if (!hasActiveDreamContext(candidate)) {
      throw new MemoryDreamRecoveryResolvedError(
        `memory dream run ${runId} cannot start new work because its agent is no longer eligible`,
      );
    }
    const memoryPath = path.join(candidate.workspacePath, 'MEMORY.md');

    if (checkpoint === null) {
      const seed = await this.distillMemory({
        agentAccountId: candidate.agentAccountId,
        openclawId: candidate.openclawId,
        username: candidate.username,
        name: candidate.name,
        persona: candidate.persona,
        workspacePath: candidate.workspacePath,
        mode: 'automatic-seed',
      });
      const durableSeed = await this.memoryStatus(
        candidate.openclawId,
        candidate.workspacePath,
      );
      const seededMemory = await readText(memoryPath);
      if (
        seed.status === 'skipped' &&
        seed.skippedReason === 'too_little_history' &&
        durableSeed?.status === 'skipped'
      ) {
        throw new MemoryDreamSkippedError(
          'seed-too-little-history',
          'memory seed deferred because the agent has too little transcript history',
        );
      }
      if (seed.status !== 'done' || durableSeed?.status !== 'done' || seededMemory === null) {
        throw new Error(
          `memory seed prerequisite is not durably done (result=${seed.status}, durable=${durableSeed?.status ?? 'missing'})`,
        );
      }
      checkpoint = {
        schema: 'eden-memory-dream-v1',
        phase: 'seed_done',
        date: this.now().toISOString().slice(0, 10),
        previousSha256: memorySha256(seededMemory),
      };
      await this.durability.saveCheckpoint(run, checkpoint, 'not_started');
    }

    if (checkpoint.phase === 'seed_done') {
      checkpoint = { ...checkpoint, phase: 'deep_started' };
      await this.durability.saveCheckpoint(run, checkpoint, 'not_started');
      const previousMemory = await readText(memoryPath);
      const promotion = await this.options.memoryRuntime.promoteAgent(candidate.openclawId);
      const promotedMemory = await readText(memoryPath);
      if (
        promotedMemory !== null &&
        memorySha256(promotedMemory) !== memorySha256(previousMemory)
      ) {
        await recordMemoryRevision({
          agentAccountId: candidate.agentAccountId,
          openclawId: candidate.openclawId,
          operation: 'dream-promotion',
          previousContent: previousMemory,
          content: promotedMemory,
          metadata: { sweepId, runId, promotion, phase: 'deep' },
        });
      }
      const deepDir = path.join(candidate.workspacePath, 'memory', 'dreaming', 'deep');
      await fs.mkdir(deepDir, { recursive: true });
      await fs.writeFile(
        path.join(deepDir, `${checkpoint.date}.md`),
        [
          `# Deep memory promotion — ${checkpoint.date}`,
          '',
          `- Sweep: ${sweepId}`,
          `- Run: ${runId}`,
          `- Candidates: ${promotion.candidates}`,
          `- Promoted: ${promotion.promoted}`,
          `- MEMORY.md before: ${memorySha256(previousMemory) ?? 'absent'}`,
          `- MEMORY.md after: ${memorySha256(promotedMemory) ?? 'absent'}`,
          '',
        ].join('\n'),
        'utf8',
      );
      checkpoint = {
        ...checkpoint,
        phase: 'deep_done',
        previousSha256: memorySha256(previousMemory),
        promotedSha256: memorySha256(promotedMemory),
        promotion,
      };
      await this.durability.saveCheckpoint(run, checkpoint, 'not_started');
    }

    if (!checkpoint.promotion) {
      throw new MemoryDreamRecoveryPendingError(
        `memory dream run ${runId} has no durable native-promotion result`,
      );
    }

    if (checkpoint.phase === 'deep_done') {
      const dreamsPath = path.join(candidate.workspacePath, 'DREAMS.md');
      const remPath = path.join(
        candidate.workspacePath,
        'memory',
        'dreaming',
        'rem',
        `${checkpoint.date}.md`,
      );
      const [previousDreamDiary, previousRemReport, agentRuntime] = await Promise.all([
        readText(dreamsPath),
        readText(remPath),
        this.options.modelRuntime.getRuntime(MEMORY_DREAM_MODEL),
      ]);
      checkpoint = {
        ...checkpoint,
        phase: 'provider_started',
        previousDreamDiarySha256: memorySha256(previousDreamDiary),
        previousRemReportSha256: memorySha256(previousRemReport),
        agentRuntime,
      };
      // This checkpoint commits before runTurn's debit and provider handoff.
      await this.durability.saveCheckpoint(run, checkpoint, 'started');
    }

    if (checkpoint.phase !== 'provider_started' || !checkpoint.agentRuntime) {
      throw new MemoryDreamRecoveryPendingError(
        `memory dream run ${runId} has an invalid provider checkpoint`,
      );
    }

    const owner: AuthSession = {
      accountId: candidate.ownerAccountId,
      username: candidate.ownerUsername,
      isAdmin: false,
    };
    const session = await ensureMemoryDreamSession(candidate, owner, checkpoint.date, runId);
    // Final atomic fence/renew immediately before runTurn's debit/provider
    // sequence. An expired owner may not revive itself or hand work off.
    await this.durability.saveCheckpoint(run, checkpoint, 'started');
    let turnErrorCode: string | null = null;
    let remResponse = '';
    const remSink: TurnSink = {
      emit(event) {
        if (event.type === 'token') remResponse += event.delta;
      },
      end() {},
    };
    try {
      const outcome = await runTurn(
        {
          compat: this.options.compat,
          bus: this.options.bus,
          registry: this.options.registry,
          historySync: this.options.historySync,
          onError: this.options.onError,
        },
        {
          session,
          agent: {
            accountId: candidate.agentAccountId,
            username: candidate.username,
            openclawId: candidate.openclawId,
            model: MEMORY_DREAM_MODEL,
            gatewayModelOverride: MEMORY_DREAM_MODEL,
            agentRuntime: checkpoint.agentRuntime,
            thinkingLevel: 'balanced',
          },
          user: owner,
          content: renderMemoryRemPrompt(checkpoint.date),
          source: { kind: 'memory_dream', sweepId, runId },
          beginStream: () => remSink,
          turnId: runId,
          fundingFence: (dbc) => this.claimFence(run, dbc),
          beforeProvider: () => this.claimFence(run),
          beforeTerminal: () => this.claimFence(run),
        },
      );
      turnErrorCode = outcome.errorCode;
      if (outcome.errorCode === null) {
        await materializeMemoryRemResponse(
          candidate.workspacePath,
          checkpoint.date,
          runId,
          remResponse,
        );
      }
    } catch (err) {
      evidence = await this.durability.inspect(runId);
      if (evidence.usage) {
        return await this.recoverTerminalUsage(candidate, sweepId, run, evidence);
      }
      if (evidence.debitKeys.length > 0) {
        await this.reverseIndeterminateDebits(
          run,
          checkpoint,
          evidence.providerStatus === 'indeterminate',
        );
      }
      throw err;
    }
    evidence = await this.durability.inspect(runId);
    if (!evidence.usage) {
      if (evidence.debitKeys.length > 0) {
        await this.reverseIndeterminateDebits(
          run,
          checkpoint,
          evidence.providerStatus === 'indeterminate',
        );
      }
      throw new MemoryDreamRecoveryPendingError(
        `memory dream run ${runId} returned ${turnErrorCode ?? 'success'} without a matching terminal usage event`,
      );
    }
    return await this.recoverTerminalUsage(candidate, sweepId, run, evidence);
  }

  private async reverseIndeterminateDebits(
    run: MemoryDreamRunClaim,
    existing: MemoryDreamCheckpoint | null,
    alreadyIndeterminate: boolean,
  ): Promise<never> {
    const checkpoint = existing ?? {
      schema: 'eden-memory-dream-v1' as const,
      phase: 'provider_started' as const,
      date: this.now().toISOString().slice(0, 10),
      previousSha256: null,
    };
    try {
      await this.reverseRunAuthorization(run);
      await this.recordRecoveryUsage(run);
      await this.durability.saveCheckpoint(run, checkpoint, 'indeterminate');
    } catch (err) {
      throw new MemoryDreamRecoveryPendingError(
        `memory dream run ${run.id} has a debit without terminal usage; reversal remains pending (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    throw new MemoryDreamRecoveryResolvedError(
      `memory dream run ${run.id} had a debit without terminal usage; its authorization was reversed idempotently and the provider call will not be replayed${alreadyIndeterminate ? '' : ' after crash recovery'}`,
    );
  }

  private async reverseTerminalErrorDebits(
    run: MemoryDreamRunClaim,
    checkpoint: MemoryDreamCheckpoint | null,
    usageStatus: string,
  ): Promise<never> {
    try {
      await this.reverseRunAuthorization(run);
      await this.recordRecoveryUsage(run);
      if (checkpoint) {
        await this.durability.saveCheckpoint(
          run,
          { ...checkpoint, phase: 'provider_terminal' },
          'terminal',
        );
      }
    } catch (err) {
      throw new MemoryDreamRecoveryPendingError(
        `memory dream run ${run.id} terminal ${usageStatus} reversal remains pending (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    throw new MemoryDreamRecoveryResolvedError(
      `memory dream run ${run.id} terminal usage status is ${usageStatus}; its authorization was reversed idempotently`,
    );
  }

  private async reverseRunAuthorization(
    run: MemoryDreamRunClaim,
  ): Promise<ReverseTurnAuthorizationResult> {
    return await this.reverseAuthorization({
      turnId: run.id,
      refundType: 'refund:memory-dream',
      fence: (dbc) => this.claimFence(run, dbc),
    });
  }

  private async recoverTerminalUsage(
    candidate: RunnableMemoryDreamCandidate,
    sweepId: string,
    run: MemoryDreamRunClaim,
    evidence: MemoryDreamDurableEvidence,
  ): Promise<MemoryDreamExecutionResult> {
    const usage = evidence.usage;
    const checkpoint = evidence.checkpoint;
    if (!usage) {
      throw new MemoryDreamRecoveryResolvedError(
        `memory dream run ${run.id} has no terminal usage`,
      );
    }
    if (usage.sessionId !== run.id || usage.agentId !== candidate.agentAccountId) {
      throw new MemoryDreamRecoveryResolvedError(
        `memory dream run ${run.id} usage event does not match its session/agent`,
      );
    }
    if (usage.pricingBasis !== 'provider-api' && usage.pricingBasis !== 'notional-subscription') {
      throw new MemoryDreamRecoveryResolvedError(
        `memory dream run ${run.id} usage event has invalid pricing provenance`,
      );
    }
    if (isSettledPartialOutputDreamFailure(evidence)) {
      if (!checkpoint) {
        throw new MemoryDreamRecoveryPendingError(
          `memory dream run ${run.id} has charged partial-output truth without a recovery checkpoint`,
        );
      }
      await this.durability.saveCheckpoint(
        run,
        { ...checkpoint, phase: 'provider_terminal' },
        'terminal',
      );
      throw new MemoryDreamRecoveryResolvedError(
        `memory dream run ${run.id} failed after usable output; full authorized reserve remains charged`,
      );
    }
    if (!['completed', 'missing_usage', 'unmetered'].includes(usage.status)) {
      if (evidence.debitKeys.length > 0) {
        await this.reverseTerminalErrorDebits(run, checkpoint, usage.status);
      }
      if (checkpoint) {
        await this.durability.saveCheckpoint(run, { ...checkpoint, phase: 'provider_terminal' }, 'terminal');
      }
      throw new MemoryDreamRecoveryResolvedError(
        `memory dream run ${run.id} terminal usage status is ${usage.status}`,
      );
    }
    if (
      !checkpoint?.promotion ||
      !checkpoint.agentRuntime ||
      checkpoint.previousDreamDiarySha256 === undefined ||
      checkpoint.previousRemReportSha256 === undefined
    ) {
      throw new MemoryDreamRecoveryPendingError(
        `memory dream run ${run.id} has terminal usage but incomplete recovery provenance`,
      );
    }
    if (!hasActiveDreamContext(candidate)) {
      throw new MemoryDreamRecoveryResolvedError(
        `memory dream run ${run.id} has successful terminal usage but its workspace context is unavailable`,
      );
    }
    const expectedPricingBasis =
      checkpoint.agentRuntime === 'claude-cli'
        ? 'notional-subscription'
        : 'provider-api';
    if (usage.pricingBasis !== expectedPricingBasis) {
      throw new MemoryDreamRecoveryResolvedError(
        `memory dream run ${run.id} usage pricing does not match its frozen runtime`,
      );
    }
    const dreamsPath = path.join(candidate.workspacePath, 'DREAMS.md');
    const remPath = path.join(
      candidate.workspacePath,
      'memory',
      'dreaming',
      'rem',
      `${checkpoint.date}.md`,
    );
    const [currentDiary, currentReport] = await Promise.all([
      readText(dreamsPath),
      readText(remPath),
    ]);
    const needsProjection =
      currentDiary === null ||
      currentReport === null ||
      memorySha256(currentDiary) === checkpoint.previousDreamDiarySha256 ||
      memorySha256(currentReport) === checkpoint.previousRemReportSha256;
    if (needsProjection) {
      if (!usage.messageId) {
        throw new MemoryDreamRecoveryResolvedError(
          `memory dream run ${run.id} cannot recover its structured response`,
        );
      }
      const assistantContent = await this.loadAssistantContent(usage.messageId, run.id);
      if (assistantContent === null) {
        throw new MemoryDreamRecoveryResolvedError(
          `memory dream run ${run.id} has no durable structured response`,
        );
      }
      await materializeMemoryRemResponse(
        candidate.workspacePath,
        checkpoint.date,
        run.id,
        assistantContent,
      );
    }
    const deepPath = path.join(
      candidate.workspacePath,
      'memory',
      'dreaming',
      'deep',
      `${checkpoint.date}.md`,
    );
    const [dreamDiary, remReport, deepReport, finalMemory] = await Promise.all([
      readText(dreamsPath),
      readText(remPath),
      readText(deepPath),
      readText(path.join(candidate.workspacePath, 'MEMORY.md')),
    ]);
    if (
      dreamDiary === null ||
      remReport === null ||
      deepReport === null ||
      !deepReport.includes(`- Run: ${run.id}`) ||
      memorySha256(dreamDiary) === checkpoint.previousDreamDiarySha256 ||
      memorySha256(remReport) === checkpoint.previousRemReportSha256
    ) {
      throw new MemoryDreamRecoveryResolvedError(
        `memory dream run ${run.id} has terminal usage without its complete changed dream files`,
      );
    }
    const terminalCheckpoint: MemoryDreamCheckpoint = {
      ...checkpoint,
      phase: 'provider_terminal',
    };
    await this.durability.saveCheckpoint(run, terminalCheckpoint, 'terminal');
    return {
      agentRuntime: checkpoint.agentRuntime,
      pricingBasis: usage.pricingBasis,
      promotion: checkpoint.promotion,
      usageEventId: usage.id,
      previousSha256: checkpoint.previousSha256,
      sha256: memorySha256(finalMemory),
      provenance: {
        scheduler: 'eden-managed-active-only',
        upstreamManagedSchedule: false,
        checkpoint: terminalCheckpoint,
        deep: { nativeCli: true, ...checkpoint.promotion.policy },
        rem: { model: MEMORY_DREAM_MODEL, meteredTurnId: run.id },
      },
    };
  }
}

/** Deterministic/idempotent hidden session: session id and turn id are the run id. */
export async function ensureMemoryDreamSession(
  candidate: ActiveMemoryDreamCandidate,
  owner: AuthSession,
  date: string,
  runId: string,
): Promise<Session> {
  return await db.transaction(async (tx) => {
    await tx
      .insert(sessions)
      .values({
        id: runId,
        ownerId: owner.accountId,
        title: `[Memory dream] ${date}`,
        sessionType: 'memory_dream',
        visible: false,
        deleted: true,
        gatewaySessionKey: gatewaySessionKey(runId),
      })
      .onConflictDoNothing({ target: sessions.id });
    const [session] = await tx.select().from(sessions).where(eq(sessions.id, runId)).limit(1);
    if (
      !session ||
      session.ownerId !== owner.accountId ||
      session.sessionType !== 'memory_dream' ||
      session.gatewaySessionKey !== gatewaySessionKey(runId)
    ) {
      throw new Error(`memory dream deterministic session ${runId} conflicts with another session`);
    }
    await tx
      .insert(sessionAgents)
      .values({ sessionId: runId, agentAccountId: candidate.agentAccountId })
      .onConflictDoNothing();
    await tx
      .insert(sessionUsers)
      .values({ sessionId: runId, userAccountId: owner.accountId })
      .onConflictDoNothing();
    return session;
  });
}

export class MemoryDreamScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly orchestrator: MemoryDreamOrchestrator,
    private readonly options: {
      intervalMs: number;
      hourUtc: number;
      now?: () => Date;
      onError?: (err: unknown) => void;
    },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null || this.options.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.options.onError?.(err));
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(options: { force?: boolean } = {}): Promise<MemoryDreamSweepResult | null> {
    const now = this.now();
    if (options.force !== true && now.getUTCHours() < this.options.hourUtc) return null;
    const sweepKey = `memory-dream:${now.toISOString().slice(0, 10)}`;
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return await this.orchestrator.run(sweepKey, windowStart);
  }
}
