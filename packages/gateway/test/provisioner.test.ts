import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentProvisioner,
  PERSONA_TEMPLATE_FILES,
  ProvisionError,
  renderTemplate,
  type ProvisionAgentParams,
} from '../src/provisioner';
import type { CliExecOptions, OpenClawCliLike, OpenClawCliResult } from '../src/docker';

const REAL_TEMPLATES_DIR = fileURLToPath(new URL('../workspace-templates/', import.meta.url));

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type CliCall = { args: readonly string[]; options?: CliExecOptions };

class FakeCli implements OpenClawCliLike {
  calls: CliCall[] = [];
  /** agents currently "registered" (returned by agents list). */
  agents: { id: string; model?: string }[] = [];
  failListWith?: Error;

  async exec(args: readonly string[], options?: CliExecOptions): Promise<OpenClawCliResult> {
    this.calls.push({ args, ...(options !== undefined ? { options } : {}) });
    return { stdout: '', stderr: '' };
  }

  async execJson<T = unknown>(args: readonly string[], options?: CliExecOptions): Promise<T> {
    this.calls.push({ args, ...(options !== undefined ? { options } : {}) });
    if (args[0] === 'agents' && args[1] === 'list') {
      if (this.failListWith !== undefined) throw this.failListWith;
      return this.agents as T;
    }
    if (args[0] === 'agents' && args[1] === 'add') {
      const id = args[2]!;
      const model = args[args.indexOf('--model') + 1];
      this.agents.push({ id, ...(model !== undefined ? { model } : {}) });
      return { agentId: id, name: id } as T;
    }
    throw new Error(`FakeCli: unexpected command ${args.join(' ')}`);
  }
}

