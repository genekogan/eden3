import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { credit, gatewaySessionKey, getBalance, type DbHandle } from '@eden3/core';
import { db, pg, sessions } from '@eden3/db';
import Fastify from 'fastify';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { requireAuth } from '../../src/auth-plugin';
import { ApiError } from '../../src/errors';
import { EventsBus } from '../../src/events-bus';
import { collectionsRoutes } from '../../src/routes/collections';
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
  PostgresAccountErasureTargetStore,
  LocalLegacyErasureExecutor,
} from '../../src/services/account-erasure-postgres';
import { PostgresUploadMultipartCleanupStore } from '../../src/services/upload-multipart-cleanup-postgres';
import { UploadMultipartCleanupWorker } from '../../src/services/upload-multipart-cleanup';
import { HistorySync } from '../../src/services/history-sync';
import { legacyMediaIsPubliclyReachable } from '../../src/services/legacy-media-visibility';
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
  await pg.unsafe(`grant select on accounts,agents,sessions,session_users,session_agents,messages,account_erasure_jobs,account_erasure_targets,media_assets,concept_images,creations,concepts to "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant update on accounts,agents to "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant insert,update,delete on media_assets,concept_images,creations to "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant select,insert,update on manna_accounts,manna_transactions,turn_authorizations,turn_provider_runs,usage_events,messages,sessions,session_users,session_agents,channel_turns to "${ORDINARY_LOGIN}"`);
  await pg.unsafe(`grant select,update on channel_connections to "${ORDINARY_LOGIN}"`);
  const base = new URL(process.env.DATABASE_URL!);
  const operatorUrl = new URL(base); operatorUrl.username = OPERATOR_LOGIN; operatorUrl.password = OPERATOR_PASSWORD;
  const ordinaryUrl = new URL(base); ordinaryUrl.username = ORDINARY_LOGIN; ordinaryUrl.password = ORDINARY_PASSWORD;
  operatorPg = postgres(operatorUrl.toString(), { max: 1 });
  ordinaryPg = postgres(ordinaryUrl.toString(), { max: 1 });
  ordinaryDb = drizzle(ordinaryPg) as DbHandle;
  ERASURE_DB_BOUNDARY = await attestAccountErasureDatabaseBoundary({
    operatorClient: operatorPg as never,
    ordinaryApplicationClient: ordinaryPg as never,
    ordinaryApplicationDb: ordinaryDb,
    operatorLogin: OPERATOR_LOGIN,
    ordinaryApplicationLogin: ORDINARY_LOGIN,
  });
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
  it('proves money, privacy, multipart gating, worker concurrency, and route-vs-worker fencing', async () => {
    await pg`
      insert into accounts (id,type,username,clerk_user_id) values
        (${HUMAN},'user','erase_runtime_human','clerk-runtime-human'),
        (${AGENT},'agent','erase_runtime_agent',null),
        (${FOREIGN},'user','erase_runtime_foreign',null)`;
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
      insert into collections (id,user_id,name,description,public)
      values (${COLLECTION},${HUMAN},'public secret collection','private description',true)`;
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
      values (${CHANNEL_CONNECTION},${HUMAN},${AGENT},'discord','ciphertext','iv','tag',
        ${sha('channel-token')},'runtime-private')`;
    await pg`
      insert into secret_access_audit_events
        (actor_account_id,owner_account_id,secret_kind,secret_id,action,metadata)
      values (${HUMAN},${HUMAN},'channel_token',${CHANNEL_CONNECTION},'runtime_retrieve',
        ${JSON.stringify({ runtimeAccountId: 'runtime-private', provider: 'discord', correlation: 'secret' })}::jsonb)`;
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
      sweep_skipped: unknown;
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
});
