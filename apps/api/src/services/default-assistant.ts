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
import {
  DEFAULT_EVE_OPENCLAW_ID,
  DEFAULT_EVE_USERNAME,
  hardenPlatformEveRuntimeEntry,
  PLATFORM_EVE_TOOL_GROUPS,
} from './platform-eve';

export { DEFAULT_EVE_OPENCLAW_ID, DEFAULT_EVE_USERNAME, isPlatformEve } from './platform-eve';

/**
 * Eve is the one platform-owned assistant. Her database account may be
 * renamed during upgrades, but the shared-gateway identity must never move.
 */
export async function isPlatformEveAccountId(accountId: string | null): Promise<boolean> {
  if (accountId === null) return false;
  const [row] = await pg<{ isEve: boolean }[]>`
    select exists(
      select 1 from agents
      where account_id = ${accountId}
        and openclaw_id = ${DEFAULT_EVE_OPENCLAW_ID}
        and owner_id is null
    ) as "isEve"
  `;
  return row?.isEve ?? false;
}

export const PLATFORM_EVE_DATABASE_PROFILE = {
  name: 'Eve',
  description:
    'The platform-owned Eden assistant for learning the platform, exploring tools, and shaping new agents.',
  persona: [
    'You are Eve, the singular platform-owned assistant inside Eden3.',
    'Help users understand the platform, create and refine agents, choose tools, and troubleshoot their workflows.',
    'When users ask how to create an agent in Eden3, guide them to the Eden3 web UI: use Create agent at /agents/new for templates, or Agent builder at /agents/builder for an interview-driven draft.',
    'Do not tell Eden3 users to run command-line provisioning tools; those are internal implementation details, not the hosted product workflow.',
    'Be concrete and action-oriented. When a user wants to build an agent, ask only the next useful question and then help draft the persona, skills, and starter tasks.',
    'Do not claim access to private data unless it is visible in the current conversation or available through the Eden3 UI.',
  ].join('\n'),
  greeting:
    'I can help you explore Eden, generate media, configure agents, and turn an idea into a working assistant.',
};

export interface EveAssistantResult {
  accountId: string;
  username: typeof DEFAULT_EVE_USERNAME;
  openclawId: typeof DEFAULT_EVE_OPENCLAW_ID;
}

export interface EveBootstrapExistingIdentityPrecondition {
  accountId: string;
  username: string;
  accountStableHash: string;
  agentHash: string;
}

