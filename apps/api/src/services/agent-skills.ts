import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pg } from '@eden3/db';

import type { SkillSyncLike } from '../gateway-glue';
import {
  AGENT_RUNTIME_SYNC_LOCK_SEED,
  agentRuntimeSyncLockKey,
} from './agent-runtime-lock';

export interface SkillDefinitionRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  body: string;
  source: 'curated' | 'user';
  status: 'pending' | 'approved' | 'rejected';
  owner_id: string | null;
  reviewer_id: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentSkillRow extends SkillDefinitionRow {
  enabled: boolean;
}

export class SkillInstallError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'SkillInstallError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const BUILTIN_SKILLS = [
  {
    slug: 'creative-brief',
    name: 'Creative Brief',
    description: 'Turns vague creative direction into concrete prompts, constraints, and review criteria.',
    body:
      '# Creative Brief\n\n' +
      '- Clarify subject, medium, mood, constraints, and success criteria before generation.\n' +
      '- Preserve the user\'s aesthetic intent instead of defaulting to generic style language.\n' +
      '- When reviewing media, comment on composition, lighting, material, pacing, and fit to brief.\n',
  },
  {
    slug: 'session-synthesizer',
    name: 'Session Synthesizer',
    description: 'Summarizes long context into durable next actions and memory candidates.',
    body:
      '# Session Synthesizer\n\n' +
      '- Distill long conversations into stable facts, open questions, decisions, and next actions.\n' +
      '- Keep subjective impressions separate from confirmed facts.\n' +
      '- Do not store sensitive facts as memory unless the user clearly wants that retained.\n',
  },
] as const;

/**
 * Skills attached to every newly provisioned agent. Now empty: the old
 * `eden-safe-base` baseline moved OUT of the skill system and into the
 * always-loaded platform layer (packages/gateway/workspace-templates/AGENTS.md
 * "Conduct" section) so privacy/consent/careful-execution rules are standing
 * conduct no toggle can remove — not a user-facing, deletable "skill". The
 * secrets portion is additionally enforced by the runtime egress sealed-interior
 * + capability floor, so the AGENTS.md line is a restatement, not the control.
 */
export const DEFAULT_AGENT_SKILL_SLUGS: readonly string[] = [];

/**
 * Skills that were once curated/default but are now handled by the platform
 * layer. On every provision/skill-sync they are deleted from `skill_definitions`
 * (cascading their `agent_skills` links), stripped from the TOOLS.md manifest,
 * and their `skills/<slug>/` directory removed — so existing workspaces shed
 * them idempotently without a one-off migration. Adding a slug here retires it.
 */
export const RETIRED_SKILL_SLUGS = ['eden-safe-base'] as const;

export function skillColumns() {
  return pg`
    id, slug, name, description, body, source, status,
    owner_id, reviewer_id, reviewed_at, created_at, updated_at
  `;
}

export function normalizedUniqueSlugs(slugs: string[]): string[] {
  return [...new Set(slugs)].sort();
}

export async function ensureBuiltinSkills(): Promise<void> {
  for (const skill of BUILTIN_SKILLS) {
    await pg`
      insert into skill_definitions (slug, name, description, body, source, status)
      values (${skill.slug}, ${skill.name}, ${skill.description}, ${skill.body}, 'curated', 'approved')
      on conflict (slug) do update
      set name = excluded.name,
          description = excluded.description,
          body = excluded.body,
          source = 'curated',
          status = 'approved',
          updated_at = now()
    `;
  }
  // Retire skills that are now platform-enforced. Deleting the definition row
  // cascades to `agent_skills` (FK onDelete: cascade), so it vanishes from the
  // global catalog (GET /skills) and every agent's panel. Idempotent.
  if (RETIRED_SKILL_SLUGS.length > 0) {
    await pg`delete from skill_definitions where slug = any(${[...RETIRED_SKILL_SLUGS]}::text[])`;
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' ').trim());
}

function hasFrontmatter(body: string): boolean {
  return body.trimStart().startsWith('---\n');
}

function stripFrontmatter(body: string): string {
  const trimmedStart = body.trimStart();
  if (!trimmedStart.startsWith('---\n')) return body.trim();
  const close = trimmedStart.indexOf('\n---', 4);
  if (close === -1) return body.trim();
  return trimmedStart.slice(close + 4).trim();
}

