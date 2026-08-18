import { pg } from '@eden3/db';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_EVE_OPENCLAW_ID,
  DEFAULT_EVE_USERNAME,
  PLATFORM_EVE_DATABASE_PROFILE,
} from '../services/default-assistant';
import { PLATFORM_EVE_TOOL_GROUPS } from '../services/platform-eve';

import {
  cleanupE2EScratchUser,
  parseE2EScratchApiUrl,
  parseE2EScratchDatabaseUrl,
  preflightE2EScratchUser,
  seedE2EScratchUser,
  type E2EScratchFixtureRepository,
  type E2EScratchSideEffects,
  type E2EScratchUser,
} from './e2e-scratch-fixture';

/**
 * Test-only disposable-Postgres fixture seam. Run through:
 *   DATABASE_URL=postgres://.../eden3_runtime_e2e_<run> pnpm --filter @eden3/api exec tsx src/testing/e2e-scratch-fixture-cli.ts seed
 * and, after the alt-port API is healthy, the same command with `preflight`
 * plus a loopback API_URL. It refuses protected/shared databases before its
 * first query and never reads or copies a real account.
 */

interface QuerySql {
  <T extends readonly object[] = Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...parameters: unknown[]
  ): PromiseLike<T>;
  unsafe<T extends readonly object[] = Record<string, unknown>[]>(query: string): PromiseLike<T>;
}

function queryOnly(sql: unknown): QuerySql {
  return sql as QuerySql;
}

export function postgresRepository(
  sql: QuerySql,
  begin?: <T>(operation: (transaction: QuerySql) => Promise<T>) => Promise<T>,
): E2EScratchFixtureRepository {
  const repository: E2EScratchFixtureRepository = {
    transaction: (operation) =>
      begin
        ? begin((transaction) => operation(postgresRepository(transaction)))
        : operation(repository),
    async currentDatabase() {
      const [row] = await sql<{ databaseName: string }[]>`
        select current_database()::text as "databaseName"
      `;
      if (!row) throw new Error('scratch fixture database identity was empty');
      return row.databaseName;
    },
    async accountRows(options = {}) {
      return options.forUpdate
        ? await sql`
            select a.id::text,
                   a.type,
                   a.username::text,
                   a.external_id as "externalId",
                   a.clerk_user_id as "clerkUserId",
                   a.user_image as "userImage",
                   a.deleted,
                   g.owner_id as "ownerId",
                   g.openclaw_id as "openclawId",
                   (
                     a.username = ${DEFAULT_EVE_USERNAME}
                     and g.owner_id is null
                     and g.name = ${PLATFORM_EVE_DATABASE_PROFILE.name}
                     and g.description = ${PLATFORM_EVE_DATABASE_PROFILE.description}
                     and g.persona = ${PLATFORM_EVE_DATABASE_PROFILE.persona}
                     and g.is_persona_public = true
                     and g.greeting = ${PLATFORM_EVE_DATABASE_PROFILE.greeting}
                     and g.public = true
                     and g.openclaw_id = ${DEFAULT_EVE_OPENCLAW_ID}
                     and g.tool_groups = ${JSON.stringify(PLATFORM_EVE_TOOL_GROUPS)}::jsonb
                     and g.is_pilot = true
                     and g.is_synthetic = false
                     and g.provision_status = 'ready'
                     and g.provisioned_at is not null
                   ) as "bootstrapCanonical"
            from accounts a
            left join agents g on g.account_id = a.id
            order by a.id
            for update of a
          `
        : await sql`
            select a.id::text,
                   a.type,
                   a.username::text,
                   a.external_id as "externalId",
                   a.clerk_user_id as "clerkUserId",
                   a.user_image as "userImage",
                   a.deleted,
                   g.owner_id as "ownerId",
                   g.openclaw_id as "openclawId",
                   (
                     a.username = ${DEFAULT_EVE_USERNAME}
                     and g.owner_id is null
                     and g.name = ${PLATFORM_EVE_DATABASE_PROFILE.name}
                     and g.description = ${PLATFORM_EVE_DATABASE_PROFILE.description}
                     and g.persona = ${PLATFORM_EVE_DATABASE_PROFILE.persona}
                     and g.is_persona_public = true
                     and g.greeting = ${PLATFORM_EVE_DATABASE_PROFILE.greeting}
                     and g.public = true
                     and g.openclaw_id = ${DEFAULT_EVE_OPENCLAW_ID}
                     and g.tool_groups = ${JSON.stringify(PLATFORM_EVE_TOOL_GROUPS)}::jsonb
                     and g.is_pilot = true
                     and g.is_synthetic = false
                     and g.provision_status = 'ready'
                     and g.provisioned_at is not null
                   ) as "bootstrapCanonical"
            from accounts a
            left join agents g on g.account_id = a.id
            order by a.id
          `;
    },
    async insertUser(fixture) {
      await sql`
        insert into accounts
          (id, type, username, external_id, clerk_user_id, user_image, deleted)
        values
          (${fixture.id}, ${fixture.type}, ${fixture.username}, null, null, null, false)
      `;
    },
    async sideEffectCounts() {
      const [counts] = await sql<E2EScratchSideEffects[]>`
        select (select count(*)::int from accounts) as "accountCount",
               (select count(*)::int from agents) as "agentCount",
               (select count(*)::int from sessions) as "sessionCount",
               (select count(*)::int from usage_events) as "usageCount",
               (select count(*)::int from turn_provider_runs) as "providerRunCount",
               (select count(*)::int from manna_accounts) as "mannaAccountCount",
               (select count(*)::int from manna_transactions) as "mannaTransactionCount",
               (select count(*)::int from agent_voice_assignments) as "agentVoiceAssignmentCount",
               (select count(*)::int from voice_clones) as "voiceCloneCount",
               (select count(*)::int from voice_clone_clips) as "voiceCloneClipCount",
               (select count(*)::int from voice_quotes) as "voiceQuoteCount",
               (select count(*)::int from voice_executions) as "voiceExecutionCount",
               (select count(*)::int from direct_voice_jobs) as "directVoiceJobCount",
               (select count(*)::int from transcription_sessions) as "transcriptionSessionCount",
               (select count(*)::int from transcription_chunks) as "transcriptionChunkCount",
               (select count(*)::int from storage_uploads) as "storageUploadCount",
               (select count(*)::int from storage_objects) as "storageObjectCount"
      `;
      if (!counts) throw new Error('scratch fixture side-effect inventory was empty');
      return counts;
    },
    async deleteExactUser(fixture: E2EScratchUser) {
      const rows = await sql<{ id: string }[]>`
        delete from accounts
        where id = ${fixture.id}
          and type = ${fixture.type}
          and username = ${fixture.username}
          and external_id is null
          and clerk_user_id is null
          and user_image is null
          and deleted = false
        returning id::text
      `;
      return rows.map((row) => row.id);
    },
  };
  return repository;
}

