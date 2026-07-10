import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resetEnvCache } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ConceptDto } from '../src/routes/concepts';
import { buildServer } from '../src/server';
import {
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertUserAccount,
  makeFakeCronSync,
  makeFakeProvisioner,
  makeFakeSkillSync,
  makeFakeToolSync,
  makeMarker,
} from './fixtures';

loadRootEnv();

/**
 * Concepts API against live Postgres with a FAKE gateway provisioner.
 *
 * TABLE BOOTSTRAP: migration 0016 (concepts + concept_images) is committed in
 * this branch but deliberately NOT applied — the main session owns live DBs
 * and applies real migrations. So this suite creates the tables itself with
 * `create table if not exists` DDL that matches
 * packages/db/migrations/0016_harsh_avengers.sql exactly; once the migration
 * is applied for real, this bootstrap becomes a no-op (nothing is dropped).
 */

const CONCEPTS_DDL = [
  `CREATE TABLE IF NOT EXISTS "concepts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "agent_id" uuid NOT NULL,
    "name" text NOT NULL,
    "slug" text NOT NULL,
    "description" text,
    "instructions" text,
    "deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "concept_images" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "concept_id" uuid NOT NULL,
    "url" text NOT NULL,
    "local_path" text,
    "sha256" text NOT NULL,
    "mime" text NOT NULL,
    "width" integer,
    "height" integer,
    "size_bytes" bigint,
    "filename" text,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `DO $$ BEGIN
    ALTER TABLE "concept_images" ADD CONSTRAINT "concept_images_concept_id_concepts_id_fk"
      FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE "concepts" ADD CONSTRAINT "concepts_agent_id_accounts_id_fk"
      FOREIGN KEY ("agent_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE INDEX IF NOT EXISTS "concept_images_concept_position_idx" ON "concept_images" USING btree ("concept_id","position")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "concepts_agent_slug_uq" ON "concepts" USING btree ("agent_id","slug") WHERE "concepts"."deleted" = false`,
  `CREATE INDEX IF NOT EXISTS "concepts_agent_created_idx" ON "concepts" USING btree ("agent_id","created_at" DESC NULLS LAST)`,
];

/** 1x1 transparent PNG. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** Same pixels, different content address (trailing byte is ignored by header probes). */
const PNG_1PX_VARIANT = Buffer.concat([PNG_1PX, Buffer.from([0x00])]);

const marker = makeMarker('cptapi');
let app: FastifyInstance;
let tmpRoot = '';
let workspaceDir = ''; // the "muse" agent's workspace
let capWorkspaceDir = ''; // separate workspace so cap-agent projections can't clobber muse's
let mediaDir = '';

let ownerId = '';
let strangerId = '';
let agentId = ''; // public, provisioned (workspace_path = workspaceDir)
let capAgentId = ''; // public, used only for the 20-concept cap test
let pendingAgentId = ''; // public, never provisioned (workspace_path null)
const agentName = `${marker}_muse`;
const capAgentName = `${marker}_full`;
const privateAgentName = `${marker}_ghost`;
const pendingAgentName = `${marker}_dormant`;

interface ConceptsPage {
  concepts: ConceptDto[];
}

function uploadBody(buffer: Buffer, mime = 'image/png', filename = 'ref.png') {
  return { filename, mime, dataBase64: buffer.toString('base64') };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  for (const statement of CONCEPTS_DDL) {
    await pg.unsafe(statement);
  }

  tmpRoot = await mkdtemp(path.join(tmpdir(), 'eden3-concepts-'));
  workspaceDir = path.join(tmpRoot, 'workspace-muse');
  capWorkspaceDir = path.join(tmpRoot, 'workspace-cap');
  mediaDir = path.join(tmpRoot, 'media');
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(capWorkspaceDir, { recursive: true });
  await fs.mkdir(mediaDir, { recursive: true });
  // The upload route stores through @eden3/core LocalMediaStore (env MEDIA_DIR);
  // point it at a temp dir before the server (and its /media static mount) boots.
  process.env.MEDIA_DIR = mediaDir;
  resetEnvCache();

  ownerId = await insertUserAccount(`${marker}_owner`);
  strangerId = await insertUserAccount(`${marker}_str`);
  agentId = await insertAgentAccount(agentName, {
    ownerId,
    name: 'Muse',
    public: true,
    openclawId: agentName,
    workspacePath: workspaceDir,
    provisionStatus: 'ready',
  });
  capAgentId = await insertAgentAccount(capAgentName, {
    ownerId,
    name: 'Full Agent',
    public: true,
    openclawId: capAgentName,
    workspacePath: capWorkspaceDir,
    provisionStatus: 'ready',
  });
  await insertAgentAccount(privateAgentName, {
    ownerId,
    name: 'Ghost',
    public: false,
  });
  pendingAgentId = await insertAgentAccount(pendingAgentName, {
    ownerId,
    name: 'Dormant',
    public: true,
    provisionStatus: 'pending',
  });

  app = await buildServer({
    gateway: null,
    provisioning: {
      provisioner: makeFakeProvisioner(),
      cronSync: makeFakeCronSync(),
      skillSync: makeFakeSkillSync(),
      toolSync: makeFakeToolSync(),
    },
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app?.close();
  // Local cleanup (fixtures.ts stays concepts-agnostic until the migration
  // is applied everywhere): cascade wipes concept_images.
  const ids = (
    await pg<{ id: string }[]>`select id from accounts where username like ${`${marker}%`}`
  ).map((row) => row.id);
  if (ids.length > 0) {
    await pg`delete from concepts where agent_id = any(${ids}::uuid[])`;
  }
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CRUD + authz
// ---------------------------------------------------------------------------

describe('POST /agents/:username/concepts', () => {
  it('rejects anonymous (401) and strangers (403); private agents 404', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts`,
      payload: { name: 'Nope' },
    });
    expect(anon.statusCode).toBe(401);

    const stranger = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts`,
      headers: { cookie: devCookie(strangerId) },
      payload: { name: 'Nope' },
    });
    expect(stranger.statusCode).toBe(403);

    const privateAgent = await app.inject({
      method: 'POST',
      url: `/agents/${privateAgentName}/concepts`,
      headers: { cookie: devCookie(strangerId) },
      payload: { name: 'Nope' },
    });
    expect(privateAgent.statusCode).toBe(404);
  });

  it('creates a concept with a kebab slug and projects CONCEPT.md + INDEX.md', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts`,
      headers: { cookie: devCookie(ownerId) },
      payload: {
        name: 'Sunset Watercolor!',
        description: 'Loose washes, warm dusk palette.',
        instructions: 'Keep edges soft; favor orange-to-violet gradients.',
      },
    });
    expect(res.statusCode).toBe(201);
    const { concept } = res.json() as { concept: ConceptDto };
    expect(concept.slug).toBe('sunset-watercolor');
    expect(concept.name).toBe('Sunset Watercolor!');
    expect(concept.images).toEqual([]);

    const conceptMd = await fs.readFile(
      path.join(workspaceDir, 'concepts', 'sunset-watercolor', 'CONCEPT.md'),
      'utf8',
    );
    expect(conceptMd).toContain('name: "Sunset Watercolor!"');
    expect(conceptMd).toContain('Keep edges soft');
    const indexMd = await fs.readFile(path.join(workspaceDir, 'concepts', 'INDEX.md'), 'utf8');
    expect(indexMd).toContain('Sunset Watercolor!');
    expect(indexMd).toContain('in the style of');
    expect(indexMd).toContain('`images` parameter');
  });

  it('deduplicates slugs per agent (base, base-2, …)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts`,
      headers: { cookie: devCookie(ownerId) },
      payload: { name: 'Sunset Watercolor' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { concept: ConceptDto }).concept.slug).toBe('sunset-watercolor-2');
  });

  it('validates the name length', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts`,
      headers: { cookie: devCookie(ownerId) },
      payload: { name: 'x'.repeat(81) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforces the 20-concepts-per-agent cap with 429', async () => {
    for (let i = 0; i < 20; i += 1) {
      await pg`
        insert into concepts (agent_id, name, slug)
        values (${capAgentId}, ${`Filler ${i}`}, ${`filler-${i}`})
      `;
    }
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${capAgentName}/concepts`,
      headers: { cookie: devCookie(ownerId) },
      payload: { name: 'One Too Many' },
    });
    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: { code: string } }).error.code).toBe('concept_quota_exceeded');
  });

  it('creates (without projecting) for an unprovisioned agent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${pendingAgentName}/concepts`,
      headers: { cookie: devCookie(ownerId) },
      payload: { name: 'Waiting Room' },
    });
    expect(res.statusCode).toBe(201);
    // No workspace_path — the projection is skipped (re-projected on the next
    // mutation after provisioning) and nothing crashes.
    const rows = await pg<{ count: number }[]>`
      select count(*)::int as count from concepts
      where agent_id = ${pendingAgentId} and deleted = false
    `;
    expect(rows[0]!.count).toBe(1);
  });
});