function skillFileBody(skill: SkillDefinitionRow): string {
  const body = skill.body.endsWith('\n') ? skill.body : `${skill.body}\n`;
  if (hasFrontmatter(body)) return body;
  return [
    '---',
    `name: ${skill.slug}`,
    `description: ${yamlString(skill.description ?? skill.name)}`,
    '---',
    '',
    body,
  ].join('\n');
}

const MANAGED_SKILL_SLUG = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function assertManagedSkillSlug(slug: string): void {
  if (!MANAGED_SKILL_SLUG.test(slug)) {
    throw new SkillInstallError(400, 'invalid_skill_slug', `Invalid skill slug "${slug}"`);
  }
}

interface AnchoredDirectory {
  path: string;
  expected: { dev: string; ino: string };
}

async function anchoredDirectory(directoryPath: string): Promise<AnchoredDirectory> {
  const entry = await fs.lstat(directoryPath, { bigint: true });
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new SkillInstallError(
      409,
      'unsafe_skill_workspace',
      'Managed skill path must be a real directory',
    );
  }
  return {
    path: directoryPath,
    expected: { dev: entry.dev.toString(), ino: entry.ino.toString() },
  };
}

async function runSkillFilesystemWorker(
  anchor: AnchoredDirectory,
  request: Record<string, unknown>,
): Promise<void> {
  const worker = fileURLToPath(new URL('./agent-skill-fs-worker.mjs', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [worker], {
      cwd: anchor.path,
      env: {},
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    timeout.unref?.();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `skill filesystem worker exited ${code ?? signal}`));
    });
    child.stdin.end(JSON.stringify({ ...request, expected: anchor.expected }));
  });
}

