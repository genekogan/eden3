import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { readOpenClawConfig, resolveDataDir, setAgentModel } from './config-gen';
import { OpenClawCli, type OpenClawCliLike } from './docker';
import type { GatewayClientOptions } from './types';

/**
 * Agent provisioner: renders the eden3 workspace templates for an agent,
 * registers the agent with the OpenClaw gateway via the CLI (hot-add, no
 * restart — spike probe #1), and verifies the agent is routable via
 * `GET /v1/models`.
 *
 * Paths: the workspace is written on the HOST at
 * `<dataDir>/workspace-<openclawId>` while the gateway must be told the
 * CONTAINER path `/home/node/.openclaw/workspace-<openclawId>` (the data dir
 * is bind-mounted at `/home/node/.openclaw`).
 *
 * The full template set is written INCLUDING `openclaw-workspace-state.json`
 * (`{"version":1,"setupCompletedAt":<iso>}`) so the gateway's first-boot
 * BOOTSTRAP ritual is skipped for migrated agents (spike "workspace seeding").
 */

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionError';
  }
}

/** Conservative id shape — path-safe on host + container, CLI-safe. */
const OPENCLAW_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertValidOpenclawId(openclawId: string): void {
  if (!OPENCLAW_ID_PATTERN.test(openclawId)) {
    throw new ProvisionError(
      `invalid openclawId "${openclawId}" — expected ${OPENCLAW_ID_PATTERN} (lowercase alphanumeric, "-", "_")`,
    );
  }
}

/** Placeholder keys the workspace templates may use ({{KEY}} syntax). */
export type TemplateVarKey =
  | 'NAME'
  | 'USERNAME'
  | 'DESCRIPTION'
  | 'PERSONA'
  | 'GREETING'
  | 'MEMORY_SEED'
  | 'PROVISIONED_AT';

export type TemplateVars = Record<TemplateVarKey, string>;

/** Files re-rendered by {@link AgentProvisioner.updateAgentPersona} (hot). */
export const PERSONA_TEMPLATE_FILES = ['SOUL.md', 'IDENTITY.md'] as const;

const PLACEHOLDER_RE = /\{\{([A-Z_]+)\}\}/g;

/**
 * Replace `{{KEY}}` placeholders. Unknown keys are left in place and reported
 * by {@link assertFullyRendered} — template/provisioner drift must fail loudly
 * rather than ship a workspace with literal `{{...}}` in an agent's context.
 */
export function renderTemplate(template: string, vars: Partial<TemplateVars>): string {
  return template.replace(PLACEHOLDER_RE, (match, key: string) => {
    const value = (vars as Record<string, string | undefined>)[key];
    return value ?? match;
  });
}

function assertFullyRendered(relPath: string, rendered: string): void {
  const leftovers = [...new Set([...rendered.matchAll(PLACEHOLDER_RE)].map((m) => m[0]))];
  if (leftovers.length > 0) {
    throw new ProvisionError(
      `template ${relPath} has unresolved placeholder(s) ${leftovers.join(', ')} — ` +
        'workspace-templates and the provisioner var map are out of sync',
    );
  }
}

async function loadTemplates(dir: string): Promise<{ relPath: string; raw: string }[]> {
  const out: { relPath: string; raw: string }[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      throw new ProvisionError(`cannot read workspace templates dir ${dir}: ${(err as Error).message}`);
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), rel);
      } else if (entry.isFile()) {
        out.push({ relPath: rel, raw: await fs.readFile(path.join(current, entry.name), 'utf8') });
      }
    }
  }
  await walk(dir, '');
  if (out.length === 0) throw new ProvisionError(`no template files found in ${dir}`);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ---------------------------------------------------------------------------
// CLI + /v1/models schemas
// ---------------------------------------------------------------------------

/** `openclaw agents list --json` entry (canonical shape, spike probe #1). */
const agentsListEntrySchema = z
  .object({ id: z.string(), model: z.string().optional(), workspace: z.string().optional() })
  .passthrough();
const agentsListSchema = z.array(agentsListEntrySchema);

const modelsResponseSchema = z
  .object({ data: z.array(z.object({ id: z.string() }).passthrough()).optional() })
  .passthrough();

// ---------------------------------------------------------------------------
// Params / results
// ---------------------------------------------------------------------------

export interface ProvisionAgentParams {
  /** Gateway agent id (also names the workspace dir). */
  openclawId: string;
  /** Display name ({{NAME}}). */
  name: string;
  /** eden.art handle ({{USERNAME}}). */
  username: string;
  /** One-line role description ({{DESCRIPTION}}). */
  description: string;
  /** Persona body for SOUL.md ({{PERSONA}}). */
  persona: string;
  /** First-time-visitor greeting ({{GREETING}}). */
  greeting: string;
  /** Gateway model ref, e.g. "anthropic/claude-haiku-4-5". */
  model: string;
  /** Distilled history seeded into MEMORY.md ({{MEMORY_SEED}}); default "". */
  memorySeed?: string;
}

