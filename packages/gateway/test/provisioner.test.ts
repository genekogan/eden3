import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentProvisioner,
  BOOTSTRAP_FILENAME,
  PERSONA_TEMPLATE_FILES,
  ProvisionError,
  WORKSPACE_STATE_FILENAME,
  renderTemplate,
  workspaceBootstrapStatus,
  type ProvisionAgentParams,
} from '../src/provisioner';
import type { CliExecOptions, OpenClawCliLike, OpenClawCliResult } from '../src/docker';

const REAL_TEMPLATES_DIR = fileURLToPath(new URL('../workspace-templates/', import.meta.url));

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type CliCall = { args: readonly string[]; options?: CliExecOptions };

/** The generic persona OpenClaw seeds into a fresh workspace on `agents add`. */
const SEEDED_DEFAULT_SOUL = "# SOUL.md\n\nYou're not a chatbot. You're becoming someone.\n";

class FakeCli implements OpenClawCliLike {
  calls: CliCall[] = [];
  /** agents currently "registered" (returned by agents list). */
  agents: { id: string; model?: string }[] = [];
  failListWith?: Error;
  /**
   * When set, `agents add` mimics the real gateway seeding a fresh workspace:
   * it drops OpenClaw's generic default SOUL.md, a BOOTSTRAP.md, and its OWN
   * `openclaw-workspace-state.json` (with `bootstrapSeededAt`, no
   * `setupCompletedAt`) so tests can prove our render/marker wins afterwards.
   * Maps openclawId -> host workspace dir.
   */
  seedWorkspaceDirs?: Map<string, string>;

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
      await this.seedWorkspace(id);
      return { agentId: id, name: id } as T;
    }
    throw new Error(`FakeCli: unexpected command ${args.join(' ')}`);
  }

  private async seedWorkspace(id: string): Promise<void> {
    const dir = this.seedWorkspaceDirs?.get(id);
    if (dir === undefined) return;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SOUL.md'), SEEDED_DEFAULT_SOUL, 'utf8');
    await fs.writeFile(path.join(dir, BOOTSTRAP_FILENAME), '# BOOTSTRAP\n\nWho am I?\n', 'utf8');
    await fs.writeFile(
      path.join(dir, WORKSPACE_STATE_FILENAME),
      `${JSON.stringify({ version: 1, bootstrapSeededAt: new Date().toISOString() })}\n`,
      'utf8',
    );
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
  voice: 'bright banana baritone',
  thinkingLevel: 'deep',
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

/**
 * Truth table for the EXACT predicate the running gateway
 * (`resolveWorkspaceBootstrapStatus`, image 2026.6.10) uses per turn. If this
 * ever diverges from the bundled source, migrated agents silently regress to the
 * blank-slate ritual — so it is pinned here as a contract.
 */
describe('workspaceBootstrapStatus (mirrors OpenClaw resolveWorkspaceBootstrapStatus)', () => {
  let ws: string;
  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-bootstrap-status-'));
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  const writeState = (obj: unknown) =>
    fs.writeFile(path.join(ws, WORKSPACE_STATE_FILENAME), JSON.stringify(obj), 'utf8');
  const writeBootstrap = () => fs.writeFile(path.join(ws, BOOTSTRAP_FILENAME), '# BOOTSTRAP\n', 'utf8');

  it('complete: non-empty setupCompletedAt suppresses even when BOOTSTRAP.md is present', async () => {
    await writeState({ version: 1, setupCompletedAt: '2026-07-03T00:00:00.000Z' });
    await writeBootstrap();
    expect(await workspaceBootstrapStatus(ws)).toBe('complete');
  });

  it('complete: no BOOTSTRAP.md suppresses even without a setupCompletedAt', async () => {
    await writeState({ version: 1 });
    expect(await workspaceBootstrapStatus(ws)).toBe('complete');
  });

  it('complete: no state file at all + no BOOTSTRAP.md', async () => {
    expect(await workspaceBootstrapStatus(ws)).toBe('complete');
  });

  it('pending: BOOTSTRAP.md present AND setupCompletedAt missing (the poisoned seed state)', async () => {
    await writeState({ version: 1, bootstrapSeededAt: '2026-07-03T00:00:00.000Z' });
    await writeBootstrap();
    expect(await workspaceBootstrapStatus(ws)).toBe('pending');
  });

  it('pending: BOOTSTRAP.md present AND setupCompletedAt is an empty/whitespace string', async () => {
    await writeState({ version: 1, setupCompletedAt: '   ' });
    await writeBootstrap();
    expect(await workspaceBootstrapStatus(ws)).toBe('pending');
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
    // filesWritten covers the CONTENT templates; the bootstrap-suppression
    // marker is reported via bootstrapSuppressed, not filesWritten.
    const contentTemplates = templateNames.filter((n) => n !== WORKSPACE_STATE_FILENAME);
    expect(result.filesWritten.sort()).toEqual(contentTemplates);
    expect(result.filesSkipped).toEqual([]);
    expect(result.bootstrapSuppressed).toBe(true);
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
    expect(soul).toContain('Thinking level: deep.');
    const identity = await fs.readFile(path.join(result.hostWorkspaceDir, 'IDENTITY.md'), 'utf8');
    expect(identity).toContain('Voice: bright banana baritone');
    const memory = await fs.readFile(path.join(result.hostWorkspaceDir, 'MEMORY.md'), 'utf8');
    expect(memory).toContain('- Banny joined Eden in 2023.');
    const state = JSON.parse(
      await fs.readFile(path.join(result.hostWorkspaceDir, WORKSPACE_STATE_FILENAME), 'utf8'),
    ) as { version: number; setupCompletedAt: string };
    expect(state).toEqual({ version: 1, setupCompletedAt: '2026-07-03T00:00:00.000Z' });

    // memory dirs for the agent's own journals + per-user notes
    const usersDir = await fs.stat(path.join(result.hostWorkspaceDir, 'memory', 'users'));
    expect(usersDir.isDirectory()).toBe(true);
  });

  it('renders persona AFTER agents add — our SOUL beats the seeded default, ' +
    'BOOTSTRAP.md is removed, and the state marker suppresses the ritual', async () => {
    // FakeCli seeds OpenClaw's generic defaults on `agents add` (the real bug
    // trigger). Provisioning must overwrite them so our persona wins.
    const cli = new FakeCli();
    cli.seedWorkspaceDirs = new Map([['banny', path.join(dataDir, 'workspace-banny')]]);
    const provisioner = makeProvisioner({ cli });
    const result = await provisioner.provisionAgent(PARAMS);

    // registration happened before the render (add is in the call log)
    expect(result.registration).toBe('added');
    expect(result.bootstrapSuppressed).toBe(true);

    // (a) persona file contains OUR persona, not the seeded generic default
    const soul = await fs.readFile(path.join(result.hostWorkspaceDir, 'SOUL.md'), 'utf8');
    expect(soul).toContain('exuberant banana');
    expect(soul).not.toContain("You're not a chatbot");

    // (b) bootstrap-suppression state file exists with the right key
    const state = JSON.parse(
      await fs.readFile(path.join(result.hostWorkspaceDir, WORKSPACE_STATE_FILENAME), 'utf8'),
    ) as { version: number; setupCompletedAt?: string; bootstrapSeededAt?: string };
    expect(state.setupCompletedAt).toBe('2026-07-03T00:00:00.000Z');
    expect(state.bootstrapSeededAt).toBeUndefined(); // seed's marker was overwritten

    // BOOTSTRAP.md the seed dropped is gone (belt-and-suspenders suppression)
    expect(await fileExists(path.join(result.hostWorkspaceDir, BOOTSTRAP_FILENAME))).toBe(false);

    // the durable, restart-surviving contract: the workspace now resolves to
    // "complete" under the SAME predicate the gateway runs per turn — this is
    // exactly what a `docker restart` re-evaluates, so proving it here proves
    // restart-survival without a live gateway.
    expect(await workspaceBootstrapStatus(result.hostWorkspaceDir)).toBe('complete');
  });

  it('leaves the workspace bootstrap-complete after provisioning (restart-survival contract)', async () => {
    const cli = new FakeCli();
    cli.seedWorkspaceDirs = new Map([['banny', path.join(dataDir, 'workspace-banny')]]);
    const provisioner = makeProvisioner({ cli });
    const result = await provisioner.provisionAgent(PARAMS);
    // The gateway re-reads this predicate on every load, including after a
    // restart; "complete" here == no blank-slate ritual then.
    expect(await workspaceBootstrapStatus(result.hostWorkspaceDir)).toBe('complete');
  });

  it('fails loudly when bootstrap suppression is defeated (BOOTSTRAP.md reappears + empty marker)', async () => {
    // Simulate the worst-case regression: the state marker renders with an EMPTY
    // setupCompletedAt (so suppression would rely solely on BOOTSTRAP.md being
    // gone) AND a stray BOOTSTRAP.md reappears AFTER the provisioner removed it
    // (a late seed / hook / race). Under the real gateway predicate this flips
    // the workspace back to "pending" → blank-slate ritual on next load. The
    // read-back assertion (step 4b) must convert that into a hard failure.
    //
    // We inject the reappearance via a FakeCli subclass whose `agents list`
    // (called during findRegisteredAgent on a SECOND provision) re-drops
    // BOOTSTRAP.md — but simplest & most direct: override the marker writer to
    // leave an empty marker, then re-create BOOTSTRAP.md through a subclass hook
    // that runs after removal.
    const wsDir = path.join(dataDir, 'workspace-banny');
    const brokenTemplatesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-broken-tpl-'));
    for (const f of await fs.readdir(REAL_TEMPLATES_DIR)) {
      await fs.copyFile(path.join(REAL_TEMPLATES_DIR, f), path.join(brokenTemplatesDir, f));
    }
    await fs.writeFile(
      path.join(brokenTemplatesDir, WORKSPACE_STATE_FILENAME),
      JSON.stringify({ version: 1, setupCompletedAt: '' }) + '\n',
      'utf8',
    );

    /** Subclass that re-drops BOOTSTRAP.md strictly AFTER the provisioner's rm. */
    class RaceProvisioner extends AgentProvisioner {
      protected override async afterBootstrapSuppression(dir: string): Promise<void> {
        await fs.writeFile(path.join(dir, BOOTSTRAP_FILENAME), '# BOOTSTRAP\n', 'utf8');
      }
    }
    const provisioner = new RaceProvisioner({
      gateway: { baseUrl: 'http://gw.test', token: 'tok', fetchImpl: modelsFetch({
        ids: ['openclaw/main', 'openclaw/banny'],
      }).fetchImpl },
      cli: new FakeCli(),
      dataDir,
      templatesDir: brokenTemplatesDir,
      routableTimeoutMs: 2_000,
      routablePollIntervalMs: 10,
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });
    await expect(provisioner.provisionAgent(PARAMS)).rejects.toThrow(
      /bootstrap suppression failed.*blank-slate ritual/s,
    );
    // and the workspace really is in the pending state the assertion caught
    expect(await workspaceBootstrapStatus(wsDir)).toBe('pending');
    await fs.rm(brokenTemplatesDir, { recursive: true, force: true });
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

  it('skips existing content files without force and overwrites with force, ' +
    'but ALWAYS re-asserts the bootstrap-suppression marker', async () => {
    const provisioner = makeProvisioner({});
    const first = await provisioner.provisionAgent(PARAMS);
    const soulPath = path.join(first.hostWorkspaceDir, 'SOUL.md');
    const statePath = path.join(first.hostWorkspaceDir, WORKSPACE_STATE_FILENAME);
    await fs.writeFile(soulPath, 'hand-edited\n');
    // Simulate a stray BOOTSTRAP.md + a regressed state marker reappearing.
    await fs.writeFile(path.join(first.hostWorkspaceDir, BOOTSTRAP_FILENAME), 'stale\n');
    await fs.writeFile(statePath, `${JSON.stringify({ version: 1 })}\n`);

    const second = await provisioner.provisionAgent(PARAMS);
    // content files untouched (idempotent), so filesWritten is empty...
    expect(second.filesWritten).toEqual([]);
    expect(second.filesSkipped.sort()).toEqual(first.filesWritten.sort());
    expect(await fs.readFile(soulPath, 'utf8')).toBe('hand-edited\n');
    // ...but the marker is re-asserted and BOOTSTRAP.md re-removed every time.
    expect(second.bootstrapSuppressed).toBe(true);
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as { setupCompletedAt?: string };
    expect(state.setupCompletedAt).toBe('2026-07-03T00:00:00.000Z');
    expect(await fileExists(path.join(first.hostWorkspaceDir, BOOTSTRAP_FILENAME))).toBe(false);

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
      voice: 'quiet stone rasp',
      thinkingLevel: 'fast',
    });
    expect(updated.filesWritten).toEqual([...PERSONA_TEMPLATE_FILES]);

    const soul = await fs.readFile(path.join(first.hostWorkspaceDir, 'SOUL.md'), 'utf8');
    expect(soul).toContain('# Banny Prime');
    expect(soul).toContain('solemn sculptor');
    expect(soul).toContain('Thinking level: fast.');
    const identity = await fs.readFile(path.join(first.hostWorkspaceDir, 'IDENTITY.md'), 'utf8');
    expect(identity).toContain('Banny Prime');
    expect(identity).toContain('Reformed banana');
    expect(identity).toContain('Voice: quiet stone rasp');
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

  it('re-asserts the bootstrap-suppression marker (self-heals a wiped marker + stray BOOTSTRAP.md)', async () => {
    const provisioner = makeProvisioner({});
    const first = await provisioner.provisionAgent(PARAMS);

    // Simulate a workspace that has LOST its durable "onboarded" state after the
    // initial provision: the marker got emptied AND a BOOTSTRAP.md slipped back
    // in. Under OpenClaw's per-turn predicate this is the poisoned "pending"
    // state that would trigger the blank-slate ritual (and clobber the persona).
    await fs.writeFile(
      path.join(first.hostWorkspaceDir, WORKSPACE_STATE_FILENAME),
      `${JSON.stringify({ version: 1, setupCompletedAt: '' })}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(first.hostWorkspaceDir, BOOTSTRAP_FILENAME),
      '# BOOTSTRAP\n\nWho am I?\n',
      'utf8',
    );
    expect(await workspaceBootstrapStatus(first.hostWorkspaceDir)).toBe('pending');

    // Editing the persona in the studio must restore the durable suppression so
    // the agent keeps its (freshly edited) persona across the next turn/restart.
    const updated = await provisioner.updateAgentPersona({
      openclawId: 'banny',
      name: 'Banny Prime',
      username: 'banny',
      description: 'Reformed banana, now a sculptor',
      persona: 'You are Banny Prime, a solemn sculptor.',
      greeting: 'Welcome to the studio.',
    });
    expect(updated.bootstrapSuppressed).toBe(true);

    // Marker restored with a non-empty setupCompletedAt, stray BOOTSTRAP.md gone.
    const marker = JSON.parse(
      await fs.readFile(path.join(first.hostWorkspaceDir, WORKSPACE_STATE_FILENAME), 'utf8'),
    ) as { setupCompletedAt?: unknown };
    expect(typeof marker.setupCompletedAt).toBe('string');
    expect((marker.setupCompletedAt as string).length).toBeGreaterThan(0);
    expect(await fileExists(path.join(first.hostWorkspaceDir, BOOTSTRAP_FILENAME))).toBe(false);
    expect(await workspaceBootstrapStatus(first.hostWorkspaceDir)).toBe('complete');
  });
});
