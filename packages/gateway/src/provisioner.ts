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
 * ORDERING (critical — see fix in this file): `openclaw agents add` SEEDS the
 * workspace with OpenClaw's DEFAULT template files (generic SOUL.md, a
 * `BOOTSTRAP.md`, and its own `openclaw-workspace-state.json`). So we register
 * FIRST, then overwrite ALL of our rendered persona files so ours win, then
 * write the bootstrap-suppression marker LAST.
 *
 * BOOTSTRAP SUPPRESSION (verified against the running image, 2026.6.10,
 * `workspace-*.js` `resolveWorkspaceBootstrapStatus`): the first-boot ritual is
 * skipped iff `openclaw-workspace-state.json` at the workspace ROOT carries a
 * non-empty-string `setupCompletedAt` — OR no `BOOTSTRAP.md` exists. We do
 * BOTH: write `{"version":1,"setupCompletedAt":<iso>}` last, and delete the
 * `BOOTSTRAP.md` the seeder dropped. These two are correctness invariants
 * (re-asserted on every provision, even without `force`) rather than
 * user-editable content, so they live outside the skip-if-exists file loop.
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
  | 'VOICE'
  | 'THINKING_LEVEL'
  | 'MEMORY_SEED'
  | 'PROVISIONED_AT';

export type TemplateVars = Record<TemplateVarKey, string>;

/** Files re-rendered by {@link AgentProvisioner.updateAgentPersona} (hot). */
export const PERSONA_TEMPLATE_FILES = ['SOUL.md', 'IDENTITY.md'] as const;

/**
 * Bootstrap-suppression marker at the workspace ROOT. OpenClaw
 * (`resolveWorkspaceBootstrapStatus`) treats the first-boot ritual as complete
 * when this file carries a non-empty `setupCompletedAt`. Written LAST so the
 * seeding done by `agents add` cannot clobber it.
 */
export const WORKSPACE_STATE_FILENAME = 'openclaw-workspace-state.json';

/**
 * First-run ritual file OpenClaw's seeder drops into a fresh workspace. Its mere
 * presence flips the workspace back to bootstrap-pending, so we remove it after
 * registration (belt-and-suspenders alongside {@link WORKSPACE_STATE_FILENAME}).
 */
export const BOOTSTRAP_FILENAME = 'BOOTSTRAP.md';

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
  /** Canonical persona — rendered verbatim as the whole SOUL.md body ({{PERSONA}}). */
  persona: string;
  /** First-time-visitor greeting rendered into IDENTITY.md ({{GREETING}}). */
  greeting: string;
  /** Voice/tone or external voice identifier rendered into IDENTITY.md. */
  voice?: string;
  /** Runtime reasoning posture rendered into IDENTITY.md; default "balanced". */
  thinkingLevel?: string;
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
  voice?: string;
  thinkingLevel?: string;
}

export interface UpdatePersonaResult {
  filesWritten: string[];
  /**
   * Always true on success: the bootstrap-suppression marker was re-asserted
   * (see {@link AgentProvisioner.updateAgentPersona}). Mirrors
   * {@link ProvisionAgentResult.bootstrapSuppressed}.
   */
  bootstrapSuppressed: true;
}

