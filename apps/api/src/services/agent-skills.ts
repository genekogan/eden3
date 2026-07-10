import { promises as fs } from 'node:fs';
import path from 'node:path';

import { pg } from '@eden3/db';

import type { SkillSyncLike } from '../gateway-glue';

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
    slug: 'eden-safe-base',
    name: 'Eden Safe Base',
    description: 'Baseline operating rules for privacy, consent, and careful execution.',
    body:
      '# Eden Safe Base\n\n' +
      '- Protect private user data, secrets, credentials, payment details, and unreleased work.\n' +
      '- Ask before taking irreversible or externally visible actions.\n' +
      '- State uncertainty plainly when evidence is incomplete.\n' +
      '- Prefer the smallest effective tool call and avoid unnecessary spend.\n',
  },
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

export const DEFAULT_AGENT_SKILL_SLUGS = ['eden-safe-base'] as const;

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

const SKILL_MANIFEST_BEGIN = '<!-- EDEN3_SKILLS_BEGIN -->';
const SKILL_MANIFEST_END = '<!-- EDEN3_SKILLS_END -->';

function removeSkillManifest(text: string): string {
  const start = text.indexOf(SKILL_MANIFEST_BEGIN);
  const end = text.indexOf(SKILL_MANIFEST_END);
  if (start === -1 || end === -1 || end < start) return text.trimEnd();
  return `${text.slice(0, start).trimEnd()}\n${text.slice(end + SKILL_MANIFEST_END.length).trimStart()}`.trimEnd();
}

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
  const toolsPath = path.resolve(workspacePath, 'TOOLS.md');
  let base = '';
  try {
    base = await fs.readFile(toolsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const without = removeSkillManifest(base);
  const manifest = skillManifestBody(skills);
  const next = manifest ? `${without}\n\n${manifest}\n` : `${without}\n`;
  await fs.writeFile(toolsPath, next, { mode: 0o600 });
}

export async function writeSkillFiles(
  workspacePath: string,
  skills: SkillDefinitionRow[],
): Promise<void> {
  const root = path.resolve(workspacePath, 'skills');
  await fs.mkdir(root, { recursive: true });
  for (const skill of skills) {
    const dir = path.resolve(root, skill.slug);
    if (!dir.startsWith(`${root}${path.sep}`)) {
      throw new SkillInstallError(400, 'invalid_skill_slug', `Invalid skill slug "${skill.slug}"`);
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), skillFileBody(skill), { mode: 0o600 });
  }
  await writeSkillManifest(workspacePath, skills);
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

export async function replaceAgentSkills(params: {
  agentId: string;
  openclawId: string;
  workspacePath: string;
  slugs: string[];
  skillSync: SkillSyncLike;
}): Promise<{ skills: AgentSkillRow[]; openclaw: { changed: boolean } }> {
  const requested = normalizedUniqueSlugs(params.slugs);
  const rows = await skillRowsBySlugs(requested);
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

  await writeSkillFiles(params.workspacePath, rows);
  await pg.begin(async (sql) => {
    await sql`delete from agent_skills where agent_id = ${params.agentId}`;
    for (const skill of rows) {
      await sql`
        insert into agent_skills (agent_id, skill_id, enabled)
        values (${params.agentId}, ${skill.id}, true)
      `;
    }
  });
  const openclaw = await params.skillSync.syncAgentSkills({
    openclawId: params.openclawId,
    skills: requested,
  });
  return { skills: await attachedSkillRows(params.agentId), openclaw };
}

export async function installDefaultAgentSkills(params: {
  agentId: string;
  openclawId: string;
  workspacePath: string;
  skillSync: SkillSyncLike;
}): Promise<{ skills: AgentSkillRow[]; openclaw: { changed: boolean } }> {
  await ensureBuiltinSkills();
  return replaceAgentSkills({
    ...params,
    slugs: [...DEFAULT_AGENT_SKILL_SLUGS],
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
    .filter((row) => row.status === 'approved')
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