describe('GET /agents/:username/concepts', () => {
  it('lists concepts (with images) for anyone who can see the agent', async () => {
    const res = await app.inject({ method: 'GET', url: `/agents/${agentName}/concepts` });
    expect(res.statusCode).toBe(200);
    const { concepts } = res.json() as ConceptsPage;
    expect(concepts.map((c) => c.slug)).toEqual(['sunset-watercolor', 'sunset-watercolor-2']);
  });

  it('404s a private agent for strangers and anonymous, but lists for the owner', async () => {
    const anon = await app.inject({
      method: 'GET',
      url: `/agents/${privateAgentName}/concepts`,
    });
    expect(anon.statusCode).toBe(404);

    const stranger = await app.inject({
      method: 'GET',
      url: `/agents/${privateAgentName}/concepts`,
      headers: { cookie: devCookie(strangerId) },
    });
    expect(stranger.statusCode).toBe(404);

    const owner = await app.inject({
      method: 'GET',
      url: `/agents/${privateAgentName}/concepts`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(owner.statusCode).toBe(200);
    expect((owner.json() as ConceptsPage).concepts).toEqual([]);
  });
});

describe('PATCH + DELETE /agents/:username/concepts/:slug', () => {
  it('lets the owner edit fields and re-projects the workspace', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentName}/concepts/sunset-watercolor`,
      headers: { cookie: devCookie(ownerId) },
      payload: { instructions: 'Updated: lean on cadmium orange.' },
    });
    expect(res.statusCode).toBe(200);
    const { concept } = res.json() as { concept: ConceptDto };
    expect(concept.instructions).toBe('Updated: lean on cadmium orange.');

    const conceptMd = await fs.readFile(
      path.join(workspaceDir, 'concepts', 'sunset-watercolor', 'CONCEPT.md'),
      'utf8',
    );
    expect(conceptMd).toContain('cadmium orange');
  });

  it('blocks strangers from PATCH (403) and unknown slugs 404', async () => {
    const stranger = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentName}/concepts/sunset-watercolor`,
      headers: { cookie: devCookie(strangerId) },
      payload: { name: 'Hijacked' },
    });
    expect(stranger.statusCode).toBe(403);

    const missing = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentName}/concepts/never-existed`,
      headers: { cookie: devCookie(ownerId) },
      payload: { name: 'Ghost' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('soft-deletes, removes the folder + INDEX entry, and frees the slug', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${agentName}/concepts/sunset-watercolor-2`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(res.statusCode).toBe(200);

    expect(
      await fileExists(path.join(workspaceDir, 'concepts', 'sunset-watercolor-2')),
    ).toBe(false);
    const indexMd = await fs.readFile(path.join(workspaceDir, 'concepts', 'INDEX.md'), 'utf8');
    expect(indexMd).not.toContain('sunset-watercolor-2');
    expect(indexMd).toContain('sunset-watercolor');

    // Slug freed by the partial unique index: re-creating the same name
    // lands back on the -2 suffix (base is still taken by the live concept).
    const recreate = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts`,
      headers: { cookie: devCookie(ownerId) },
      payload: { name: 'Sunset Watercolor' },
    });
    expect(recreate.statusCode).toBe(201);
    expect((recreate.json() as { concept: ConceptDto }).concept.slug).toBe(
      'sunset-watercolor-2',
    );
    // Clean up the recreated row so later projection assertions stay focused.
    await app.inject({
      method: 'DELETE',
      url: `/agents/${agentName}/concepts/sunset-watercolor-2`,
      headers: { cookie: devCookie(ownerId) },
    });
  });
});

// ---------------------------------------------------------------------------
// Image upload / reorder / delete
// ---------------------------------------------------------------------------

describe('concept images', () => {
  it('uploads a png through the media store and copies it into the workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images`,
      headers: { cookie: devCookie(ownerId) },
      payload: uploadBody(PNG_1PX, 'image/png', 'dusk.png'),
    });
    expect(res.statusCode).toBe(201);
    const { concept } = res.json() as { concept: ConceptDto };
    expect(concept.images).toHaveLength(1);
    const image = concept.images[0]!;
    expect(image.url).toMatch(/^\/media\/[0-9a-f]{64}\.png$/);
    expect(image.width).toBe(1);
    expect(image.height).toBe(1);
    expect(image.filename).toBe('dusk.png');

    // Content-addressed copy exists in MEDIA_DIR…
    const sha = image.url.split('/').pop()!;
    expect(await fileExists(path.join(mediaDir, sha))).toBe(true);
    // …and the projection copied the bytes into the workspace as ref-1.png.
    const projected = await fs.readFile(
      path.join(workspaceDir, 'concepts', 'sunset-watercolor', 'ref-1.png'),
    );
    expect(projected.equals(PNG_1PX)).toBe(true);
    const conceptMd = await fs.readFile(
      path.join(workspaceDir, 'concepts', 'sunset-watercolor', 'CONCEPT.md'),
      'utf8',
    );
    expect(conceptMd).toContain('concepts/sunset-watercolor/ref-1.png (1x1)');
  });

  it('rejects unsupported mime types, oversized files, and non-image bytes', async () => {
    const gif = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images`,
      headers: { cookie: devCookie(ownerId) },
      payload: uploadBody(PNG_1PX, 'image/gif'),
    });
    expect(gif.statusCode).toBe(400);
    expect((gif.json() as { error: { code: string } }).error.code).toBe(
      'unsupported_image_type',
    );

    const oversized = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images`,
      headers: { cookie: devCookie(ownerId) },
      payload: uploadBody(Buffer.alloc(8 * 1024 * 1024 + 1), 'image/png'),
    });
    expect(oversized.statusCode).toBe(400);
    expect((oversized.json() as { error: { code: string } }).error.code).toBe('image_too_large');

    const garbage = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images`,
      headers: { cookie: devCookie(ownerId) },
      payload: uploadBody(Buffer.from('definitely not an image'), 'image/png'),
    });
    expect(garbage.statusCode).toBe(400);
    expect((garbage.json() as { error: { code: string } }).error.code).toBe('invalid_image_data');
  });

  it('blocks strangers and anonymous uploads', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images`,
      payload: uploadBody(PNG_1PX),
    });
    expect(anon.statusCode).toBe(401);

    const stranger = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images`,
      headers: { cookie: devCookie(strangerId) },
      payload: uploadBody(PNG_1PX),
    });
    expect(stranger.statusCode).toBe(403);
  });

  it('reorders images and re-projects ref-N files in the new order', async () => {
    const second = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images`,
      headers: { cookie: devCookie(ownerId) },
      payload: uploadBody(PNG_1PX_VARIANT, 'image/png', 'dawn.png'),
    });
    expect(second.statusCode).toBe(201);
    const images = (second.json() as { concept: ConceptDto }).concept.images;
    expect(images).toHaveLength(2);
    expect(images.map((i) => i.filename)).toEqual(['dusk.png', 'dawn.png']);

    const reversed = [images[1]!.id, images[0]!.id];
    const reorder = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images`,
      headers: { cookie: devCookie(ownerId) },
      payload: { imageIds: reversed },
    });
    expect(reorder.statusCode).toBe(200);
    const after = (reorder.json() as { concept: ConceptDto }).concept.images;
    expect(after.map((i) => i.filename)).toEqual(['dawn.png', 'dusk.png']);
    expect(after.map((i) => i.position)).toEqual([0, 1]);

    // ref-1 is now the variant (larger by one trailing byte).
    const ref1 = await fs.readFile(
      path.join(workspaceDir, 'concepts', 'sunset-watercolor', 'ref-1.png'),
    );
    expect(ref1.equals(PNG_1PX_VARIANT)).toBe(true);
  });

  it('rejects a reorder that is not an exact permutation', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images`,
      headers: { cookie: devCookie(ownerId) },
      payload: { imageIds: ['00000000-0000-4000-8000-000000000000'] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_image_order');
  });

  it('enforces the 8-images-per-concept cap with 429', async () => {
    // 2 already uploaded; pad with distinct content up to the cap of 8.
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/agents/${agentName}/concepts/sunset-watercolor/images`,
        headers: { cookie: devCookie(ownerId) },
        payload: uploadBody(
          Buffer.concat([PNG_1PX, Buffer.from([0x10 + i])]),
          'image/png',
          `pad-${i}.png`,
        ),
      });
      expect(res.statusCode).toBe(201);
    }
    const overflow = await app.inject({
      method: 'POST',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images`,
      headers: { cookie: devCookie(ownerId) },
      payload: uploadBody(Buffer.concat([PNG_1PX, Buffer.from([0xff])])),
    });
    expect(overflow.statusCode).toBe(429);
    expect((overflow.json() as { error: { code: string } }).error.code).toBe(
      'concept_image_limit',
    );
  });

  it('deletes an image and re-projects without it', async () => {
    const list = await app.inject({ method: 'GET', url: `/agents/${agentName}/concepts` });
    const concept = (list.json() as ConceptsPage).concepts.find(
      (c) => c.slug === 'sunset-watercolor',
    )!;
    expect(concept.images).toHaveLength(8);
    const target = concept.images[concept.images.length - 1]!;

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images/${target.id}`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { concept: ConceptDto }).concept.images).toHaveLength(7);

    expect(
      await fileExists(path.join(workspaceDir, 'concepts', 'sunset-watercolor', 'ref-8.png')),
    ).toBe(false);

    const missing = await app.inject({
      method: 'DELETE',
      url: `/agents/${agentName}/concepts/sunset-watercolor/images/${target.id}`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('removes the whole concepts dir when the last concept is deleted', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${agentName}/concepts/sunset-watercolor`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(res.statusCode).toBe(200);
    expect(await fileExists(path.join(workspaceDir, 'concepts'))).toBe(false);
  });
});
