import { promises as fs } from 'node:fs';
import path from 'node:path';

import { pg } from '@eden3/db';

/**
 * Concepts — per-agent reference-image aesthetics (the eden1 "concepts"
 * successor) and their projection into the agent's OpenClaw workspace.
 *
 * A concept row (see packages/db schema `concepts` / `concept_images`) is the
 * source of truth; {@link projectAgentConcepts} makes the runtime actually
 * able to USE it by rebuilding `<workspace>/concepts/` from the DB:
 *
 *   concepts/
 *     INDEX.md              — all concepts + a standing "in the style of X"
 *                             tip pointing at image_generate's `images` param
 *     <slug>/
 *       CONCEPT.md          — frontmatter (name, description) + instructions
 *                             + the reference-image file listing
 *       ref-1.png … ref-N   — the reference images themselves, copied from
 *                             the content-addressed media store so the agent
 *                             can pass real file paths to image tools
 *
 * The projection is a FULL REBUILD (rm + rewrite) called after every concept
 * mutation — simple, idempotent, and self-healing. Agents that are not
 * provisioned yet (workspace_path null — e.g. dormant migrated agents that
 * lazy-provision on first chat) skip the projection with reason
 * 'not_provisioned'; the next concept mutation after provisioning re-projects
 * everything, so no state is lost. When the last concept is deleted the whole
 * `concepts/` dir is removed.
 *
 * Rebuilds for the same agent are serialized in-process (see
 * {@link projectionChains}) so two concurrent mutations cannot interleave
 * rm/write on the same directory.
 */

