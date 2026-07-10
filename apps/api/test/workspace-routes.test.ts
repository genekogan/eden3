import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadRootEnv, pg } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
 * Workspace browser routes (/agents/:username/workspace*) against live
 * Postgres with REAL temp-dir workspaces — the whole point is exercising the
 * path jail (traversal, symlink escape, neighbor workspaces) on a real fs.
 */

const marker = makeMarker('wsapi');
let app: FastifyInstance;

let ownerId = '';
let strangerId = '';
const agentFiles = `${marker}_files`; // public, provisioned, populated workspace
const agentGhost = `${marker}_ghost`; // private, provisioned
const agentBare = `${marker}_bare`; // public, NOT provisioned
const agentVoid = `${marker}_void`; // provisioned but workspace dir never created
const agentBig = `${marker}_big`; // workspace with >2000 entries

let parentDir = ''; // holds the workspaces + an outside file (escape target)
let wsFiles = '';
let wsNeighbor = '';

const NOTES_CONTENT = '# Notes\nhello world\n';
const notesSha = createHash('sha256').update(NOTES_CONTENT).digest('hex');
const WRONG_SHA = 'a'.repeat(64);

interface TreeBody {
  entries: { path: string; kind: 'file' | 'dir'; sizeBytes: number; mtime: string; sha256?: string }[];
  truncated: boolean;
}
interface TextFileBody {
  file: { path: string; kind: 'text'; content: string; sizeBytes: number; mtime: string; sha256: string };
}
interface BinaryFileBody {
  file: { path: string; kind: 'binary'; sizeBytes: number; mtime: string; content?: string };
}
interface ConflictBody {
  error: { code: string };
  currentSha256: string | null;
  currentMtime: string | null;
}

function treeUrl(agent: string): string {
  return `/agents/${agent}/workspace`;
}
function fileUrl(agent: string, p: string): string {
  return `/agents/${agent}/workspace/file?path=${encodeURIComponent(p)}`;
}
function downloadUrl(agent: string, p: string): string {
  return `/agents/${agent}/workspace/download?path=${encodeURIComponent(p)}`;
}

const asOwner = { cookie: devCookie('') }; // filled in beforeAll
const asStranger = { cookie: devCookie('') };

