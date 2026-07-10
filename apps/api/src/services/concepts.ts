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
 * Always-loaded operating rules that point the agent AT the projected
 * `concepts/` dir. New agents get this baked into their AGENTS.md by the
 * gateway's workspace template (packages/gateway/workspace-templates/AGENTS.md);
 * agents provisioned before concepts existed have an AGENTS.md on disk that the
 * provisioner SKIPS (skip-if-exists), so {@link ensureConceptsPointer} backfills
 * the same pointer the first time an owner projects a concept. Marker-guarded
 * (mirrors the TOOLS.md skills manifest) so the append stays idempotent.
 */
const AGENTS_FILENAME = 'AGENTS.md';
const CONCEPTS_DOC_BEGIN = '<!-- EDEN3_CONCEPTS_BEGIN -->';
const CONCEPTS_DOC_END = '<!-- EDEN3_CONCEPTS_END -->';

/** The pointer body appended to an existing AGENTS.md (voice matches the template). */
function conceptsPointerSection(): string {
  return [
    CONCEPTS_DOC_BEGIN,
    '## Concepts (visual style references)',
    '',
    '- Concepts are named aesthetics your owner taught you, each a folder of reference images. If `concepts/INDEX.md` exists, read it — it lists every concept and how to apply it.',
    '- For work "in the style of <name>", open `concepts/<slug>/CONCEPT.md` and pass its reference-image file paths to `image_generate` via the `images` parameter.',
    '- When a concept clearly fits the request, default to its references without being asked.',
    CONCEPTS_DOC_END,
  ].join('\n');
}

/**
 * Ensure the agent's always-loaded AGENTS.md points at `concepts/`. No-op when
 * the file is missing (agent not fully provisioned — the provisioner writes it,
 * with the template section, on the next provision/repair) or when a concepts
 * pointer is already present (the baked-in template section is detected by its
 * `concepts/INDEX.md` reference, a prior append by the begin marker). Best-effort
 * and idempotent; safe to call after every projection.
 */
export async function ensureConceptsPointer(workspacePath: string): Promise<void> {
  const agentsPath = path.resolve(workspacePath, AGENTS_FILENAME);
  let current: string;
  try {
    current = await fs.readFile(agentsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  // Already wired — either the baked-in template section or a prior append.
  if (current.includes(CONCEPTS_DOC_BEGIN) || current.includes('concepts/INDEX.md')) return;
  const next = `${current.trimEnd()}\n\n${conceptsPointerSection()}\n`;
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
    return { projected: true, concepts: 0, images: 0 };
  }
  await fs.mkdir(root, { recursive: true });

  // Backfill the always-loaded pointer so existing agents (whose AGENTS.md the
  // provisioner skipped) discover concepts the moment their owner projects one.
  // Best-effort: a missing/unwritable AGENTS.md must not fail the projection.
  try {
    await ensureConceptsPointer(agent.workspace_path);
  } catch {
    // Pointer backfill is advisory — the next mutation (or a repair) retries.
  }

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
  return { projected: true, concepts: rendered.length, images: copiedImages };
}