async function verifiedSkillRoot(workspacePath: string): Promise<AnchoredDirectory> {
  const workspaceRoot = await fs.realpath(workspacePath);
  const root = path.resolve(workspacePath, 'skills');
  try {
    const entry = await fs.lstat(root);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new SkillInstallError(
        409,
        'unsafe_skill_workspace',
        'Managed skill root must be a real directory',
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.mkdir(root, { recursive: false, mode: 0o700 });
  }
  const resolvedRoot = await fs.realpath(root);
  if (resolvedRoot !== path.join(workspaceRoot, 'skills')) {
    throw new SkillInstallError(
      409,
      'unsafe_skill_workspace',
      'Managed skill root resolves outside the agent workspace',
    );
  }
  return anchoredDirectory(root);
}

async function managedDirectory(
  root: AnchoredDirectory,
  slug: string,
  create: boolean,
): Promise<AnchoredDirectory | null> {
  const target = path.join(root.path, slug);
  try {
    const entry = await fs.lstat(target, { bigint: true });
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      if (!create) return null;
      throw new SkillInstallError(
        409,
        'unsafe_skill_workspace',
        `Managed skill directory "${slug}" must be a real directory`,
      );
    }
    return {
      path: target,
      expected: { dev: entry.dev.toString(), ino: entry.ino.toString() },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && create) {
      await fs.mkdir(target, { mode: 0o700 });
      return anchoredDirectory(target);
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertSelectedDirectorySafe(root: AnchoredDirectory, slug: string): Promise<void> {
  const target = path.join(root.path, slug);
  try {
    const entry = await fs.lstat(target);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new SkillInstallError(
        409,
        'unsafe_skill_workspace',
        `Managed skill directory "${slug}" must be a real directory`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function cleanupManagedTombstones(
  root: AnchoredDirectory,
  slugs: readonly string[],
): Promise<void> {
  for (const slug of slugs) {
    for (const phase of ['delete', 'remove'] as const) {
      const tombstonePath = path.join(root.path, `.eden3-managed-${phase}-${slug}`);
      let tombstone: AnchoredDirectory;
      try {
        tombstone = await anchoredDirectory(tombstonePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      await runSkillFilesystemWorker(tombstone, {
        operation: 'cleanup-tombstone',
        slug,
        phase,
      });
    }
  }
}

const SKILL_MANIFEST_BEGIN = '<!-- EDEN3_SKILLS_BEGIN -->';
const SKILL_MANIFEST_END = '<!-- EDEN3_SKILLS_END -->';

function skillManifestBody(skills: SkillDefinitionRow[]): string {
  if (skills.length === 0) return '';
  const sections = skills.map((skill) =>
    [
      `### ${skill.name} (${skill.slug})`,
      '',
      skill.description ? `Description: ${skill.description}` : null,
      '',
      stripFrontmatter(skill.body),
    ]
      .filter((part): part is string => part !== null)
      .join('\n')
      .trim(),
  );
  return [
    SKILL_MANIFEST_BEGIN,
    '## Enabled Eden Skills',
    '',
    'Follow these approved skill instructions when relevant to the user request.',
    '',
    ...sections,
    SKILL_MANIFEST_END,
  ].join('\n\n');
}

async function writeSkillManifest(workspacePath: string, skills: SkillDefinitionRow[]): Promise<void> {
  const manifest = skillManifestBody(skills);
  await runSkillFilesystemWorker(await anchoredDirectory(workspacePath), {
    operation: 'rewrite-tools',
    manifest,
  });
}

export async function writeSkillFiles(
  workspacePath: string,
  skills: SkillDefinitionRow[],
  managedSlugs: readonly string[],
): Promise<void> {
  const selectedSlugs = normalizedUniqueSlugs(skills.map((skill) => skill.slug));
  const allManagedSlugs = normalizedUniqueSlugs([
    ...managedSlugs,
    ...RETIRED_SKILL_SLUGS,
  ]);
  for (const slug of [...selectedSlugs, ...allManagedSlugs]) assertManagedSkillSlug(slug);
  if (
    selectedSlugs.length !== skills.length ||
    selectedSlugs.some((slug) => !allManagedSlugs.includes(slug))
  ) {
    throw new SkillInstallError(
      409,
      'invalid_skill_projection',
      'Selected skills do not match the managed skill catalog',
    );
  }

  const root = await verifiedSkillRoot(workspacePath);
  // Validate every selected final entry before even sanitizing TOOLS.md. A
  // workspace-controlled symlink or special file is tampering, not a target
  // to follow or normalize during projection.
  for (const slug of selectedSlugs) {
    await assertSelectedDirectorySafe(root, slug);
  }
  await cleanupManagedTombstones(root, allManagedSlugs);
  const selected = new Set(selectedSlugs);
  const removed = allManagedSlugs.filter((slug) => !selected.has(slug));
  // Make every rejected entry inert before any rename. A crash after the root
  // worker renames it leaves only a deterministic, inert tombstone which the
  // next retry can identify and remove.
  for (const slug of removed) {
    const dir = await managedDirectory(root, slug, false);
    if (dir) {
      await runSkillFilesystemWorker(dir, {
        operation: 'sanitize-and-tombstone',
        slug,
      });
    }
  }
  // Symlink/special final entries cannot carry an in-directory tombstone.
  // Unlink those exact entries through the root inode before any fallible
  // manifest I/O, so a rejected link cannot survive a pending retry.
  await runSkillFilesystemWorker(root, { operation: 'remove-special', slugs: removed });
  // Publish the authoritative managed prompt block before selected-file work.
  await writeSkillManifest(workspacePath, skills);
  // `skills/` is also a normal owner workspace location, so never enumerate
  // and delete unknown directories. Only catalog/retirement slugs are
  // Eden-managed and eligible for exact-set cleanup.
  await cleanupManagedTombstones(root, removed);
  for (const skill of skills) {
    const dir = await managedDirectory(root, skill.slug, true);
    // Starting the worker with this directory as cwd converts the verified
    // inode into a kernel-held directory capability. A later rename/symlink
    // swap of the visible path cannot redirect its relative file access.
    await runSkillFilesystemWorker(dir!, {
      operation: 'write-skill',
      body: skillFileBody(skill),
    });
  }
}

export async function skillRowsBySlugs(slugs: string[]): Promise<SkillDefinitionRow[]> {
  if (slugs.length === 0) return [];
  return pg<SkillDefinitionRow[]>`
    select ${skillColumns()}
    from skill_definitions
    where slug = any(${slugs}::text[])
    order by slug asc
  `;
}

function assertInstallableSkills(
  requested: string[],
  rows: SkillDefinitionRow[],
): void {
  const found = new Set(rows.map((row) => row.slug));
  const missing = requested.filter((slug) => !found.has(slug));
  if (missing.length > 0) {
    throw new SkillInstallError(404, 'skill_not_found', `Unknown skill(s): ${missing.join(', ')}`);
  }
  const notApproved = rows.filter((row) => row.status !== 'approved').map((row) => row.slug);
  if (notApproved.length > 0) {
    throw new SkillInstallError(
      409,
      'skill_not_approved',
      `Skill(s) are not approved: ${notApproved.join(', ')}`,
    );
  }
}

export async function approvedSkillsForAgent(agentId: string): Promise<string[]> {
  const rows = await pg<{ slug: string }[]>`
    select sd.slug
    from agent_skills aks
    join skill_definitions sd on sd.id = aks.skill_id
    where aks.agent_id = ${agentId}
      and aks.enabled = true
      and sd.status = 'approved'
    order by sd.slug asc
  `;
  return rows.map((row) => row.slug);
}

export async function attachedSkillRows(agentId: string): Promise<AgentSkillRow[]> {
  return pg<AgentSkillRow[]>`
    select sd.id, sd.slug, sd.name, sd.description, sd.body, sd.source, sd.status,
           sd.owner_id, sd.reviewer_id, sd.reviewed_at, sd.created_at, sd.updated_at,
           aks.enabled
    from agent_skills aks
    join skill_definitions sd on sd.id = aks.skill_id
    where aks.agent_id = ${agentId}
    order by sd.slug asc
  `;
}

/**
 * Commit the DB-authoritative skill selection and enqueue one durable runtime
 * revision. No filesystem or OpenClaw mutation is allowed here: those effects
 * belong to the per-agent reconciler's session advisory lock.
 *
 * `FOR SHARE` on every selected definition closes the moderation race. An
 * admin rejection either lands first (and this request observes `rejected`) or
 * waits for this transaction, then sees and removes the newly attached row.
 */
export async function commitAgentSkillSelection(params: {
  agentId: string;
  slugs: string[];
}): Promise<AgentSkillRow[]> {
  const requested = normalizedUniqueSlugs(params.slugs);
  for (const slug of params.slugs) assertManagedSkillSlug(slug);
  if (requested.length !== params.slugs.length) {
    throw new SkillInstallError(
      400,
      'invalid_skill_selection',
      'Skill selection must contain unique canonical slugs',
    );
  }
  await pg.begin(async (sql) => {
    const rows =
      requested.length === 0
        ? []
        : await sql<SkillDefinitionRow[]>`
            select ${skillColumns()}
            from skill_definitions
            where slug = any(${requested}::text[])
            order by slug asc
            for share
          `;
    assertInstallableSkills(requested, rows);

    // Definition-row locks precede the agent lock, matching admin rejection's
    // row-update -> agent-lock order and avoiding a moderation/owner deadlock.
    // Keep this seed aligned with PATCH /agents and POST /agents/.../repair.
    await sql`select pg_advisory_xact_lock(hashtextextended(${params.agentId}::text, 91))`;

    await sql`update agent_skills set enabled = false where agent_id = ${params.agentId}`;
    for (const skill of rows) {
      await sql`
        insert into agent_skills (agent_id, skill_id, enabled)
        values (${params.agentId}, ${skill.id}, true)
        on conflict (agent_id, skill_id) do update set enabled = true
      `;
    }
    const [updated] = await sql<{ account_id: string }[]>`
      update agents
      set runtime_sync_version = runtime_sync_version + 1,
          runtime_sync_lease_expires_at = null,
          runtime_sync_error = null
      where account_id = ${params.agentId}
      returning account_id
    `;
    if (!updated) throw new Error('agent skill runtime revision target unavailable');
  });
  return (await attachedSkillRows(params.agentId)).filter((row) => row.enabled);
}

/**
 * Project the current DB-authoritative approved skills into one ready runtime.
 * The caller must hold the agent runtime session advisory lock. This function
 * deliberately never changes `agent_skills`, so an older claimant cannot
 * overwrite a newer owner/admin selection while finishing its projection.
 */
export async function projectApprovedAgentSkills(params: {
  agentId: string;
  openclawId: string;
  workspacePath: string;
  skillSync: SkillSyncLike;
}): Promise<{ skills: AgentSkillRow[]; openclaw: { changed: boolean } }> {
  // The runtime scheduler starts before route registration finishes. Reassert
  // curated/retired definitions here so an immediate boot recovery cannot
  // briefly re-project a retired skill before server bootstrap cleans it up.
  await ensureBuiltinSkills();
  const attached = await attachedSkillRows(params.agentId);
  const skills = attached.filter(
    (row) => row.enabled && row.status === 'approved',
  );
  await writeSkillFiles(params.workspacePath, skills, attached.map((row) => row.slug));
  const openclaw = await params.skillSync.syncAgentSkills({
    openclawId: params.openclawId,
    skills: skills.map((skill) => skill.slug),
  });
  return { skills, openclaw };
}

export async function replaceAgentSkills(params: {
  agentId: string;
  openclawId: string;
  workspacePath: string;
  slugs: string[];
  skillSync: SkillSyncLike;
}): Promise<{ skills: AgentSkillRow[]; openclaw: { changed: boolean } }> {
  const requested = normalizedUniqueSlugs(params.slugs);
  for (const slug of params.slugs) assertManagedSkillSlug(slug);
  if (requested.length !== params.slugs.length) {
    throw new SkillInstallError(
      400,
      'invalid_skill_selection',
      'Skill selection must contain unique canonical slugs',
    );
  }
  await pg.begin(async (sql) => {
    // Initial provisioning/import is the sole remaining direct projection
    // path. Lock definitions through the attachment commit so moderation
    // either wins first (and validation refuses) or observes the new link and
    // enqueues a correcting runtime revision.
    const selected =
      requested.length === 0
        ? []
        : await sql<SkillDefinitionRow[]>`
            select ${skillColumns()}
            from skill_definitions
            where slug = any(${requested}::text[])
            order by slug asc
            for share
          `;
    assertInstallableSkills(requested, selected);
    await sql`update agent_skills set enabled = false where agent_id = ${params.agentId}`;
    for (const skill of selected) {
      await sql`
        insert into agent_skills (agent_id, skill_id, enabled)
        values (${params.agentId}, ${skill.id}, true)
        on conflict (agent_id, skill_id) do update set enabled = true
      `;
    }
  });
  // If projection now fails, provisioning remains non-ready while the DB
  // selection survives. Serialize the direct bootstrap/import path against
  // the ordinary runtime reconciler, then lock every attached definition so
  // moderation either wins before the re-read or waits and enqueues cleanup.
  const openclaw = await pg.begin(async (sql) => {
    const [lock] = await sql<{ acquired: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtextextended(
        ${agentRuntimeSyncLockKey(params.agentId)}::text,
        ${AGENT_RUNTIME_SYNC_LOCK_SEED}
      )) as acquired
    `;
    if (lock?.acquired !== true) {
      throw new SkillInstallError(
        409,
        'skill_projection_busy',
        'Agent runtime projection is busy; retry pending',
      );
    }
    const attached = await sql<AgentSkillRow[]>`
      select sd.id, sd.slug, sd.name, sd.description, sd.body, sd.source, sd.status,
             sd.owner_id, sd.reviewer_id, sd.reviewed_at, sd.created_at, sd.updated_at,
             aks.enabled
      from agent_skills aks
      join skill_definitions sd on sd.id = aks.skill_id
      where aks.agent_id = ${params.agentId}
      order by sd.slug asc
      for share of sd
    `;
    const selected = attached.filter((row) => row.enabled);
    assertInstallableSkills(
      selected.map((row) => row.slug),
      selected,
    );
    await writeSkillFiles(
      params.workspacePath,
      selected,
      attached.map((row) => row.slug),
    );
    return params.skillSync.syncAgentSkills({
      openclawId: params.openclawId,
      skills: selected.map((row) => row.slug),
    });
  });
  return {
    skills: (await attachedSkillRows(params.agentId)).filter((row) => row.enabled),
    openclaw,
  };
}

export async function installDefaultAgentSkills(params: {
  agentId: string;
  openclawId: string;
  workspacePath: string;
  skillSync: SkillSyncLike;
}): Promise<{ skills: AgentSkillRow[]; openclaw: { changed: boolean } }> {
  await ensureBuiltinSkills();
  // Re-sync the agent's CURRENT approved skills union the defaults. On a fresh
  // agent both are empty (DEFAULT_AGENT_SKILL_SLUGS moved to the platform layer),
  // so nothing is attached; on an existing agent (repair, lazy first-chat
  // provision) this preserves the owner's chosen skills instead of wiping them,
  // while still rewriting the manifest and shedding any RETIRED_SKILL_SLUGS.
  const existing = await approvedSkillsForAgent(params.agentId);
  return replaceAgentSkills({
    ...params,
    slugs: [...new Set([...existing, ...DEFAULT_AGENT_SKILL_SLUGS])],
  });
}

export async function exportedSkillBundlesForAgent(agentId: string): Promise<
  {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    source: 'curated' | 'user';
    enabled: boolean;
    body: string;
  }[]
> {
  const rows = await attachedSkillRows(agentId);
  return rows
    .filter((row) => row.enabled && row.status === 'approved')
    .map((row) => ({
      id: row.slug,
      slug: row.slug,
      name: row.name,
      description: row.description,
      source: row.source,
      enabled: row.enabled,
      body: row.body,
    }));
}