/** /v1/models fetch fake — models appear per the ids list. */
function modelsFetch(idsRef: { ids: string[] }): { fetchImpl: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    requests.push(String(input));
    return new Response(
      JSON.stringify({ object: 'list', data: idsRef.ids.map((id) => ({ id, object: 'model' })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const PARAMS: ProvisionAgentParams = {
  openclawId: 'banny',
  name: 'Banny',
  username: 'banny',
  description: 'Resident banana artist',
  persona: 'You are Banny, an exuberant banana who paints.',
  greeting: 'Peel free to ask me anything!',
  model: 'anthropic/claude-haiku-4-5',
  memorySeed: '- Banny joined Eden in 2023.',
};

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-provisioner-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function makeProvisioner(overrides: {
  cli?: OpenClawCliLike;
  fetchImpl?: typeof fetch;
  routableTimeoutMs?: number;
}): AgentProvisioner {
  const idsRef = { ids: ['openclaw/main', 'openclaw/banny'] };
  const { fetchImpl } = modelsFetch(idsRef);
  return new AgentProvisioner({
    gateway: {
      baseUrl: 'http://gw.test',
      token: 'tok-secret',
      fetchImpl: overrides.fetchImpl ?? fetchImpl,
    },
    cli: overrides.cli ?? new FakeCli(),
    dataDir,
    templatesDir: REAL_TEMPLATES_DIR,
    routableTimeoutMs: overrides.routableTimeoutMs ?? 2_000,
    routablePollIntervalMs: 10,
    now: () => new Date('2026-07-03T00:00:00.000Z'),
  });
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('renderTemplate', () => {
  it('substitutes known placeholders and leaves unknown ones', () => {
    expect(renderTemplate('Hi {{NAME}} ({{USERNAME}}) {{UNKNOWN_KEY}}', { NAME: 'A', USERNAME: 'b' })).toBe(
      'Hi A (b) {{UNKNOWN_KEY}}',
    );
  });
});

describe('AgentProvisioner.provisionAgent', () => {
  it('renders every real template with no unresolved placeholders', async () => {
    const cli = new FakeCli();
    const provisioner = makeProvisioner({ cli });
    const result = await provisioner.provisionAgent(PARAMS);

    const templateNames = (await fs.readdir(REAL_TEMPLATES_DIR)).sort((a, b) =>
      a.localeCompare(b),
    );
    expect(result.filesWritten).toEqual(templateNames);
    expect(result.filesSkipped).toEqual([]);
    expect(result.hostWorkspaceDir).toBe(path.join(dataDir, 'workspace-banny'));
    expect(result.containerWorkspaceDir).toBe('/home/node/.openclaw/workspace-banny');

    for (const name of templateNames) {
      const rendered = await fs.readFile(path.join(result.hostWorkspaceDir, name), 'utf8');
      expect(rendered, `${name} should have no {{PLACEHOLDER}} left`).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
    const soul = await fs.readFile(path.join(result.hostWorkspaceDir, 'SOUL.md'), 'utf8');
    expect(soul).toContain('# Banny');
    expect(soul).toContain('exuberant banana');
    expect(soul).toContain('Peel free to ask me anything!');
    const memory = await fs.readFile(path.join(result.hostWorkspaceDir, 'MEMORY.md'), 'utf8');
    expect(memory).toContain('- Banny joined Eden in 2023.');
    const state = JSON.parse(
      await fs.readFile(path.join(result.hostWorkspaceDir, 'openclaw-workspace-state.json'), 'utf8'),
    ) as { version: number; setupCompletedAt: string };
    expect(state).toEqual({ version: 1, setupCompletedAt: '2026-07-03T00:00:00.000Z' });

    // memory dirs for the agent's own journals + per-user notes
    const usersDir = await fs.stat(path.join(result.hostWorkspaceDir, 'memory', 'users'));
    expect(usersDir.isDirectory()).toBe(true);
  });

  it('omitted memorySeed renders as empty (never a literal placeholder)', async () => {
    const provisioner = makeProvisioner({});
    const { memorySeed: _unused, ...noSeed } = PARAMS;
    const result = await provisioner.provisionAgent(noSeed);
    const memory = await fs.readFile(path.join(result.hostWorkspaceDir, 'MEMORY.md'), 'utf8');
    expect(memory).not.toContain('{{MEMORY_SEED}}');
    expect(memory).not.toContain('Banny joined');
  });

  it('registers via agents add with the CONTAINER workspace path', async () => {
    const cli = new FakeCli();
    const provisioner = makeProvisioner({ cli });
    const result = await provisioner.provisionAgent(PARAMS);
    expect(result.registration).toBe('added');

    const add = cli.calls.find((c) => c.args[0] === 'agents' && c.args[1] === 'add');
    expect(add).toBeDefined();
    expect(add!.args).toEqual([
      'agents',
      'add',
      'banny',
      '--non-interactive',
      '--workspace',
      '/home/node/.openclaw/workspace-banny',
      '--model',
      'anthropic/claude-haiku-4-5',
    ]);
    // config-file command: must NOT ask for the gateway token
    expect(add!.options?.gatewayToken).toBeUndefined();
  });

  it('skips existing files without force and overwrites with force', async () => {
    const provisioner = makeProvisioner({});
    const first = await provisioner.provisionAgent(PARAMS);
    const soulPath = path.join(first.hostWorkspaceDir, 'SOUL.md');
    await fs.writeFile(soulPath, 'hand-edited\n');

    const second = await provisioner.provisionAgent(PARAMS);
    expect(second.filesWritten).toEqual([]);
    expect(second.filesSkipped.sort()).toEqual(first.filesWritten.sort());
    expect(await fs.readFile(soulPath, 'utf8')).toBe('hand-edited\n');

    const third = await provisioner.provisionAgent(PARAMS, { force: true });
    expect(third.filesWritten.sort()).toEqual(first.filesWritten.sort());
    expect(await fs.readFile(soulPath, 'utf8')).toContain('# Banny');
  });

  it('does not re-add an already-registered agent', async () => {
    const cli = new FakeCli();
    cli.agents = [{ id: 'banny', model: 'anthropic/claude-haiku-4-5' }];
    const provisioner = makeProvisioner({ cli });
    const result = await provisioner.provisionAgent(PARAMS);
    expect(result.registration).toBe('existing');
    expect(result.modelUpdated).toBe(false);
    expect(cli.calls.some((c) => c.args[1] === 'add')).toBe(false);
  });

  it('falls back to reading openclaw.json when agents list fails', async () => {
    const cli = new FakeCli();
    cli.failListWith = new Error('no such command');
    await fs.writeFile(
      path.join(dataDir, 'openclaw.json'),
      JSON.stringify({
        agents: { list: [{ id: 'banny', model: 'anthropic/claude-haiku-4-5' }] },
      }),
    );
    const provisioner = makeProvisioner({ cli });
    const result = await provisioner.provisionAgent(PARAMS);
    expect(result.registration).toBe('existing');
    expect(cli.calls.some((c) => c.args[1] === 'add')).toBe(false);
  });

  it('updates the model in openclaw.json when an existing registration drifts', async () => {
    const cli = new FakeCli();
    cli.agents = [{ id: 'banny', model: 'anthropic/claude-opus-4-6' }];
    await fs.writeFile(
      path.join(dataDir, 'openclaw.json'),
      JSON.stringify({ agents: { list: [{ id: 'banny', model: 'anthropic/claude-opus-4-6' }] } }),
    );
    const provisioner = makeProvisioner({ cli });
    const result = await provisioner.provisionAgent(PARAMS);
    expect(result.registration).toBe('existing');
    expect(result.modelUpdated).toBe(true);
    const config = JSON.parse(await fs.readFile(path.join(dataDir, 'openclaw.json'), 'utf8')) as {
      agents: { list: { id: string; model: string }[] };
    };
    expect(config.agents.list[0]!.model).toBe('anthropic/claude-haiku-4-5');
  });

  it('polls /v1/models until routable and fails past the deadline', async () => {
    // routable on the third poll
    const idsRef = { ids: ['openclaw/main'] };
    let polls = 0;
    const fetchImpl = (async () => {
      polls += 1;
      if (polls >= 3) idsRef.ids = ['openclaw/main', 'openclaw/banny'];
      return new Response(
        JSON.stringify({ data: idsRef.ids.map((id) => ({ id })) }),
        { status: 200 },
      );
    }) as typeof fetch;
    const ok = await makeProvisioner({ fetchImpl }).provisionAgent(PARAMS);
    expect(ok.openclawId).toBe('banny');
    expect(polls).toBeGreaterThanOrEqual(3);

    // never routable → ProvisionError mentioning the deadline
    const neverFetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    await expect(
      makeProvisioner({ fetchImpl: neverFetch, routableTimeoutMs: 60 }).provisionAgent({
        ...PARAMS,
        openclawId: 'banny2',
        username: 'banny2',
      }),
    ).rejects.toThrow(/not routable within 60ms/);
  });

  it('rejects path-hostile openclaw ids', async () => {
    const provisioner = makeProvisioner({});
    for (const bad of ['../evil', 'UPPER', 'has space', '', 'dot.dot']) {
      await expect(provisioner.provisionAgent({ ...PARAMS, openclawId: bad })).rejects.toBeInstanceOf(
        ProvisionError,
      );
    }
  });
});

describe('AgentProvisioner.updateAgentPersona', () => {
  it('re-renders only SOUL.md and IDENTITY.md', async () => {
    const provisioner = makeProvisioner({});
    const first = await provisioner.provisionAgent(PARAMS);
    const memoryBefore = await fs.readFile(path.join(first.hostWorkspaceDir, 'MEMORY.md'), 'utf8');

    const updated = await provisioner.updateAgentPersona({
      openclawId: 'banny',
      name: 'Banny Prime',
      username: 'banny',
      description: 'Reformed banana, now a sculptor',
      persona: 'You are Banny Prime, a solemn sculptor.',
      greeting: 'Welcome to the studio.',
    });
    expect(updated.filesWritten).toEqual([...PERSONA_TEMPLATE_FILES]);

    const soul = await fs.readFile(path.join(first.hostWorkspaceDir, 'SOUL.md'), 'utf8');
    expect(soul).toContain('# Banny Prime');
    expect(soul).toContain('solemn sculptor');
    const identity = await fs.readFile(path.join(first.hostWorkspaceDir, 'IDENTITY.md'), 'utf8');
    expect(identity).toContain('Banny Prime');
    expect(identity).toContain('Reformed banana');
    // untouched files stay untouched
    expect(await fs.readFile(path.join(first.hostWorkspaceDir, 'MEMORY.md'), 'utf8')).toBe(memoryBefore);
  });

  it('throws when the workspace has not been provisioned', async () => {
    const provisioner = makeProvisioner({});
    await expect(
      provisioner.updateAgentPersona({
        openclawId: 'ghost',
        name: 'G',
        username: 'g',
        description: 'd',
        persona: 'p',
        greeting: 'hi',
      }),
    ).rejects.toThrow(/provision "ghost" first/);
  });
});
