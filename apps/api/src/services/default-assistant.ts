import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pg } from '@eden3/db';
import {
  BOOTSTRAP_FILENAME,
  WORKSPACE_STATE_FILENAME,
  mutateOpenClawConfig,
  readOpenClawConfig,
  renderTemplate,
  workspaceBootstrapStatus,
} from '@eden3/gateway';

export const DEFAULT_EDEN_USERNAME = 'eden';
export const DEFAULT_EDEN_OPENCLAW_ID = 'main';

const DEFAULT_EDEN_PROFILE = {
  name: 'Eden',
  description:
    'The default Eden assistant for learning the platform, exploring tools, and shaping new agents.',
  persona: [
    'You are Eden, the default assistant inside Eden3.',
    'Help users understand the platform, create and refine agents, choose tools, and troubleshoot their workflows.',
    'When users ask how to create an agent in Eden3, guide them to the Eden3 web UI: use Create agent at /agents/new for templates, or Agent builder at /agents/builder for an interview-driven draft.',
    'Do not tell Eden3 users to run command-line provisioning tools; those are internal implementation details, not the hosted product workflow.',
    'Be concrete and action-oriented. When a user wants to build an agent, ask only the next useful question and then help draft the persona, skills, and starter tasks.',
    'Do not claim access to private data unless it is visible in the current conversation or available through the Eden3 UI.',
  ].join('\n'),
  greeting:
    'I can help you explore Eden, generate media, configure agents, and turn an idea into a working assistant.',
};

export interface DefaultEdenAssistantResult {
  accountId: string;
  username: typeof DEFAULT_EDEN_USERNAME;
  openclawId: typeof DEFAULT_EDEN_OPENCLAW_ID;
}

