import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  credit,
  gatewaySessionKey,
  getBalance,
  LocalMediaStore,
  type DbHandle,
  type MediaPutOptions,
  type MediaPutResult,
  type MediaStore,
} from '@eden3/core';
import { db, pg, sessions } from '@eden3/db';
import Fastify from 'fastify';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { requireAuth } from '../../src/auth-plugin';
import { ApiError } from '../../src/errors';
import { EventsBus } from '../../src/events-bus';
import { collectionsRoutes } from '../../src/routes/collections';
import { conceptsRoutes } from '../../src/routes/concepts';
import { agentsRoutes } from '../../src/routes/agents';
import {
  AccountErasureRecoveryWorker,
  accountErasureLedgerSha256,
  accountErasureManifestSha256,
  requestAccountErasure,
  type AccountErasureLedgerSink,
  type AccountErasureRecoveryManifestSink,
} from '../../src/services/account-erasure';
import {
  AccountErasureTargetWorker,
  attestAccountErasureLegacyMediaBoundary,
  attestAccountErasureDatabaseBoundary,
  type AccountErasureDatabaseBoundary,
  PostgresAccountErasureStore,
  PostgresAccountErasurePresealReconciler,
  PostgresAccountErasureTargetStore,
  LocalLegacyErasureExecutor,
} from '../../src/services/account-erasure-postgres';
import { PostgresUploadMultipartCleanupStore } from '../../src/services/upload-multipart-cleanup-postgres';
import { UploadMultipartCleanupWorker } from '../../src/services/upload-multipart-cleanup';
import { HistorySync } from '../../src/services/history-sync';
import { reconcileAgentRuntime } from '../../src/services/agent-runtime-sync';
import { legacyMediaIsPubliclyReachable } from '../../src/services/legacy-media-visibility';
import {
  EdenMemoryDreamAgentRunner,
  type MemoryDreamCheckpoint,
  type MemoryDreamDurability,
} from '../../src/services/memory-dreaming';
import {
  admitStudioGeneration,
  compensateStudioGeneration,
  reserveStudioGeneration,
} from '../../src/services/studio-reservations';
import {
  compensateChatMedia,
  quoteChatMediaTool,
  reserveChatMedia,
} from '../../src/services/chat-media-authorization';
import { TurnRegistry } from '../../src/services/turn-registry';
import { runTurn, type CompatClientLike } from '../../src/services/turns';
import {
  ChannelTurnMeteringService,
  PostgresChannelTurnStore,
} from '../../src/services/channel-metering';
import { makeFakeProvisioner, makeFakeToolSync } from '../fixtures';
import { PrivateTranscriptionAudioStore } from '../../src/services/transcription-audio-custody';
import { PostgresTranscriptionRepository } from '../../src/services/transcription-postgres';
import {
  DeterministicTranscriptionProvider,
  TranscriptionService,
} from '../../src/services/transcriptions';

const databaseName = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/invalid')
  .pathname.slice(1);
