import {
  LocalMediaStore,
  normalizeMime,
  probeImageSize,
  resolveAgentByUsername,
  type MediaStore,
} from '@eden3/core';
import { pg, type Account, type Agent } from '@eden3/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { sendError } from '../errors';
import { isUniqueViolation, pgToIso } from '../route-helpers';
import {
  activeConceptRows,
  conceptImageRows,
  projectAgentConcepts,
  type ConceptImageRow,
  type ConceptRow,
} from '../services/concepts';
import { canManage } from './agents';

/**
 * Concepts API — per-agent reference-image aesthetics. Mounted under the
 * /agents prefix (see server.ts):
 *
 *   GET    /agents/:username/concepts                    — list (+image URLs)
 *   POST   /agents/:username/concepts                    — create (cap 20 → 429)
 *   PATCH  /agents/:username/concepts/:slug              — edit name/description/instructions
 *   DELETE /agents/:username/concepts/:slug              — soft-delete
 *   POST   /agents/:username/concepts/:slug/images       — base64-JSON upload (cap 8 → 429)
 *   PATCH  /agents/:username/concepts/:slug/images       — reorder {imageIds}
 *   DELETE /agents/:username/concepts/:slug/images/:id   — remove one image
 *
 * Visibility mirrors the agents routes: reads are open to anyone who can see
 * the agent (private agents 404 for non-managers); every mutation is
 * owner/admin only. After each mutation the agent's workspace `concepts/`
 * dir is rebuilt from the DB (services/concepts.ts) — best-effort: a
 * projection failure is logged, never fails the request, and the next
 * mutation self-heals (full rebuild).
 *
 * Upload storage: reference images go through the SAME content-addressed
 * media store the studio/media pipeline uses (@eden3/core LocalMediaStore →
 * MEDIA_DIR, served at /media/<sha256><ext>). They deliberately do NOT write
 * `media_assets` rows: that table is the media watcher's correlation ledger
 * for gateway-generated files (session/message/creation), not a general
 * asset registry — concept images have their own table with the fields the
 * feature needs.
 */

const MAX_CONCEPTS_PER_AGENT = 20;
const MAX_IMAGES_PER_CONCEPT = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** base64 inflates ~4/3; 12MB leaves room for the JSON envelope around 8MB. */
const UPLOAD_BODY_LIMIT_BYTES = 12 * 1024 * 1024;

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const usernameParamsSchema = z.object({ username: z.string().trim().min(1).max(200) });
const slugParamsSchema = usernameParamsSchema.extend({
  slug: z.string().trim().min(1).max(120),
});
const imageParamsSchema = slugParamsSchema.extend({
  imageId: z.string().uuid(),
});

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2_000).optional(),
  instructions: z.string().trim().max(4_000).optional(),
});

const patchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(2_000).optional(),
    instructions: z.string().trim().max(4_000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'no fields to update' });

const uploadBodySchema = z.object({
  filename: z.string().trim().min(1).max(300).optional(),
  mime: z.string().trim().min(1).max(200),
  /** Raw base64 (a data: URL prefix is tolerated and stripped). */
  dataBase64: z.string().min(1),
});

const reorderBodySchema = z.object({
  imageIds: z.array(z.string().uuid()).min(1).max(MAX_IMAGES_PER_CONCEPT),
});

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface ConceptImageDto {
  id: string;
  url: string;
  mime: string;
  width: number | null;
  height: number | null;
  filename: string | null;
  position: number;
  createdAt: string;
}

export interface ConceptDto {
  id: string;
  agentId: string;
  name: string;
  slug: string;
  description: string | null;
  instructions: string | null;
  images: ConceptImageDto[];
  createdAt: string;
  updatedAt: string;
}

function conceptImageDto(row: ConceptImageRow): ConceptImageDto {
  return {
    id: row.id,
    url: row.url,
    mime: row.mime,
    width: row.width,
    height: row.height,
    filename: row.filename,
    position: row.position,
    createdAt: pgToIso(row.created_at),
  };
}