export interface ConceptRow {
  id: string;
  agent_id: string;
  name: string;
  slug: string;
  description: string | null;
  instructions: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConceptImageRow {
  id: string;
  concept_id: string;
  url: string;
  local_path: string | null;
  sha256: string;
  mime: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  filename: string | null;
  position: number;
  created_at: string;
}

export interface ConceptProjectionResult {
  projected: boolean;
  /** Why nothing was written (projected: false). */
  reason?: 'agent_not_found' | 'not_provisioned';
  /** Concepts rendered into the workspace. */
  concepts?: number;
  /** Reference-image files copied. */
  images?: number;
}

export const CONCEPTS_DIRNAME = 'concepts';
export const CONCEPT_FILENAME = 'CONCEPT.md';
export const CONCEPTS_INDEX_FILENAME = 'INDEX.md';

/**
 * Always-loaded operating rules that inventory the projected concepts in
 * `concepts/` dir. New agents get this baked into their AGENTS.md by the
 * gateway's workspace template (packages/gateway/workspace-templates/AGENTS.md);
 * agents provisioned before concepts existed have an AGENTS.md on disk that the
 * provisioner SKIPS (skip-if-exists), so {@link ensureConceptsPointer} backfills
 * a concrete inventory the first time an owner projects a concept. The marker
 * block is replaced after every mutation, so stale names/references disappear.
 */
const AGENTS_FILENAME = 'AGENTS.md';
const CONCEPTS_DOC_BEGIN = '<!-- EDEN3_CONCEPTS_BEGIN -->';
const CONCEPTS_DOC_END = '<!-- EDEN3_CONCEPTS_END -->';

/** Always-loaded inventory projected into AGENTS.md from the canonical DB rows. */
function conceptsPointerSection(concepts: RenderedConcept[]): string {
  const inventory = concepts.flatMap((concept) => {
    const references = concept.files.map(
      (file) => `${CONCEPTS_DIRNAME}/${concept.row.slug}/${file.name}`,
    );
    return [
      `### ${concept.row.name}`,
      '',
      `- Purpose: ${concept.row.description?.trim() || 'Use this named visual reference when requested.'}`,
      `- Instructions: ${concept.row.instructions?.trim().replace(/\s+/g, ' ') || 'Use the listed files as visual references.'}`,
      `- Brief: \`${CONCEPTS_DIRNAME}/${concept.row.slug}/${CONCEPT_FILENAME}\``,
      `- References: ${references.length > 0 ? references.map((file) => `\`${file}\``).join(', ') : '(none uploaded)'}`,
      '',
    ];
  });
  return [
    CONCEPTS_DOC_BEGIN,
    '## Active concepts (always check before image generation)',
    '',
    '- The concepts listed below are available now. Before asking a user for a reference image, physical description, or style clarification, check this inventory.',
    '- If an image request names or clearly depicts a listed concept, read its brief and pass every listed reference path to `image_generate` via `images`.',
    '- Carry the concept purpose and instructions into the generation prompt; for a named person or character, explicitly preserve their identity from the references.',
    '- Do not ask the user to re-upload or describe something already supplied by a matching concept. Use the concept automatically unless the request conflicts with its instructions.',
    '',
    ...inventory,
    CONCEPTS_DOC_END,
  ].join('\n');
}

/**
 * Synchronize the always-loaded AGENTS.md concept inventory. No-op when the
 * file is missing; marker-guarded replacement preserves every non-concept rule.
 * An empty concept list removes the generated block.
 */
export async function ensureConceptsPointer(
  workspacePath: string,
  concepts: RenderedConcept[] = [],
): Promise<void> {
  const agentsPath = path.resolve(workspacePath, AGENTS_FILENAME);
  let current: string;
  try {
    current = await fs.readFile(agentsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const markerPattern = new RegExp(
    `${CONCEPTS_DOC_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${CONCEPTS_DOC_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
  const withoutInventory = current.replace(markerPattern, '').trimEnd();
  if (concepts.length === 0) {
    if (withoutInventory !== current.trimEnd()) {
      await fs.writeFile(agentsPath, `${withoutInventory}\n`, { mode: 0o600 });
    }
    return;
  }
  const next = `${withoutInventory}\n\n${conceptsPointerSection(concepts)}\n`;
  if (next === current) return;
  await fs.writeFile(agentsPath, next, { mode: 0o600 });
}

/** File-extension for a stored image (mirrors the media store's mapping). */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

function refFileName(index: number, mime: string): string {
  return `ref-${index + 1}${IMAGE_EXTENSIONS[mime] ?? '.bin'}`;
}

/** Collapse newlines + JSON-quote so user text is always YAML-safe. */
function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' ').trim());
}

export async function activeConceptRows(agentAccountId: string): Promise<ConceptRow[]> {
  return pg<ConceptRow[]>`
    select id, agent_id, name, slug, description, instructions, created_at, updated_at
    from concepts
    where agent_id = ${agentAccountId} and deleted = false
    order by created_at asc, id asc
  `;
}

export async function conceptImageRows(conceptIds: string[]): Promise<ConceptImageRow[]> {
  if (conceptIds.length === 0) return [];
  return pg<ConceptImageRow[]>`
    select id, concept_id, url, local_path, sha256, mime, width, height,
           size_bytes, filename, position, created_at
    from concept_images
    where concept_id = any(${conceptIds}::uuid[])
    order by position asc, created_at asc, id asc
  `;
}

interface RenderedConcept {
  row: ConceptRow;
  /** Reference files that actually landed on disk, in position order. */
  files: { name: string; image: ConceptImageRow }[];
}

function conceptMarkdown(concept: RenderedConcept): string {
  const { row, files } = concept;
  const lines: string[] = [
    '---',
    `name: ${yamlString(row.name)}`,
    `description: ${yamlString(row.description ?? '')}`,
    '---',
    '',
    `# ${row.name}`,
    '',
  ];
  if (row.description?.trim()) {
    lines.push(row.description.trim(), '');
  }
  lines.push('## How to use these references', '');
  lines.push(
    row.instructions?.trim() ||
      'Use the reference images below as style references: pass their file paths to ' +
        '`image_generate` via its `images` parameter so generations match this aesthetic.',
    '',
  );
  lines.push('## Reference images', '');
  if (files.length === 0) {
    lines.push('(no reference images uploaded yet)', '');
  } else {
    for (const file of files) {
      const dims =
        file.image.width !== null && file.image.height !== null
          ? ` (${file.image.width}x${file.image.height})`
          : '';
      lines.push(`- ${CONCEPTS_DIRNAME}/${row.slug}/${file.name}${dims}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function indexMarkdown(rendered: RenderedConcept[]): string {
  const lines: string[] = [
    '# Concepts',
    '',
    'Concepts are named visual aesthetics taught to this agent by its owner. Each',
    'folder holds a CONCEPT.md brief plus the reference images that define the look.',
    '',
    '**When asked for work "in the style of <name>", read `concepts/<slug>/CONCEPT.md`',
    'and pass its reference image files to `image_generate` via the `images` parameter',
    '(edit/style-reference mode).**',
    '',
    '## Available concepts',
    '',
  ];
  for (const concept of rendered) {
    const description = concept.row.description?.trim();
    const imageNote = `${concept.files.length} reference image${concept.files.length === 1 ? '' : 's'}`;
    lines.push(
      `- **${concept.row.name}** (\`${CONCEPTS_DIRNAME}/${concept.row.slug}/\`) — ` +
        `${description ? `${description} — ` : ''}${imageNote}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Per-agent projection chain — serializes concurrent rebuilds in-process. */
const projectionChains = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = projectionChains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  projectionChains.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Rebuild `<workspace>/concepts/` for an agent from the DB. Safe to call after
 * every mutation; a missing workspace (not yet provisioned) is a documented
 * no-op — the projection happens on the next mutation once the agent exists
 * on the gateway.
 */
export async function projectAgentConcepts(
  agentAccountId: string,
): Promise<ConceptProjectionResult> {
  return serialized(agentAccountId, () => rebuildConceptsDir(agentAccountId));
}

/** Refresh all active concept inventories on API boot (deployment migration). */
export async function refreshActiveConceptInventories(): Promise<{
  agents: number;
  projected: number;
  failed: number;
}> {
  const rows = await pg<{ agent_id: string }[]>`
    select distinct agent_id from concepts where deleted = false order by agent_id
  `;
  let projected = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await projectAgentConcepts(row.agent_id);
      if (result.projected) projected += 1;
    } catch {
      failed += 1;
    }
  }
  return { agents: rows.length, projected, failed };
}

async function rebuildConceptsDir(agentAccountId: string): Promise<ConceptProjectionResult> {
  const [agent] = await pg<{ workspace_path: string | null }[]>`
    select workspace_path from agents where account_id = ${agentAccountId}
  `;
  if (!agent) return { projected: false, reason: 'agent_not_found' };
  if (!agent.workspace_path) return { projected: false, reason: 'not_provisioned' };

  const conceptRows = await activeConceptRows(agentAccountId);
  const imagesByConcept = new Map<string, ConceptImageRow[]>();
  for (const image of await conceptImageRows(conceptRows.map((row) => row.id))) {
    const list = imagesByConcept.get(image.concept_id) ?? [];
    list.push(image);
    imagesByConcept.set(image.concept_id, list);
  }

  const root = path.resolve(agent.workspace_path, CONCEPTS_DIRNAME);
  // Full rebuild: wipe and rewrite. The dir is entirely eden3-owned.
  await fs.rm(root, { recursive: true, force: true });
  if (conceptRows.length === 0) {
    await ensureConceptsPointer(agent.workspace_path, []);
    return { projected: true, concepts: 0, images: 0 };
  }
  await fs.mkdir(root, { recursive: true });

  let copiedImages = 0;
  const rendered: RenderedConcept[] = [];
  for (const row of conceptRows) {
    const dir = path.resolve(root, row.slug);
    // Slugs are validated kebab-case at the route, but never trust a path
    // segment that came out of the DB.
    if (!dir.startsWith(`${root}${path.sep}`)) continue;
    await fs.mkdir(dir, { recursive: true });

    const files: RenderedConcept['files'] = [];
    const images = imagesByConcept.get(row.id) ?? [];
    for (const [index, image] of images.entries()) {
      if (!image.local_path) continue;
      const name = refFileName(index, image.mime);
      try {
        await fs.copyFile(image.local_path, path.join(dir, name));
        files.push({ name, image });
        copiedImages += 1;
      } catch {
        // Source file missing from the media dir — keep the concept text
        // projection alive rather than failing the whole rebuild.
      }
    }

    const conceptDoc: RenderedConcept = { row, files };
    await fs.writeFile(path.join(dir, CONCEPT_FILENAME), conceptMarkdown(conceptDoc), {
      mode: 0o600,
    });
    rendered.push(conceptDoc);
  }

  await fs.writeFile(path.join(root, CONCEPTS_INDEX_FILENAME), indexMarkdown(rendered), {
    mode: 0o600,
  });
  // Project a compact, concrete inventory into the always-loaded AGENTS.md.
  // This makes concept selection proactive instead of relying on the model to
  // remember to discover INDEX.md before it asks the user for references.
  await ensureConceptsPointer(agent.workspace_path, rendered);
  return { projected: true, concepts: rendered.length, images: copiedImages };
}