if (!/^t12u03_runtime_(?:0041_)?[a-f0-9]{8}$/.test(databaseName)) {
  throw new Error(`refusing non-disposable account-erasure runtime database ${databaseName}`);
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const roleSuffix = databaseName.slice(-8);
const OPERATOR_LOGIN = `t12u03_erasure_${roleSuffix}`;
const ORDINARY_LOGIN = `t12u03_app_${roleSuffix}`;
const OPERATOR_PASSWORD = `op_${roleSuffix}_${randomUUID().replaceAll('-', '')}`;
const ORDINARY_PASSWORD = `app_${roleSuffix}_${randomUUID().replaceAll('-', '')}`;
let operatorPg: ReturnType<typeof postgres>;
let ordinaryPg: ReturnType<typeof postgres>;
let ordinaryDb: DbHandle;
let ERASURE_DB_BOUNDARY: AccountErasureDatabaseBoundary;
const erasureStore = () => new PostgresAccountErasureStore({
  databaseBoundary: ERASURE_DB_BOUNDARY,
});
const erasureTargetStore = (legacyMediaRoot = join(tmpdir(), 'eden3-erasure-default-media')) => {
  mkdirSync(legacyMediaRoot, { recursive: true });
  return new PostgresAccountErasureTargetStore({
    databaseBoundary: ERASURE_DB_BOUNDARY,
    legacyMediaBoundary: attestAccountErasureLegacyMediaBoundary(legacyMediaRoot),
  });
};
const HUMAN = '10000000-0000-4000-8000-000000000001';
const AGENT = '10000000-0000-4000-8000-000000000002';
const FOREIGN = '10000000-0000-4000-8000-000000000003';
const HUMAN_OBJECT = '20000000-0000-4000-8000-000000000001';
const AGENT_OBJECT = '20000000-0000-4000-8000-000000000002';
const UPLOAD = '30000000-0000-4000-8000-000000000001';
const PRIVATE_SESSION = '40000000-0000-4000-8000-000000000001';
const SHARED_SESSION = '40000000-0000-4000-8000-000000000002';
const FOREIGN_SESSION = '40000000-0000-4000-8000-000000000003';
const PRIVATE_MESSAGE = '50000000-0000-4000-8000-000000000001';
const SHARED_OWN_MESSAGE = '50000000-0000-4000-8000-000000000002';
const SHARED_FOREIGN_MESSAGE = '50000000-0000-4000-8000-000000000003';
const FOREIGN_OWN_MESSAGE = '50000000-0000-4000-8000-000000000004';
const FOREIGN_FOREIGN_MESSAGE = '50000000-0000-4000-8000-000000000005';
const COLLECTION = '60000000-0000-4000-8000-000000000001';
const FOREIGN_COLLECTION = '60000000-0000-4000-8000-000000000002';
const UNRELATED_COLLECTION = '60000000-0000-4000-8000-000000000003';
const OWN_CREATION = '60000000-0000-4000-8000-000000000004';
const FOREIGN_CREATION = '60000000-0000-4000-8000-000000000005';
const TURN = '70000000-0000-4000-8000-000000000001';
const CONCEPT = '80000000-0000-4000-8000-000000000001';
const CONCEPT_IMAGE = '80000000-0000-4000-8000-000000000002';
const USER_SKILL = '90000000-0000-4000-8000-000000000001';
const CHECKOUT_INTENT = '90000000-0000-4000-8000-000000000004';
const FOREIGN_SKILL = '90000000-0000-4000-8000-000000000005';
const PRIVACY_SWEEP = '90000000-0000-4000-8000-000000000006';
const CHANNEL_CONNECTION = '90000000-0000-4000-8000-000000000007';
const OUTBOUND_INTENT = '90000000-0000-4000-8000-000000000008';
const FOREIGN_MEDIA = '90000000-0000-4000-8000-000000000002';
const PRIVATE_MEDIA = '90000000-0000-4000-8000-000000000003';
const SHARED_A = 'a0000000-0000-4000-8000-000000000001';
const SHARED_B = 'a0000000-0000-4000-8000-000000000002';
const SEQUENTIAL_SESSION = 'a0000000-0000-4000-8000-000000000003';
const SEQUENTIAL_A_MESSAGE = 'a0000000-0000-4000-8000-000000000004';
const SEQUENTIAL_B_MESSAGE = 'a0000000-0000-4000-8000-000000000005';
const WORK_HUMAN = 'b0000000-0000-4000-8000-000000000001';
const WORK_AGENT = 'b0000000-0000-4000-8000-000000000002';
const WORK_TURN_NO_PROVIDER = 'b0000000-0000-4000-8000-000000000003';
const WORK_TURN_TERMINAL_ERROR = 'b0000000-0000-4000-8000-000000000004';
const WORK_TURN_OUTPUT = 'b0000000-0000-4000-8000-000000000005';
const WORK_SWEEP = 'b0000000-0000-4000-8000-000000000006';
const WORK_DREAM = 'b0000000-0000-4000-8000-000000000007';
const WORK_TRIGGER = 'b0000000-0000-4000-8000-000000000008';
const WORK_OCCURRENCE = 'b0000000-0000-4000-8000-000000000009';
const LATE_HUMAN = 'c0000000-0000-4000-8000-000000000001';
const LATE_ERROR_TURN = 'c0000000-0000-4000-8000-000000000002';
const LATE_OUTPUT_TURN = 'c0000000-0000-4000-8000-000000000003';
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

class PausingMediaStore implements MediaStore {
  readonly published: Promise<MediaPutResult>;
  putCount = 0;
  private publishedResult: ((result: MediaPutResult) => void) | null = null;
  private releasePut: (() => void) | null = null;
  private readonly release = new Promise<void>((resolve) => {
    this.releasePut = resolve;
  });

  constructor(private readonly inner: MediaStore) {
    this.published = new Promise<MediaPutResult>((resolve) => {
      this.publishedResult = resolve;
    });
  }

  async put(file: Buffer | string, options: MediaPutOptions): Promise<MediaPutResult> {
    this.putCount += 1;
    const result = await this.inner.put(file, options);
    this.publishedResult?.(result);
    this.publishedResult = null;
    await this.release;
    return result;
  }

  resume(): void {
    this.releasePut?.();
    this.releasePut = null;
  }
}

async function waitForOperatorOwnerLockWait(
  accountId: string,
  intentSettled: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (intentSettled()) {
      throw new Error('erasure intent settled before reaching the owner-account lock wait');
    }
    const [operatorActivity] = await pg<{
      state: string;
      wait_event_type: string | null;
      query: string;
      active_job: boolean;
    }[]>`
      select activity.state,activity.wait_event_type,activity.query,
        exists (
          select 1 from account_erasure_jobs
          where account_id=${accountId} and state <> 'succeeded'
        ) active_job
      from pg_stat_activity activity
      where activity.usename=${OPERATOR_LOGIN}
        and activity.datname=${databaseName}
      order by activity.backend_start desc
      limit 1
    `;
    if (operatorActivity?.active_job) {
      throw new Error('erasure intent committed before the paused media write');
    }
    if (
      operatorActivity?.state === 'active' &&
      operatorActivity.wait_event_type === 'Lock' &&
      /from\s+accounts\s+where\s+id\s*=\s*\$\d+\s+for\s+update/i.test(
        operatorActivity.query,
      )
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('erasure operator did not reach the exact owner-account lock wait');
}

function ledger(): AccountErasureLedgerSink {
  return {
    writeAndConfirm: vi.fn(async (record) => ({
      record,
      confirmedAt: new Date(Date.now() + 1_000).toISOString(),
      sha256: accountErasureLedgerSha256(record),
      macSha256: sha(`ledger-mac:${record.jobId}`),
    })),
  };
}

function recoverySink(): AccountErasureRecoveryManifestSink {
  return {
    encryptWriteAndConfirm: vi.fn(async (manifest) => ({
      schemaVersion: manifest.schemaVersion,
      jobId: manifest.jobId,
      accountId: manifest.accountId,
      inventorySha256: manifest.inventorySha256,
      manifestSha256: accountErasureManifestSha256(manifest),
      confirmedAt: new Date(Date.now() + 2_000).toISOString(),
      ciphertextSha256: sha(`cipher:${manifest.jobId}`),
      macSha256: sha(`manifest-mac:${manifest.jobId}`),
      keyVersion: 1,
    })),
  };
}

beforeAll(async () => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(OPERATOR_LOGIN) ||
      !/^[a-z_][a-z0-9_]{0,62}$/.test(ORDINARY_LOGIN)) throw new Error('unsafe scratch role name');
  await pg.unsafe(`drop role if exists "${OPERATOR_LOGIN}"`);
  await pg.unsafe(`drop role if exists "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`create role "${OPERATOR_LOGIN}" login nosuperuser nocreaterole nobypassrls noreplication password '${OPERATOR_PASSWORD}'`);
  await pg.unsafe(`create role "${ORDINARY_LOGIN}" login nosuperuser nocreaterole nobypassrls noreplication password '${ORDINARY_PASSWORD}'`);
  await pg.unsafe(`grant eden3_erasure_operator to "${OPERATOR_LOGIN}"`);
  await pg.unsafe(`grant eden3_erasure_terminal_writer to "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant connect on database "${databaseName}" to "${OPERATOR_LOGIN}","${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant usage on schema public to "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant select on accounts,agents,sessions,session_users,session_agents,messages,account_erasure_jobs,account_erasure_targets,media_assets,concept_images,agent_avatar_assets,creations,concepts to "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant update on accounts,agents to "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant insert,update,delete on media_assets,concept_images,agent_avatar_assets,creations to "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant select,insert,update on manna_accounts,manna_transactions,turn_authorizations,turn_provider_runs,usage_events,messages,sessions,session_users,session_agents,channel_turns to "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant select,update on channel_connections to "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant select,update on stripe_checkout_intents,channel_outbound_post_intents to "${ORDINARY_LOGIN}"`);
  const base = new URL(process.env.DATABASE_URL!);
  const operatorUrl = new URL(base); operatorUrl.username = OPERATOR_LOGIN; operatorUrl.password = OPERATOR_PASSWORD;
  const ordinaryUrl = new URL(base); ordinaryUrl.username = ORDINARY_LOGIN; ordinaryUrl.password = ORDINARY_PASSWORD;
  operatorPg = postgres(operatorUrl.toString(), { max: 1 });
  ordinaryPg = postgres(ordinaryUrl.toString(), { max: 1 });
  await expect(operatorPg`
    select has_table_privilege(session_user,'public.agent_avatar_assets','select') as can_select,
      has_table_privilege(session_user,'public.agent_avatar_assets','insert') as can_insert,
      has_table_privilege(session_user,'public.agent_avatar_assets','update') as can_update,
      has_table_privilege(session_user,'public.agent_avatar_assets','delete') as can_delete`
  ).resolves.toEqual([{ can_select: true, can_insert: true, can_update: true, can_delete: true }]);
  ordinaryDb = drizzle(ordinaryPg) as DbHandle;
  ERASURE_DB_BOUNDARY = await attestAccountErasureDatabaseBoundary({
    operatorClient: operatorPg as never,
    ordinaryApplicationClient: ordinaryPg as never,
    ordinaryApplicationDb: ordinaryDb,
    operatorLogin: OPERATOR_LOGIN,
    ordinaryApplicationLogin: ORDINARY_LOGIN,
  });
});

afterEach(async () => {
  // Most cases intentionally stop with accepted or partially executed
  // erasures. Production correctly retains those jobs and prevents deleting
  // fenced accounts. This suite is guarded to a disposable scratch database,
  // so truncate the aggregate roots between cases instead of weakening the
  // production retention boundary or letting the global claimer see stale
  // work from a previous case.
  vi.restoreAllMocks();
  await pg.unsafe('truncate table account_erasure_jobs, accounts cascade');
});

afterAll(async () => {
  await operatorPg?.end({ timeout: 5 });
  await ordinaryPg?.end({ timeout: 5 });
  await pg.unsafe(`revoke eden3_erasure_operator from "${OPERATOR_LOGIN}"`);
  await pg.unsafe(`revoke eden3_erasure_terminal_writer from "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`drop owned by "${OPERATOR_LOGIN}"`);
  await pg.unsafe(`drop owned by "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`drop role if exists "${OPERATOR_LOGIN}"`);
  await pg.unsafe(`drop role if exists "${ORDINARY_LOGIN}"`);
  await pg.end({ timeout: 5 });
});

describe.sequential('T12-U03 account erasure runtime on fully migrated scratch PostgreSQL', () => {
  it('attests a distinct least-privilege operator and rejects ordinary GUC spoofing', async () => {
    await expect(ordinaryPg`select set_config('eden3.erasure_job_id',${randomUUID()},false)`)
      .resolves.toBeDefined();
    await expect(ordinaryPg`select account_erasure_begin_operation()`).rejects.toMatchObject({ code: '42501' });
    await expect(ordinaryPg`select account_erasure_lock_legacy_content(
      ${null},${null},${null},${null},${null},${null},${null},${null},${null},${null})`)
      .rejects.toMatchObject({ code: '42501' });
    await expect(ordinaryPg`
      select account_erasure_record_provider_terminal_no_output(${'not-a-uuid'}::uuid)`)
      .rejects.toMatchObject({ code: '22P02' });
    await expect(ordinaryPg`
      select account_erasure_record_provider_terminal_no_output(${randomUUID()}) recorded`)
      .resolves.toMatchObject([{ recorded: false }]);
    await expect(operatorPg`select account_erasure_begin_operation()`).resolves.toBeDefined();
    await expect(ordinaryPg`
      select has_table_privilege(session_user,'account_erasure_jobs','select') permitted`
    ).resolves.toEqual([{ permitted: true }]);
  });

  it('serializes runtime projection with owner erasure admission in both lock orders', async () => {
    const dataDir = join(tmpdir(), 'eden3-runtime-erasure-fence');
    const writerOwner = randomUUID();
    const writerAgent = randomUUID();
    const deniedOwner = randomUUID();
    const deniedAgent = randomUUID();
    const writerUsername = `runtime_writer_${writerOwner.slice(0, 8)}`;
    const writerOpenclawId = `runtime-agent-${writerAgent.slice(0, 8)}`;
    const deniedUsername = `runtime_denied_${deniedOwner.slice(0, 8)}`;
    const deniedOpenclawId = `runtime-denied-${deniedAgent.slice(0, 8)}`;
    const provisioner = makeFakeProvisioner();
    const toolSync = makeFakeToolSync();
    const originalPersonaUpdate = provisioner.updateAgentPersona.bind(provisioner);
    let releaseWriter!: () => void;
    let writerEntered!: () => void;
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const entered = new Promise<void>((resolve) => { writerEntered = resolve; });
    const outstanding = new Set<Promise<unknown>>();
    provisioner.updateAgentPersona = async (params) => {
      writerEntered();
      await release;
      return await originalPersonaUpdate(params);
    };
    try {
      await pg`
        insert into accounts(id,type,username) values
          (${writerOwner},'user',${writerUsername}),
          (${writerAgent},'agent',${`runtime_writer_agent_${writerAgent.slice(0, 8)}`}),
          (${deniedOwner},'user',${deniedUsername}),
          (${deniedAgent},'agent',${`runtime_denied_agent_${deniedAgent.slice(0, 8)}`})`;
      await pg`
        insert into agents
          (account_id,owner_id,name,persona,openclaw_id,workspace_path,provision_status,
           runtime_sync_version,runtime_synced_version)
        values
          (${writerAgent},${writerOwner},'runtime writer','writer persona',${writerOpenclawId},
           ${join(dataDir, `workspace-${writerOpenclawId}`)},'ready',1,0),
          (${deniedAgent},${deniedOwner},'runtime denied','denied persona',${deniedOpenclawId},
           ${join(dataDir, `workspace-${deniedOpenclawId}`)},'ready',1,0)`;

      const writer = reconcileAgentRuntime(writerAgent, { provisioner, toolSync, dataDir });
      outstanding.add(writer);
      await entered;
      let intentSettled = false;
      const store = erasureStore();
      const intent = store.acceptIntent({
        accountId: writerOwner,
        confirmUsername: writerUsername,
      }).finally(() => { intentSettled = true; });
      outstanding.add(intent);
      await waitForOperatorOwnerLockWait(writerOwner, () => intentSettled);
      expect(intentSettled).toBe(false);

      releaseWriter();
      await expect(writer).resolves.toEqual({ status: 'synced', version: 1 });
      const accepted = await intent;
      const manifestSink = recoverySink();
      await expect(requestAccountErasure({
        actorAccountId: writerOwner,
        actorUsername: writerUsername,
        actorIsAdmin: false,
        confirmUsername: writerUsername,
      }, store, ledger(), manifestSink)).resolves.toEqual({
        jobId: accepted.jobId,
        status: 'pending',
      });
      const manifest = vi.mocked(manifestSink.encryptWriteAndConfirm).mock.calls[0]![0];
      expect(manifest.locators).toContainEqual(expect.objectContaining({
        kind: 'agent_runtime',
        resourceId: writerAgent,
      }));

      await expect(erasureStore().acceptIntent({
        accountId: deniedOwner,
        confirmUsername: deniedUsername,
      })).resolves.toMatchObject({ state: 'intent_pending' });
      const callsBeforeDenied = {
        persona: provisioner.personaUpdates.length,
        provision: provisioner.provisions.length,
        tools: toolSync.calls.length,
      };
      await expect(reconcileAgentRuntime(deniedAgent, { provisioner, toolSync, dataDir }))
        .resolves.toEqual({ status: 'ineligible' });
      expect(provisioner.personaUpdates).toHaveLength(callsBeforeDenied.persona);
      expect(provisioner.provisions).toHaveLength(callsBeforeDenied.provision);
      expect(toolSync.calls).toHaveLength(callsBeforeDenied.tools);
    } finally {
      releaseWriter();
      await Promise.allSettled([...outstanding]);
    }
  }, 30_000);

  it('serializes native deep-memory promotion with owner erasure in both lock orders', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'eden3-dream-erasure-fence-'));
    const writerOwner = randomUUID();
    const writerAgent = randomUUID();
    const deniedOwner = randomUUID();
    const deniedAgent = randomUUID();
    const writerUsername = `dream_writer_${writerOwner.slice(0, 8)}`;
    const deniedUsername = `dream_denied_${deniedOwner.slice(0, 8)}`;
    const writerOpenclawId = `dream-agent-${writerAgent.slice(0, 8)}`;
    const deniedOpenclawId = `dream-denied-${deniedAgent.slice(0, 8)}`;
    const writerWorkspace = join(workspaceRoot, `workspace-${writerOpenclawId}`);
    const deniedWorkspace = join(workspaceRoot, `workspace-${deniedOpenclawId}`);
    const outstanding = new Set<Promise<unknown>>();
    let releasePromotion!: () => void;
    let promotionEntered!: () => void;
    const release = new Promise<void>((resolve) => { releasePromotion = resolve; });
    const entered = new Promise<void>((resolve) => { promotionEntered = resolve; });
    const promotion = {
      agentId: writerOpenclawId,
      candidates: 1,
      promoted: 1,
      policy: {
        limit: 10 as const,
        minScore: 0.55 as const,
        minRecallCount: 1 as const,
        minUniqueQueries: 1 as const,
        apply: true as const,
      },
    };
    const checkpointFor = (): MemoryDreamCheckpoint => ({
      schema: 'eden-memory-dream-v1',
      phase: 'seed_done',
      date: '2026-08-09',
      previousSha256: null,
    });
    const durabilityFor = (
      runId: string,
      saves: MemoryDreamCheckpoint[],
    ): MemoryDreamDurability => ({
      inspect: async (requestedRunId) => {
        expect(requestedRunId).toBe(runId);
        return {
          checkpoint: checkpointFor(),
          providerStatus: 'not_started',
          usage: null,
          debitKeys: [],
        };
      },
      saveCheckpoint: async (_claim, checkpoint) => { saves.push(checkpoint); },
    });
    const runnerFor = (
      runId: string,
      openclawId: string,
      workspacePath: string,
      saves: MemoryDreamCheckpoint[],
      promote: () => Promise<typeof promotion>,
    ) => new EdenMemoryDreamAgentRunner({
      compat: { async *chatTurn() {} },
      bus: { publish: () => 0 } as never,
      registry: { register() {}, touch() {} } as never,
      historySync: { scheduleTrailingSync() {} } as never,
      memoryRuntime: { promoteAgent: promote } as never,
      modelRuntime: { getRuntime: async () => { throw new Error('stop after deep checkpoint'); } } as never,
      durability: durabilityFor(runId, saves),
      claimFence: async () => {},
      recordRecoveryUsage: async () => {},
      now: () => new Date('2026-08-09T12:00:00.000Z'),
    });
    try {
      await mkdirSync(writerWorkspace, { recursive: true });
      await mkdirSync(deniedWorkspace, { recursive: true });
      await writeFile(join(writerWorkspace, 'MEMORY.md'), '# seeded writer memory\n', 'utf8');
      await writeFile(join(deniedWorkspace, 'MEMORY.md'), '# seeded denied memory\n', 'utf8');
      await pg`
        insert into accounts(id,type,username) values
          (${writerOwner},'user',${writerUsername}),
          (${writerAgent},'agent',${`dream_writer_agent_${writerAgent.slice(0, 8)}`}),
          (${deniedOwner},'user',${deniedUsername}),
          (${deniedAgent},'agent',${`dream_denied_agent_${deniedAgent.slice(0, 8)}`})`;
      await pg`
        insert into agents(account_id,owner_id,name,openclaw_id,workspace_path,provision_status)
        values
          (${writerAgent},${writerOwner},'dream writer',${writerOpenclawId},${writerWorkspace},'ready'),
          (${deniedAgent},${deniedOwner},'dream denied',${deniedOpenclawId},${deniedWorkspace},'ready')`;

      const writerRunId = randomUUID();
      const writerSaves: MemoryDreamCheckpoint[] = [];
      const writerRunner = runnerFor(
        writerRunId,
        writerOpenclawId,
        writerWorkspace,
        writerSaves,
        async () => {
          promotionEntered();
          await release;
          await writeFile(join(writerWorkspace, 'MEMORY.md'), '# promoted writer memory\n', 'utf8');
          return promotion;
        },
      );
      const writer = writerRunner.run({
        agentAccountId: writerAgent,
        openclawId: writerOpenclawId,
        username: `dream_writer_agent_${writerAgent.slice(0, 8)}`,
        name: 'dream writer',
        persona: null,
        workspacePath: writerWorkspace,
        provisionStatus: 'ready',
        ownerAccountId: writerOwner,
        ownerUsername: writerUsername,
        lastActivityAt: new Date('2026-08-09T11:00:00.000Z'),
        lastSuccessfulDreamActivityAt: null,
        recoveryPending: false,
      }, 'dream-sweep-writer', {
        id: writerRunId,
        sweepId: 'dream-sweep-writer',
        claimToken: randomUUID(),
        lastActivityAt: new Date('2026-08-09T11:00:00.000Z'),
        isRecovery: false,
      });
      outstanding.add(writer);
      await entered;
      let intentSettled = false;
      const store = erasureStore();
      const intent = store.acceptIntent({
        accountId: writerOwner,
        confirmUsername: writerUsername,
      }).finally(() => { intentSettled = true; });
      outstanding.add(intent);
      await waitForOperatorOwnerLockWait(writerOwner, () => intentSettled);
      releasePromotion();
      await expect(writer).rejects.toThrow('stop after deep checkpoint');
      expect(writerSaves.map((saved) => saved.phase)).toEqual(['deep_started', 'deep_done']);
      const accepted = await intent;
      const manifestSink = recoverySink();
      await expect(requestAccountErasure({
        actorAccountId: writerOwner,
        actorUsername: writerUsername,
        actorIsAdmin: false,
        confirmUsername: writerUsername,
      }, store, ledger(), manifestSink)).resolves.toEqual({
        jobId: accepted.jobId,
        status: 'pending',
      });
      expect(vi.mocked(manifestSink.encryptWriteAndConfirm).mock.calls[0]![0].locators)
        .toContainEqual(expect.objectContaining({ kind: 'agent_runtime', resourceId: writerAgent }));

      await expect(erasureStore().acceptIntent({
        accountId: deniedOwner,
        confirmUsername: deniedUsername,
      })).resolves.toMatchObject({ state: 'intent_pending' });
      let deniedPromotions = 0;
      const deniedRunId = randomUUID();
      const deniedSaves: MemoryDreamCheckpoint[] = [];
      const deniedRunner = runnerFor(
        deniedRunId,
        deniedOpenclawId,
        deniedWorkspace,
        deniedSaves,
        async () => { deniedPromotions += 1; return { ...promotion, agentId: deniedOpenclawId }; },
      );
      await expect(deniedRunner.run({
        agentAccountId: deniedAgent,
        openclawId: deniedOpenclawId,
        username: `dream_denied_agent_${deniedAgent.slice(0, 8)}`,
        name: 'dream denied',
        persona: null,
        workspacePath: deniedWorkspace,
        provisionStatus: 'ready',
        ownerAccountId: deniedOwner,
        ownerUsername: deniedUsername,
        lastActivityAt: new Date('2026-08-09T11:00:00.000Z'),
        lastSuccessfulDreamActivityAt: null,
        recoveryPending: false,
      }, 'dream-sweep-denied', {
        id: deniedRunId,
        sweepId: 'dream-sweep-denied',
        claimToken: randomUUID(),
        lastActivityAt: new Date('2026-08-09T11:00:00.000Z'),
        isRecovery: false,
      })).rejects.toMatchObject({ statusCode: 409, code: 'account_erasure_active' });
      expect(deniedPromotions).toBe(0);
      expect(deniedSaves.map((saved) => saved.phase)).toEqual(['deep_started']);
      await expect(readFile(join(deniedWorkspace, 'memory', 'dreaming', 'deep', '2026-08-09.md')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releasePromotion();
      await Promise.allSettled([...outstanding]);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('serializes concept media publication with owner erasure admission in both lock orders', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'eden3-concept-erasure-race-'));
    const uploadOwner = randomUUID();
    const uploadAgent = randomUUID();
    const uploadConcept = randomUUID();
    const deniedOwner = randomUUID();
    const deniedAgent = randomUUID();
    const deniedConcept = randomUUID();
    const uploadUsername = `concept_upload_${uploadOwner.slice(0, 8)}`;
    const uploadAgentUsername = `concept_agent_${uploadAgent.slice(0, 8)}`;
    const deniedUsername = `concept_denied_${deniedOwner.slice(0, 8)}`;
    const deniedAgentUsername = `concept_denied_agent_${deniedAgent.slice(0, 8)}`;
    const authorized = new Map<string, string>([
      [uploadOwner, uploadUsername],
      [deniedOwner, deniedUsername],
    ]);
    const pausingStore = new PausingMediaStore(new LocalMediaStore({
      mediaDir: mediaRoot,
      baseUrl: '/media',
    }));
    const outstanding = new Set<Promise<unknown>>();
    const app = Fastify();
    app.decorateRequest('account', null);
    app.decorate('requireAuth', requireAuth);
    app.decorate('accessAllowlist', new Set<string>());
    app.addHook('onRequest', async (request) => {
      const value = request.headers['x-test-account-id'];
      const accountId = Array.isArray(value) ? value[0] : value;
      const username = accountId ? authorized.get(accountId) : undefined;
      request.account = accountId && username
        ? { accountId, username, isAdmin: false }
        : null;
    });
    await app.register(conceptsRoutes, { store: pausingStore });
    try {
      await pg`
        insert into accounts (id,type,username) values
          (${uploadOwner},'user',${uploadUsername}),
          (${uploadAgent},'agent',${uploadAgentUsername}),
          (${deniedOwner},'user',${deniedUsername}),
          (${deniedAgent},'agent',${deniedAgentUsername})`;
      await pg`
        insert into agents (account_id,owner_id,name,public) values
          (${uploadAgent},${uploadOwner},'upload first agent',false),
          (${deniedAgent},${deniedOwner},'erasure first agent',false)`;
      await pg`
        insert into concepts (id,agent_id,name,slug) values
          (${uploadConcept},${uploadAgent},'upload first concept','upload-first'),
          (${deniedConcept},${deniedAgent},'erasure first concept','erasure-first')`;

      const uploadRequest = app.inject({
        method: 'POST',
        url: `/${uploadAgentUsername}/concepts/upload-first/images`,
        headers: { 'x-test-account-id': uploadOwner },
        payload: {
          mime: 'image/png',
          filename: 'upload-first.png',
          dataBase64: PNG_1PX.toString('base64'),
        },
      });
      outstanding.add(uploadRequest);
      const stored = await pausingStore.published;
      let intentSettled = false;
      const intentStore = erasureStore();
      const intentRequest = intentStore.acceptIntent({
        accountId: uploadOwner,
        confirmUsername: uploadUsername,
      }).finally(() => {
        intentSettled = true;
      });
      outstanding.add(intentRequest);
      await waitForOperatorOwnerLockWait(uploadOwner, () => intentSettled);
      expect(intentSettled).toBe(false);

      pausingStore.resume();
      expect((await uploadRequest).statusCode).toBe(201);
      const accepted = await intentRequest;
      const [image] = await pg<{ id: string; url: string; local_path: string; sha256: string }[]>`
        select id,url,local_path,sha256 from concept_images
        where concept_id=${uploadConcept} and sha256=${stored.sha256}`;
      expect(image).toMatchObject({
        url: stored.url,
        local_path: stored.localPath,
        sha256: stored.sha256,
      });

      const manifestSink = recoverySink();
      await expect(requestAccountErasure({
        actorAccountId: uploadOwner,
        actorUsername: uploadUsername,
        actorIsAdmin: false,
        confirmUsername: uploadUsername,
      }, intentStore, ledger(), manifestSink)).resolves.toEqual({
        jobId: accepted.jobId,
        status: 'pending',
      });
      const manifest = vi.mocked(manifestSink.encryptWriteAndConfirm).mock.calls[0]![0];
      const locator = manifest.locators.find((entry) =>
        entry.kind === 'legacy_concept_asset' && entry.resourceId === image!.id);
      expect(locator).toBeDefined();
      expect(JSON.parse(locator!.locator)).toEqual({
        kind: 'legacy_concept_asset',
        localPath: stored.localPath,
        url: stored.url,
        sha256: stored.sha256,
      });

      await expect(intentStore.acceptIntent({
        accountId: deniedOwner,
        confirmUsername: deniedUsername,
      })).resolves.toMatchObject({ accountId: deniedOwner, state: 'intent_pending' });
      const deniedBody = Buffer.concat([PNG_1PX, Buffer.from([0x7f])]);
      const deniedSha = createHash('sha256').update(deniedBody).digest('hex');
      const putCountBeforeDenied = pausingStore.putCount;
      const denied = await app.inject({
        method: 'POST',
        url: `/${deniedAgentUsername}/concepts/erasure-first/images`,
        headers: { 'x-test-account-id': deniedOwner },
        payload: {
          mime: 'image/png',
          filename: 'erasure-first.png',
          dataBase64: deniedBody.toString('base64'),
        },
      });
      expect(denied.statusCode).toBe(409);
      expect(pausingStore.putCount).toBe(putCountBeforeDenied);
      await expect(readFile(join(mediaRoot, `${deniedSha}.png`))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      pausingStore.resume();
      await Promise.allSettled([...outstanding]);
      await app.close();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps avatar publication, history, shared-byte election, and erasure cleanup exact', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'eden3-avatar-erasure-race-'));
    const uploadOwner = randomUUID();
    const uploadAgent = randomUUID();
    const deniedOwner = randomUUID();
    const deniedAgent = randomUUID();
    const foreignOwner = randomUUID();
    const foreignAgent = randomUUID();
    const uploadUsername = `avatar_upload_${uploadOwner.slice(0, 8)}`;
    const uploadAgentUsername = `avatar_agent_${uploadAgent.slice(0, 8)}`;
    const deniedUsername = `avatar_denied_${deniedOwner.slice(0, 8)}`;
    const deniedAgentUsername = `avatar_denied_agent_${deniedAgent.slice(0, 8)}`;
    const foreignUsername = `avatar_foreign_${foreignOwner.slice(0, 8)}`;
    const foreignAgentUsername = `avatar_foreign_agent_${foreignAgent.slice(0, 8)}`;
    const authorized = new Map<string, string>([
      [uploadOwner, uploadUsername],
      [deniedOwner, deniedUsername],
    ]);
    const pausingStore = new PausingMediaStore(new LocalMediaStore({
      mediaDir: mediaRoot,
      baseUrl: '/media',
    }));
    // Keep this test's cross-owner shared-byte election independent from the
    // canonical 1px fixture hash used by the concept-publication cases.
    const avatarBody = Buffer.concat([PNG_1PX, Buffer.from('avatar-custody')]);
    const outstanding = new Set<Promise<unknown>>();
    const app = Fastify();
    app.decorateRequest('account', null);
    app.decorate('requireAuth', requireAuth);
    app.decorate('accessAllowlist', new Set<string>());
    app.decorate('gatewayGlue', {
      modelRuntime: {
        getRuntime: async () => 'openclaw',
        getCatalog: async () => [],
      },
    } as never);
    app.addHook('onRequest', async (request) => {
      const value = request.headers['x-test-account-id'];
      const accountId = Array.isArray(value) ? value[0] : value;
      const username = accountId ? authorized.get(accountId) : undefined;
      request.account = accountId && username
        ? { accountId, username, isAdmin: false }
        : null;
    });
    await app.register(agentsRoutes, { prefix: '/agents', store: pausingStore });
    try {
      await pg`
        insert into accounts (id,type,username) values
          (${uploadOwner},'user',${uploadUsername}),
          (${uploadAgent},'agent',${uploadAgentUsername}),
          (${deniedOwner},'user',${deniedUsername}),
          (${deniedAgent},'agent',${deniedAgentUsername}),
          (${foreignOwner},'user',${foreignUsername}),
          (${foreignAgent},'agent',${foreignAgentUsername})`;
      await pg`
        insert into agents (account_id,owner_id,name,public) values
          (${uploadAgent},${uploadOwner},'upload first avatar agent',false),
          (${deniedAgent},${deniedOwner},'erasure first avatar agent',false),
          (${foreignAgent},${foreignOwner},'foreign shared avatar agent',false)`;

      const uploadRequest = app.inject({
        method: 'POST',
        url: `/agents/${uploadAgentUsername}/avatar`,
        headers: { 'x-test-account-id': uploadOwner },
        payload: {
          mime: 'image/png',
          filename: 'upload-first-avatar.png',
          dataBase64: avatarBody.toString('base64'),
        },
      });
      outstanding.add(uploadRequest);
      const stored = await pausingStore.published;
      let intentSettled = false;
      const intentStore = erasureStore();
      const intentRequest = intentStore.acceptIntent({
        accountId: uploadOwner,
        confirmUsername: uploadUsername,
      }).finally(() => {
        intentSettled = true;
      });
      outstanding.add(intentRequest);
      await waitForOperatorOwnerLockWait(uploadOwner, () => intentSettled);

      pausingStore.resume();
      const uploadResponse = await uploadRequest;
      expect(uploadResponse.statusCode, uploadResponse.body).toBe(200);
      const accepted = await intentRequest;
      const [avatar] = await pg<{
        id: string; url: string; local_path: string; sha256: string; state: string;
      }[]>`
        select id,url,local_path,sha256,state from agent_avatar_assets
        where agent_account_id=${uploadAgent} and state='current'`;
      expect(avatar).toMatchObject({
        url: stored.url,
        local_path: stored.localPath,
        sha256: stored.sha256,
        state: 'current',
      });
      const [foreignAvatar] = await pg<{ id: string }[]>`
        insert into agent_avatar_assets
          (owner_account_id,agent_account_id,url,local_path,sha256,mime,size_bytes)
        values (${foreignOwner},${foreignAgent},${stored.url},${stored.localPath},
          ${stored.sha256},${stored.mime},${stored.sizeBytes}) returning id`;
      await pg`update accounts set user_image=${stored.url} where id=${foreignAgent}`;

      const manifestSink = recoverySink();
      await expect(requestAccountErasure({
        actorAccountId: uploadOwner,
        actorUsername: uploadUsername,
        actorIsAdmin: false,
        confirmUsername: uploadUsername,
      }, intentStore, ledger(), manifestSink)).resolves.toEqual({
        jobId: accepted.jobId,
        status: 'pending',
      });
      const manifest = vi.mocked(manifestSink.encryptWriteAndConfirm).mock.calls[0]![0];
      const locator = manifest.locators.find((entry) =>
        entry.kind === 'legacy_avatar_asset' && entry.resourceId === avatar!.id);
      expect(JSON.parse(locator!.locator)).toEqual({
        kind: 'legacy_avatar_asset',
        localPath: stored.localPath,
        url: stored.url,
        sha256: stored.sha256,
      });
      const targetStore = erasureTargetStore(mediaRoot);
      const claimAvatar = async (resourceId: string) => {
        for (let index = 0; index < 3; index += 1) {
          const candidate = await targetStore.claimTarget();
          if (!candidate || 'status' in candidate) {
            throw new Error('expected avatar erasure target claim');
          }
          if (candidate.kind === 'legacy_avatar_asset') {
            expect(candidate.resourceId).toBe(resourceId);
            return candidate;
          }
          // The account's runtime target is independent and may sort first by
          // UUID. Defer it through the real retry path so this avatar-focused
          // case does not depend on incidental target ordering.
          expect(candidate.kind).toBe('agent_runtime');
          await expect(targetStore.failTarget(candidate, 'test_runtime_deferred'))
            .resolves.toBe('retried');
        }
        throw new Error('avatar erasure target was not claimable');
      };
      const claim = await claimAvatar(avatar!.id);
      const executor = new LocalLegacyErasureExecutor(targetStore.legacyMediaBoundary, {
        erase: async () => { throw new Error('local avatar must not use external erasure'); },
      });
      await expect(executor.erase({ ...claim, signal: AbortSignal.timeout(5_000) }))
        .resolves.toEqual({ confirmedAbsent: true });
      await expect(targetStore.completeTarget(claim)).resolves.toBe('completed');
      await expect(readFile(stored.localPath)).resolves.toBeInstanceOf(Buffer);
      const [foreignPointer] = await pg<{ user_image: string | null }[]>`
        select user_image from accounts where id=${foreignAgent}`;
      expect(foreignPointer?.user_image).toBe(stored.url);

      await expect(requestAccountErasure({
        actorAccountId: foreignOwner,
        actorUsername: foreignUsername,
        actorIsAdmin: false,
        confirmUsername: foreignUsername,
      }, erasureStore(), ledger(), recoverySink())).resolves.toMatchObject({ status: 'pending' });
      const foreignClaim = await claimAvatar(foreignAvatar!.id);
      await expect(executor.erase({ ...foreignClaim, signal: AbortSignal.timeout(5_000) }))
        .resolves.toEqual({ confirmedAbsent: true });
      await expect(targetStore.completeTarget(foreignClaim)).resolves.toBe('completed');
      await expect(readFile(stored.localPath)).rejects.toMatchObject({ code: 'ENOENT' });

      await expect(intentStore.acceptIntent({
        accountId: deniedOwner,
        confirmUsername: deniedUsername,
      })).resolves.toMatchObject({ accountId: deniedOwner, state: 'intent_pending' });
      const putCountBeforeDenied = pausingStore.putCount;
      const denied = await app.inject({
        method: 'POST',
        url: `/agents/${deniedAgentUsername}/avatar`,
        headers: { 'x-test-account-id': deniedOwner },
        payload: {
          mime: 'image/png',
          filename: 'erasure-first-avatar.png',
          dataBase64: Buffer.concat([PNG_1PX, Buffer.from([0x51])]).toString('base64'),
        },
      });
      expect(denied.statusCode).toBe(409);
      expect(pausingStore.putCount).toBe(putCountBeforeDenied);
      await expect(pg`select 1 from agent_avatar_assets where agent_account_id=${deniedAgent}`)
        .resolves.toHaveLength(0);
    } finally {
      pausingStore.resume();
      await Promise.allSettled([...outstanding]);
      await app.close();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  }, 30_000);
  it('rejects cross-tenant outbound intents and nonhuman Stripe ownership', async () => {
    const owner = randomUUID();
    const foreign = randomUUID();
    const agent = randomUUID();
    const connection = randomUUID();
    await pg`insert into accounts(id,type,username) values
      (${owner},'user',${`intent_owner_${owner.slice(0, 8)}`}),
      (${foreign},'user',${`intent_foreign_${foreign.slice(0, 8)}`}),
      (${agent},'agent',${`intent_agent_${agent.slice(0, 8)}`})`;
    await pg`insert into agents(account_id,owner_id,name,public)
      values (${agent},${owner},'intent ownership agent',false)`;
    await pg`insert into channel_connections
      (id,account_id,channel,token_ciphertext,token_iv,token_auth_tag,token_sha256)
      values (${connection},${foreign},'x','cipher','iv','tag',${sha('intent-owner-token')})`;
    await expect(pg`insert into channel_outbound_post_intents(account_id,connection_id)
      values (${owner},${connection})`).rejects.toThrow(
      'outbound intent must match its owned X connection',
    );
    await expect(pg`insert into stripe_checkout_intents(account_id,kind,request_key_sha256)
      values (${agent},'manna_topup',${sha('agent-stripe-intent')})`).rejects.toThrow(
      'checkout intent owner must be a human account',
    );
    await expect(pg`insert into stripe_checkout_intents(account_id,kind,request_key_sha256)
      values (${owner},'manna_topup',${sha('human-stripe-intent')}) returning id`).resolves.toHaveLength(1);
  });
  it('proves money, privacy, multipart gating, worker concurrency, and route-vs-worker fencing', async () => {
    await pg`
      insert into accounts (id,type,username,clerk_user_id,external_id) values
        (${HUMAN},'user','erase_runtime_human','clerk-runtime-human','legacy-human'),
        (${AGENT},'agent','erase_runtime_agent',null,'legacy-agent'),
        (${FOREIGN},'user','erase_runtime_foreign',null,'legacy-foreign')`;
    await pg`
      insert into agents (account_id,owner_id,name,description,persona,public)
      values (${AGENT},${HUMAN},'private agent','private description','private persona',true)`;

    const [manna] = await pg<{ id: string }[]>`
      insert into manna_accounts (account_id,balance,subscription_balance)
      values (${HUMAN},'90.0000','5.0000') returning id`;
    const [debit] = await pg<{ id: string }[]>`
      insert into manna_transactions (manna_account_id,amount,type,idempotency_key)
      values (${manna!.id},'-10.0000','spend:chat',${TURN}) returning id`;
    await pg`
      insert into turn_authorizations
        (turn_id,account_id,provider,model,pricing_basis,ceiling_table_version,
         authorized_max_manna,reserved_subscription_manna,reservation_tx_id,state)
      values (${TURN},${HUMAN},'anthropic','claude-haiku-4-5','provider-api','v1',
        '10.0000','5.0000',${debit!.id},'reserved')`;
    await pg`
      insert into manna_transactions
        (manna_account_id,amount,type,idempotency_key,stripe_event_data)
      values (${manna!.id},'20.0000','credit:stripe','stripe-topup-runtime',
        ${JSON.stringify({ objectId: 'cs_runtime_topup', customerId: 'cus_runtime_topup', accountId: HUMAN })}::jsonb)`;
    await pg`
      insert into billing_subscriptions
        (account_id,stripe_customer_id,stripe_subscription_id,status)
      values (${HUMAN},'cus_runtime_topup','sub_runtime','active')`;
    await pg`insert into stripe_checkout_intents
      (id,account_id,kind,request_key_sha256)
      values (${CHECKOUT_INTENT},${HUMAN},'manna_topup',${sha('checkout-request')})`;
    await pg`update stripe_checkout_intents set state='provider_started' where id=${CHECKOUT_INTENT}`;
    await pg`update stripe_checkout_intents set state='created',stripe_session_id='cs_runtime_intent'
      where id=${CHECKOUT_INTENT}`;

    await pg`
      insert into sessions (id,owner_id,title,is_public) values
        (${PRIVATE_SESSION},${HUMAN},'private payload',true),
        (${SHARED_SESSION},${HUMAN},'shared survives',true),
        (${FOREIGN_SESSION},${FOREIGN},'foreign survives',true)`;
    await pg`
      insert into session_users (session_id,user_account_id) values
        (${SHARED_SESSION},${FOREIGN}),
        (${FOREIGN_SESSION},${HUMAN})`;
    await pg`
      insert into messages (id,session_id,sender_id,content,attachments) values
        (${PRIVATE_MESSAGE},${PRIVATE_SESSION},${HUMAN},'erase private','[{"secret":true}]'::jsonb),
        (${SHARED_OWN_MESSAGE},${SHARED_SESSION},${HUMAN},'erase shared owner','[]'::jsonb),
        (${SHARED_FOREIGN_MESSAGE},${SHARED_SESSION},${FOREIGN},'foreign shared survives','[]'::jsonb),
        (${FOREIGN_OWN_MESSAGE},${FOREIGN_SESSION},${HUMAN},'erase in foreign','[]'::jsonb),
        (${FOREIGN_FOREIGN_MESSAGE},${FOREIGN_SESSION},${FOREIGN},'foreign content survives','[]'::jsonb)`;
    for (const sessionId of [PRIVATE_SESSION, SHARED_SESSION, FOREIGN_SESSION]) {
      await pg`
        insert into session_share_links
          (session_id,created_by,token_hash,mode,snapshot_payload)
        values (${sessionId},${HUMAN},${sha(`share:${sessionId}`)},'snapshot','{"secret":"snapshot"}'::jsonb)`;
    }
    await pg`
      insert into collections (id,user_id,name,description,contributors,public) values
        (${COLLECTION},${HUMAN},'public secret collection','private description',null,true),
        (${FOREIGN_COLLECTION},${FOREIGN},'foreign collection','foreign survives',
          ${JSON.stringify(['legacy-human', 'legacy-survivor', 'legacy-agent'])}::jsonb,true),
        (${UNRELATED_COLLECTION},${FOREIGN},'unrelated collection','unrelated survives',
          ${JSON.stringify(['legacy-foreign'])}::jsonb,true)`;
    await pg`
      insert into creations (id,user_id,url,public,deleted) values
        (${OWN_CREATION},${HUMAN},'/media/owned-social.png',false,false),
        (${FOREIGN_CREATION},${FOREIGN},'/media/foreign-social.png',false,false)`;
    await pg`
      insert into etl_social_edges
        (source_collection,source_external_id,edge_kind,user_id,target_id,last_seen_run_id) values
        ('users3','foreign-agent-edge','agent_like',${FOREIGN},${AGENT},${randomUUID()}),
        ('users3','foreign-creation-edge','creation_like',${FOREIGN},${OWN_CREATION},${randomUUID()}),
        ('users3','unrelated-edge','creation_like',${FOREIGN},${FOREIGN_CREATION},${randomUUID()})`;
    await pg`
      insert into concepts (id,agent_id,name,slug,description,instructions)
      values (${CONCEPT},${AGENT},'private concept','private-concept','private description','private instructions')`;
    await pg`
      insert into concept_images (id,concept_id,url,local_path,sha256,mime,filename)
      values (${CONCEPT_IMAGE},${CONCEPT},${`/media/${sha('concept')}.png`},
        ${`/tmp/${sha('concept')}.png`},${sha('concept')},'image/png','private.png')`;
    await pg`
      insert into media_assets (id,local_path,url,sha256,mime,session_id)
      values (${FOREIGN_MEDIA},${`/tmp/${sha('concept')}.png`},${`/media/${sha('concept')}.png`},
        ${sha('concept')},'image/png',${FOREIGN_SESSION})`;
    const privateMediaUrl = `/media/${sha('private-media')}.png`;
    await pg`
      insert into media_assets (id,url,sha256,mime,session_id)
      values (${PRIVATE_MEDIA},${privateMediaUrl},${sha('private-media')},'image/png',${PRIVATE_SESSION})`;
    await expect(legacyMediaIsPubliclyReachable(pg, privateMediaUrl)).resolves.toBe(true);
    await pg`
      insert into skill_definitions (id,slug,name,description,body,source,status,owner_id)
      values (${USER_SKILL},'private-skill','Private Skill','private description','SECRET SKILL BODY',
        'user','approved',${HUMAN})`;
    await pg`
      insert into skill_definitions
        (id,slug,name,description,body,source,status,owner_id,reviewer_id,reviewed_at)
      values (${FOREIGN_SKILL},'foreign-skill','Foreign Skill','foreign survives','FOREIGN BODY',
        'user','approved',${FOREIGN},${HUMAN},statement_timestamp())`;
    await pg`
      insert into memory_dream_sweeps (id,sweep_key,window_start,status,skipped_agents)
      values (${PRIVACY_SWEEP},'erase-privacy-sweep',statement_timestamp(),'done',${JSON.stringify([
        { agentAccountId: AGENT, openclawId: 'private-openclaw' },
        { agentAccountId: FOREIGN, openclawId: 'foreign-openclaw' },
      ])}::jsonb)`;
    await pg`
      insert into channel_connections
        (id,account_id,agent_id,channel,token_ciphertext,token_iv,token_auth_tag,token_sha256,
         runtime_account_id)
      values (${CHANNEL_CONNECTION},${HUMAN},${AGENT},'x','ciphertext','iv','tag',
        ${sha('channel-token')},'runtime-private')`;
    await pg`
      insert into secret_access_audit_events
        (actor_account_id,owner_account_id,secret_kind,secret_id,action,metadata)
      values (${HUMAN},${HUMAN},'channel_token',${CHANNEL_CONNECTION},'runtime_retrieve',
        ${JSON.stringify({ runtimeAccountId: 'runtime-private', provider: 'x', correlation: 'secret' })}::jsonb)`;
    await pg`
      insert into channel_outbound_post_intents(id,account_id,connection_id)
      values (${OUTBOUND_INTENT},${HUMAN},${CHANNEL_CONNECTION})`;
    await pg`update channel_outbound_post_intents set state='provider_started' where id=${OUTBOUND_INTENT}`;
    await pg`update channel_outbound_post_intents set state='succeeded',provider_post_id='post_safe_1'
      where id=${OUTBOUND_INTENT}`;

    for (const [objectId, owner, key] of [
      [HUMAN_OBJECT, HUMAN, `objects/${HUMAN_OBJECT.slice(0, 2)}/${HUMAN_OBJECT}`],
      [AGENT_OBJECT, AGENT, `objects/${AGENT_OBJECT.slice(0, 2)}/${AGENT_OBJECT}`],
    ] as const) {
      await pg`
        insert into storage_objects
          (id,owner_account_id,purpose,declared_mime,declared_size_bytes,declared_sha256,
           state,backing_store,backing_key)
        values (${objectId},${owner},'chat','text/plain',1,${sha(objectId)},
          'pending','local',${key})`;
    }
    await pg`
      insert into storage_uploads
        (id,object_id,owner_account_id,backend_multipart_id,state,part_size_bytes,
         expires_at,capability_expires_at)
      values (${UPLOAD},${HUMAN_OBJECT},${HUMAN},'runtime-multipart','uploading',1,
        statement_timestamp()+interval '1 day',statement_timestamp()+interval '1 hour')`;

    const store = erasureStore();
    const manifestCustody = recoverySink();
    const accepted = await requestAccountErasure({
      actorAccountId: HUMAN,
      actorUsername: 'erase_runtime_human',
      actorIsAdmin: false,
      confirmUsername: 'erase_runtime_human',
    }, store, ledger(), manifestCustody);
    expect(accepted.status).toBe('pending');
    await expect(legacyMediaIsPubliclyReachable(pg, privateMediaUrl)).resolves.toBe(false);
    await expect(legacyMediaIsPubliclyReachable(pg, `/media/${sha('concept')}.png`)).resolves.toBe(true);
    const sealedManifest = vi.mocked(manifestCustody.encryptWriteAndConfirm).mock.calls[0]![0];
    const stripeLocator = sealedManifest.locators.find((entry) => entry.kind === 'stripe_customer');
    expect(JSON.parse(stripeLocator!.locator)).toEqual({
      kind: 'stripe_customer',
      customerIds: ['cus_runtime_topup'],
      checkoutSessionIds: ['cs_runtime_intent', 'cs_runtime_topup'],
      checkoutIntents: [{
        intentId: CHECKOUT_INTENT,
        state: 'created',
        requestKeySha256: sha('checkout-request'),
        stripeSessionId: 'cs_runtime_intent',
      }],
      subscriptions: [{ stripeCustomerId: 'cus_runtime_topup', stripeSubscriptionId: 'sub_runtime' }],
    });
    const [manifestEvidence] = await pg<{ recovery_manifest_sha256: string }[]>`
      select recovery_manifest_sha256 from account_erasure_jobs where id=${accepted.jobId}`;
    expect(manifestEvidence!.recovery_manifest_sha256).toBe(
      accountErasureManifestSha256(sealedManifest),
    );
    await ordinaryPg`create temp table account_erasure_targets (job_id uuid,kind text,resource_id uuid)`;
    await ordinaryPg`set search_path=pg_temp,public`;
    await expect(ordinaryPg`
      insert into media_assets (local_path,url,sha256,mime)
      values (${`/tmp/${sha('concept')}.png`},${`/media/${sha('concept')}.png`},
        ${sha('new-foreign-reference')},'image/png')`
    ).rejects.toThrow('legacy content is fenced by active erasure');
    const ordinaryMedia = randomUUID();
    await expect(ordinaryPg`
      insert into media_assets (id,url,sha256,mime)
      values (${ordinaryMedia},'/media/unrelated.png',${sha('ordinary-unrelated')},'image/png')`
    ).resolves.toBeDefined();
    await ordinaryPg`delete from media_assets where id=${ordinaryMedia}`;
    await ordinaryPg`reset search_path`;
    await ordinaryPg`drop table if exists pg_temp.account_erasure_targets`;

    const [moneyTruth] = await pg<{
      balance: string; subscription_balance: string; state: string; refunds: number;
    }[]>`
      select ma.balance,ma.subscription_balance,a.state,
        (select count(*)::int from manna_transactions r where r.refunds_transaction_id=${debit!.id}) refunds
      from manna_accounts ma join turn_authorizations a on a.account_id=ma.account_id
      where ma.account_id=${HUMAN}`;
    expect(moneyTruth).toMatchObject({
      balance: '100.0000', subscription_balance: '10.0000', state: 'reversed', refunds: 1,
    });

    const [privacy] = await pg<{
      private_deleted: boolean; private_title: string | null; shared_public: boolean;
      shared_foreign: string | null; shared_own: string | null;
      foreign_foreign: string | null; foreign_own: string | null; shares: number;
      collection_public: boolean; collection_name: string | null;
      concept_name: string; concept_instructions: string | null; concept_filename: string | null;
      skill_name: string; skill_body: string; upload_state: string; cleanup_state: string;
      foreign_skill_reviewer: string | null; foreign_skill_name: string;
      sweep_skipped: unknown; foreign_contributors: unknown; unrelated_contributors: unknown;
      deleted_social_edges: number; unrelated_social_edges: number;
    }[]>`
      select
        (select deleted from sessions where id=${PRIVATE_SESSION}) private_deleted,
        (select title from sessions where id=${PRIVATE_SESSION}) private_title,
        (select coalesce(is_public,false) from sessions where id=${SHARED_SESSION}) shared_public,
        (select content from messages where id=${SHARED_FOREIGN_MESSAGE}) shared_foreign,
        (select content from messages where id=${SHARED_OWN_MESSAGE}) shared_own,
        (select content from messages where id=${FOREIGN_FOREIGN_MESSAGE}) foreign_foreign,
        (select content from messages where id=${FOREIGN_OWN_MESSAGE}) foreign_own,
        (select count(*)::int from session_share_links where session_id in
          (${PRIVATE_SESSION},${SHARED_SESSION},${FOREIGN_SESSION})) shares,
        (select public from collections where id=${COLLECTION}) collection_public,
        (select name from collections where id=${COLLECTION}) collection_name,
        (select name from concepts where id=${CONCEPT}) concept_name,
        (select instructions from concepts where id=${CONCEPT}) concept_instructions,
        (select filename from concept_images where id=${CONCEPT_IMAGE}) concept_filename,
        (select name from skill_definitions where id=${USER_SKILL}) skill_name,
        (select body from skill_definitions where id=${USER_SKILL}) skill_body,
        (select reviewer_id::text from skill_definitions where id=${FOREIGN_SKILL}) foreign_skill_reviewer,
        (select name from skill_definitions where id=${FOREIGN_SKILL}) foreign_skill_name,
        (select skipped_agents from memory_dream_sweeps where id=${PRIVACY_SWEEP}) sweep_skipped,
        (select contributors from collections where id=${FOREIGN_COLLECTION}) foreign_contributors,
        (select contributors from collections where id=${UNRELATED_COLLECTION}) unrelated_contributors,
        (select count(*)::int from etl_social_edges where source_external_id in
          ('foreign-agent-edge','foreign-creation-edge')) deleted_social_edges,
        (select count(*)::int from etl_social_edges where source_external_id='unrelated-edge') unrelated_social_edges,
        (select state from storage_uploads where id=${UPLOAD}) upload_state,
        (select cleanup_state from storage_uploads where id=${UPLOAD}) cleanup_state`;
    expect(privacy).toMatchObject({
      private_deleted: true,
      private_title: null,
      shared_public: false,
      shared_foreign: 'foreign shared survives',
      shared_own: null,
      foreign_foreign: 'foreign content survives',
      foreign_own: null,
      shares: 0,
      collection_public: false,
      collection_name: null,
      concept_name: '[deleted]',
      concept_instructions: null,
      concept_filename: null,
      skill_name: '[deleted]',
      skill_body: '',
      foreign_skill_reviewer: null,
      foreign_skill_name: 'Foreign Skill',
      sweep_skipped: [{ agentAccountId: FOREIGN, openclawId: 'foreign-openclaw' }],
      foreign_contributors: ['legacy-survivor'],
      unrelated_contributors: ['legacy-foreign'],
      deleted_social_edges: 0,
      unrelated_social_edges: 1,
      upload_state: 'aborted',
      cleanup_state: 'pending',
    });

    const targetStore = erasureTargetStore();
    const firstClaim = await targetStore.claimTarget();
    expect(firstClaim && !('status' in firstClaim) ? firstClaim.resourceId : null).not.toBe(HUMAN_OBJECT);
    if (firstClaim && !('status' in firstClaim)) {
      await expect(targetStore.completeTarget(firstClaim)).resolves.toBe('completed');
    }

    const aborts: string[] = [];
    const cleanup = new UploadMultipartCleanupWorker({
      store: new PostgresUploadMultipartCleanupStore(),
      backend: {
        abortMultipart: async ({ backendUploadId }) => { aborts.push(backendUploadId); },
      },
      onError: vi.fn(),
      batchSize: 1,
      leaseMs: 5_000,
      abortTimeoutMs: 1_000,
    });
    await expect(cleanup.tick()).resolves.toMatchObject({ claimed: 1, succeeded: 1 });
    expect(aborts).toEqual(['runtime-multipart']);

    const externalCalls = new Map<string, number>();
    const executor = {
      erase: vi.fn(async ({ kind, resourceId }: { kind: string; resourceId: string }) => {
        const key = `${kind}:${resourceId}`;
        externalCalls.set(key, (externalCalls.get(key) ?? 0) + 1);
        return { confirmedAbsent: true as const };
      }),
    };
    const workers = [
      new AccountErasureTargetWorker(targetStore, executor, 1, 1_000),
      new AccountErasureTargetWorker(targetStore, executor, 1, 1_000),
    ];
    for (let round = 0; round < 4; round += 1) {
      await Promise.all(workers.map((worker) => worker.tick()));
    }
    expect([...externalCalls.values()].every((count) => count === 1)).toBe(true);
    const [finished] = await pg<{ state: string; remaining: number }[]>`
      select j.state,
        (select count(*)::int from account_erasure_targets t
          where t.job_id=j.id and t.state <> 'succeeded') remaining
      from account_erasure_jobs j where j.id=${accepted.jobId}`;
    expect(finished).toEqual({ state: 'succeeded', remaining: 0 });
    await expect(pg`select 1 from stripe_checkout_intents where id=${CHECKOUT_INTENT}`)
      .resolves.toHaveLength(0);
    const [audit] = await pg<{
      actor_account_id: string | null; owner_account_id: string | null; metadata: unknown;
      outbound_rows: number; connection_rows: number;
    }[]>`
      select actor_account_id,owner_account_id,metadata,
        (select count(*)::int from channel_outbound_post_intents where id=${OUTBOUND_INTENT}) outbound_rows,
        (select count(*)::int from channel_connections where id=${CHANNEL_CONNECTION}) connection_rows
      from secret_access_audit_events where secret_id=${CHANNEL_CONNECTION}`;
    expect(audit).toEqual({
      actor_account_id: null, owner_account_id: null, metadata: {},
      outbound_rows: 0, connection_rows: 0,
    });
    await expect(pg`
      insert into etl_social_edges
        (source_collection,source_external_id,edge_kind,user_id,target_id,last_seen_run_id)
      values ('users3','reinsert-deleted-target','agent_like',${FOREIGN},${AGENT},${randomUUID()})`
    ).rejects.toThrow();

    const collectionApp = Fastify();
    collectionApp.decorateRequest('account', null);
    collectionApp.decorate('requireAuth', requireAuth);
    collectionApp.decorate('accessAllowlist', new Set<string>());
    await collectionApp.register(collectionsRoutes);
    expect((await collectionApp.inject({ method: 'GET', url: `/collections/${COLLECTION}` })).statusCode)
      .toBe(404);
    await collectionApp.close();

    const raceAccount = randomUUID();
    await pg`
      insert into accounts (id,type,username) values
        (${raceAccount},'user',${`erase_race_${raceAccount.slice(0, 8)}`})`;
    const raceStore = erasureStore();
    const intent = await raceStore.acceptIntent({
      accountId: raceAccount,
      confirmUsername: `erase_race_${raceAccount.slice(0, 8)}`,
    });
    const claim = await raceStore.claimIntentForRecovery();
    expect(claim && !('status' in claim) ? claim.intent.jobId : null).toBe(intent.jobId);
    await expect(raceStore.sealUnclaimedAfterLedgerConfirmation({
      jobId: intent.jobId,
      accountId: raceAccount,
      acceptedAt: intent.acceptedAt,
      confirmedAt: new Date(Date.now() + 1_000).toISOString(),
      ledgerSha256: sha('race-ledger'),
      ledgerMacSha256: sha('race-ledger-mac'),
    })).resolves.toEqual({ jobId: intent.jobId, status: 'stale' });
    expect(claim).not.toBeNull();
    if (claim && !('status' in claim)) {
      const sealed = await raceStore.sealClaimedAfterLedgerConfirmation({
        jobId: intent.jobId,
        accountId: raceAccount,
        acceptedAt: intent.acceptedAt,
        confirmedAt: new Date(Date.now() + 1_000).toISOString(),
        ledgerSha256: sha('race-ledger'),
        ledgerMacSha256: sha('race-ledger-mac'),
        claimToken: claim.claimToken,
        claimExpiresAt: claim.claimExpiresAt,
      });
      if (sealed.status === 'stale') throw new Error('recovery claim unexpectedly became stale');
      const confirmation = await recoverySink().encryptWriteAndConfirm(sealed.recoveryManifest);
      await expect(raceStore.confirmClaimedRecoveryManifest({
        jobId: intent.jobId,
        accountId: raceAccount,
        confirmation,
        claimToken: claim.claimToken,
        claimExpiresAt: claim.claimExpiresAt,
      })).resolves.toMatchObject({ status: expect.stringMatching(/pending|succeeded/) });
    }

    const durableText = JSON.stringify(await pg`
      select kind,resource_id,state,last_error_code from account_erasure_targets
      union all select 'job',id,state,last_error_code from account_erasure_jobs`);
    expect(durableText).not.toContain('clerk-runtime-human');
    expect(durableText).not.toContain('runtime-multipart');
    expect(durableText).not.toContain('private payload');
  }, 60_000);

  it('converges two accepted erasures across one shared session without cross-job livelock', async () => {
    await pg`
      insert into accounts (id,type,username) values
        (${SHARED_A},'user','erase_shared_a'),
        (${SHARED_B},'user','erase_shared_b')`;
    await pg`
      insert into sessions (id,owner_id,title,is_public)
      values (${SEQUENTIAL_SESSION},${SHARED_A},'two-account secret',true)`;
    await pg`
      insert into session_users (session_id,user_account_id)
      values (${SEQUENTIAL_SESSION},${SHARED_B})`;
    await pg`
      insert into messages (id,session_id,sender_id,content) values
        (${SEQUENTIAL_A_MESSAGE},${SEQUENTIAL_SESSION},${SHARED_A},'secret a'),
        (${SEQUENTIAL_B_MESSAGE},${SEQUENTIAL_SESSION},${SHARED_B},'secret b')`;

    const first = await requestAccountErasure({
      actorAccountId: SHARED_A,
      actorUsername: 'erase_shared_a',
      actorIsAdmin: false,
      confirmUsername: 'erase_shared_a',
    }, erasureStore(), ledger(), recoverySink());
    expect(first.status).toBe('pending');
    const [midpoint] = await pg<{ deleted: boolean; public: boolean; a: string | null; b: string | null }[]>`
      select s.deleted,s.is_public public,
        (select content from messages where id=${SEQUENTIAL_A_MESSAGE}) a,
        (select content from messages where id=${SEQUENTIAL_B_MESSAGE}) b
      from sessions s where s.id=${SEQUENTIAL_SESSION}`;
    expect(midpoint).toEqual({ deleted: false, public: false, a: null, b: 'secret b' });

    const second = await requestAccountErasure({
      actorAccountId: SHARED_B,
      actorUsername: 'erase_shared_b',
      actorIsAdmin: false,
      confirmUsername: 'erase_shared_b',
    }, erasureStore(), ledger(), recoverySink());
    expect(second.status).toBe('pending');
    const [finished] = await pg<{ deleted: boolean; title: string | null; remaining_content: number }[]>`
      select s.deleted,s.title,
        (select count(*)::int from messages where session_id=s.id and content is not null) remaining_content
      from sessions s where s.id=${SEQUENTIAL_SESSION}`;
    expect(finished).toEqual({ deleted: true, title: null, remaining_content: 0 });
  }, 30_000);

  it('globally elects one legacy-byte disposer across two erasure jobs and guards concept success', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'eden3-erasure-global-'));
    try {
    const mediaOwner = randomUUID();
    const conceptOwner = randomUUID();
    const conceptAgent = randomUUID();
    const sessionId = randomUUID();
    const conceptId = randomUUID();
    const mediaId = randomUUID();
    const imageId = randomUUID();
    const sharedSha = sha('two-job-shared-byte');
    const sharedUrl = `/media/${sharedSha}.png`;
    const sharedPath = join(mediaRoot, `${sharedSha}.png`);
    await writeFile(sharedPath, 'shared private bytes');
    await pg`
      insert into accounts (id,type,username) values
        (${mediaOwner},'user',${`erase_media_${mediaOwner.slice(0, 8)}`}),
        (${conceptOwner},'user',${`erase_concept_${conceptOwner.slice(0, 8)}`}),
        (${conceptAgent},'agent',${`erase_agent_${conceptAgent.slice(0, 8)}`})`;
    await pg`insert into agents (account_id,owner_id,name,public)
      values (${conceptAgent},${conceptOwner},'shared byte agent',false)`;
    await pg`insert into sessions (id,owner_id,title) values (${sessionId},${mediaOwner},'shared byte')`;
    await pg`insert into media_assets (id,session_id,url,local_path,sha256,mime)
      values (${mediaId},${sessionId},${sharedUrl},${sharedPath},${sharedSha},'image/png')`;
    await pg`insert into concepts (id,agent_id,name,slug)
      values (${conceptId},${conceptAgent},'shared byte concept',${`shared-${conceptId.slice(0, 8)}`})`;
    await pg`insert into concept_images (id,concept_id,url,local_path,sha256,mime)
      values (${imageId},${conceptId},${sharedUrl},${sharedPath},${sharedSha},'image/png')`;

    for (const [accountId, username] of [
      [mediaOwner, `erase_media_${mediaOwner.slice(0, 8)}`],
      [conceptOwner, `erase_concept_${conceptOwner.slice(0, 8)}`],
    ] as const) {
      await expect(requestAccountErasure({
        actorAccountId: accountId, actorUsername: username,
        actorIsAdmin: false, confirmUsername: username,
      }, erasureStore(), ledger(), recoverySink())).resolves.toMatchObject({ status: 'pending' });
    }
    const targetStore = erasureTargetStore(mediaRoot);
    const claims = await Promise.all([targetStore.claimTarget(), targetStore.claimTarget()]);
    const claimed = claims.filter((value): value is Exclude<typeof value, null | { status: 'attention' }> =>
      Boolean(value && !('status' in value)));
    expect(claimed).toHaveLength(2);
    const locators = claimed.map((value) => JSON.parse(value.locator) as { deletePhysical: boolean });
    expect(locators.filter((value) => value.deletePhysical), JSON.stringify(locators)).toHaveLength(1);

    const conceptClaim = claimed.find((value) => value.kind === 'legacy_concept_asset')!;
    await expect(operatorPg.begin(async (tx) => {
      await tx`select account_erasure_begin_operation()`;
      await tx`select set_config('eden3.erasure_job_id',${conceptClaim.jobId},true)`;
      await tx`select set_config('eden3.erasure_target_kind',${conceptClaim.kind},true)`;
      await tx`select set_config('eden3.erasure_target_resource_id',${conceptClaim.resourceId},true)`;
      await tx`select set_config('eden3.erasure_target_claim_token',${conceptClaim.claimToken},true)`;
      await tx`select set_config('eden3.erasure_target_claim_expires_at',${conceptClaim.claimExpiresAt},true)`;
      await tx`update account_erasure_targets set state='succeeded',claim_token=null,
        claim_expires_at=null,completed_at=statement_timestamp(),updated_at=statement_timestamp()
        where id=${conceptClaim.targetId}`;
    })).rejects.toThrow('positive concept asset absence must precede source disposal');
    const externalErase = vi.fn(async () => ({ confirmedAbsent: true as const }));
    const executor = new LocalLegacyErasureExecutor(
      targetStore.legacyMediaBoundary,
      { erase: externalErase },
    );
    for (const claimedTarget of claimed) {
      await expect(executor.erase({ ...claimedTarget, signal: AbortSignal.timeout(5_000) }))
        .resolves.toEqual({ confirmedAbsent: true });
      await expect(targetStore.completeTarget(claimedTarget)).resolves.toBe('completed');
    }
    await expect(readFile(sharedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(externalErase).not.toHaveBeenCalled();
    const [absence] = await pg<{ media: number; concepts: number }[]>`
      select (select count(*)::int from media_assets where id=${mediaId}) media,
        (select count(*)::int from concept_images where id=${imageId}) concepts`;
    expect(absence).toEqual({ media: 0, concepts: 0 });

    const retainedOwner = randomUUID();
    const retainedForeign = randomUUID();
    const retainedSession = randomUUID();
    const retainedMedia = randomUUID();
    const retainedCreation = randomUUID();
    const retainedSha = sha('retained-foreign-byte');
    const retainedUrl = `/media/${retainedSha}.png`;
    const retainedPath = join(mediaRoot, `${retainedSha}.png`);
    await writeFile(retainedPath, 'foreign referenced bytes');
    await pg`insert into accounts (id,type,username) values
      (${retainedOwner},'user',${`erase_retained_${retainedOwner.slice(0, 8)}`}),
      (${retainedForeign},'user',${`keep_retained_${retainedForeign.slice(0, 8)}`})`;
    await pg`insert into sessions (id,owner_id,title)
      values (${retainedSession},${retainedOwner},'retained byte')`;
    await pg`insert into media_assets (id,session_id,url,local_path,sha256,mime)
      values (${retainedMedia},${retainedSession},${retainedUrl},${retainedPath},${retainedSha},'image/png')`;
    await pg`insert into creations (id,user_id,url,public,deleted)
      values (${retainedCreation},${retainedForeign},${retainedUrl},false,false)`;
    const retainedUsername = `erase_retained_${retainedOwner.slice(0, 8)}`;
    await expect(requestAccountErasure({
      actorAccountId: retainedOwner, actorUsername: retainedUsername,
      actorIsAdmin: false, confirmUsername: retainedUsername,
    }, erasureStore(), ledger(), recoverySink())).resolves.toMatchObject({ status: 'pending' });
    const retainedClaim = await targetStore.claimTarget();
    if (!retainedClaim || 'status' in retainedClaim) throw new Error('expected retained media claim');
    expect(JSON.parse(retainedClaim.locator)).toMatchObject({
      dispositionKey: `local:${retainedUrl}`,
      deletePhysical: false,
      externalDisposition: false,
    });
    await expect(executor.erase({ ...retainedClaim, signal: AbortSignal.timeout(5_000) }))
      .resolves.toEqual({ confirmedAbsent: true });
    await expect(targetStore.completeTarget(retainedClaim)).resolves.toBe('completed');
    await expect(readFile(retainedPath, 'utf8')).resolves.toBe('foreign referenced bytes');
    const [retained] = await pg<{ media: number; creation: number }[]>`
      select (select count(*)::int from media_assets where id=${retainedMedia}) media,
        (select count(*)::int from creations where id=${retainedCreation}) creation`;
    expect(retained).toEqual({ media: 0, creation: 1 });
    } finally {
      await rm(mediaRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('freezes intent first then autonomously converges every provider-free open-work class', async () => {
    await pg`
      insert into accounts (id,type,username) values
        (${WORK_HUMAN},'user','erase_open_work'),(${WORK_AGENT},'agent','erase_open_work_agent')`;
    await pg`
      insert into agents (account_id,owner_id,name,public)
      values (${WORK_AGENT},${WORK_HUMAN},'open work agent',false)`;
    const [manna] = await pg<{ id: string }[]>`
      insert into manna_accounts (account_id,balance,subscription_balance)
      values (${WORK_HUMAN},'70.0000','0.0000') returning id`;
    const reservations: Record<string, string> = {};
    for (const turnId of [WORK_TURN_NO_PROVIDER, WORK_TURN_TERMINAL_ERROR, WORK_TURN_OUTPUT]) {
      const [row] = await pg<{ id: string }[]>`
        insert into manna_transactions (manna_account_id,amount,type,idempotency_key)
        values (${manna!.id},'-10.0000','spend:chat',${turnId}) returning id`;
      reservations[turnId] = row!.id;
      await pg`
        insert into turn_authorizations
          (turn_id,account_id,agent_account_id,provider,model,pricing_basis,ceiling_table_version,
           authorized_max_manna,reserved_subscription_manna,reservation_tx_id,state)
        values (${turnId},${WORK_HUMAN},${WORK_AGENT},'anthropic','claude-haiku-4-5',
          'provider-api','v1','10.0000','0.0000',${row!.id},'reserved')`;
    }
    await pg`
      insert into turn_provider_runs (turn_id,provider_started_at) values
        (${WORK_TURN_TERMINAL_ERROR},statement_timestamp()),
        (${WORK_TURN_OUTPUT},statement_timestamp())`;
    await pg`
      update turn_provider_runs set usable_output_at=statement_timestamp()
      where turn_id=${WORK_TURN_OUTPUT}`;
    await pg`
      insert into channel_turns (turn_id,account_id,agent_id,status,reserved_manna)
      values (${WORK_TURN_NO_PROVIDER},${WORK_HUMAN},${WORK_AGENT},'reserved',10)`;
    await pg`
      insert into usage_events (event_type,status,user_id,agent_id,turn_id,error_code,manna,metadata) values
        ('chat','pending',${WORK_HUMAN},${WORK_AGENT},${WORK_TURN_NO_PROVIDER},null,null,null),
        ('chat','error',${WORK_HUMAN},${WORK_AGENT},${WORK_TURN_TERMINAL_ERROR},
          'provider_terminal_no_output',0,null),
        ('chat','provider_admitted',${WORK_HUMAN},${WORK_AGENT},${WORK_TURN_OUTPUT},null,null,null)`;
    await pg`
      insert into memory_dream_sweeps (id,sweep_key,window_start)
      values (${WORK_SWEEP},'erase-open-work',statement_timestamp())`;
    await pg`
      insert into memory_dream_runs
        (id,sweep_id,agent_account_id,openclaw_id,status,provider_status)
      values (${WORK_DREAM},${WORK_SWEEP},${WORK_AGENT},'erase-open-work','running','not_started')`;
    await pg`
      insert into agent_provision_jobs (agent_account_id,state)
      values (${WORK_AGENT},'pending')`;
    await pg`
      insert into triggers
        (id,user_id,agent_id,name,status,pending_occurrence_id,pending_occurrence_kind)
      values (${WORK_TRIGGER},${WORK_HUMAN},${WORK_AGENT},'erase open work','active',
        ${WORK_OCCURRENCE},'manual')`;

    const completed = await requestAccountErasure({
      actorAccountId: WORK_HUMAN,
      actorUsername: 'erase_open_work',
      actorIsAdmin: false,
      confirmUsername: 'erase_open_work',
    }, erasureStore(), ledger(), recoverySink());
    expect(completed.status).toBe('pending');
    const [truth] = await pg<{
      balance: string; reversed: number; settled: number; channel_status: string;
      open_usage: number; dream_status: string; provision_state: string;
      trigger_deleted: boolean; trigger_occurrence: string | null;
    }[]>`
      select
        (select balance from manna_accounts where account_id=${WORK_HUMAN}) balance,
        (select count(*)::int from turn_authorizations where account_id=${WORK_HUMAN} and state='reversed') reversed,
        (select count(*)::int from turn_authorizations where account_id=${WORK_HUMAN} and state='settled') settled,
        (select status from channel_turns where turn_id=${WORK_TURN_NO_PROVIDER}) channel_status,
        (select count(*)::int from usage_events where user_id=${WORK_HUMAN}
          and status in ('pending','provider_admitted','running','refund_pending')) open_usage,
        (select status from memory_dream_runs where id=${WORK_DREAM}) dream_status,
        (select state from agent_provision_jobs where agent_account_id=${WORK_AGENT}) provision_state,
        (select deleted from triggers where id=${WORK_TRIGGER}) trigger_deleted,
        (select pending_occurrence_id::text from triggers where id=${WORK_TRIGGER}) trigger_occurrence`;
    expect(truth).toEqual({
      balance: '90.0000',
      reversed: 2,
      settled: 1,
      channel_status: 'refunded',
      open_usage: 0,
      dream_status: 'error',
      provision_state: 'failed',
      trigger_deleted: true,
      trigger_occurrence: null,
    });
    expect(reservations[WORK_TURN_OUTPUT]).toBeDefined();
  }, 30_000);

  it('reverses queued STT exactly and deletes private audio before its erasure locator', async () => {
    const accountId = randomUUID();
    const username = `erase_stt_${accountId.slice(0, 8)}`;
    const audioRoot = await mkdtemp(join(tmpdir(), 'eden-erasure-stt-'));
    try {
      await pg`insert into accounts(id,type,username) values (${accountId},'user',${username})`;
      await credit({ accountId, amount: 100, type: 'credit:test' });
      const audio = new PrivateTranscriptionAudioStore(audioRoot);
      await audio.initialize();
      const repository = new PostgresTranscriptionRepository({
        db,
        audio,
        dailyMannaCap: 10_000,
        maxActivePerOwner: 2,
        maxCreatedPerOwnerPerDay: 100,
      });
      const service = new TranscriptionService({
        repository,
        provider: new DeterministicTranscriptionProvider(),
      });
      const created = await service.create(accountId, {
        idempotencyKey: randomUUID(),
        language: 'en',
      });
      const body = Buffer.alloc(32_000, 3);
      await service.appendChunk(accountId, created.id, 0, {
        body,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
      const before = await getBalance(accountId);
      await service.finalize(accountId, created.id, {
        idempotencyKey: randomUUID(),
        finalChunkNumber: 0,
      });
      const intent = await erasureStore().acceptIntent({ accountId, confirmUsername: username });
      const reconciler = new PostgresAccountErasurePresealReconciler(operatorPg as never, audio);

      await reconciler.reconcile({ accountId, jobId: intent.jobId, mode: 'unclaimed' });

      expect(await getBalance(accountId)).toEqual(before);
      const [truth] = await pg<{ sessions: number; usage_status: string; usage_manna: number }[]>`
        select
          (select count(*)::int from transcription_sessions where id=${created.id}) sessions,
          (select status from usage_events where event_type='speech_transcription' and turn_id=${created.id}) usage_status,
          (select manna from usage_events where event_type='speech_transcription' and turn_id=${created.id}) usage_manna`;
      expect(truth).toEqual({ sessions: 0, usage_status: 'error', usage_manna: 0 });
      await expect(access(join(audioRoot, accountId, created.id))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(audioRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('holds unresolved Stripe and outbound effects before inventory in direct and recovery paths', async () => {
    const activeAccount = randomUUID();
    const activeUsername = `erase_effect_active_${activeAccount.slice(0, 8)}`;
    const activeConnection = randomUUID();
    const activeStripePreparing = randomUUID();
    const activeStripeStarted = randomUUID();
    const activePostPreparing = randomUUID();
    const activePostStarted = randomUUID();
    await pg`insert into accounts(id,type,username) values (${activeAccount},'user',${activeUsername})`;
    await pg`
      insert into channel_connections
        (id,account_id,channel,token_ciphertext,token_iv,token_auth_tag,token_sha256)
      values (${activeConnection},${activeAccount},'x','cipher','iv','tag',${sha('active-effect-token')})`;
    await pg`
      insert into stripe_checkout_intents(id,account_id,kind,request_key_sha256) values
        (${activeStripePreparing},${activeAccount},'manna_topup',${sha('active-stripe-preparing')}),
        (${activeStripeStarted},${activeAccount},'manna_topup',${sha('active-stripe-started')})`;
    await pg`update stripe_checkout_intents set state='provider_started'
      where id=${activeStripeStarted}`;
    await pg`
      insert into channel_outbound_post_intents(id,account_id,connection_id) values
        (${activePostPreparing},${activeAccount},${activeConnection}),
        (${activePostStarted},${activeAccount},${activeConnection})`;
    await pg`update channel_outbound_post_intents set state='provider_started'
      where id=${activePostStarted}`;

    const activeStore = erasureStore();
    const directManifest = recoverySink();
    await expect(requestAccountErasure({
      actorAccountId: activeAccount,
      actorUsername: activeUsername,
      actorIsAdmin: false,
      confirmUsername: activeUsername,
    }, activeStore, ledger(), directManifest)).resolves.toEqual({
      jobId: expect.any(String), status: 'pending',
    });
    expect(directManifest.encryptWriteAndConfirm).not.toHaveBeenCalled();
    const [directState] = await pg<{
      deleted: boolean; state: string; inventoried_at: Date | null; active_effects: number;
    }[]>`
      select a.deleted,j.state,j.inventoried_at,
        ((select count(*) from stripe_checkout_intents where account_id=${activeAccount}
            and state in ('preparing','provider_started'))+
         (select count(*) from channel_outbound_post_intents where account_id=${activeAccount}
            and state in ('preparing','provider_started')))::int active_effects
      from accounts a join account_erasure_jobs j on j.account_id=a.id where a.id=${activeAccount}`;
    expect(directState).toEqual({
      deleted: false, state: 'intent_pending', inventoried_at: null, active_effects: 2,
    });

    const recoveryManifest = recoverySink();
    const recovery = new AccountErasureRecoveryWorker(
      activeStore, ledger(), recoveryManifest, 1, 1_000,
    );
    await expect(recovery.tick()).resolves.toMatchObject({
      claimed: 1, sealed: 0, retried: 1,
    });
    expect(recoveryManifest.encryptWriteAndConfirm).not.toHaveBeenCalled();
    const [recoveryState] = await pg<{
      deleted: boolean; state: string; inventoried_at: Date | null; attempt_count: number;
    }[]>`
      select a.deleted,j.state,j.inventoried_at,j.attempt_count::int attempt_count
      from accounts a join account_erasure_jobs j on j.account_id=a.id where a.id=${activeAccount}`;
    expect(recoveryState).toEqual({
      deleted: false, state: 'intent_pending', inventoried_at: null, attempt_count: 1,
    });
    await ordinaryPg`select account_erasure_record_stripe_checkout_terminal(
      ${activeAccount},${activeStripeStarted},'created','cs_active_effect_reconciled',null)`;
    await ordinaryPg`select account_erasure_record_outbound_post_terminal(
      ${activeAccount},${activePostStarted},'succeeded','post_active_effect_reconciled',null)`;
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await expect(recovery.tick()).resolves.toMatchObject({ claimed: 1, sealed: 1 });

    const terminalAccount = randomUUID();
    const terminalUsername = `erase_effect_terminal_${terminalAccount.slice(0, 8)}`;
    const terminalConnection = randomUUID();
    const terminalStripeCreated = randomUUID();
    const terminalStripeFailed = randomUUID();
    const terminalPostSucceeded = randomUUID();
    const terminalPostFailed = randomUUID();
    await pg`insert into accounts(id,type,username) values (${terminalAccount},'user',${terminalUsername})`;
    await pg`
      insert into channel_connections
        (id,account_id,channel,token_ciphertext,token_iv,token_auth_tag,token_sha256)
      values (${terminalConnection},${terminalAccount},'x','cipher','iv','tag',${sha('terminal-effect-token')})`;
    await pg`
      insert into stripe_checkout_intents(id,account_id,kind,request_key_sha256) values
        (${terminalStripeCreated},${terminalAccount},'manna_topup',${sha('terminal-stripe-created')}),
        (${terminalStripeFailed},${terminalAccount},'manna_topup',${sha('terminal-stripe-failed')})`;
    await pg`update stripe_checkout_intents set state='provider_started'
      where id=${terminalStripeCreated}`;
    await pg`update stripe_checkout_intents set state='created',stripe_session_id='cs_terminal_created'
      where id=${terminalStripeCreated}`;
    await pg`update stripe_checkout_intents set state='failed',last_error_code='provider_failed'
      where id=${terminalStripeFailed}`;
    await pg`
      insert into channel_outbound_post_intents(id,account_id,connection_id) values
        (${terminalPostSucceeded},${terminalAccount},${terminalConnection}),
        (${terminalPostFailed},${terminalAccount},${terminalConnection})`;
    await pg`update channel_outbound_post_intents set state='provider_started'
      where id=${terminalPostSucceeded}`;
    await pg`update channel_outbound_post_intents set state='succeeded',provider_post_id='post_terminal'
      where id=${terminalPostSucceeded}`;
    await pg`update channel_outbound_post_intents set state='failed',last_error_code='provider_failed'
      where id=${terminalPostFailed}`;

    const terminalManifest = recoverySink();
    await expect(requestAccountErasure({
      actorAccountId: terminalAccount,
      actorUsername: terminalUsername,
      actorIsAdmin: false,
      confirmUsername: terminalUsername,
    }, erasureStore(), ledger(), terminalManifest)).resolves.toMatchObject({ status: 'pending' });
    expect(terminalManifest.encryptWriteAndConfirm).toHaveBeenCalledTimes(1);
    const [terminalState] = await pg<{
      deleted: boolean; inventoried: boolean; stripe_states: string[]; post_states: string[];
    }[]>`
      select a.deleted,(j.inventoried_at is not null) inventoried,
        (select array_agg(state order by state) from stripe_checkout_intents
          where account_id=${terminalAccount}) stripe_states,
        (select array_agg(state order by state) from channel_outbound_post_intents
          where account_id=${terminalAccount}) post_states
      from accounts a join account_erasure_jobs j on j.account_id=a.id where a.id=${terminalAccount}`;
    expect(terminalState).toEqual({
      deleted: true,
      inventoried: true,
      stripe_states: ['created', 'failed'],
      post_states: ['failed', 'succeeded'],
    });
  }, 30_000);

  it('independently fences and evidence-terminalizes every outbound-effect state', async () => {
    const cases = [
      { kind: 'stripe' as const, state: 'preparing' as const },
      { kind: 'stripe' as const, state: 'provider_started' as const },
      { kind: 'x' as const, state: 'preparing' as const },
      { kind: 'x' as const, state: 'provider_started' as const },
    ];
    for (const [index, testCase] of cases.entries()) {
      const accountId = randomUUID();
      const intentId = randomUUID();
      const connectionId = randomUUID();
      const username = `erase_effect_${testCase.kind}_${testCase.state}_${accountId.slice(0, 8)}`;
      await pg`insert into accounts(id,type,username) values (${accountId},'user',${username})`;
      if (testCase.kind === 'stripe') {
        await pg`insert into stripe_checkout_intents(id,account_id,kind,request_key_sha256)
          values (${intentId},${accountId},'manna_topup',${sha(`independent-stripe-${index}`)})`;
        if (testCase.state === 'provider_started') {
          await pg`update stripe_checkout_intents set state='provider_started' where id=${intentId}`;
        }
      } else {
        await pg`insert into channel_connections
          (id,account_id,channel,token_ciphertext,token_iv,token_auth_tag,token_sha256)
          values (${connectionId},${accountId},'x','cipher','iv','tag',${sha(`independent-x-${index}`)})`;
        await pg`insert into channel_outbound_post_intents(id,account_id,connection_id)
          values (${intentId},${accountId},${connectionId})`;
        if (testCase.state === 'provider_started') {
          await pg`update channel_outbound_post_intents set state='provider_started' where id=${intentId}`;
        }
      }

      const store = erasureStore();
      const manifest = recoverySink();
      const accepted = await requestAccountErasure({
        actorAccountId: accountId,
        actorUsername: username,
        actorIsAdmin: false,
        confirmUsername: username,
      }, store, ledger(), manifest);
      expect(accepted).toEqual({ jobId: expect.any(String), status: 'pending' });
      if (testCase.state === 'preparing') {
        expect(manifest.encryptWriteAndConfirm).toHaveBeenCalledTimes(1);
        const table = testCase.kind === 'stripe'
          ? await pg<{ state: string; last_error_code: string | null }[]>`
              select state,last_error_code from stripe_checkout_intents where id=${intentId}`
          : await pg<{ state: string; last_error_code: string | null }[]>`
              select state,last_error_code from channel_outbound_post_intents where id=${intentId}`;
        expect(table[0]).toEqual({
          state: 'failed', last_error_code: 'erasure_cancelled_before_provider',
        });
        const [direct] = await pg<{ deleted: boolean; inventoried: boolean }[]>`
          select a.deleted,(j.inventoried_at is not null) inventoried from accounts a
          join account_erasure_jobs j on j.account_id=a.id where a.id=${accountId}`;
        expect(direct).toEqual({ deleted: true, inventoried: true });

        // Crash/restart shape: Tx1 committed but no direct seal call survived.
        const restartAccount = randomUUID();
        const restartIntent = randomUUID();
        const restartConnection = randomUUID();
        const restartUsername = `erase_restart_${testCase.kind}_${restartAccount.slice(0, 8)}`;
        await pg`insert into accounts(id,type,username) values
          (${restartAccount},'user',${restartUsername})`;
        if (testCase.kind === 'stripe') {
          await pg`insert into stripe_checkout_intents(id,account_id,kind,request_key_sha256)
            values (${restartIntent},${restartAccount},'manna_topup',${sha(`restart-stripe-${index}`)})`;
        } else {
          await pg`insert into channel_connections
            (id,account_id,channel,token_ciphertext,token_iv,token_auth_tag,token_sha256)
            values (${restartConnection},${restartAccount},'x','cipher','iv','tag',
              ${sha(`restart-x-${index}`)})`;
          await pg`insert into channel_outbound_post_intents(id,account_id,connection_id)
            values (${restartIntent},${restartAccount},${restartConnection})`;
        }
        await store.acceptIntent({ accountId: restartAccount, confirmUsername: restartUsername });
        if (testCase.kind === 'stripe') {
          await expect(ordinaryPg`select account_erasure_record_stripe_checkout_terminal(
            ${restartAccount},${restartIntent},'created','cs_forged_started',null
          ) recorded`).resolves.toEqual([{ recorded: false }]);
          await expect(ordinaryPg`update stripe_checkout_intents set state='provider_started'
            where id=${restartIntent}`).rejects.toMatchObject({ code: '55000' });
        } else {
          await expect(ordinaryPg`select account_erasure_record_outbound_post_terminal(
            ${restartAccount},${restartIntent},'succeeded','post_forged_started',null
          ) recorded`).resolves.toEqual([{ recorded: false }]);
          await expect(ordinaryPg`update channel_outbound_post_intents set state='provider_started'
            where id=${restartIntent}`).rejects.toMatchObject({ code: '55000' });
        }
        const restartManifest = recoverySink();
        const restartRecovery = new AccountErasureRecoveryWorker(
          store, ledger(), restartManifest, 1, 1_000,
        );
        await expect(restartRecovery.tick()).resolves.toMatchObject({ claimed: 1, sealed: 1 });
        const [restartTruth] = await pg<{ deleted: boolean; state: string }[]>`
          select a.deleted,
            ${testCase.kind === 'stripe'
              ? pg`(select state from stripe_checkout_intents where id=${restartIntent})`
              : pg`(select state from channel_outbound_post_intents where id=${restartIntent})`} state
          from accounts a where a.id=${restartAccount}`;
        expect(restartTruth).toEqual({ deleted: true, state: 'failed' });
        continue;
      }
      expect(manifest.encryptWriteAndConfirm).not.toHaveBeenCalled();
      const [before] = await pg<{
        deleted: boolean; state: string; inventoried_at: Date | null;
      }[]>`select a.deleted,j.state,j.inventoried_at from accounts a
        join account_erasure_jobs j on j.account_id=a.id where a.id=${accountId}`;
      expect(before).toEqual({ deleted: false, state: 'intent_pending', inventoried_at: null });

      const recovery = new AccountErasureRecoveryWorker(store, ledger(), manifest, 1, 1_000);
      await expect(recovery.tick()).resolves.toMatchObject({ claimed: 1, sealed: 0, retried: 1 });
      expect(manifest.encryptWriteAndConfirm).not.toHaveBeenCalled();

      if (testCase.kind === 'stripe') {
        const terminal = ['created', `cs_independent_${index}`, null] as const;
        await expect(ordinaryPg`select account_erasure_record_stripe_checkout_terminal(
          ${randomUUID()},${intentId},${terminal[0]},${terminal[1]},${terminal[2]}) recorded`)
          .resolves.toEqual([{ recorded: false }]);
        await expect(ordinaryPg`select account_erasure_record_stripe_checkout_terminal(
          ${accountId},${intentId},'failed',null,'forged_error') recorded`)
          .resolves.toEqual([{ recorded: false }]);
        await expect(ordinaryPg`select account_erasure_record_stripe_checkout_terminal(
          ${accountId},${intentId},${terminal[0]},${terminal[1]},${terminal[2]}) recorded`)
          .resolves.toEqual([{ recorded: true }]);
      } else {
        const terminal = ['succeeded', `post_independent_${index}`, null] as const;
        await expect(ordinaryPg`select account_erasure_record_outbound_post_terminal(
          ${randomUUID()},${intentId},${terminal[0]},${terminal[1]},${terminal[2]}) recorded`)
          .resolves.toEqual([{ recorded: false }]);
        await expect(ordinaryPg`select account_erasure_record_outbound_post_terminal(
          ${accountId},${intentId},'failed',null,'forged_error') recorded`)
          .resolves.toEqual([{ recorded: false }]);
        await expect(ordinaryPg`select account_erasure_record_outbound_post_terminal(
          ${accountId},${intentId},${terminal[0]},${terminal[1]},${terminal[2]}) recorded`)
          .resolves.toEqual([{ recorded: true }]);
      }

      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await expect(recovery.tick()).resolves.toMatchObject({ claimed: 1, sealed: 1 });
      const [after] = await pg<{ deleted: boolean; inventoried: boolean }[]>`
        select a.deleted,(j.inventoried_at is not null) inventoried from accounts a
        join account_erasure_jobs j on j.account_id=a.id where a.id=${accountId}`;
      expect(after).toEqual({ deleted: true, inventoried: true });
    }
  }, 60_000);

  it('admits each terminal outbound-effect state without aggregate masking', async () => {
    const cases = [
      { kind: 'stripe' as const, state: 'created' as const },
      { kind: 'stripe' as const, state: 'failed' as const },
      { kind: 'x' as const, state: 'succeeded' as const },
      { kind: 'x' as const, state: 'failed' as const },
    ];
    for (const [index, testCase] of cases.entries()) {
      const accountId = randomUUID();
      const intentId = randomUUID();
      const connectionId = randomUUID();
      const username = `erase_terminal_${testCase.kind}_${testCase.state}_${accountId.slice(0, 8)}`;
      await pg`insert into accounts(id,type,username) values (${accountId},'user',${username})`;
      if (testCase.kind === 'stripe') {
        await pg`insert into stripe_checkout_intents(id,account_id,kind,request_key_sha256)
          values (${intentId},${accountId},'manna_topup',${sha(`terminal-stripe-${index}`)})`;
        if (testCase.state === 'created') {
          await pg`update stripe_checkout_intents set state='provider_started' where id=${intentId}`;
          await pg`update stripe_checkout_intents set state='created',stripe_session_id=${`cs_terminal_${index}`}
            where id=${intentId}`;
        } else {
          await pg`update stripe_checkout_intents set state='failed',last_error_code='provider_failed'
            where id=${intentId}`;
        }
      } else {
        await pg`insert into channel_connections
          (id,account_id,channel,token_ciphertext,token_iv,token_auth_tag,token_sha256)
          values (${connectionId},${accountId},'x','cipher','iv','tag',${sha(`terminal-x-${index}`)})`;
        await pg`insert into channel_outbound_post_intents(id,account_id,connection_id)
          values (${intentId},${accountId},${connectionId})`;
        if (testCase.state === 'succeeded') {
          await pg`update channel_outbound_post_intents set state='provider_started' where id=${intentId}`;
          await pg`update channel_outbound_post_intents set state='succeeded',provider_post_id=${`post_terminal_${index}`}
            where id=${intentId}`;
        } else {
          await pg`update channel_outbound_post_intents set state='failed',last_error_code='provider_failed'
            where id=${intentId}`;
        }
      }
      const manifest = recoverySink();
      await expect(requestAccountErasure({
        actorAccountId: accountId,
        actorUsername: username,
        actorIsAdmin: false,
        confirmUsername: username,
      }, erasureStore(), ledger(), manifest)).resolves.toEqual({
        jobId: expect.any(String), status: 'pending',
      });
      expect(manifest.encryptWriteAndConfirm).toHaveBeenCalledTimes(1);
      const [truth] = await pg<{ deleted: boolean; inventoried: boolean }[]>`
        select a.deleted,(j.inventoried_at is not null) inventoried from accounts a
        join account_erasure_jobs j on j.account_id=a.id where a.id=${accountId}`;
      expect(truth).toEqual({ deleted: true, inventoried: true });
    }
  }, 30_000);

  it('records real provider terminal-no-output after Tx1 freezes reversal, then recovery refunds once', async () => {
    const accountId = randomUUID();
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const username = `erase_live_${accountId.slice(0, 8)}`;
    await pg`insert into accounts (id,type,username) values
      (${accountId},'user',${username}),(${agentId},'agent',${`agent_${agentId.slice(0, 8)}`})`;
    await pg`insert into agents (account_id,owner_id,name,openclaw_id,provision_status,public)
      values (${agentId},${accountId},'live erasure agent',${`bot-${agentId}`},'ready',false)`;
    const [session] = await db.insert(sessions).values({
      id: sessionId,
      ownerId: accountId,
      title: 'live provider erasure',
      sessionType: 'chat',
      gatewaySessionKey: gatewaySessionKey(sessionId),
    }).returning();
    await pg`insert into session_users (session_id,user_account_id) values (${sessionId},${accountId})`;
    await pg`insert into session_agents (session_id,agent_account_id) values (${sessionId},${agentId})`;
    await credit({ accountId, amount: 200, type: 'credit:test', db });

    let providerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { providerEntered = resolve; });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const compat: CompatClientLike = {
      async *chatTurn() {
        providerEntered();
        yield { type: 'turn.started' as const };
        await providerGate;
        yield { type: 'error' as const, code: 'gateway_upstream_error', message: 'provider failed' };
      },
    };
    const turn = runTurn({
      compat,
      bus: new EventsBus(),
      registry: new TurnRegistry(),
      db: ordinaryDb,
      historySync: new HistorySync({ tools: { sessionsHistory: async () => ({
        sessionKey: '', messages: [], truncated: false, contentTruncated: false,
      }) } }),
    }, {
      session: session!,
      agent: {
        accountId: agentId,
        username: `agent_${agentId.slice(0, 8)}`,
        openclawId: `bot-${agentId}`,
        model: 'anthropic/claude-haiku-4-5',
        agentRuntime: 'openclaw',
      },
      user: { accountId, username, isAdmin: false },
      content: 'fail after erasure intent',
      beginStream: () => ({ emit() {}, end() {} }),
    });
    await entered;
    const pending = await requestAccountErasure({
      actorAccountId: accountId, actorUsername: username,
      actorIsAdmin: false, confirmUsername: username,
    }, erasureStore(), ledger(), recoverySink());
    expect(pending.status).toBe('pending');
    const [frozen] = await pg<{ deleted: boolean; state: string; reserved: number; balance: string }[]>`
      select a.deleted,j.state,
        (select count(*)::int from turn_authorizations where account_id=${accountId} and state='reserved') reserved,
        (select balance from manna_accounts where account_id=${accountId}) balance
      from accounts a join account_erasure_jobs j on j.account_id=a.id where a.id=${accountId}`;
    expect(frozen).toEqual({ deleted: false, state: 'intent_pending', reserved: 1, balance: '139.0000' });

    // A terminal-writer connection may set custom GUCs/search_path, but the
    // security-definer evidence producer and account fence resolve only the
    // public catalog. Temp shadows cannot authorize or redirect either one.
    await ordinaryPg`create temp table account_erasure_jobs (account_id uuid,state text)`;
    await ordinaryPg`create temp table usage_events (turn_id uuid,status text)`;
    await ordinaryPg`create temp table turn_authorizations (turn_id uuid,state text)`;
    await ordinaryPg`create temp table turn_provider_runs (turn_id uuid,usable_output_at timestamptz)`;
    await ordinaryPg`set search_path=pg_temp,public`;
    await expect(ordinaryPg`update public.accounts set username=username where id=${accountId}`)
      .rejects.toThrow('account is deleted or has an active erasure job');

    releaseProvider();
    const outcome = await turn;
    await ordinaryPg`reset search_path`;
    await ordinaryPg`drop table if exists pg_temp.account_erasure_jobs`;
    await ordinaryPg`drop table if exists pg_temp.usage_events`;
    await ordinaryPg`drop table if exists pg_temp.turn_authorizations`;
    await ordinaryPg`drop table if exists pg_temp.turn_provider_runs`;
    expect(outcome.errorCode).toBe('gateway_upstream_error');
    const [evidence] = await pg<{
      state: string; status: string; manna: number; error_code: string;
      error_message: string | null; metadata: unknown;
    }[]>`
      select a.state,u.status,u.manna,u.error_code,u.error_message,u.metadata
      from turn_authorizations a join usage_events u on u.turn_id=a.turn_id
      where a.turn_id=${outcome.turnId}`;
    expect(evidence).toEqual({
      state: 'reserved', status: 'error', manna: 0,
      error_code: 'provider_terminal_no_output', error_message: null, metadata: null,
    });
    const recovery = new AccountErasureRecoveryWorker(erasureStore(), ledger(), recoverySink(), 1, 1_000);
    await expect(recovery.tick()).resolves.toMatchObject({ claimed: 1, sealed: 1 });
    const [final] = await pg<{ state: string; balance: string; refunds: number }[]>`
      select a.state,(select balance from manna_accounts where account_id=${accountId}) balance,
        (select count(*)::int from manna_transactions r join turn_authorizations x
          on x.reservation_tx_id=r.refunds_transaction_id where x.turn_id=a.turn_id) refunds
      from turn_authorizations a where a.turn_id=${outcome.turnId}`;
    expect(final).toEqual({ state: 'reversed', balance: '200.0000', refunds: 1 });
  }, 30_000);

  it('binds native channel provider admission and terminal evidence to the attested ordinary login', async () => {
    for (const terminal of ['no_output', 'usable_output'] as const) {
      const accountId = randomUUID();
      const agentId = randomUUID();
      const connectionId = randomUUID();
      const turnId = randomUUID();
      const username = `erase_channel_${terminal}_${accountId.slice(0, 8)}`;
      const runtimeAccountId = `runtime-${agentId}`;
      await pg`insert into accounts (id,type,username) values
        (${accountId},'user',${username}),(${agentId},'agent',${`agent_${agentId.slice(0, 8)}`})`;
      await pg`insert into agents
        (account_id,owner_id,openclaw_id,model,provision_status,public)
        values (${agentId},${accountId},${`bot-${agentId}`},'anthropic/claude-haiku-4-5','ready',false)`;
      await pg`insert into channel_connections
        (id,account_id,agent_id,channel,desired_state,runtime_account_id,
         token_ciphertext,token_iv,token_auth_tag,token_sha256)
        values (${connectionId},${accountId},${agentId},'discord','active',${runtimeAccountId},
          'ciphertext','iv','tag',${sha(`channel:${connectionId}`)})`;
      await credit({ accountId, amount: 500, type: 'credit:test', db: ordinaryDb });
      const channel = new ChannelTurnMeteringService(
        new PostgresChannelTurnStore(async () => 'openclaw', ordinaryDb, ordinaryPg as never),
        ordinaryDb,
      );
      await expect(channel.reserve({
        turnId,
        connectionId,
        runtimeAccountId,
      })).resolves.toMatchObject({ turn: { turnId, status: 'reserved' } });
      const [admission] = await pg<{ runs: number; usages: number }[]>`
        select
          (select count(*)::int from turn_provider_runs where turn_id=${turnId}) runs,
          (select count(*)::int from usage_events where turn_id=${turnId}
            and event_type='channel_chat' and status='provider_admitted') usages`;
      expect(admission).toEqual({ runs: 1, usages: 1 });
      await expect(requestAccountErasure({
        actorAccountId: accountId,
        actorUsername: username,
        actorIsAdmin: false,
        confirmUsername: username,
      }, erasureStore(), ledger(), recoverySink())).resolves.toMatchObject({ status: 'pending' });
      if (terminal === 'no_output') {
        await expect(channel.refund(turnId)).resolves.toBeUndefined();
      } else {
        await expect(channel.settle(turnId, {
          promptTokens: 1,
          completionTokens: 1,
        }, {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          agentRuntime: 'openclaw',
        })).rejects.toThrow('account is deleted or has an active erasure job');
      }
      const recovery = new AccountErasureRecoveryWorker(
        erasureStore(), ledger(), recoverySink(), 1, 1_000,
      );
      await expect(recovery.tick()).resolves.toMatchObject({ claimed: 1, sealed: 1 });
      const [terminalTruth] = await pg<{
        auth_state: string; usage_status: string; usage_manna: number; refunds: number;
      }[]>`
        select a.state auth_state,u.status usage_status,u.manna usage_manna,
          (select count(*)::int from manna_transactions r
            where r.refunds_transaction_id=a.reservation_tx_id) refunds
        from turn_authorizations a join usage_events u on u.turn_id=a.turn_id
        where a.turn_id=${turnId}`;
      expect(terminalTruth).toEqual(terminal === 'no_output'
        ? { auth_state: 'reversed', usage_status: 'error', usage_manna: 0, refunds: 1 }
        : { auth_state: 'settled', usage_status: 'completed', usage_manna: expect.any(Number), refunds: 0 });
      if (terminal === 'usable_output') expect(terminalTruth!.usage_manna).toBeGreaterThan(0);
    }

    const frozenAccount = randomUUID();
    const frozenAgent = randomUUID();
    const frozenConnection = randomUUID();
    const frozenUsername = `erase_channel_frozen_${frozenAccount.slice(0, 8)}`;
    await pg`insert into accounts(id,type,username) values
      (${frozenAccount},'user',${frozenUsername}),
      (${frozenAgent},'agent',${`agent_${frozenAgent.slice(0, 8)}`})`;
    await pg`insert into agents(account_id,owner_id,openclaw_id,model,provision_status,public)
      values (${frozenAgent},${frozenAccount},${`bot-${frozenAgent}`},
        'anthropic/claude-haiku-4-5','ready',false)`;
    await pg`insert into channel_connections
      (id,account_id,agent_id,channel,desired_state,runtime_account_id,
       token_ciphertext,token_iv,token_auth_tag,token_sha256)
      values (${frozenConnection},${frozenAccount},${frozenAgent},'discord','active',
        ${`runtime-${frozenAgent}`},'ciphertext','iv','tag',${sha(`channel:${frozenConnection}`)})`;
    await credit({ accountId: frozenAccount, amount: 500, type: 'credit:test', db: ordinaryDb });
    await requestAccountErasure({
      actorAccountId: frozenAccount,
      actorUsername: frozenUsername,
      actorIsAdmin: false,
      confirmUsername: frozenUsername,
    }, erasureStore(), ledger(), recoverySink());
    const frozenChannel = new ChannelTurnMeteringService(
      new PostgresChannelTurnStore(async () => 'openclaw', ordinaryDb, ordinaryPg as never),
      ordinaryDb,
    );
    await expect(frozenChannel.reserve({
      turnId: randomUUID(),
      connectionId: frozenConnection,
      runtimeAccountId: `runtime-${frozenAgent}`,
    })).rejects.toThrow();
    expect(await pg`select 1 from turn_provider_runs r join turn_authorizations a on a.turn_id=r.turn_id
      where a.account_id=${frozenAccount}`).toHaveLength(0);
  }, 30_000);

  it('converges real Studio and chat-media provider admissions after Tx1 without broad refund authority', async () => {
    for (const kind of ['studio_generation', 'chat_media'] as const) {
      const accountId = randomUUID();
      const agentId = randomUUID();
      const sessionId = randomUUID();
      const username = `erase_${kind}_${accountId.slice(0, 8)}`;
      const openclawId = `bot-${agentId}`;
      await pg`insert into accounts (id,type,username) values
        (${accountId},'user',${username}),(${agentId},'agent',${`agent_${agentId.slice(0, 8)}`})`;
      await pg`insert into agents (account_id,owner_id,openclaw_id,provision_status,public)
        values (${agentId},${accountId},${openclawId},'ready',false)`;
      await pg`insert into sessions (id,owner_id,title,session_type,gateway_session_key)
        values (${sessionId},${accountId},${kind},'chat',${gatewaySessionKey(sessionId)})`;
      await pg`insert into session_users(session_id,user_account_id) values (${sessionId},${accountId})`;
      await pg`insert into session_agents(session_id,agent_account_id) values (${sessionId},${agentId})`;
      await credit({ accountId, amount: 500, type: 'credit:test', db: ordinaryDb });

      let turnId: string;
      let reservationTxId: string;
      let compensate: () => Promise<string>;
      if (kind === 'studio_generation') {
        turnId = randomUUID();
        const reservation = await reserveStudioGeneration({
          turnId,
          accountId,
          tool: 'tts',
          quote: {
            action: 'tts', provider: 'openai', model: 'gpt-4o-mini-tts',
            tableVersion: 'erasure-pg-v1', costUsd: 0.034, manna: 34,
          },
          reservationKey: `studio:${turnId}:reserve`,
          dailyCap: 10_000,
          db: ordinaryDb,
        });
        await admitStudioGeneration({ reservation, db: ordinaryDb });
        reservationTxId = reservation.metadata.reservation.transactionId;
        compensate = () => compensateStudioGeneration({
          turnId, errorCode: 'provider_failed', errorMessage: 'safe failure', db: ordinaryDb,
        });
      } else {
        const quote = quoteChatMediaTool('image_generate', { prompt: 'erasure race' });
        const authorization = await reserveChatMedia({
          request: {
            runId: randomUUID(), toolCallId: randomUUID(),
            sessionKey: `agent:${openclawId}:${gatewaySessionKey(sessionId)}`,
            agentId: openclawId, tool: 'image_generate', args: { prompt: 'erasure race' },
          },
          dailyCap: 10_000,
          db: ordinaryDb,
        });
        turnId = authorization.authorizationId;
        reservationTxId = authorization.metadata.reservation.transactionId;
        compensate = () => compensateChatMedia({
          authorizationId: turnId, errorCode: 'provider_failed',
          errorMessage: 'safe failure', db: ordinaryDb,
        });
        expect(quote.manna).toBe(authorization.quote.manna);
      }
      const debited = (await getBalance(accountId, { db: ordinaryDb })).total;
      const pending = await requestAccountErasure({
        actorAccountId: accountId, actorUsername: username,
        actorIsAdmin: false, confirmUsername: username,
      }, erasureStore(), ledger(), recoverySink());
      expect(pending.status).toBe('pending');
      await expect(compensate()).resolves.toBe('refund_pending');
      const [evidence] = await pg<{ status: string; error_code: string; manna: number; metadata: unknown }[]>`
        select status,error_code,manna,metadata from usage_events where turn_id=${turnId}`;
      expect(evidence?.status).toBe('refund_pending');
      expect(evidence?.error_code).toBe('refund_pending');
      expect(evidence?.manna).toBeGreaterThan(0);
      expect(evidence?.metadata).toMatchObject({
        terminalEvidence: { version: 1, code: 'provider_terminal_no_output' },
        outputQuarantine: { version: 1 },
      });
      expect(JSON.stringify(evidence?.metadata)).not.toContain('safe failure');
      expect((await getBalance(accountId)).total).toBe(debited);
      const recovery = new AccountErasureRecoveryWorker(
        erasureStore(), ledger(), recoverySink(), 1, 1_000,
      );
      await expect(recovery.tick()).resolves.toMatchObject({ claimed: 1, sealed: 1 });
      expect((await getBalance(accountId)).total).toBe(500);
      const [terminal] = await pg<{ status: string; refunds: number }[]>`
        select u.status,(select count(*)::int from manna_transactions r
          where r.refunds_transaction_id=${reservationTxId}) refunds
        from usage_events u where u.turn_id=${turnId}`;
      expect(terminal?.status).toBe('error');
      expect(terminal?.refunds).toBe(1);
    }
  }, 30_000);

  it('accepts intent before provider completion and resumes from monotonic terminal evidence', async () => {
    await pg`insert into accounts (id,type,username) values (${LATE_HUMAN},'user','erase_late_terminal')`;
    const [manna] = await pg<{ id: string }[]>`
      insert into manna_accounts (account_id,balance,subscription_balance)
      values (${LATE_HUMAN},'80.0000','0.0000') returning id`;
    for (const turnId of [LATE_ERROR_TURN, LATE_OUTPUT_TURN]) {
      const [reservation] = await pg<{ id: string }[]>`
        insert into manna_transactions (manna_account_id,amount,type,idempotency_key)
        values (${manna!.id},'-10.0000','spend:chat',${turnId}) returning id`;
      await pg`
        insert into turn_authorizations
          (turn_id,account_id,provider,model,pricing_basis,ceiling_table_version,
           authorized_max_manna,reserved_subscription_manna,reservation_tx_id,state)
        values (${turnId},${LATE_HUMAN},'anthropic','claude-haiku-4-5','provider-api','v1',
          '10.0000','0.0000',${reservation!.id},'reserved')`;
      await pg`insert into turn_provider_runs (turn_id) values (${turnId})`;
      await pg`
        insert into usage_events
          (event_type,status,user_id,turn_id,provider,model,pricing_basis)
        values ('chat_turn','provider_admitted',${LATE_HUMAN},${turnId},
          'anthropic','claude-haiku-4-5','provider-api')`;
    }
    const store = erasureStore();
    const pending = await requestAccountErasure({
      actorAccountId: LATE_HUMAN,
      actorUsername: 'erase_late_terminal',
      actorIsAdmin: false,
      confirmUsername: 'erase_late_terminal',
    }, store, ledger(), recoverySink());
    expect(pending.status).toBe('pending');
    const [midpoint] = await pg<{
      deleted: boolean; state: string; inventoried_at: Date | null;
      reserved: number; balance: string; admitted: number;
    }[]>`
      select a.deleted,j.state,j.inventoried_at,
        (select count(*)::int from turn_authorizations where account_id=${LATE_HUMAN} and state='reserved') reserved,
        (select balance from manna_accounts where account_id=${LATE_HUMAN}) balance,
        (select count(*)::int from usage_events where user_id=${LATE_HUMAN}
          and status='provider_admitted') admitted
      from accounts a join account_erasure_jobs j on j.account_id=a.id
      where a.id=${LATE_HUMAN}`;
    expect(midpoint).toEqual({
      deleted: false, state: 'intent_pending', inventoried_at: null,
      reserved: 2, balance: '80.0000', admitted: 2,
    });

    // These are ordinary canonical terminal-evidence writes, not an erasure
    // GUC bypass: 0041 permits only their monotonic, provenance-preserving shape.
    await expect(pg`
      update usage_events set status='error',error_code='provider_terminal_no_output',
        error_message=null,manna=7,metadata=null
      where turn_id=${LATE_ERROR_TURN}`).rejects.toThrow();
    await expect(ordinaryPg`
      select account_erasure_record_provider_terminal_no_output(${LATE_ERROR_TURN}) recorded`
    ).resolves.toMatchObject([{ recorded: true }]);
    await pg`
      update turn_provider_runs set usable_output_at=statement_timestamp()
      where turn_id=${LATE_OUTPUT_TURN}`;
    await expect(ordinaryPg`
      select account_erasure_record_provider_terminal_no_output(${LATE_OUTPUT_TURN}) recorded`
    ).resolves.toMatchObject([{ recorded: false }]);

    const recovery = new AccountErasureRecoveryWorker(store, ledger(), recoverySink(), 1, 1_000);
    await expect(recovery.tick()).resolves.toMatchObject({ claimed: 1, sealed: 1 });
    const [truth] = await pg<{ state: string; balance: string; reversed: number; settled: number }[]>`
      select j.state,(select balance from manna_accounts where account_id=${LATE_HUMAN}) balance,
        (select count(*)::int from turn_authorizations where account_id=${LATE_HUMAN} and state='reversed') reversed,
        (select count(*)::int from turn_authorizations where account_id=${LATE_HUMAN} and state='settled') settled
      from account_erasure_jobs j where j.id=${pending.jobId}`;
    expect(truth).toEqual({ state: 'succeeded', balance: '90.0000', reversed: 1, settled: 1 });
  }, 30_000);

  it('fails closed on malformed foreign collection contributor provenance', async () => {
    await pg`
      insert into accounts (id,type,username)
      values (${FOREIGN},'user','erase_runtime_foreign')`;
    const malformedCases: unknown[] = [
      { contributor: 'embedded-legacy-identity' },
      [null],
      [42],
    ];
    for (const [index, contributors] of malformedCases.entries()) {
      const accountId = randomUUID();
      const collectionId = randomUUID();
      const username = `erase_bad_contributors_${index}_${accountId.slice(0, 8)}`;
      await pg`
        insert into accounts (id,type,username,external_id)
        values (${accountId},'user',${username},${`legacy-${accountId}`})`;
      await pg`
        insert into collections (id,user_id,name,contributors)
        values (${collectionId},${FOREIGN},${`foreign malformed provenance ${index}`},
          ${JSON.stringify(contributors)}::jsonb)`;

      await expect(requestAccountErasure({
        actorAccountId: accountId,
        actorUsername: username,
        actorIsAdmin: false,
        confirmUsername: username,
      }, erasureStore(), ledger(), recoverySink())).rejects.toThrow(
        'account_erasure_collection_contributors_invalid',
      );
      const [state] = await pg<{
        deleted: boolean; contributors: unknown; inventoried_at: Date | null;
      }[]>`
        select a.deleted,c.contributors,j.inventoried_at
        from accounts a
        join account_erasure_jobs j on j.account_id=a.id
        join collections c on c.id=${collectionId}
        where a.id=${accountId}`;
      expect(state).toEqual({ deleted: false, contributors, inventoried_at: null });
    }
  }, 30_000);
});