function conceptDto(row: ConceptRow, images: ConceptImageRow[]): ConceptDto {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    instructions: row.instructions,
    images: images.map(conceptImageDto),
    createdAt: pgToIso(row.created_at),
    updatedAt: pgToIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedAgent {
  account: Account;
  agent: Agent;
  manager: boolean;
}

/**
 * Resolve the agent and enforce visibility. `write: true` additionally
 * requires manage rights (403 for signed-in non-owners on public agents;
 * private agents 404 to hide their existence, mirroring routes/agents.ts).
 */
async function resolveConceptAgent(
  req: FastifyRequest,
  reply: FastifyReply,
  username: string,
  opts: { write: boolean },
): Promise<ResolvedAgent | null> {
  const resolved = await resolveAgentByUsername(username);
  if (!resolved) {
    sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    return null;
  }
  const { account, agent } = resolved;
  const manager = canManage(req.account, account, agent);
  if (!agent.public && !manager) {
    sendError(reply, 404, 'agent_not_found', `No agent named "${username}"`);
    return null;
  }
  if (opts.write && !manager) {
    sendError(reply, 403, 'forbidden', 'Only the owner can manage this agent’s concepts');
    return null;
  }
  return { account, agent, manager };
}

async function activeConceptBySlug(agentId: string, slug: string): Promise<ConceptRow | null> {
  const [row] = await pg<ConceptRow[]>`
    select id, agent_id, name, slug, description, instructions, created_at, updated_at
    from concepts
    where agent_id = ${agentId} and slug = ${slug} and deleted = false
    limit 1
  `;
  return row ?? null;
}

async function conceptResponse(row: ConceptRow): Promise<{ concept: ConceptDto }> {
  const images = await conceptImageRows([row.id]);
  return { concept: conceptDto(row, images) };
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || 'concept';
}

/** First free kebab slug for the agent: base, base-2, base-3, … */
async function availableSlug(agentId: string, name: string): Promise<string | null> {
  const base = slugify(name);
  const taken = new Set(
    (
      await pg<{ slug: string }[]>`
        select slug from concepts where agent_id = ${agentId} and deleted = false
      `
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n <= MAX_CONCEPTS_PER_AGENT * 2; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** Best-effort workspace re-projection after a mutation (never fails the request). */
async function reproject(req: FastifyRequest, agentAccountId: string): Promise<void> {
  try {
    await projectAgentConcepts(agentAccountId);
  } catch (err) {
    req.log.warn({ err }, `concept projection failed for agent ${agentAccountId}`);
  }
}

function decodeUploadData(dataBase64: string): Buffer | null {
  const raw = dataBase64.includes(',') && dataBase64.trimStart().startsWith('data:')
    ? dataBase64.slice(dataBase64.indexOf(',') + 1)
    : dataBase64;
  try {
    const buffer = Buffer.from(raw, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

export interface ConceptsRoutesOptions {
  /** Media store override (tests). Default: LocalMediaStore over env MEDIA_DIR. */
  store?: MediaStore;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const conceptsRoutes: FastifyPluginAsync<ConceptsRoutesOptions> = async (app, opts) => {
  let lazyStore: MediaStore | null = opts.store ?? null;
  const getStore = (): MediaStore => {
    lazyStore ??= new LocalMediaStore();
    return lazyStore;
  };

  // ---- GET /agents/:username/concepts --------------------------------------
  app.get('/:username/concepts', async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const resolved = await resolveConceptAgent(req, reply, username, { write: false });
    if (!resolved) return reply;

    const rows = await activeConceptRows(resolved.account.id);
    const images = await conceptImageRows(rows.map((row) => row.id));
    const byConcept = new Map<string, ConceptImageRow[]>();
    for (const image of images) {
      const list = byConcept.get(image.concept_id) ?? [];
      list.push(image);
      byConcept.set(image.concept_id, list);
    }
    return {
      concepts: rows.map((row) => conceptDto(row, byConcept.get(row.id) ?? [])),
    };
  });

  // ---- POST /agents/:username/concepts --------------------------------------
  app.post('/:username/concepts', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const body = createBodySchema.parse(req.body);
    const resolved = await resolveConceptAgent(req, reply, username, { write: true });
    if (!resolved) return reply;

    const [quota] = await pg<{ count: number }[]>`
      select count(*)::int as count
      from concepts
      where agent_id = ${resolved.account.id} and deleted = false
    `;
    if ((quota?.count ?? 0) >= MAX_CONCEPTS_PER_AGENT) {
      return sendError(
        reply,
        429,
        'concept_quota_exceeded',
        `Concept limit reached (${MAX_CONCEPTS_PER_AGENT} per agent)`,
      );
    }

    const slug = await availableSlug(resolved.account.id, body.name);
    if (!slug) {
      return sendError(reply, 409, 'concept_slug_taken', 'No free slug for that name');
    }

    let row: ConceptRow | undefined;
    try {
      [row] = await pg<ConceptRow[]>`
        insert into concepts (agent_id, name, slug, description, instructions)
        values (${resolved.account.id}, ${body.name}, ${slug},
                ${body.description || null}, ${body.instructions || null})
        returning id, agent_id, name, slug, description, instructions, created_at, updated_at
      `;
    } catch (err) {
      // The partial unique index is the real slug guard under concurrency.
      if (isUniqueViolation(err)) {
        return sendError(reply, 409, 'concept_slug_taken', `Slug "${slug}" is already in use`);
      }
      throw err;
    }
    if (!row) throw new Error('concepts insert returned no row');

    await reproject(req, resolved.account.id);
    return reply.code(201).send(await conceptResponse(row));
  });

  // ---- PATCH /agents/:username/concepts/:slug --------------------------------
  app.patch('/:username/concepts/:slug', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username, slug } = slugParamsSchema.parse(req.params);
    const body = patchBodySchema.parse(req.body);
    const resolved = await resolveConceptAgent(req, reply, username, { write: true });
    if (!resolved) return reply;

    const concept = await activeConceptBySlug(resolved.account.id, slug);
    if (!concept) {
      return sendError(reply, 404, 'concept_not_found', `No concept "${slug}"`);
    }

    const [row] = await pg<ConceptRow[]>`
      update concepts
      set name = ${body.name ?? concept.name},
          description = ${body.description !== undefined ? body.description || null : concept.description},
          instructions = ${body.instructions !== undefined ? body.instructions || null : concept.instructions},
          updated_at = now()
      where id = ${concept.id}
      returning id, agent_id, name, slug, description, instructions, created_at, updated_at
    `;
    if (!row) throw new Error('concepts update returned no row');

    await reproject(req, resolved.account.id);
    return conceptResponse(row);
  });

  // ---- DELETE /agents/:username/concepts/:slug --------------------------------
  app.delete('/:username/concepts/:slug', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username, slug } = slugParamsSchema.parse(req.params);
    const resolved = await resolveConceptAgent(req, reply, username, { write: true });
    if (!resolved) return reply;

    const concept = await activeConceptBySlug(resolved.account.id, slug);
    if (!concept) {
      return sendError(reply, 404, 'concept_not_found', `No concept "${slug}"`);
    }
    await pg`update concepts set deleted = true, updated_at = now() where id = ${concept.id}`;

    await reproject(req, resolved.account.id);
    return { ok: true };
  });

  // ---- POST /agents/:username/concepts/:slug/images ---------------------------
  app.post(
    '/:username/concepts/:slug/images',
    { preHandler: app.requireAuth, bodyLimit: UPLOAD_BODY_LIMIT_BYTES },
    async (req, reply) => {
      const { username, slug } = slugParamsSchema.parse(req.params);
      const body = uploadBodySchema.parse(req.body);
      const resolved = await resolveConceptAgent(req, reply, username, { write: true });
      if (!resolved) return reply;

      const concept = await activeConceptBySlug(resolved.account.id, slug);
      if (!concept) {
        return sendError(reply, 404, 'concept_not_found', `No concept "${slug}"`);
      }

      const mime = normalizeMime(body.mime);
      if (!ALLOWED_IMAGE_MIMES.has(mime)) {
        return sendError(
          reply,
          400,
          'unsupported_image_type',
          `Unsupported image type "${mime}" — expected png, jpeg, or webp`,
        );
      }
      const buffer = decodeUploadData(body.dataBase64);
      if (!buffer) {
        return sendError(reply, 400, 'invalid_image_data', 'dataBase64 is not valid base64');
      }
      if (buffer.length > MAX_IMAGE_BYTES) {
        return sendError(
          reply,
          400,
          'image_too_large',
          `Image is ${buffer.length} bytes — the limit is ${MAX_IMAGE_BYTES} (8MB)`,
        );
      }
      const dims = probeImageSize(buffer);
      if (!dims) {
        return sendError(
          reply,
          400,
          'invalid_image_data',
          'File does not look like a valid png/jpeg/webp image',
        );
      }

      const [count] = await pg<{ count: number }[]>`
        select count(*)::int as count from concept_images where concept_id = ${concept.id}
      `;
      if ((count?.count ?? 0) >= MAX_IMAGES_PER_CONCEPT) {
        return sendError(
          reply,
          429,
          'concept_image_limit',
          `Reference-image limit reached (${MAX_IMAGES_PER_CONCEPT} per concept)`,
        );
      }

      const stored = await getStore().put(buffer, { mime });
      await pg`
        insert into concept_images (concept_id, url, local_path, sha256, mime,
                                    width, height, size_bytes, filename, position)
        values (${concept.id}, ${stored.url}, ${stored.localPath}, ${stored.sha256},
                ${stored.mime}, ${dims.width}, ${dims.height}, ${stored.sizeBytes},
                ${body.filename ?? null},
                (select coalesce(max(position), -1) + 1
                 from concept_images where concept_id = ${concept.id}))
      `;

      await reproject(req, resolved.account.id);
      return reply.code(201).send(await conceptResponse(concept));
    },
  );

  // ---- PATCH /agents/:username/concepts/:slug/images — reorder ---------------
  app.patch(
    '/:username/concepts/:slug/images',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { username, slug } = slugParamsSchema.parse(req.params);
      const body = reorderBodySchema.parse(req.body);
      const resolved = await resolveConceptAgent(req, reply, username, { write: true });
      if (!resolved) return reply;

      const concept = await activeConceptBySlug(resolved.account.id, slug);
      if (!concept) {
        return sendError(reply, 404, 'concept_not_found', `No concept "${slug}"`);
      }

      const current = await conceptImageRows([concept.id]);
      const currentIds = new Set(current.map((row) => row.id));
      const requested = body.imageIds;
      const exactPermutation =
        requested.length === currentIds.size &&
        new Set(requested).size === requested.length &&
        requested.every((id) => currentIds.has(id));
      if (!exactPermutation) {
        return sendError(
          reply,
          400,
          'invalid_image_order',
          'imageIds must contain each of the concept’s image ids exactly once',
        );
      }

      await pg.begin(async (sql) => {
        for (const [position, id] of requested.entries()) {
          await sql`update concept_images set position = ${position} where id = ${id}`;
        }
        await sql`update concepts set updated_at = now() where id = ${concept.id}`;
      });

      await reproject(req, resolved.account.id);
      return conceptResponse(concept);
    },
  );

  // ---- DELETE /agents/:username/concepts/:slug/images/:imageId ---------------
  app.delete(
    '/:username/concepts/:slug/images/:imageId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { username, slug, imageId } = imageParamsSchema.parse(req.params);
      const resolved = await resolveConceptAgent(req, reply, username, { write: true });
      if (!resolved) return reply;

      const concept = await activeConceptBySlug(resolved.account.id, slug);
      if (!concept) {
        return sendError(reply, 404, 'concept_not_found', `No concept "${slug}"`);
      }

      const deleted = await pg<{ id: string }[]>`
        delete from concept_images
        where id = ${imageId} and concept_id = ${concept.id}
        returning id
      `;
      if (deleted.length === 0) {
        return sendError(reply, 404, 'concept_image_not_found', `No image "${imageId}"`);
      }
      await pg`update concepts set updated_at = now() where id = ${concept.id}`;

      await reproject(req, resolved.account.id);
      return conceptResponse(concept);
    },
  );
};
