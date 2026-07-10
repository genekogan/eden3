import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getEnv } from '@eden3/core';
import {
  AgentProvisioner,
  CronSync,
  setAgentSkills,
  setAgentToolGroups,
  type ProvisionAgentParams,
  type ProvisionAgentResult,
  type SyncTriggerResult,
  type UpdatePersonaParams,
  type UpdatePersonaResult,
} from '@eden3/gateway';

import { ApiError } from './errors';

/**
 * Gateway glue — the api's seam to @eden3/gateway.
 *
 * Routes reach the provisioner / cron-sync through `app.gatewayGlue` so tests
 * can inject fakes (BuildServerOptions.gateway) and so the REAL clients are
 * constructed lazily: building them requires OPENCLAW_GATEWAY_TOKEN, and a
 * server that only serves reads must keep working without it.
 */

/** Default gateway model for newly created agents (cheap; pilots re-model later). */
export { DEFAULT_AGENT_MODEL } from '@eden3/shared';

/** Structural subset of {@link AgentProvisioner} the routes use. */
export interface ProvisionerLike {
  provisionAgent(
    params: ProvisionAgentParams,
    options?: { force?: boolean },
  ): Promise<ProvisionAgentResult>;
  updateAgentPersona(params: UpdatePersonaParams): Promise<UpdatePersonaResult>;
}

/**
 * Structural subset of {@link CronSync} eden3 uses. Scheduled firing is
 * eden3-side (services/task-scheduler.ts) — the gateway seam only ever
 * REMOVES cron jobs now: per-trigger on create/edit/pause/delete, and a
 * bulk sweep of legacy `eden3:*` jobs on scheduler boot.
 */
export interface CronSyncLike {
  removeTrigger(triggerId: string): Promise<SyncTriggerResult>;
  removeAllEden3Jobs(): Promise<{ removed: number }>;
}

export interface SkillSyncParams {
  openclawId: string;
  skills: string[];
}

export interface SkillSyncLike {
  syncAgentSkills(params: SkillSyncParams): Promise<{ changed: boolean }>;
}

export interface ToolSyncParams {
  openclawId: string;
  toolGroups: string[];
}

export interface ToolSyncLike {
  syncAgentToolGroups(params: ToolSyncParams): Promise<{ changed: boolean }>;
}

export interface GatewayGlueOptions {
  /** Override the provisioner (tests). Default: real AgentProvisioner, lazy. */
  provisioner?: ProvisionerLike;
  /** Override cron sync (tests). Default: real CronSync (docker exec CLI), lazy. */
  cronSync?: CronSyncLike;
  /** Override skill sync (tests). Default: openclaw.json allowlist writer. */
  skillSync?: SkillSyncLike;
  /** Override tool-group sync (tests). Default: openclaw.json allowlist writer. */
  toolSync?: ToolSyncLike;
}

export class GatewayGlue {
  private readonly provisionerOverride: ProvisionerLike | undefined;
  private readonly cronSyncOverride: CronSyncLike | undefined;
  private readonly skillSyncOverride: SkillSyncLike | undefined;
  private readonly toolSyncOverride: ToolSyncLike | undefined;
  private lazyProvisioner: ProvisionerLike | undefined;
  private lazyCronSync: CronSyncLike | undefined;

  constructor(options: GatewayGlueOptions = {}) {
    this.provisionerOverride = options.provisioner;
    this.cronSyncOverride = options.cronSync;
    this.skillSyncOverride = options.skillSync;
    this.toolSyncOverride = options.toolSync;
  }

  /** Throws ApiError 503 when the gateway token is not configured. */
  get provisioner(): ProvisionerLike {
    if (this.provisionerOverride) return this.provisionerOverride;
    this.lazyProvisioner ??= buildDefaultProvisioner();
    return this.lazyProvisioner;
  }

  get cronSync(): CronSyncLike {
    if (this.cronSyncOverride) return this.cronSyncOverride;
    // The cron CLI authenticates with the CONTAINER's own env token
    // (docker.ts), so no host-side token is needed here.
    this.lazyCronSync ??= new CronSync();
    return this.lazyCronSync;
  }

  get skillSync(): SkillSyncLike {
    return (
      this.skillSyncOverride ?? {
        syncAgentSkills: async ({ openclawId, skills }) =>
          setAgentSkills(openclawId, skills, { dataDir: defaultOpenclawDataDir() }),
      }
    );
  }

  get toolSync(): ToolSyncLike {
    return (
      this.toolSyncOverride ?? {
        syncAgentToolGroups: async ({ openclawId, toolGroups }) =>
          setAgentToolGroups(openclawId, toolGroups, { dataDir: defaultOpenclawDataDir() }),
      }
    );
  }
}

/** apps/api/src -> repo root (three levels up). */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Host-side OpenClaw data dir. The gateway package's own default resolves
 * relative to CWD (wrong under `pnpm --filter @eden3/api dev` / vitest), so
 * the api anchors the fallback at the repo root instead.
 */
export function defaultOpenclawDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OPENCLAW_DATA_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  return path.join(REPO_ROOT, 'infra', 'openclaw', 'data');
}

function buildDefaultProvisioner(): AgentProvisioner {
  const env = getEnv();
  const token = env.OPENCLAW_GATEWAY_TOKEN;
  if (token === undefined || token === '') {
    throw new ApiError(
      503,
      'gateway_unconfigured',
      'OPENCLAW_GATEWAY_TOKEN is not set — cannot provision agents',
    );
  }
  return new AgentProvisioner({
    gateway: { baseUrl: env.OPENCLAW_BASE_URL, token },
    dataDir: defaultOpenclawDataDir(),
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    gatewayGlue: GatewayGlue;
  }
}