export const e2eScratchPostgresRepository = postgresRepository(
  queryOnly(pg),
  async (operation) =>
  (await pg.begin((sql) => operation(queryOnly(sql)))) as Awaited<ReturnType<typeof operation>>,
);

async function seed(databaseName: string) {
  const result = await seedE2EScratchUser({
    repository: e2eScratchPostgresRepository,
    databaseName,
  });
  return { ok: true, action: result.action, databaseName, userId: result.fixture.id };
}

async function preflight(databaseName: string, rawApiUrl: string) {
  const apiUrl = parseE2EScratchApiUrl(rawApiUrl);
  const fixture = await preflightE2EScratchUser({
    repository: e2eScratchPostgresRepository,
    databaseName,
    fetchUsers: async () => {
      const response = await fetch(new URL('/dev/users?q=alex', apiUrl), {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('isolated E2E API user preflight failed');
      return response.json();
    },
  });
  return { ok: true, databaseName, userId: fixture.id, sideEffects: 'none' };
}

async function cleanup(databaseName: string) {
  const result = await cleanupE2EScratchUser({
    repository: e2eScratchPostgresRepository,
    databaseName,
  });
  return { ok: true, databaseName, userId: result.fixture.id, removed: result.removed };
}

async function main() {
  const command = process.argv[2];
  const rawDatabaseUrl = process.env.DATABASE_URL;
  if (!rawDatabaseUrl) throw new Error('DATABASE_URL is required');
  const { databaseName } = parseE2EScratchDatabaseUrl(rawDatabaseUrl);
  if (command === 'seed') return seed(databaseName);
  if (command === 'preflight') {
    const apiUrl = process.env.API_URL;
    if (!apiUrl) throw new Error('API_URL is required for preflight');
    return preflight(databaseName, apiUrl);
  }
  if (command === 'cleanup') return cleanup(databaseName);
  throw new Error('usage: e2e-scratch-fixture-cli.ts seed|preflight|cleanup');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
      process.exitCode = 1;
    })
    .finally(() => pg.end({ timeout: 5 }));
}