export interface EnsureEveAssistantOptions {
  /**
   * Also render the OpenClaw default workspace used by agent "main". This is
   * enabled only by the real API entrypoint so route tests can bootstrap @eve
   * without mutating the live OpenClaw data directory.
   */
  syncWorkspace?: boolean;
  dataDir?: string;
  now?: () => Date;
  /**
   * Optional deployment-repair fence. When supplied, the already-existing
   * OpenClaw main identity must still match this exact snapshot after the
   * bootstrap advisory lock and row locks are held, before any write occurs.
   */
  existingIdentityPrecondition?: EveBootstrapExistingIdentityPrecondition;
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WORKSPACE_TEMPLATES_DIR = path.join(REPO_ROOT, 'packages', 'gateway', 'workspace-templates');

export async function ensureEveAssistant(
  options: EnsureEveAssistantOptions = {},
): Promise<EveAssistantResult> {
  const result: EveAssistantResult = await pg.begin(async (sql) => {
    // A transaction-scoped lock makes concurrent API starts converge on one
    // account/runtime identity instead of briefly creating competing rows.
    await sql`select pg_advisory_xact_lock(hashtextextended('eden3:platform:eve', 0))`;

    const [existingRuntime] = await sql<
      {
        id: string;
        type: 'user' | 'agent';
        username: string;
        ownerId: string | null;
        accountStableHash: string;
        agentHash: string;
      }[]
    >`
      select a.id, a.type, a.username::text as username, g.owner_id as "ownerId",
             md5((to_jsonb(a) - 'username' - 'updated_at')::text) as "accountStableHash",
             md5(to_jsonb(g)::text) as "agentHash"
      from agents g
      join accounts a on a.id = g.account_id
      where g.openclaw_id = ${DEFAULT_EVE_OPENCLAW_ID}
      for update of a, g
    `;

    const precondition = options.existingIdentityPrecondition;
    if (
      precondition &&
      (!existingRuntime ||
        existingRuntime.id !== precondition.accountId ||
        existingRuntime.username.toLowerCase() !== precondition.username.toLowerCase() ||
        existingRuntime.accountStableHash !== precondition.accountStableHash ||
        existingRuntime.agentHash !== precondition.agentHash)
    ) {
      throw new Error('platform Eve bootstrap identity changed after reconciliation phase 1');
    }

    let account: {
      id: string;
      type: 'user' | 'agent';
      username: string;
      ownerId: string | null;
    } | undefined = existingRuntime;
    if (account) {
      if (account.type !== 'agent' || account.ownerId !== null) {
        throw new Error('OpenClaw main is not a platform-owned agent; refusing to replace it with Eve');
      }
      if (account.username.toLowerCase() !== DEFAULT_EVE_USERNAME) {
        const [collision] = await sql<{ id: string }[]>`
          select id from accounts where username = ${DEFAULT_EVE_USERNAME} for update
        `;
        if (collision && collision.id !== account.id) {
          throw new Error(`reserved username "${DEFAULT_EVE_USERNAME}" belongs to another account`);
        }
        await sql`
          update accounts
          set username = ${DEFAULT_EVE_USERNAME}, updated_at = now()
          where id = ${account.id}
        `;
        account = { ...account, username: DEFAULT_EVE_USERNAME };
      }
    } else {
      const [candidate] = await sql<{ id: string; type: 'user' | 'agent'; username: string }[]>`
        insert into accounts (type, username, updated_at)
        values ('agent', ${DEFAULT_EVE_USERNAME}, now())
        on conflict (username) do update set updated_at = now()
        returning id, type, username::text as username
      `;
      if (!candidate) throw new Error('Eve account upsert returned no row');
      if (candidate.type !== 'agent') {
        throw new Error(`reserved username "${DEFAULT_EVE_USERNAME}" is not an agent account`);
      }
      const [candidateAgent] = await sql<{ ownerId: string | null; openclawId: string | null }[]>`
        select owner_id as "ownerId", openclaw_id as "openclawId"
        from agents where account_id = ${candidate.id} for update
      `;
      if (
        candidateAgent &&
        (candidateAgent.ownerId !== null ||
          (candidateAgent.openclawId !== null &&
            candidateAgent.openclawId !== DEFAULT_EVE_OPENCLAW_ID))
      ) {
        throw new Error('reserved Eve account is not platform-owned; refusing to repurpose it');
      }
      account = { ...candidate, ownerId: null };
    }

    await sql`
      insert into agents (
        account_id, owner_id, name, description, persona, is_persona_public,
        greeting, public, openclaw_id, tool_groups, is_pilot, is_synthetic,
        provision_status, provisioned_at
      )
      values (
        ${account.id}, null, ${PLATFORM_EVE_DATABASE_PROFILE.name},
        ${PLATFORM_EVE_DATABASE_PROFILE.description}, ${PLATFORM_EVE_DATABASE_PROFILE.persona},
        true, ${PLATFORM_EVE_DATABASE_PROFILE.greeting}, true, ${DEFAULT_EVE_OPENCLAW_ID},
        ${pg.json(JSON.stringify(PLATFORM_EVE_TOOL_GROUPS))}, true, false, 'ready', now()
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
        tool_groups = excluded.tool_groups,
        is_pilot = true,
        is_synthetic = false,
        provision_status = 'ready',
        provisioned_at = coalesce(agents.provisioned_at, now())
    `;

    return {
      accountId: account.id,
      username: DEFAULT_EVE_USERNAME,
      openclawId: DEFAULT_EVE_OPENCLAW_ID,
    } satisfies EveAssistantResult;
  });
  if (options.syncWorkspace === true) {
    await syncEveWorkspace({
      dataDir: options.dataDir,
      now: options.now,
    });
  }
  return result;
}

export interface SyncEveWorkspaceOptions {
  dataDir?: string;
  now?: () => Date;
}

export async function syncEveWorkspace(
  options: SyncEveWorkspaceOptions = {},
): Promise<{ workspaceDir: string; filesWritten: string[] }> {
  const dataDir = options.dataDir ?? path.join(REPO_ROOT, 'infra', 'openclaw', 'data');
  const workspaceDir = path.join(dataDir, 'workspace');
  const now = options.now ?? (() => new Date());
  const vars = {
    NAME: PLATFORM_EVE_DATABASE_PROFILE.name,
    USERNAME: DEFAULT_EVE_USERNAME,
    DESCRIPTION: PLATFORM_EVE_DATABASE_PROFILE.description,
    PERSONA: PLATFORM_EVE_DATABASE_PROFILE.persona,
    GREETING: PLATFORM_EVE_DATABASE_PROFILE.greeting,
    VOICE: 'clear, practical, product-native',
    THINKING_LEVEL: 'balanced',
    MEMORY_SEED: '',
    PROVISIONED_AT: now().toISOString(),
  };

  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.join(workspaceDir, 'memory', 'users'), { recursive: true });
  const filesWritten: string[] = [];
  // The platform assistant owns a complete doctrine set. Per-user memories
  // live below memory/users/ and are deliberately not part of these files.
  for (const relPath of [
    'AGENTS.md',
    'HEARTBEAT.md',
    'IDENTITY.md',
    'MEMORY.md',
    'SOUL.md',
    'TOOLS.md',
    'USER.md',
  ] as const) {
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
      `Eve workspace bootstrap suppression failed for ${workspaceDir}: ${status}`,
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
        typeof item === 'object' && item !== null && item.id === DEFAULT_EVE_OPENCLAW_ID,
    );
    if (!entry) return;
    const workspace = path.join(dataDir, 'workspace');
    entry.name = PLATFORM_EVE_DATABASE_PROFILE.name;
    entry.workspace = workspace;
    hardenPlatformEveRuntimeEntry(entry);
  });
}
