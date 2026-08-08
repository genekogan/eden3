import { randomUUID } from 'node:crypto';

import { DEV_USER_COOKIE } from '@eden3/core';
import { pg } from '@eden3/db';
import type {
  ProvisionAgentParams,
  ProvisionAgentResult,
  SyncTriggerResult,
  UpdatePersonaParams,
} from '@eden3/gateway';

import type {
  CronSyncLike,
  ProvisionerLike,
  SkillSyncLike,
  SkillSyncParams,
  ToolSyncLike,
  ToolSyncParams,
} from '../src/gateway-glue';

/**
 * Shared fixtures for the route tests: live-Postgres row factories with a
 * unique per-run marker (tests run against the real dev database, which may
 * hold ETL data — every fixture username/regexp is marker-prefixed and
 * hard-deleted afterwards), plus fake gateway provisioner/cron-sync
 * implementations that record their calls.
 */

export function makeMarker(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/**
 * The shared `pg` client is wrapped by drizzle, which strips its Date
 * serializers — raw-query timestamptz params must be ISO strings.
 */
function ts(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}

export function devCookie(accountId: string): string {
  return `${DEV_USER_COOKIE}=${accountId}`;
}

/** Random 24-hex "legacy Mongo id" for external_id fixtures. */
export function fakeHex24(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

export async function insertUserAccount(
  username: string,
  opts: { externalId?: string } = {},
): Promise<string> {
  const rows = await pg<{ id: string }[]>`
    insert into accounts (type, username, external_id)
    values ('user', ${username}, ${opts.externalId ?? null})
    returning id
  `;
  return rows[0]!.id;
}

export interface AgentFixtureOptions {
  ownerId?: string | null;
  name?: string | null;
  description?: string | null;
  persona?: string | null;
  isPersonaPublic?: boolean;
  greeting?: string | null;
  public?: boolean;
  openclawId?: string | null;
  workspacePath?: string | null;
  isPilot?: boolean;
  provisionStatus?: string;
  provisionedAt?: Date | null;
  createdAt?: Date;
  externalId?: string;
}

export async function insertAgentAccount(
  username: string,
  opts: AgentFixtureOptions = {},
): Promise<string> {
  const rows = await pg<{ id: string }[]>`
    insert into accounts (type, username, external_id, created_at)
    values ('agent', ${username}, ${opts.externalId ?? null}, ${ts(opts.createdAt)})
    returning id
  `;
  const accountId = rows[0]!.id;
  await pg`
    insert into agents (account_id, owner_id, name, description, persona,
                        is_persona_public, greeting, public, openclaw_id,
                        workspace_path, is_pilot, provision_status, provisioned_at)
    values (${accountId}, ${opts.ownerId ?? null}, ${opts.name ?? null},
            ${opts.description ?? null}, ${opts.persona ?? null},
            ${opts.isPersonaPublic ?? false}, ${opts.greeting ?? null},
            ${opts.public ?? true}, ${opts.openclawId ?? null},
            ${opts.workspacePath ?? null}, ${opts.isPilot ?? false},
            ${opts.provisionStatus ?? 'pending'},
            ${opts.provisionedAt === undefined ? null : opts.provisionedAt ? ts(opts.provisionedAt) : null})
  `;
  return accountId;
}

export interface CreationFixtureOptions {
  userId?: string | null;
  agentId?: string | null;
  tool?: string | null;
  url?: string | null;
  thumbnailUrl?: string | null;
  attributes?: unknown;
  public?: boolean;
  deleted?: boolean;
  createdAt?: Date;
  externalId?: string;
}

export async function insertCreation(opts: CreationFixtureOptions = {}): Promise<string> {
  const attributes = opts.attributes === undefined ? null : JSON.stringify(opts.attributes);
  const rows = await pg<{ id: string }[]>`
    insert into creations (external_id, user_id, agent_id, tool, url,
                           thumbnail_url, attributes, public, deleted, created_at)
    values (${opts.externalId ?? null}, ${opts.userId ?? null}, ${opts.agentId ?? null},
            ${opts.tool ?? 'create'}, ${opts.url ?? null}, ${opts.thumbnailUrl ?? null},
            ${attributes}::jsonb, ${opts.public ?? true}, ${opts.deleted ?? false},
            ${ts(opts.createdAt)})
    returning id
  `;
  return rows[0]!.id;
}

export interface CollectionFixtureOptions {
  userId?: string | null;
  name?: string | null;
  public?: boolean;
  deleted?: boolean;
  createdAt?: Date;
  externalId?: string;
}

export async function insertCollection(opts: CollectionFixtureOptions = {}): Promise<string> {
  const rows = await pg<{ id: string }[]>`
    insert into collections (external_id, user_id, name, public, deleted, created_at)
    values (${opts.externalId ?? null}, ${opts.userId ?? null}, ${opts.name ?? null},
            ${opts.public ?? true}, ${opts.deleted ?? false}, ${ts(opts.createdAt)})
    returning id
  `;
  return rows[0]!.id;
}

export async function addCollectionCreation(
  collectionId: string,
  creationId: string,
  position: number | null,
): Promise<void> {
  await pg`
    insert into collection_creations (collection_id, creation_id, position)
    values (${collectionId}, ${creationId}, ${position})
  `;
}

// ---------------------------------------------------------------------------
// Cleanup — FK-safe hard delete of everything hanging off marker accounts
// ---------------------------------------------------------------------------

export async function deleteFixturesByMarker(marker: string): Promise<void> {
  const pattern = `${marker}%`;
  await pg`delete from manna_vouchers where code::text like ${pattern}`;
  await pg`delete from distill_state where username::text like ${pattern} or openclaw_id like ${pattern}`;
  const ids = (
    await pg<{ id: string }[]>`select id from accounts where username like ${pattern}`
  ).map((row) => row.id);
  await pg`delete from skill_definitions where slug like ${pattern}`;
  if (ids.length === 0) return;
  await pg`delete from content_reports where reporter_id = any(${ids}::uuid[]) or target_id = any(${ids}::uuid[])`;
  await pg`delete from agent_skills where agent_id = any(${ids}::uuid[])`;
  await pg`
    delete from usage_events
    where user_id = any(${ids}::uuid[])
       or agent_id = any(${ids}::uuid[])
       or session_id in (select id from sessions where owner_id = any(${ids}::uuid[]))
       or message_id in (select id from messages where sender_id = any(${ids}::uuid[]))
  `;
  await pg`
    delete from secret_access_audit_events
    where owner_account_id = any(${ids}::uuid[])
       or actor_account_id = any(${ids}::uuid[])
  `;
  await pg`
    delete from channel_turns
    where account_id = any(${ids}::uuid[])
       or agent_id = any(${ids}::uuid[])
       or connection_id in (
         select id from channel_connections
         where account_id = any(${ids}::uuid[]) or agent_id = any(${ids}::uuid[]))
  `;
  await pg`delete from channel_connections where account_id = any(${ids}::uuid[]) or agent_id = any(${ids}::uuid[])`;
  await pg`
    delete from messages
    where sender_id = any(${ids}::uuid[])
       or session_id in (select id from sessions where owner_id = any(${ids}::uuid[]))
  `;
  await pg`
    delete from collection_creations
    where collection_id in (select id from collections where user_id = any(${ids}::uuid[]))
       or creation_id in (
         select id from creations
         where user_id = any(${ids}::uuid[]) or agent_id = any(${ids}::uuid[]))
  `;
  await pg`
    delete from creation_likes
    where user_id = any(${ids}::uuid[])
       or creation_id in (
         select id from creations
         where user_id = any(${ids}::uuid[]) or agent_id = any(${ids}::uuid[]))
  `;
  await pg`
    delete from agent_likes
    where user_id = any(${ids}::uuid[])
       or agent_id = any(${ids}::uuid[])
  `;
  await pg`delete from collections where user_id = any(${ids}::uuid[])`;
  await pg`delete from creations where user_id = any(${ids}::uuid[]) or agent_id = any(${ids}::uuid[])`;
  await pg`delete from triggers where user_id = any(${ids}::uuid[]) or agent_id = any(${ids}::uuid[])`;
  await pg`delete from billing_subscriptions where account_id = any(${ids}::uuid[])`;
  await pg`delete from distill_state where agent_account_id = any(${ids}::uuid[])`;
  // Authorization rows FK-reference the ledger (reservation_tx_id) — remove
  // them first (T08-U02).
  await pg`
    delete from turn_authorizations
    where account_id = any(${ids}::uuid[]) or agent_account_id = any(${ids}::uuid[])
  `;
  await pg`
    delete from manna_transactions
    where manna_account_id in (select id from manna_accounts where account_id = any(${ids}::uuid[]))
  `;
  await pg`delete from manna_accounts where account_id = any(${ids}::uuid[])`;
  await pg`delete from session_agents where agent_account_id = any(${ids}::uuid[])`;
  await pg`delete from session_users where user_account_id = any(${ids}::uuid[])`;
  await pg`delete from sessions where owner_id = any(${ids}::uuid[])`;
  // Detach agents owned by fixture accounts but created under other usernames
  // (e.g. the integration test's apitest-* agent) so the account delete works
  // even when a crashed run left them behind.
  await pg`update agents set owner_id = null where owner_id = any(${ids}::uuid[])`;
  await pg`delete from agents where account_id = any(${ids}::uuid[])`;
  await pg`delete from accounts where id = any(${ids}::uuid[])`;
}

// ---------------------------------------------------------------------------
// Fake gateway seams
// ---------------------------------------------------------------------------

export interface FakeProvisioner extends ProvisionerLike {
  provisions: ProvisionAgentParams[];
  personaUpdates: UpdatePersonaParams[];
}

export function makeFakeProvisioner(
  opts: { failProvision?: boolean; failPersonaUpdate?: boolean } = {},
): FakeProvisioner {
  const provisions: ProvisionAgentParams[] = [];
  const personaUpdates: UpdatePersonaParams[] = [];
  return {
    provisions,
    personaUpdates,
    async provisionAgent(params): Promise<ProvisionAgentResult> {
      provisions.push(params);
      if (opts.failProvision === true) throw new Error('fake provision failure');
      return {
        openclawId: params.openclawId,
        hostWorkspaceDir: `/tmp/fake-workspaces/workspace-${params.openclawId}`,
        containerWorkspaceDir: `/home/node/.openclaw/workspace-${params.openclawId}`,
        filesWritten: ['SOUL.md', 'IDENTITY.md'],
        filesSkipped: [],
        registration: 'added',
        modelUpdated: false,
        bootstrapSuppressed: true,
      };
    },
    async updateAgentPersona(params): ReturnType<ProvisionerLike['updateAgentPersona']> {
      personaUpdates.push(params);
      if (opts.failPersonaUpdate === true) throw new Error('fake persona doctrine failure');
      return { filesWritten: ['SOUL.md', 'IDENTITY.md'], bootstrapSuppressed: true };
    },
  };
}

export interface FakeCronSync extends CronSyncLike {
  /** Trigger ids whose gateway-job removal was requested, in call order. */
  removals: string[];
  /** Count of removeAllEden3Jobs boot sweeps. */
  sweeps: number;
}

/**
 * Removal-only cron seam (scheduled firing is eden3-side; the gateway only
 * ever gets REMOVE calls now — see services/task-scheduler.ts).
 */
export function makeFakeCronSync(opts: { fail?: boolean } = {}): FakeCronSync {
  const fake: FakeCronSync = {
    removals: [],
    sweeps: 0,
    async removeTrigger(triggerId): Promise<SyncTriggerResult> {
      fake.removals.push(triggerId);
      if (opts.fail === true) throw new Error('fake cron-sync failure');
      return { name: `eden3:${triggerId}`, action: 'absent' };
    },
    async removeAllEden3Jobs(): Promise<{ removed: number }> {
      fake.sweeps += 1;
      if (opts.fail === true) throw new Error('fake cron-sync failure');
      return { removed: 0 };
    },
  };
  return fake;
}

export interface FakeSkillSync extends SkillSyncLike {
  calls: SkillSyncParams[];
}

export function makeFakeSkillSync(): FakeSkillSync {
  const calls: SkillSyncParams[] = [];
  return {
    calls,
    async syncAgentSkills(params) {
      calls.push(params);
      return { changed: true };
    },
  };
}

export interface FakeToolSync extends ToolSyncLike {
  calls: ToolSyncParams[];
}

export function makeFakeToolSync(): FakeToolSync {
  const calls: ToolSyncParams[] = [];
  return {
    calls,
    async syncAgentToolGroups(params) {
      calls.push(params);
      return { changed: true };
    },
  };
}