export interface UpdatePersonaParams {
  openclawId: string;
  name: string;
  username: string;
  description: string;
  persona: string;
  greeting: string;
}

export interface ProvisionAgentResult {
  openclawId: string;
  hostWorkspaceDir: string;
  containerWorkspaceDir: string;
  /** Template files written this call (relative paths). */
  filesWritten: string[];
  /** Template files left untouched (existed and !force). */
  filesSkipped: string[];
  /** "added" via CLI this call, or "existing" (already registered). */
  registration: 'added' | 'existing';
  /** True when an existing registration's model was updated to params.model. */
  modelUpdated: boolean;
}

export interface ProvisionerOptions {
  /** Gateway origin+token for the /v1/models routability check. */
  gateway: GatewayClientOptions;
  /** CLI wrapper; a real `OpenClawCli` by default. */
  cli?: OpenClawCliLike;
  /** Host openclaw data dir; default OPENCLAW_DATA_DIR env / infra/openclaw/data. */
  dataDir?: string;
  /** Template source; default `packages/gateway/workspace-templates/`. */
  templatesDir?: string;
  /** Container-side data dir (bind mount target). */
  containerDataDir?: string;
  /** Routability poll deadline (default 15s per task spec). */
  routableTimeoutMs?: number;
  routablePollIntervalMs?: number;
  /** Clock override for {{PROVISIONED_AT}} (tests). */
  now?: () => Date;
}

const DEFAULT_TEMPLATES_DIR = fileURLToPath(new URL('../workspace-templates/', import.meta.url));
const DEFAULT_CONTAINER_DATA_DIR = '/home/node/.openclaw';

