import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { SkillDefinitionRow } from './agent-skills';

let writeSkillFiles: typeof import('./agent-skills').writeSkillFiles;
const workspaces: string[] = [];

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:1/unused';
  ({ writeSkillFiles } = await import('./agent-skills'));
});

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true })));
});

async function workspace(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), 'eden3-managed-skills-'));
  workspaces.push(created);
  return created;
}

async function anchoredWorker(params: {
  cwd: string;
  request: Record<string, unknown>;
  afterSpawn: () => Promise<void>;
}): Promise<{ code: number | null; stderr: string }> {
  const stat = await lstat(params.cwd, { bigint: true });
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./agent-skill-fs-worker.mjs', import.meta.url))],
    { cwd: params.cwd, env: {}, stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  await params.afterSpawn();
  child.stdin.end(
    JSON.stringify({
      ...params.request,
      expected: { dev: stat.dev.toString(), ino: stat.ino.toString() },
    }),
  );
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { code, stderr };
}

function skill(slug: string, overrides: Partial<SkillDefinitionRow> = {}): SkillDefinitionRow {
  return {
    id: `${slug}-id`,
    slug,
    name: slug,
    description: `${slug} description`,
    body: `# ${slug}\n\nManaged instructions.\n`,
    source: 'curated',
    status: 'approved',
    owner_id: null,
    reviewer_id: null,
    reviewed_at: null,
    created_at: '2026-08-08T00:00:00.000Z',
    updated_at: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('managed skill filesystem projection', () => {
  it('removes only deselected managed directories and preserves unknown owner content', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'TOOLS.md'), '# Owner tools\n', 'utf8');
    await writeSkillFiles(root, [skill('alpha'), skill('beta')], ['alpha', 'beta', 'pending']);

    const unknown = path.join(root, 'skills', 'owner-authored');
    await mkdir(unknown, { recursive: true });
    await writeFile(path.join(unknown, 'SKILL.md'), '# Owner authored\n', 'utf8');
    await writeFile(path.join(root, 'skills', 'beta', 'owner-note.txt'), 'remove with beta', 'utf8');
    await mkdir(path.join(root, 'skills', 'pending'), { recursive: true });
    await writeFile(path.join(root, 'skills', 'pending', 'SKILL.md'), '# Pending\n', 'utf8');

    await writeSkillFiles(root, [skill('alpha')], ['alpha', 'beta', 'pending']);

    await expect(readFile(path.join(root, 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toContain(
      '# alpha',
    );
    await expect(readFile(path.join(unknown, 'SKILL.md'), 'utf8')).resolves.toBe('# Owner authored\n');
    expect((await readdir(path.join(root, 'skills'))).sort()).toEqual(['alpha', 'owner-authored']);
    const tools = await readFile(path.join(root, 'TOOLS.md'), 'utf8');
    expect(tools).toContain('# Owner tools');
    expect(tools).toContain('### alpha (alpha)');
    expect(tools).not.toContain('beta');
    expect(tools).not.toContain('Pending');
  });

  it('removes a rejected managed directory without enumerating unknown siblings', async () => {
    const root = await workspace();
    const rejected = path.join(root, 'skills', 'submitted-skill');
    const unknown = path.join(root, 'skills', 'private-notes');
    await mkdir(rejected, { recursive: true });
    await mkdir(unknown, { recursive: true });
    await writeFile(path.join(rejected, 'extra.txt'), 'managed residue', 'utf8');
    await writeFile(path.join(unknown, 'keep.txt'), 'owner bytes', 'utf8');

    await writeSkillFiles(root, [], ['submitted-skill']);

    expect((await readdir(path.join(root, 'skills'))).sort()).toEqual(['private-notes']);
    await expect(readFile(path.join(unknown, 'keep.txt'), 'utf8')).resolves.toBe('owner bytes');
  });

  it('refuses a symlinked skills root without touching its outside target', async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(path.join(outside, 'sentinel.txt'), 'outside bytes', 'utf8');
    await symlink(outside, path.join(root, 'skills'), 'dir');

    await expect(writeSkillFiles(root, [skill('alpha')], ['alpha'])).rejects.toMatchObject({
      code: 'unsafe_skill_workspace',
    });

    await expect(readFile(path.join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('outside bytes');
    await expect(readdir(outside)).resolves.toEqual(['sentinel.txt']);
  });

  it('refuses a selected symlinked slug before manifest or outside mutation', async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(path.join(root, 'TOOLS.md'), 'unchanged\n', 'utf8');
    await writeFile(path.join(outside, 'sentinel.txt'), 'outside bytes', 'utf8');
    await mkdir(path.join(root, 'skills'));
    await symlink(outside, path.join(root, 'skills', 'alpha'), 'dir');

    await expect(writeSkillFiles(root, [skill('alpha')], ['alpha'])).rejects.toMatchObject({
      code: 'unsafe_skill_workspace',
    });

    await expect(readFile(path.join(root, 'TOOLS.md'), 'utf8')).resolves.toBe('unchanged\n');
    await expect(readFile(path.join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('outside bytes');
  });

  it('unlinks an unselected managed symlink without traversing its target', async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(path.join(outside, 'sentinel.txt'), 'outside bytes', 'utf8');
    await mkdir(path.join(root, 'skills'));
    await symlink(outside, path.join(root, 'skills', 'rejected'), 'dir');

    await writeSkillFiles(root, [], ['rejected']);

    await expect(readFile(path.join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('outside bytes');
    await expect(readdir(path.join(root, 'skills'))).resolves.toEqual([]);
  });

  it('unlinks a rejected symlink even when the later TOOLS rewrite fails', async () => {
    const root = await workspace();
    const outsideSkill = await workspace();
    const outsideTools = await workspace();
    await mkdir(path.join(root, 'skills'));
    await writeFile(path.join(outsideSkill, 'sentinel.txt'), 'skill target bytes', 'utf8');
    await writeFile(path.join(outsideTools, 'sentinel.txt'), 'tools target bytes', 'utf8');
    await symlink(outsideSkill, path.join(root, 'skills', 'rejected'), 'dir');
    await symlink(path.join(outsideTools, 'sentinel.txt'), path.join(root, 'TOOLS.md'));

    await expect(writeSkillFiles(root, [], ['rejected'])).rejects.toThrow();

    await expect(lstat(path.join(root, 'skills', 'rejected'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(path.join(outsideSkill, 'sentinel.txt'), 'utf8')).resolves.toBe(
      'skill target bytes',
    );
    await expect(readFile(path.join(outsideTools, 'sentinel.txt'), 'utf8')).resolves.toBe(
      'tools target bytes',
    );
  });

  it('anchors selected publication to the opened cwd inode across a path swap', async () => {
    const root = await workspace();
    const outside = await workspace();
    const selected = path.join(root, 'selected');
    const displaced = path.join(root, 'selected-displaced');
    await mkdir(selected);
    await writeFile(path.join(outside, 'sentinel.txt'), 'outside bytes', 'utf8');

    const result = await anchoredWorker({
      cwd: selected,
      request: { operation: 'write-skill', body: '# Anchored\n' },
      afterSpawn: async () => {
        await rename(selected, displaced);
        await symlink(outside, selected, 'dir');
      },
    });

    expect(result).toEqual({ code: 0, stderr: '' });
    await expect(readFile(path.join(displaced, 'SKILL.md'), 'utf8')).resolves.toBe('# Anchored\n');
    await expect(readFile(path.join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('outside bytes');
    await expect(readdir(outside)).resolves.toEqual(['sentinel.txt']);
  });

  it('anchors managed deletion to the opened skills-root inode across a path swap', async () => {
    const root = await workspace();
    const outside = await workspace();
    const skillsRoot = path.join(root, 'skills');
    const displaced = path.join(root, 'skills-displaced');
    await mkdir(skillsRoot);
    await writeFile(path.join(skillsRoot, 'rejected'), 'managed special entry', 'utf8');
    await writeFile(path.join(outside, 'sentinel.txt'), 'outside bytes', 'utf8');

    const result = await anchoredWorker({
      cwd: skillsRoot,
      request: { operation: 'remove-special', slugs: ['rejected'] },
      afterSpawn: async () => {
        await rename(skillsRoot, displaced);
        await symlink(outside, skillsRoot, 'dir');
      },
    });

    expect(result).toEqual({ code: 0, stderr: '' });
    await expect(readdir(displaced)).resolves.toEqual([]);
    await expect(readFile(path.join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('outside bytes');
    await expect(readdir(outside)).resolves.toEqual(['sentinel.txt']);
  });

  it('refuses a TOOLS symlink swapped after the workspace cwd is anchored', async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(path.join(root, 'TOOLS.md'), 'owner bytes\n', 'utf8');
    await writeFile(path.join(outside, 'sentinel.txt'), 'outside bytes', 'utf8');

    const result = await anchoredWorker({
      cwd: root,
      request: { operation: 'rewrite-tools', manifest: 'managed' },
      afterSpawn: async () => {
        await rename(path.join(root, 'TOOLS.md'), path.join(root, 'TOOLS.previous'));
        await symlink(path.join(outside, 'sentinel.txt'), path.join(root, 'TOOLS.md'));
      },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('symbolic link');
    await expect(readFile(path.join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('outside bytes');
  });

  it.each([
    '../escape',
    '/absolute',
    'Alpha',
    'alpha/',
    'alpha//beta',
    'alpha.beta',
    'a',
  ])('rejects non-canonical managed slug %j before any filesystem mutation', async (invalid) => {
    const root = await workspace();
    await writeFile(path.join(root, 'TOOLS.md'), 'unchanged\n', 'utf8');

    await expect(writeSkillFiles(root, [], ['alpha', invalid])).rejects.toMatchObject({
      code: 'invalid_skill_slug',
    });

    await expect(readFile(path.join(root, 'TOOLS.md'), 'utf8')).resolves.toBe('unchanged\n');
    await expect(readdir(root)).resolves.toEqual(['TOOLS.md']);
  });

  it('rejects duplicate or unmanaged selections before changing prior projection', async () => {
    const root = await workspace();
    await writeSkillFiles(root, [skill('alpha')], ['alpha', 'beta']);
    const beforeSkill = await readFile(path.join(root, 'skills', 'alpha', 'SKILL.md'), 'utf8');
    const beforeTools = await readFile(path.join(root, 'TOOLS.md'), 'utf8');

    await expect(
      writeSkillFiles(root, [skill('alpha'), skill('alpha', { body: '# changed\n' })], ['alpha']),
    ).rejects.toMatchObject({ code: 'invalid_skill_projection' });
    await expect(writeSkillFiles(root, [skill('beta')], ['alpha'])).rejects.toMatchObject({
      code: 'invalid_skill_projection',
    });

    await expect(readFile(path.join(root, 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe(
      beforeSkill,
    );
    await expect(readFile(path.join(root, 'TOOLS.md'), 'utf8')).resolves.toBe(beforeTools);
  });

  it('cleans interrupted managed temp files while preserving unrelated files', async () => {
    const root = await workspace();
    const dir = path.join(root, 'skills', 'alpha');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md.eden3-tmp-interrupted'), 'partial', 'utf8');
    await writeFile(path.join(dir, 'notes.txt'), 'keep', 'utf8');

    await writeSkillFiles(root, [skill('alpha')], ['alpha']);

    expect((await readdir(dir)).sort()).toEqual(['SKILL.md', 'notes.txt']);
    await expect(readFile(path.join(dir, 'notes.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('sanitizes rejected manifest content before an unrelated selected-file failure', async () => {
    const root = await workspace();
    await writeSkillFiles(root, [skill('rejected'), skill('selected')], ['rejected', 'selected']);
    // A directory at the reserved temp-file prefix makes selected publication
    // fail deterministically after the authoritative manifest rewrite.
    await mkdir(path.join(root, 'skills', 'selected', 'SKILL.md.eden3-tmp-blocked'));

    await expect(
      writeSkillFiles(root, [skill('selected')], ['rejected', 'selected']),
    ).rejects.toThrow();

    const tools = await readFile(path.join(root, 'TOOLS.md'), 'utf8');
    expect(tools).not.toContain('rejected');
    expect(tools).toContain('### selected (selected)');
    await expect(readdir(path.join(root, 'skills'))).resolves.toEqual(['selected']);
  });

  it('recovers a deterministic inert tombstone left after rename', async () => {
    const root = await workspace();
    await writeSkillFiles(root, [skill('rejected')], ['rejected']);
    const result = await anchoredWorker({
      cwd: path.join(root, 'skills', 'rejected'),
      request: { operation: 'sanitize-and-tombstone', slug: 'rejected' },
      afterSpawn: async () => undefined,
    });
    expect(result).toEqual({ code: 0, stderr: '' });
    const tombstone = path.join(root, 'skills', '.eden3-managed-remove-rejected');
    await expect(readFile(path.join(tombstone, 'SKILL.md'), 'utf8')).resolves.toBe(
      '---\nname: eden-disabled-skill\ndescription: Disabled by Eden review policy.\n---\n\nThis skill is disabled.\n',
    );
    await expect(readFile(path.join(tombstone, '.eden3-managed-tombstone.json'), 'utf8')).resolves
      .toContain('"slug":"rejected"');
    await expect(lstat(path.join(root, 'skills', 'rejected'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await writeSkillFiles(root, [], ['rejected']);

    await expect(readdir(path.join(root, 'skills'))).resolves.toEqual([]);
  });

  it('cleans a valid interrupted tombstone before reselecting the managed skill', async () => {
    const root = await workspace();
    await writeSkillFiles(root, [skill('alpha')], ['alpha']);
    await anchoredWorker({
      cwd: path.join(root, 'skills', 'alpha'),
      request: { operation: 'sanitize-and-tombstone', slug: 'alpha' },
      afterSpawn: async () => undefined,
    });

    await writeSkillFiles(root, [skill('alpha', { body: '# Reselected\n' })], ['alpha']);

    await expect(readFile(path.join(root, 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toContain(
      '# Reselected',
    );
    expect((await readdir(path.join(root, 'skills'))).sort()).toEqual(['alpha']);
  });

  it('preserves an unknown reserved-name directory without an Eden marker', async () => {
    const root = await workspace();
    const unknown = path.join(root, 'skills', '.eden3-managed-remove-alpha');
    await mkdir(unknown, { recursive: true });
    await writeFile(path.join(unknown, 'sentinel.txt'), 'owner bytes', 'utf8');

    await expect(writeSkillFiles(root, [], ['alpha'])).rejects.toThrow(
      /eden3-managed-tombstone|ENOENT/,
    );

    await expect(readFile(path.join(unknown, 'sentinel.txt'), 'utf8')).resolves.toBe('owner bytes');
  });

  it('preserves an unknown reserved-name symlink and its outside target', async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(path.join(root, 'skills'));
    await writeFile(path.join(outside, 'sentinel.txt'), 'outside bytes', 'utf8');
    await symlink(outside, path.join(root, 'skills', '.eden3-managed-remove-alpha'), 'dir');

    await expect(writeSkillFiles(root, [], ['alpha'])).rejects.toMatchObject({
      code: 'unsafe_skill_workspace',
    });

    await expect(readFile(path.join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('outside bytes');
    await expect(readdir(outside)).resolves.toEqual(['sentinel.txt']);
  });
});