export interface ProvisionAgentResult {
  openclawId: string;
  hostWorkspaceDir: string;
  containerWorkspaceDir: string;
  /**
   * Content template files written this call (relative paths). Excludes the
   * bootstrap-suppression marker ({@link WORKSPACE_STATE_FILENAME}), which is
   * always re-asserted and reported via {@link bootstrapSuppressed}.
   */
  filesWritten: string[];
  /** Content template files left untouched (existed and !force). */
  filesSkipped: string[];
  /** "added" via CLI this call, or "existing" (already registered). */
  registration: 'added' | 'existing';
  /** True when an existing registration's model was updated to params.model. */
  modelUpdated: boolean;
  /**
   * Always true on success: the `openclaw-workspace-state.json` marker was
   * (re-)written with `setupCompletedAt` and any seeded `BOOTSTRAP.md` removed,
   * so the first-boot ritual is suppressed. Re-asserted every call, force or not.
   */
  bootstrapSuppressed: boolean;
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
   * Provision an agent end-to-end. Order matters — `agents add` seeds the
   * workspace with OpenClaw's generic defaults, so our persona has to be
   * written AFTER registration:
   *
   *  1. create the workspace + `memory/` (+ `memory/users/`) dirs,
   *  2. register the agent via `openclaw agents add` (container workspace
   *     path) unless it is already in agents.list — in which case a model
   *     drift is corrected in openclaw.json instead. This is what seeds the
   *     default SOUL.md/BOOTSTRAP.md/state file into a fresh workspace,
   *  3. render ALL our workspace templates OVER the seeded defaults. On a fresh
   *     registration we always overwrite (our persona must beat the just-written
   *     seed); on an already-registered agent existing files are preserved
   *     unless `force: true` (keeps user hand-edits). The two bootstrap-
   *     suppression invariants below are re-asserted regardless,
   *  4. write the `openclaw-workspace-state.json` marker
   *     (`{"version":1,"setupCompletedAt":<iso>}`) and delete any seeded
   *     `BOOTSTRAP.md` — both suppress the first-boot ritual for migrated
   *     agents,
   *  5. poll `GET /v1/models` until `openclaw/<id>` is routable.
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
      VOICE: params.voice ?? 'unspecified',
      THINKING_LEVEL: params.thinkingLevel ?? 'balanced',
      MEMORY_SEED: params.memorySeed ?? '',
      PROVISIONED_AT: this.now().toISOString(),
    };
    const workspaceDir = this.hostWorkspaceDir(params.openclawId);

    // 1. workspace + memory dirs (per-user notes live at memory/users/<username>.md)
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.join(workspaceDir, 'memory', 'users'), { recursive: true });

    // 2. register FIRST (idempotent). `agents add` seeds the workspace with
    //    OpenClaw's default template files — including a generic SOUL.md and a
    //    BOOTSTRAP.md — so it must run BEFORE we render ours (step 3), or our
    //    persona is clobbered by the seed.
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

    // 3. render our workspace files OVER whatever the seed wrote so our persona
    //    wins. The bootstrap-suppression marker is handled separately in step 4
    //    (always re-asserted, never skipped), so it is excluded from this loop.
    //
    //    Overwrite rule: skip-if-exists preserves USER hand-edits across
    //    re-provisions — but it must NOT preserve the generic defaults that
    //    `agents add` just seeded on a fresh registration. So when we added the
    //    agent THIS call, force the render over the seed; otherwise honour the
    //    caller's `force` flag (default: keep existing files).
    const overwrite = force || registration === 'added';
    const templates = (await loadTemplates(this.templatesDir)).filter(
      (t) => t.relPath !== WORKSPACE_STATE_FILENAME,
    );
    const filesWritten: string[] = [];
    const filesSkipped: string[] = [];
    for (const template of templates) {
      const rendered = renderTemplate(template.raw, vars);
      assertFullyRendered(template.relPath, rendered);
      const target = path.join(workspaceDir, template.relPath);
      if (!overwrite && (await fileExists(target))) {
        filesSkipped.push(template.relPath);
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, rendered, 'utf8');
      filesWritten.push(template.relPath);
    }

    // 4. suppress the first-boot BOOTSTRAP ritual for migrated agents. These are
    //    correctness invariants, not user-editable content: write the state
    //    marker LAST (so `agents add`'s own state file can't survive) and remove
    //    the seeded BOOTSTRAP.md. Re-asserted on EVERY provision, force or not.
    await this.writeBootstrapSuppressionMarker(workspaceDir, vars.PROVISIONED_AT);
    await fs.rm(path.join(workspaceDir, BOOTSTRAP_FILENAME), { force: true });

    // Test seam: lets a subclass simulate a post-removal race (a stray
    // BOOTSTRAP.md reappearing after we cleaned it) so the read-back assertion
    // below can be exercised. No-op in production.
    await this.afterBootstrapSuppression(workspaceDir);

    // 4b. VERIFY suppression actually took — this is the restart-survival
    //     guarantee. `resolveWorkspaceBootstrapStatus` in the running image reads
    //     ONLY these two disk facts per turn (nothing in-memory, nothing in the
    //     state sqlite), so if the marker didn't land or a BOOTSTRAP.md slipped
    //     back in, the agent WILL run the blank-slate ritual on its next load
    //     (incl. after a gateway restart). Re-read from disk and fail loudly
    //     rather than ship a workspace that regresses. See docs/dev/spike.md.
    await this.assertBootstrapSuppressed(workspaceDir);

    // 5. verify routable
    await this.waitRoutable(params.openclawId);

    return {
      openclawId: params.openclawId,
      hostWorkspaceDir: workspaceDir,
      containerWorkspaceDir: this.containerWorkspaceDir(params.openclawId),
      filesWritten,
      filesSkipped,
      registration,
      modelUpdated,
      bootstrapSuppressed: true,
    };
  }

  /**
   * Write the workspace-state marker that suppresses OpenClaw's first-boot
   * ritual. Rendered from the `openclaw-workspace-state.json` template so the
   * shape stays in one place; `setupCompletedAt` is the load-bearing key
   * (`resolveWorkspaceBootstrapStatus` → "complete" when it is a non-empty
   * string).
   */
  private async writeBootstrapSuppressionMarker(
    workspaceDir: string,
    provisionedAt: string,
  ): Promise<void> {
    const sourcePath = path.join(this.templatesDir, WORKSPACE_STATE_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(sourcePath, 'utf8');
    } catch (err) {
      throw new ProvisionError(
        `cannot read workspace-state template ${sourcePath}: ${(err as Error).message}`,
      );
    }
    const rendered = renderTemplate(raw, { PROVISIONED_AT: provisionedAt });
    assertFullyRendered(WORKSPACE_STATE_FILENAME, rendered);
    await fs.writeFile(path.join(workspaceDir, WORKSPACE_STATE_FILENAME), rendered, 'utf8');
  }

  /**
   * Test seam invoked after the bootstrap-suppression marker is written and any
   * seeded BOOTSTRAP.md removed, but before the read-back assertion. Overridden
   * in tests to simulate a post-removal race; a no-op in production.
   */
  protected async afterBootstrapSuppression(_workspaceDir: string): Promise<void> {
    // intentionally empty
  }

  /**
   * Re-read the workspace from disk and assert the first-boot ritual is
   * suppressed by the SAME predicate the running gateway uses per turn
   * ({@link workspaceBootstrapStatus}). Throws {@link ProvisionError} otherwise
   * so a provision that would regress on next load (or after a gateway restart)
   * fails loudly here instead of silently shipping a blank-slate agent.
   */
  private async assertBootstrapSuppressed(workspaceDir: string): Promise<void> {
    const status = await workspaceBootstrapStatus(workspaceDir);
    if (status !== 'complete') {
      throw new ProvisionError(
        `bootstrap suppression failed for ${workspaceDir}: workspace still resolves ` +
          `to "${status}" — the agent would run the blank-slate ritual on its next ` +
          `load. Expected a non-empty setupCompletedAt in ${WORKSPACE_STATE_FILENAME} ` +
          `and no ${BOOTSTRAP_FILENAME}.`,
      );
    }
  }

  /**
   * Hot persona update: re-render ONLY SOUL.md + IDENTITY.md (always
   * overwrites — this is the "edit persona in the studio" path). The gateway
   * reads workspace files per turn, so no re-registration is needed.
   *
   * Also RE-ASSERTS the bootstrap-suppression marker (writes
   * `openclaw-workspace-state.json` with a fresh `setupCompletedAt` and removes
   * any stray `BOOTSTRAP.md`), then verifies via {@link assertBootstrapSuppressed}.
   * This is defense-in-depth + self-healing: the running gateway never re-seeds
   * a workspace whose marker is already set, but if a marker is ever lost (manual
   * edit, a partial `agents add` re-seed, a restored-from-backup workspace),
   * editing the persona in the studio restores the durable "onboarded" state so
   * the agent cannot fall back into the blank-slate ritual (which would then
   * overwrite the very persona we just wrote) on its next turn or a restart.
   */
  async updateAgentPersona(params: UpdatePersonaParams): Promise<UpdatePersonaResult> {
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
      VOICE: params.voice ?? 'unspecified',
      THINKING_LEVEL: params.thinkingLevel ?? 'balanced',
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
    // Re-assert the durable suppression invariant so a persona edit can never
    // leave the workspace in a bootstrap-pending state on next load.
    await this.writeBootstrapSuppressionMarker(workspaceDir, this.now().toISOString());
    await fs.rm(path.join(workspaceDir, BOOTSTRAP_FILENAME), { force: true });
    await this.assertBootstrapSuppressed(workspaceDir);
    return { filesWritten, bootstrapSuppressed: true };
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

/**
 * Reimplementation of OpenClaw's `resolveWorkspaceBootstrapStatus`
 * (`dist/workspace-*.js` in image 2026.6.10) — the EXACT per-turn predicate that
 * decides whether an agent gets the blank-slate BOOTSTRAP handoff prompt or its
 * normal SOUL-based prompt. Kept here as the single durable-marker contract the
 * provisioner enforces and the tests assert against.
 *
 * The gateway checks TWO disk facts at the workspace ROOT and NOTHING else — not
 * the state sqlite (its `workspace_setup_state` table is DDL-only in 6.10 and is
 * never read), not any in-memory flag (which is why a restart re-runs this):
 *
 *   status = "complete"  when  openclaw-workspace-state.json has a non-empty
 *                              string `setupCompletedAt`
 *                        OR    no BOOTSTRAP.md exists at the workspace root
 *          = "pending"   otherwise  → triggers the "I just came online, who am
 *                                     I?" ritual (model-generated, not a fixed
 *                                     string) which then overwrites SOUL.md.
 *
 * A durable, restart-surviving "onboarded" marker therefore requires BOTH a
 * non-empty `setupCompletedAt` AND the absence of BOOTSTRAP.md — the provisioner
 * asserts exactly this after every provision.
 */
export async function workspaceBootstrapStatus(
  workspaceDir: string,
): Promise<'complete' | 'pending'> {
  let setupCompletedAt: unknown;
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(workspaceDir, WORKSPACE_STATE_FILENAME), 'utf8'),
    ) as Record<string, unknown>;
    setupCompletedAt = parsed?.setupCompletedAt;
  } catch {
    setupCompletedAt = undefined;
  }
  if (typeof setupCompletedAt === 'string' && setupCompletedAt.trim().length > 0) return 'complete';
  if (!(await fileExists(path.join(workspaceDir, BOOTSTRAP_FILENAME)))) return 'complete';
  return 'pending';
}