export class AgentProvisioner {
  private readonly gateway: GatewayClientOptions;
  private readonly cli: OpenClawCliLike;
  private readonly dataDir: string;
  private readonly templatesDir: string;
  private readonly containerDataDir: string;
  private readonly routableTimeoutMs: number;
  private readonly routablePollIntervalMs: number;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ProvisionerOptions) {
    this.gateway = options.gateway;
    this.cli = options.cli ?? new OpenClawCli();
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.templatesDir = options.templatesDir ?? DEFAULT_TEMPLATES_DIR;
    this.containerDataDir = options.containerDataDir ?? DEFAULT_CONTAINER_DATA_DIR;
    this.routableTimeoutMs = options.routableTimeoutMs ?? 15_000;
    this.routablePollIntervalMs = options.routablePollIntervalMs ?? 500;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.gateway.fetchImpl ?? fetch;
  }

  hostWorkspaceDir(openclawId: string): string {
    return path.join(this.dataDir, `workspace-${openclawId}`);
  }

  containerWorkspaceDir(openclawId: string): string {
    return `${this.containerDataDir}/workspace-${openclawId}`;
  }

  /**
   * Provision an agent end-to-end:
   *  1. render ALL workspace templates into `<dataDir>/workspace-<id>/`
   *     (existing files are only overwritten with `force: true`),
   *  2. create the `memory/` (+ `memory/users/`) dirs,
   *  3. register the agent via `openclaw agents add` (container workspace
   *     path) unless it is already in agents.list — in which case a model
   *     drift is corrected in openclaw.json instead,
   *  4. poll `GET /v1/models` until `openclaw/<id>` is routable.
   */
  async provisionAgent(
    params: ProvisionAgentParams,
    options: { force?: boolean } = {},
  ): Promise<ProvisionAgentResult> {
    assertValidOpenclawId(params.openclawId);
    const force = options.force === true;
    const vars: TemplateVars = {
      NAME: params.name,
      USERNAME: params.username,
      DESCRIPTION: params.description,
      PERSONA: params.persona,
      GREETING: params.greeting,
      MEMORY_SEED: params.memorySeed ?? '',
      PROVISIONED_AT: this.now().toISOString(),
    };

    // 1. render workspace files
    const workspaceDir = this.hostWorkspaceDir(params.openclawId);
    const templates = await loadTemplates(this.templatesDir);
    const filesWritten: string[] = [];
    const filesSkipped: string[] = [];
    await fs.mkdir(workspaceDir, { recursive: true });
    for (const template of templates) {
      const rendered = renderTemplate(template.raw, vars);
      assertFullyRendered(template.relPath, rendered);
      const target = path.join(workspaceDir, template.relPath);
      if (!force && (await fileExists(target))) {
        filesSkipped.push(template.relPath);
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, rendered, 'utf8');
      filesWritten.push(template.relPath);
    }

    // 2. memory dirs (per-user notes live at memory/users/<username>.md)
    await fs.mkdir(path.join(workspaceDir, 'memory', 'users'), { recursive: true });

    // 3. register (idempotent)
    const existing = await this.findRegisteredAgent(params.openclawId);
    let registration: ProvisionAgentResult['registration'] = 'existing';
    let modelUpdated = false;
    if (existing === undefined) {
      await this.cli.execJson([
        'agents',
        'add',
        params.openclawId,
        '--non-interactive',
        '--workspace',
        this.containerWorkspaceDir(params.openclawId),
        '--model',
        params.model,
      ]);
      registration = 'added';
    } else if (existing.model !== undefined && existing.model !== params.model) {
      await setAgentModel(params.openclawId, params.model, { dataDir: this.dataDir });
      modelUpdated = true;
    }

    // 4. verify routable
    await this.waitRoutable(params.openclawId);

    return {
      openclawId: params.openclawId,
      hostWorkspaceDir: workspaceDir,
      containerWorkspaceDir: this.containerWorkspaceDir(params.openclawId),
      filesWritten,
      filesSkipped,
      registration,
      modelUpdated,
    };
  }

  /**
   * Hot persona update: re-render ONLY SOUL.md + IDENTITY.md (always
   * overwrites — this is the "edit persona in the studio" path). The gateway
   * reads workspace files per turn, so no re-registration is needed.
   */
  async updateAgentPersona(params: UpdatePersonaParams): Promise<{ filesWritten: string[] }> {
    assertValidOpenclawId(params.openclawId);
    const workspaceDir = this.hostWorkspaceDir(params.openclawId);
    if (!(await fileExists(workspaceDir))) {
      throw new ProvisionError(
        `workspace ${workspaceDir} does not exist — provision "${params.openclawId}" first`,
      );
    }
    const vars: Partial<TemplateVars> = {
      NAME: params.name,
      USERNAME: params.username,
      DESCRIPTION: params.description,
      PERSONA: params.persona,
      GREETING: params.greeting,
    };
    const filesWritten: string[] = [];
    for (const relPath of PERSONA_TEMPLATE_FILES) {
      const sourcePath = path.join(this.templatesDir, relPath);
      let raw: string;
      try {
        raw = await fs.readFile(sourcePath, 'utf8');
      } catch (err) {
        throw new ProvisionError(`cannot read template ${sourcePath}: ${(err as Error).message}`);
      }
      const rendered = renderTemplate(raw, vars);
      assertFullyRendered(relPath, rendered);
      await fs.writeFile(path.join(workspaceDir, relPath), rendered, 'utf8');
      filesWritten.push(relPath);
    }
    return { filesWritten };
  }

  /**
   * Find the agent's `agents.list` registration: `openclaw agents list --json`
   * when the CLI is reachable, else fall back to reading openclaw.json from
   * the host data dir (same source of truth).
   */
  private async findRegisteredAgent(
    openclawId: string,
  ): Promise<{ id: string; model?: string } | undefined> {
    let entries: { id: string; model?: string }[];
    try {
      const raw = await this.cli.execJson<unknown>(['agents', 'list']);
      entries = agentsListSchema.parse(raw);
    } catch {
      const config = await readOpenClawConfig(this.dataDir);
      const agents = config.agents;
      const list =
        typeof agents === 'object' && agents !== null && !Array.isArray(agents)
          ? (agents as Record<string, unknown>).list
          : undefined;
      const parsed = agentsListSchema.safeParse(list ?? []);
      entries = parsed.success ? parsed.data : [];
    }
    const found = entries.find((entry) => entry.id === openclawId);
    if (found === undefined) return undefined;
    return { id: found.id, ...(found.model !== undefined ? { model: found.model } : {}) };
  }

  /** Poll `GET /v1/models` until `openclaw/<id>` appears (spike probe #1). */
  private async waitRoutable(openclawId: string): Promise<void> {
    const modelId = `openclaw/${openclawId}`;
    const deadline = Date.now() + this.routableTimeoutMs;
    const baseUrl = this.gateway.baseUrl.replace(/\/+$/, '');
    let lastFailure = 'no response yet';
    for (;;) {
      try {
        const res = await this.fetchImpl(`${baseUrl}/v1/models`, {
          headers: { authorization: `Bearer ${this.gateway.token}` },
        });
        if (res.ok) {
          const body = modelsResponseSchema.safeParse(await res.json());
          const ids = body.success ? (body.data.data ?? []).map((m) => m.id) : [];
          if (ids.includes(modelId)) return;
          lastFailure = `${modelId} not in /v1/models (${ids.length} models listed)`;
        } else {
          lastFailure = `/v1/models responded ${res.status}`;
        }
      } catch (err) {
        lastFailure = `/v1/models fetch failed: ${(err as Error).message}`;
      }
      if (Date.now() + this.routablePollIntervalMs > deadline) {
        throw new ProvisionError(
          `agent "${openclawId}" not routable within ${this.routableTimeoutMs}ms — last: ${lastFailure}`,
        );
      }
      await sleep(this.routablePollIntervalMs);
    }
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