beforeAll(async () => {
  ownerId = await insertUserAccount(`${marker}_owner`);
  strangerId = await insertUserAccount(`${marker}_str`);
  asOwner.cookie = devCookie(ownerId);
  asStranger.cookie = devCookie(strangerId);

  parentDir = await mkdtemp(path.join(tmpdir(), `${marker}-`));
  wsFiles = path.join(parentDir, 'workspace-files-agent');
  wsNeighbor = path.join(parentDir, 'workspace-neighbor-agent');
  const wsBig = path.join(parentDir, 'workspace-big-agent');

  // Populated workspace: visible files, hidden/internal names, binaries,
  // and symlinks that try to escape the jail.
  await mkdir(path.join(wsFiles, 'art'), { recursive: true });
  await mkdir(path.join(wsFiles, 'memory', 'users'), { recursive: true });
  await mkdir(path.join(wsFiles, 'data'), { recursive: true });
  await mkdir(path.join(wsFiles, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(wsFiles, 'notes.md'), NOTES_CONTENT);
  await writeFile(path.join(wsFiles, 'art', 'plan.md'), 'make art\n');
  await writeFile(path.join(wsFiles, 'memory', 'users', 'alice.md'), '# alice\n');
  await writeFile(path.join(wsFiles, 'data', 'blob.bin'), Buffer.from([0x00, 0x01, 0xff, 0x00, 0x7f]));
  await writeFile(path.join(wsFiles, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]));
  await writeFile(path.join(wsFiles, 'big-text.md'), 'a'.repeat(512 * 1024 + 1));
  await writeFile(path.join(wsFiles, '.secret'), 'dot secret');
  await writeFile(path.join(wsFiles, 'openclaw-workspace-state.json'), '{"setupCompletedAt":"x"}');
  await writeFile(path.join(wsFiles, 'BOOTSTRAP.md'), 'bootstrap ritual');
  await writeFile(path.join(wsFiles, 'node_modules', 'pkg', 'index.js'), 'console.log(1)');
  // Sparse >100MB file — instant to create, still stat()s over the limit.
  await writeFile(path.join(wsFiles, 'huge.bin'), '');
  await truncate(path.join(wsFiles, 'huge.bin'), 101 * 1024 * 1024);

  // Escape targets: a file outside every workspace + a neighboring agent's
  // workspace with a sentinel secret.
  await writeFile(path.join(parentDir, 'outside.txt'), 'OUTSIDE SECRET');
  await mkdir(wsNeighbor, { recursive: true });
  await writeFile(path.join(wsNeighbor, 'secret.txt'), 'NEIGHBOR SECRET');
  await symlink(path.join(parentDir, 'outside.txt'), path.join(wsFiles, 'escape-file'));
  await symlink(wsNeighbor, path.join(wsFiles, 'escape-dir'));
  await symlink(path.join(wsFiles, '.secret'), path.join(wsFiles, 'alias.md'));

  // Oversized workspace for the listing cap.
  await mkdir(path.join(wsBig, 'many'), { recursive: true });
  await Promise.all(
    Array.from({ length: 2005 }, (_, i) =>
      writeFile(path.join(wsBig, 'many', `f${String(i).padStart(4, '0')}.txt`), 'x'),
    ),
  );

  await insertAgentAccount(agentFiles, {
    ownerId,
    name: 'Files Agent',
    public: true,
    openclawId: agentFiles,
    workspacePath: wsFiles,
    provisionStatus: 'ready',
  });
  await insertAgentAccount(agentGhost, {
    ownerId,
    name: 'Ghost Agent',
    public: false,
    openclawId: agentGhost,
    workspacePath: wsFiles,
    provisionStatus: 'ready',
  });
  await insertAgentAccount(agentBare, { ownerId, name: 'Bare Agent', public: true });
  await insertAgentAccount(agentVoid, {
    ownerId,
    name: 'Void Agent',
    public: true,
    openclawId: agentVoid,
    workspacePath: path.join(parentDir, 'never-created'),
    provisionStatus: 'ready',
  });
  await insertAgentAccount(agentBig, {
    ownerId,
    name: 'Big Agent',
    public: true,
    openclawId: agentBig,
    workspacePath: wsBig,
    provisionStatus: 'ready',
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
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
  if (parentDir !== '') await rm(parentDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Auth / visibility (mirrors the memory-route gates)
// ---------------------------------------------------------------------------

describe('workspace auth', () => {
  it('401s anonymous requests on every route', async () => {
    const probes = [
      { method: 'GET' as const, url: treeUrl(agentFiles) },
      { method: 'GET' as const, url: fileUrl(agentFiles, 'notes.md') },
      { method: 'GET' as const, url: downloadUrl(agentFiles, 'notes.md') },
      { method: 'GET' as const, url: `${treeUrl(agentFiles)}/export` },
      {
        method: 'PUT' as const,
        url: `${treeUrl(agentFiles)}/file`,
        payload: { path: 'notes.md', content: 'x', baseSha256: 'new' },
      },
    ];
    for (const probe of probes) {
      const res = await app.inject(probe);
      expect(res.statusCode, probe.url).toBe(401);
    }
  });

  it('403s strangers on a public agent (read, export, and write)', async () => {
    expect(
      (await app.inject({ method: 'GET', url: treeUrl(agentFiles), headers: asStranger })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${treeUrl(agentFiles)}/export`,
          headers: asStranger,
        })
      ).statusCode,
    ).toBe(403);
    const put = await app.inject({
      method: 'PUT',
      url: `${treeUrl(agentFiles)}/file`,
      headers: asStranger,
      payload: { path: 'pwned.md', content: 'x', baseSha256: 'new' },
    });
    expect(put.statusCode).toBe(403);
  });

  it('404s strangers on a private agent (existence hidden), 200 for the owner', async () => {
    expect(
      (await app.inject({ method: 'GET', url: treeUrl(agentGhost), headers: asStranger })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: treeUrl(agentGhost), headers: asOwner })).statusCode,
    ).toBe(200);
  });

  it('409s before the agent is provisioned and 404s unknown agents', async () => {
    const bare = await app.inject({ method: 'GET', url: treeUrl(agentBare), headers: asOwner });
    expect(bare.statusCode).toBe(409);
    expect((bare.json() as { error: { code: string } }).error.code).toBe('workspace_unavailable');
    expect(
      (await app.inject({ method: 'GET', url: treeUrl(`${marker}_nope`), headers: asOwner }))
        .statusCode,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tree listing
// ---------------------------------------------------------------------------

describe('GET /agents/:username/workspace (tree)', () => {
  it('lists files + dirs with size/mtime/sha256, hiding dotfiles and runtime internals', async () => {
    const res = await app.inject({ method: 'GET', url: treeUrl(agentFiles), headers: asOwner });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TreeBody;
    const paths = body.entries.map((e) => e.path);

    expect(paths).toContain('notes.md');
    expect(paths).toContain('art');
    expect(paths).toContain('art/plan.md');
    expect(paths).toContain('memory/users/alice.md');
    expect(paths).toContain('data/blob.bin');

    // Hidden: dotfiles, runtime state, bootstrap, dependency dirs, symlinks.
    expect(paths).not.toContain('.secret');
    expect(paths).not.toContain('openclaw-workspace-state.json');
    expect(paths).not.toContain('BOOTSTRAP.md');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths).not.toContain('escape-file');
    expect(paths).not.toContain('escape-dir');
    expect(paths).not.toContain('alias.md');

    const notes = body.entries.find((e) => e.path === 'notes.md')!;
    expect(notes.kind).toBe('file');
    expect(notes.sizeBytes).toBe(Buffer.byteLength(NOTES_CONTENT));
    expect(Number.isNaN(Date.parse(notes.mtime))).toBe(false);
    expect(notes.sha256).toBe(notesSha);

    const art = body.entries.find((e) => e.path === 'art')!;
    expect(art.kind).toBe('dir');

    // >1MB files carry no sha256 (huge.bin is 101MB sparse).
    const huge = body.entries.find((e) => e.path === 'huge.bin')!;
    expect(huge.sha256).toBeUndefined();
    expect(body.truncated).toBe(false);
  });

  it('treats a missing workspace dir as empty, not an error', async () => {
    const res = await app.inject({ method: 'GET', url: treeUrl(agentVoid), headers: asOwner });
    expect(res.statusCode).toBe(200);
    expect(res.json() as TreeBody).toEqual({ entries: [], truncated: false });
  });

  it('caps the listing at 2,000 entries and reports truncated', async () => {
    const res = await app.inject({ method: 'GET', url: treeUrl(agentBig), headers: asOwner });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TreeBody;
    expect(body.entries).toHaveLength(2000);
    expect(body.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// File content
// ---------------------------------------------------------------------------

describe('GET /agents/:username/workspace/file', () => {
  it('returns text content + sha256 for UTF-8 files', async () => {
    const res = await app.inject({
      method: 'GET',
      url: fileUrl(agentFiles, 'notes.md'),
      headers: asOwner,
    });
    expect(res.statusCode).toBe(200);
    const { file } = res.json() as TextFileBody;
    expect(file.kind).toBe('text');
    expect(file.content).toBe(NOTES_CONTENT);
    expect(file.sha256).toBe(notesSha);
    expect(Number.isNaN(Date.parse(file.mtime))).toBe(false);

    const nested = await app.inject({
      method: 'GET',
      url: fileUrl(agentFiles, 'memory/users/alice.md'),
      headers: asOwner,
    });
    expect((nested.json() as TextFileBody).file.content).toBe('# alice\n');
  });

  it('returns binary metadata (no content) for non-UTF-8 and oversized files', async () => {
    const bin = await app.inject({
      method: 'GET',
      url: fileUrl(agentFiles, 'data/blob.bin'),
      headers: asOwner,
    });
    expect(bin.statusCode).toBe(200);
    const binFile = (bin.json() as BinaryFileBody).file;
    expect(binFile.kind).toBe('binary');
    expect(binFile.sizeBytes).toBe(5);
    expect(binFile.content).toBeUndefined();

    // Valid UTF-8 but over the 512KB text ceiling -> binary.
    const big = await app.inject({
      method: 'GET',
      url: fileUrl(agentFiles, 'big-text.md'),
      headers: asOwner,
    });
    expect((big.json() as BinaryFileBody).file.kind).toBe('binary');
  });

  it('404s missing paths, directories, and hidden/internal names', async () => {
    for (const p of [
      'nope.md',
      'art', // directory, not a file
      '.secret',
      'openclaw-workspace-state.json',
      'BOOTSTRAP.md',
      'node_modules/pkg/index.js',
    ]) {
      const res = await app.inject({ method: 'GET', url: fileUrl(agentFiles, p), headers: asOwner });
      expect(res.statusCode, p).toBe(404);
      expect(res.body, p).not.toContain('dot secret');
      expect(res.body, p).not.toContain('setupCompletedAt');
    }
  });
});

// ---------------------------------------------------------------------------
// Download + export
// ---------------------------------------------------------------------------

describe('GET /agents/:username/workspace/download', () => {
  it('streams raw bytes with attachment disposition and a real content type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: downloadUrl(agentFiles, 'notes.md'),
      headers: asOwner,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('notes.md');
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toBe(NOTES_CONTENT);

    const png = await app.inject({
      method: 'GET',
      url: downloadUrl(agentFiles, 'pic.png'),
      headers: asOwner,
    });
    expect(png.headers['content-type']).toBe('image/png');
  });

  it('404s hidden names and 413s files over the 100MB cap', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: downloadUrl(agentFiles, '.secret'),
          headers: asOwner,
        })
      ).statusCode,
    ).toBe(404);
    const huge = await app.inject({
      method: 'GET',
      url: downloadUrl(agentFiles, 'huge.bin'),
      headers: asOwner,
    });
    expect(huge.statusCode).toBe(413);
    expect((huge.json() as { error: { code: string } }).error.code).toBe('workspace_file_too_large');
  });
});

describe('GET /agents/:username/workspace/export (zip)', () => {
  it('streams a zip of the visible tree, excluding hidden/internal names', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${treeUrl(agentFiles)}/export`,
      headers: asOwner,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain(`${agentFiles}-workspace.zip`);

    const zip = res.rawPayload;
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04])); // PK\x03\x04
    // Zip entry NAMES are stored uncompressed — assert on them directly.
    const raw = zip.toString('latin1');
    expect(raw).toContain('notes.md');
    expect(raw).toContain('art/plan.md');
    expect(raw).not.toContain('.secret');
    expect(raw).not.toContain('BOOTSTRAP.md');
    expect(raw).not.toContain('openclaw-workspace-state.json');
    expect(raw).not.toContain('node_modules');
    expect(raw).not.toContain('OUTSIDE SECRET');
    expect(raw).not.toContain('NEIGHBOR SECRET');
  });
});

// ---------------------------------------------------------------------------
// Save (conflict-checked atomic write)
// ---------------------------------------------------------------------------

describe('PUT /agents/:username/workspace/file', () => {
  it('creates a new file (baseSha256 "new"), including parent dirs', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${treeUrl(agentFiles)}/file`,
      headers: asOwner,
      payload: { path: 'drafts/idea.md', content: 'a fresh thought\n', baseSha256: 'new' },
    });
    expect(res.statusCode).toBe(200);
    const { file } = res.json() as TextFileBody;
    expect(file.path).toBe('drafts/idea.md');
    expect(file.sha256).toBe(createHash('sha256').update('a fresh thought\n').digest('hex'));
    expect(await readFile(path.join(wsFiles, 'drafts', 'idea.md'), 'utf8')).toBe('a fresh thought\n');
  });

  it('saves over an existing file when baseSha256 matches the disk bytes', async () => {
    const loaded = (
      (
        await app.inject({
          method: 'GET',
          url: fileUrl(agentFiles, 'art/plan.md'),
          headers: asOwner,
        })
      ).json() as TextFileBody
    ).file;
    const res = await app.inject({
      method: 'PUT',
      url: `${treeUrl(agentFiles)}/file`,
      headers: asOwner,
      payload: { path: 'art/plan.md', content: 'make MORE art\n', baseSha256: loaded.sha256 },
    });
    expect(res.statusCode).toBe(200);
    expect(await readFile(path.join(wsFiles, 'art', 'plan.md'), 'utf8')).toBe('make MORE art\n');
  });

  it('409s (and does NOT write) when the file changed since it was loaded', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${treeUrl(agentFiles)}/file`,
      headers: asOwner,
      payload: { path: 'notes.md', content: 'CLOBBER\n', baseSha256: WRONG_SHA },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as ConflictBody;
    expect(body.error.code).toBe('workspace_write_conflict');
    expect(body.currentSha256).toBe(notesSha);
    expect(typeof body.currentMtime).toBe('string');
    expect(await readFile(path.join(wsFiles, 'notes.md'), 'utf8')).toBe(NOTES_CONTENT);
  });

  it('409s "new" against an existing file, and a stale sha against a missing one', async () => {
    const existing = await app.inject({
      method: 'PUT',
      url: `${treeUrl(agentFiles)}/file`,
      headers: asOwner,
      payload: { path: 'notes.md', content: 'CLOBBER\n', baseSha256: 'new' },
    });
    expect(existing.statusCode).toBe(409);
    expect((existing.json() as ConflictBody).currentSha256).toBe(notesSha);
    expect(await readFile(path.join(wsFiles, 'notes.md'), 'utf8')).toBe(NOTES_CONTENT);

    const missing = await app.inject({
      method: 'PUT',
      url: `${treeUrl(agentFiles)}/file`,
      headers: asOwner,
      payload: { path: 'vanished.md', content: 'x', baseSha256: WRONG_SHA },
    });
    expect(missing.statusCode).toBe(409);
    expect((missing.json() as ConflictBody).currentSha256).toBeNull();
  });

  it('rejects writes to hidden/internal names and through symlinks', async () => {
    for (const p of ['.secret', 'BOOTSTRAP.md', 'openclaw-workspace-state.json', 'node_modules/x.js']) {
      const res = await app.inject({
        method: 'PUT',
        url: `${treeUrl(agentFiles)}/file`,
        headers: asOwner,
        payload: { path: p, content: 'overwrite', baseSha256: 'new' },
      });
      expect(res.statusCode, p).toBe(400);
    }
    expect(await readFile(path.join(wsFiles, '.secret'), 'utf8')).toBe('dot secret');
    expect(await readFile(path.join(wsFiles, 'BOOTSTRAP.md'), 'utf8')).toBe('bootstrap ritual');

    // Existing symlink target: never write through it.
    const viaLink = await app.inject({
      method: 'PUT',
      url: `${treeUrl(agentFiles)}/file`,
      headers: asOwner,
      payload: { path: 'escape-file', content: 'pwn', baseSha256: 'new' },
    });
    expect(viaLink.statusCode).toBe(400);
    expect(await readFile(path.join(parentDir, 'outside.txt'), 'utf8')).toBe('OUTSIDE SECRET');
  });

  it('rejects editing binary files and enforces the 512KB text limit server-side', async () => {
    const bin = await app.inject({
      method: 'PUT',
      url: `${treeUrl(agentFiles)}/file`,
      headers: asOwner,
      payload: { path: 'data/blob.bin', content: 'text now', baseSha256: WRONG_SHA },
    });
    expect(bin.statusCode).toBe(400);
    expect((bin.json() as { error: { code: string } }).error.code).toBe('workspace_not_text');

    const big = await app.inject({
      method: 'PUT',
      url: `${treeUrl(agentFiles)}/file`,
      headers: asOwner,
      payload: { path: 'notes.md', content: 'a'.repeat(512 * 1024 + 1), baseSha256: notesSha },
    });
    expect(big.statusCode).toBe(413);
    expect((big.json() as { error: { code: string } }).error.code).toBe('workspace_file_too_large');
    expect(await readFile(path.join(wsFiles, 'notes.md'), 'utf8')).toBe(NOTES_CONTENT);
  });

  it('400s malformed baseSha256 values', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${treeUrl(agentFiles)}/file`,
      headers: asOwner,
      payload: { path: 'notes.md', content: 'x', baseSha256: 'not-a-sha' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Path-traversal battery (P0)
// ---------------------------------------------------------------------------

describe('path jail', () => {
  const lexicalProbes = [
    '../../etc/passwd',
    '../../../../../../etc/passwd',
    '/etc/passwd',
    'a/../../etc/passwd',
    'art/../..',
    '..\\..\\etc\\passwd',
    './notes.md',
    '.',
    'notes.md\u0000.png',
    `../${path.basename('workspace-neighbor-agent')}/secret.txt`,
  ];

  it('400s lexical traversal probes on read, download, and write — leaking nothing', async () => {
    for (const probe of lexicalProbes) {
      const read = await app.inject({
        method: 'GET',
        url: fileUrl(agentFiles, probe),
        headers: asOwner,
      });
      expect(read.statusCode, `file ${probe}`).toBe(400);
      expect(read.body, `file ${probe}`).not.toContain('root:');
      expect(read.body, `file ${probe}`).not.toContain('NEIGHBOR SECRET');

      const dl = await app.inject({
        method: 'GET',
        url: downloadUrl(agentFiles, probe),
        headers: asOwner,
      });
      expect(dl.statusCode, `download ${probe}`).toBe(400);
      expect(dl.body, `download ${probe}`).not.toContain('root:');

      const put = await app.inject({
        method: 'PUT',
        url: `${treeUrl(agentFiles)}/file`,
        headers: asOwner,
        payload: { path: probe, content: 'pwn', baseSha256: 'new' },
      });
      expect(put.statusCode, `put ${probe}`).toBe(400);
    }
    // Nothing escaped the jail onto the neighboring paths.
    expect(await readFile(path.join(parentDir, 'outside.txt'), 'utf8')).toBe('OUTSIDE SECRET');
    expect(await readFile(path.join(wsNeighbor, 'secret.txt'), 'utf8')).toBe('NEIGHBOR SECRET');
  });

  it('rejects URL-encoded dot-dot sequences (%2e%2e%2f)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/agents/${agentFiles}/workspace/file?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
      headers: asOwner,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('root:');
  });

  it('treats symlink escapes as not-found without leaking content', async () => {
    // Symlinked file pointing outside the workspace.
    const file = await app.inject({
      method: 'GET',
      url: fileUrl(agentFiles, 'escape-file'),
      headers: asOwner,
    });
    expect(file.statusCode).toBe(404);
    expect(file.body).not.toContain('OUTSIDE SECRET');

    // File under a symlinked dir that points at a NEIGHBORING agent workspace.
    const neighbor = await app.inject({
      method: 'GET',
      url: fileUrl(agentFiles, 'escape-dir/secret.txt'),
      headers: asOwner,
    });
    expect(neighbor.statusCode).toBe(404);
    expect(neighbor.body).not.toContain('NEIGHBOR SECRET');

    const dl = await app.inject({
      method: 'GET',
      url: downloadUrl(agentFiles, 'escape-dir/secret.txt'),
      headers: asOwner,
    });
    expect(dl.statusCode).toBe(404);
    expect(dl.body).not.toContain('NEIGHBOR SECRET');

    // Symlink that stays inside the root but resolves to a hidden file.
    const alias = await app.inject({
      method: 'GET',
      url: fileUrl(agentFiles, 'alias.md'),
      headers: asOwner,
    });
    expect(alias.statusCode).toBe(404);
    expect(alias.body).not.toContain('dot secret');
  });

  it('never writes through a symlinked directory into a neighbor workspace', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${treeUrl(agentFiles)}/file`,
      headers: asOwner,
      payload: { path: 'escape-dir/injected.md', content: 'pwn', baseSha256: 'new' },
    });
    expect(res.statusCode).toBe(400);
    await expect(readFile(path.join(wsNeighbor, 'injected.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