export interface EnsureDefaultEdenAssistantOptions {
  /**
   * Also render the OpenClaw default workspace used by agent "main". This is
   * enabled only by the real API entrypoint so route tests can bootstrap @eden
   * without mutating the live OpenClaw data directory.
   */
  syncWorkspace?: boolean;
  dataDir?: string;
  now?: () => Date;
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WORKSPACE_TEMPLATES_DIR = path.join(REPO_ROOT, 'packages', 'gateway', 'workspace-templates');

export async function ensureDefaultEdenAssistant(
  options: EnsureDefaultEdenAssistantOptions = {},
): Promise<DefaultEdenAssistantResult> {
  const result: DefaultEdenAssistantResult = await pg.begin(async (sql) => {
    const [account] = await sql<{ id: string; type: 'user' | 'agent' }[]>`
      insert into accounts (type, username, updated_at)
      values ('agent', ${DEFAULT_EDEN_USERNAME}, now())
      on conflict (username) do update set updated_at = now()
      returning id, type
    `;
    if (!account) throw new Error('default Eden account upsert returned no row');
    if (account.type !== 'agent') {
      throw new Error(`default Eden username "${DEFAULT_EDEN_USERNAME}" is not an agent account`);
    }

    await sql`
      insert into agents (
        account_id, owner_id, name, description, persona, is_persona_public,
        greeting, public, openclaw_id, is_pilot, is_synthetic, provision_status,
        provisioned_at
      )
      values (
        ${account.id}, null, ${DEFAULT_EDEN_PROFILE.name},
        ${DEFAULT_EDEN_PROFILE.description}, ${DEFAULT_EDEN_PROFILE.persona},
        true, ${DEFAULT_EDEN_PROFILE.greeting}, true, ${DEFAULT_EDEN_OPENCLAW_ID},
        true, false, 'ready', now()
      )
      on conflict (account_id) do update set
        owner_id = null,
        name = excluded.name,
        description = excluded.description,
        persona = excluded.persona,
        is_persona_public = true,
        greeting = excluded.greeting,
        public = true,
        openclaw_id = excluded.openclaw_id,
        is_pilot = true,
        is_synthetic = false,
        provision_status = 'ready',
        provisioned_at = coalesce(agents.provisioned_at, now())
    `;

    return {
      accountId: account.id,
      username: DEFAULT_EDEN_USERNAME,
      openclawId: DEFAULT_EDEN_OPENCLAW_ID,
    } satisfies DefaultEdenAssistantResult;
  });
  if (options.syncWorkspace === true) {
    await syncDefaultEdenWorkspace({
      dataDir: options.dataDir,
      now: options.now,
    });
  }
  return result;
}

export interface SyncDefaultEdenWorkspaceOptions {
  dataDir?: string;
  now?: () => Date;
}

export async function syncDefaultEdenWorkspace(
  options: SyncDefaultEdenWorkspaceOptions = {},
): Promise<{ workspaceDir: string; filesWritten: string[] }> {
  const dataDir = options.dataDir ?? path.join(REPO_ROOT, 'infra', 'openclaw', 'data');
  const workspaceDir = path.join(dataDir, 'workspace');
  const now = options.now ?? (() => new Date());
  const vars = {
    NAME: DEFAULT_EDEN_PROFILE.name,
    USERNAME: DEFAULT_EDEN_USERNAME,
    DESCRIPTION: DEFAULT_EDEN_PROFILE.description,
    PERSONA: DEFAULT_EDEN_PROFILE.persona,
    GREETING: DEFAULT_EDEN_PROFILE.greeting,
    VOICE: 'clear, practical, product-native',
    THINKING_LEVEL: 'balanced',
    MEMORY_SEED: '',
    PROVISIONED_AT: now().toISOString(),
  };

  await fs.mkdir(workspaceDir, { recursive: true });
  const filesWritten: string[] = [];
  for (const relPath of ['SOUL.md', 'IDENTITY.md'] as const) {
    const raw = await fs.readFile(path.join(WORKSPACE_TEMPLATES_DIR, relPath), 'utf8');
    const rendered = renderTemplate(raw, vars);
    await fs.writeFile(path.join(workspaceDir, relPath), rendered, 'utf8');
    filesWritten.push(relPath);
  }

  const stateRaw = await fs.readFile(
    path.join(WORKSPACE_TEMPLATES_DIR, WORKSPACE_STATE_FILENAME),
    'utf8',
  );
  await fs.writeFile(
    path.join(workspaceDir, WORKSPACE_STATE_FILENAME),
    renderTemplate(stateRaw, vars),
    'utf8',
  );
  filesWritten.push(WORKSPACE_STATE_FILENAME);
  await fs.rm(path.join(workspaceDir, BOOTSTRAP_FILENAME), { force: true });

  const status = await workspaceBootstrapStatus(workspaceDir);
  if (status !== 'complete') {
    throw new Error(
      `default Eden workspace bootstrap suppression failed for ${workspaceDir}: ${status}`,
    );
  }

  await ensureMainAgentUsesDefaultWorkspace(dataDir);
  return { workspaceDir, filesWritten };
}

async function ensureMainAgentUsesDefaultWorkspace(dataDir: string): Promise<void> {
  // Preserve the historical best-effort behavior for a malformed/unreadable
  // config, but never use this unlocked read as the mutation snapshot.
  try {
    await readOpenClawConfig(dataDir);
  } catch {
    return;
  }
  await mutateOpenClawConfig(dataDir, (config) => {
    const agents = config.agents;
    const list =
      typeof agents === 'object' && agents !== null && !Array.isArray(agents)
        ? (agents as Record<string, unknown>).list
        : undefined;
    if (!Array.isArray(list)) return;
    const entry = list.find(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && item.id === DEFAULT_EDEN_OPENCLAW_ID,
    );
    if (!entry) return;
    const workspace = path.join(dataDir, 'workspace');
    entry.name = DEFAULT_EDEN_PROFILE.name;
    entry.workspace = workspace;
  });
}
