import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

import type { PgClient } from '@eden3/db';
import { getEnv, type DbHandle } from '@eden3/core';
import { sql } from 'drizzle-orm';

import { ApiError } from '../errors';
import type { VoiceProviderClient } from './voice-provider';
import { DEFAULT_EVE_USERNAME } from './default-assistant';
import { PrivateTranscriptionAudioStore } from './transcription-audio-custody';
import {
  ACCOUNT_ERASURE_RECOVERY_MANIFEST_SCHEMA_VERSION,
  type AccountErasureClaimResult,
  type AccountErasureIntent,
  type AccountErasureRecoveryManifest,
  type AccountErasureRecoveryManifestConfirmation,
  type AccountErasureRecoveryLocator,
  type AccountErasureRecoveryStore,
  type AccountErasureRequestResult,
  type ClaimedAccountErasureIntent,
} from './account-erasure';

interface PgTransaction {
  <T extends readonly unknown[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): any;
}

type ErasureKind =
  | 'storage_object'
  | 'legacy_media_asset'
  | 'legacy_concept_asset'
  | 'legacy_avatar_asset'
  | 'voice_output'
  | 'voice_clone'
  | 'agent_runtime'
  | 'channel_runtime'
  | 'clerk_identity'
  | 'stripe_customer';

interface InventoryTarget {
  kind: ErasureKind;
  resourceId: string;
  locator?: string;
}

interface JobRow {
  id: string;
  account_id: string;
  state: string;
  accepted_at: Date;
  attempt_count: string;
  claim_token: string | null;
  claim_expires_at: Date | null;
  ledger_confirmed_at: Date | null;
  ledger_sha256: string | null;
  ledger_mac_sha256: string | null;
  inventoried_at: Date | null;
  inventory_sha256: string | null;
  recovery_manifest_sha256: string | null;
}

interface TombstoneRow {
  session_id: string;
  message_id: string;
  author_principal_id: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stableInventoryHash(targets: readonly InventoryTarget[], tombstones: readonly TombstoneRow[]): string {
  const inventory = {
    targets: targets
      .map(({ kind, resourceId }) => ({ kind, resourceId }))
      .sort((a, b) => `${a.kind}:${a.resourceId}`.localeCompare(`${b.kind}:${b.resourceId}`)),
    tombstones: tombstones
      .map((row) => ({
        authorPrincipalId: row.author_principal_id,
        messageId: row.message_id,
        sessionId: row.session_id,
      }))
      .sort((a, b) => a.messageId.localeCompare(b.messageId)),
  };
  return createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
}

function locator(kind: ErasureKind, fields: Record<string, string | null>): string | undefined {
  const entries = Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== null);
  if (entries.length === 0) return undefined;
  return JSON.stringify({ kind, ...Object.fromEntries(entries) });
}

interface StripeSubscriptionLocator {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string;
}

interface StripeErasureLocator {
  kind: 'stripe_customer';
  customerIds: string[];
  checkoutSessionIds: string[];
  checkoutIntents: Array<{
    intentId: string;
    state: 'preparing' | 'provider_started' | 'created' | 'failed';
    requestKeySha256: string;
    stripeSessionId: string | null;
  }>;
  subscriptions: StripeSubscriptionLocator[];
}

const STRIPE_ID_PATTERN = /^[A-Za-z0-9_]{3,255}$/;

/** Rebuild all Stripe identity from immutable, account-owned semantic evidence. */
export async function stripeErasureLocator(
  tx: PgTransaction,
  accountId: string,
): Promise<StripeErasureLocator | null> {
  const subscriptions = await tx<{
    stripe_customer_id: string | null;
    stripe_subscription_id: string;
  }[]>`
    select stripe_customer_id,stripe_subscription_id from billing_subscriptions
    where account_id=${accountId} order by stripe_subscription_id for update`;
  const credits = await tx<{ id: string; type: string; stripe_event_data: unknown }[]>`
    select t.id,t.type,t.stripe_event_data
    from manna_transactions t join manna_accounts m on m.id=t.manna_account_id
    where m.account_id=${accountId} and t.type in ('credit:stripe','credit:subscription')
    order by t.id for update of t`;
  const checkoutIntents = await tx<{
    id: string;
    state: 'preparing' | 'provider_started' | 'created' | 'failed';
    request_key_sha256: string;
    stripe_session_id: string | null;
  }[]>`
    select id,state,request_key_sha256,stripe_session_id
    from stripe_checkout_intents where account_id=${accountId} order by id for update`;

  const customerIds = new Set<string>();
  const checkoutSessionIds = new Set<string>();
  const subscriptionEvidence = new Map<string, string | null>();
  for (const intent of checkoutIntents) {
    if (!/^[0-9a-f]{64}$/.test(intent.request_key_sha256) ||
        !['preparing', 'provider_started', 'created', 'failed'].includes(intent.state) ||
        (intent.stripe_session_id !== null &&
          !/^cs_[A-Za-z0-9_]{3,252}$/.test(intent.stripe_session_id))) {
      throw new ApiError(409, 'erasure_stripe_evidence_invalid', 'Stripe erasure evidence is invalid');
    }
    if (intent.stripe_session_id) checkoutSessionIds.add(intent.stripe_session_id);
  }
  for (const row of subscriptions) {
    if (!STRIPE_ID_PATTERN.test(row.stripe_subscription_id) ||
        (row.stripe_customer_id !== null && !STRIPE_ID_PATTERN.test(row.stripe_customer_id))) {
      throw new ApiError(409, 'erasure_stripe_evidence_invalid', 'Stripe erasure evidence is invalid');
    }
    if (row.stripe_customer_id) customerIds.add(row.stripe_customer_id);
    subscriptionEvidence.set(row.stripe_subscription_id, row.stripe_customer_id);
  }
  for (const row of credits) {
    if (!row.stripe_event_data || typeof row.stripe_event_data !== 'object' ||
        Array.isArray(row.stripe_event_data)) {
      throw new ApiError(409, 'erasure_stripe_evidence_invalid', 'Stripe erasure evidence is invalid');
    }
    const evidence = row.stripe_event_data as Record<string, unknown>;
    if ((evidence.accountId !== undefined && evidence.accountId !== accountId) ||
        (evidence.customerId !== null && evidence.customerId !== undefined &&
          (typeof evidence.customerId !== 'string' || !STRIPE_ID_PATTERN.test(evidence.customerId))) ||
        (row.type === 'credit:subscription' && typeof evidence.customerId !== 'string')) {
      throw new ApiError(409, 'erasure_stripe_evidence_invalid', 'Stripe erasure evidence is invalid');
    }
    if (typeof evidence.customerId === 'string') customerIds.add(evidence.customerId);
    if (row.type === 'credit:stripe') {
      if (typeof evidence.objectId !== 'string' || !/^cs_[A-Za-z0-9_]{3,252}$/.test(evidence.objectId)) {
        throw new ApiError(409, 'erasure_stripe_evidence_invalid', 'Stripe erasure evidence is invalid');
      }
      checkoutSessionIds.add(evidence.objectId);
    }
    if (row.type === 'credit:subscription') {
      if (typeof evidence.subscriptionId !== 'string' ||
          !STRIPE_ID_PATTERN.test(evidence.subscriptionId)) {
        throw new ApiError(409, 'erasure_stripe_evidence_invalid', 'Stripe erasure evidence is invalid');
      }
      const prior = subscriptionEvidence.get(evidence.subscriptionId);
      if (prior !== undefined && prior !== null && prior !== evidence.customerId) {
        throw new ApiError(409, 'erasure_stripe_identity_conflict', 'Stripe erasure identity ownership conflicts');
      }
      if (prior === undefined || prior === null) {
        subscriptionEvidence.set(evidence.subscriptionId, evidence.customerId as string);
      }
    }
  }
  if (customerIds.size === 0 && subscriptionEvidence.size === 0 &&
      checkoutSessionIds.size === 0 && checkoutIntents.length === 0) return null;

  const sortedCustomerIds = [...customerIds].sort();
  const sortedSubscriptionIds = [...subscriptionEvidence.keys()].sort();
  const sortedCheckoutSessionIds = [...checkoutSessionIds].sort();
  const [conflict] = await tx<{ account_id: string }[]>`
    with evidence as (
      select b.account_id,b.stripe_customer_id customer_id
      from billing_subscriptions b where b.stripe_customer_id = any(${sortedCustomerIds}::text[])
        or b.stripe_subscription_id = any(${sortedSubscriptionIds}::text[])
      union all
      select m.account_id,t.stripe_event_data->>'customerId'
      from manna_transactions t join manna_accounts m on m.id=t.manna_account_id
      where t.type in ('credit:stripe','credit:subscription')
        and jsonb_typeof(t.stripe_event_data)='object'
        and (t.stripe_event_data->>'customerId' = any(${sortedCustomerIds}::text[])
          or t.stripe_event_data->>'subscriptionId' = any(${sortedSubscriptionIds}::text[])
          or t.stripe_event_data->>'objectId' = any(${sortedCheckoutSessionIds}::text[]))
    ) select account_id from evidence where account_id <> ${accountId} limit 1`;
  if (conflict) {
    throw new ApiError(409, 'erasure_stripe_identity_conflict', 'Stripe erasure identity ownership conflicts');
  }
  return {
    kind: 'stripe_customer',
    customerIds: sortedCustomerIds,
    checkoutSessionIds: sortedCheckoutSessionIds,
    checkoutIntents: checkoutIntents.map((intent: (typeof checkoutIntents)[number]) => ({
      intentId: intent.id,
      state: intent.state,
      requestKeySha256: intent.request_key_sha256,
      stripeSessionId: intent.stripe_session_id,
    })),
    subscriptions: sortedSubscriptionIds.map((stripeSubscriptionId) => ({
      stripeCustomerId: subscriptionEvidence.get(stripeSubscriptionId) ?? null,
      stripeSubscriptionId,
    })),
  };
}

/** Provider-free pre-seal convergence. Usable provider output is never reversed. */
export interface AccountErasurePresealReconciler {
  reconcile(input: {
    accountId: string;
    jobId: string;
    mode: 'unclaimed' | 'claimed';
    claimToken?: string;
    claimExpiresAt?: string;
  }): Promise<void>;
}

export class PostgresAccountErasurePresealReconciler implements AccountErasurePresealReconciler {
  private readonly transcriptionAudio: PrivateTranscriptionAudioStore;

  constructor(
    private readonly client: PgClient,
    transcriptionAudio = new PrivateTranscriptionAudioStore(getEnv().TRANSCRIPTION_AUDIO_DIR),
  ) {
    if (!client) throw new Error('Account erasure reconciliation requires the dedicated operator client');
    this.transcriptionAudio = transcriptionAudio;
  }

  async reconcile(input: {
    accountId: string;
    jobId: string;
    mode: 'unclaimed' | 'claimed';
    claimToken?: string;
    claimExpiresAt?: string;
  }): Promise<void> {
    const prunedSessions: Array<{ ownerId: string; sessionId: string }> = [];
    try {
      await this.client.begin(async (tx) => {
        await tx`select account_erasure_begin_operation()`;
        await tx`select set_config('eden3.erasure_job_id',${input.jobId},true)`;
        await tx`select set_config('eden3.erasure_inventory_mode','seal_inventory',true)`;
        if (input.mode === 'claimed') {
          await tx`select set_config('eden3.erasure_job_claim_token',${input.claimToken!},true)`;
          await tx`select set_config('eden3.erasure_job_claim_expires_at',${input.claimExpiresAt!},true)`;
        }
        await tx`select id from accounts where id=${input.accountId} for update`;
        await tx`
          select a.id from accounts a join agents ag on ag.account_id=a.id
          where ag.owner_id=${input.accountId} order by a.id for update of a`;
        await tx`select account_id from agents where owner_id=${input.accountId} order by account_id for update`;
        const [job] = await tx<{ id: string }[]>`
          select id from account_erasure_jobs where id=${input.jobId} and account_id=${input.accountId}
            and (state='intent_pending' or (state='claimed' and claim_token=${input.claimToken ?? null}
              and claim_expires_at=${input.claimExpiresAt ?? null}::timestamptz
              and claim_expires_at>statement_timestamp())) for update`;
        if (!job) return;
        await tx`select account_erasure_reconcile_open_work(${input.jobId})`;
        // Uploading and already-reconciled sessions have no live provider
        // outcome. Delete their private bytes before deleting the only DB
        // locators. provider_admitted/running usage remains fail-closed until
        // the fenced worker reaches a terminal/refunded state.
        const sessions = await tx<{
          owner_account_id: string;
          session_id: string;
        }[]>`
          select s.owner_account_id,s.id session_id
          from transcription_sessions s
          where s.owner_account_id=${input.accountId}
            and not exists (
              select 1 from usage_events u
              where u.event_type='speech_transcription' and u.turn_id=s.id
                and u.status in ('provider_admitted','running','refund_pending')
            )
          order by s.id
          for update of s`;
        for (const session of sessions) {
          await this.transcriptionAudio.deleteSession(session.owner_account_id, session.session_id);
        }
        const deletable = sessions.map((row) => row.session_id);
        if (deletable.length > 0) {
          await tx`delete from transcription_sessions where id=any(${deletable}::uuid[])`;
          prunedSessions.push(...deletable.map((sessionId) => ({
            ownerId: input.accountId,
            sessionId,
          })));
        }
      });
      for (const row of prunedSessions) {
        await this.transcriptionAudio.pruneSessionDirectories(row.ownerId, row.sessionId);
      }
    } catch (error) {
      if (error instanceof Error &&
          (error as Error & { code?: string }).code === '55000' &&
          error.message === 'open money, provider, or multipart work blocks erasure completion') {
        throw new ApiError(
          409,
          'erasure_work_in_flight',
          'Account has work requiring provider-free reconciliation',
        );
      }
      throw error;
    }
  }
}

export interface AccountErasureStoreOptions {
  databaseBoundary: AccountErasureDatabaseBoundary;
  reconciler?: AccountErasurePresealReconciler;
  claimLeaseMs?: number;
  maxRecoveryAttempts?: number;
}

const erasureDatabaseBoundary = Symbol('eden3.account-erasure-database-boundary');
const legacyMediaBoundaryBrand = Symbol('eden3.account-erasure-legacy-media-boundary');
const databaseRoleName = /^[a-z_][a-z0-9_]{0,62}$/;

export interface AccountErasureDatabaseBoundary {
  readonly [erasureDatabaseBoundary]: true;
  readonly client: PgClient;
  readonly ordinaryApplicationClient: PgClient;
  /** Exact ordinary-app Drizzle handle used by provider admission/evidence. */
  readonly ordinaryApplicationDb: DbHandle;
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly operatorLogin: string;
  readonly ordinaryApplicationLogin: string;
}

/**
 * Attest the physically separate erasure login before constructing any store.
 * The ordinary API login must never inherit the erasure operation role.
 */
export async function attestAccountErasureDatabaseBoundary(input: {
  operatorClient: PgClient;
  ordinaryApplicationClient: PgClient;
  ordinaryApplicationDb: DbHandle;
  operatorLogin: string;
  ordinaryApplicationLogin: string;
}): Promise<AccountErasureDatabaseBoundary> {
  if (!databaseRoleName.test(input.operatorLogin) ||
      !databaseRoleName.test(input.ordinaryApplicationLogin) ||
      input.operatorLogin === input.ordinaryApplicationLogin) {
    throw new Error('Account erasure requires distinct valid operator and ordinary application logins');
  }
  const [row] = await input.operatorClient<{
    database_name: string;
    database_oid: string;
    session_user: string;
    operator_member: boolean;
    operator_login: boolean;
    operator_superuser: boolean;
    operator_create_role: boolean;
    operator_bypass_rls: boolean;
    operator_replication: boolean;
  }[]>`
    select current_database()::text database_name,
      (select oid::text from pg_database where datname=current_database()) database_oid,
      session_user::text session_user,
      pg_has_role(session_user,'eden3_erasure_operator','member') operator_member,
      (select rolcanlogin from pg_roles where rolname=session_user) operator_login,
      (select rolsuper from pg_roles where rolname=session_user) operator_superuser,
      (select rolcreaterole from pg_roles where rolname=session_user) operator_create_role,
      (select rolbypassrls from pg_roles where rolname=session_user) operator_bypass_rls,
      (select rolreplication from pg_roles where rolname=session_user) operator_replication`;
  const [ordinary] = await input.ordinaryApplicationClient<{
    database_name: string;
    database_oid: string;
    session_user: string;
    operator_member: boolean;
    terminal_writer_member: boolean;
  }[]>`
    select current_database()::text database_name,
      (select oid::text from pg_database where datname=current_database()) database_oid,
      session_user::text session_user,
      pg_has_role(session_user,'eden3_erasure_operator','member') operator_member,
      pg_has_role(session_user,'eden3_erasure_terminal_writer','member') terminal_writer_member`;
  const ordinaryHandleRows = (await input.ordinaryApplicationDb.execute(sql`
    select current_database()::text database_name,
      (select oid::text from pg_database where datname=current_database()) database_oid,
      session_user::text session_user,
      pg_has_role(session_user,'eden3_erasure_operator','member') operator_member,
      pg_has_role(session_user,'eden3_erasure_terminal_writer','member') terminal_writer_member
  `)) as unknown as Array<{
    database_name: string;
    database_oid: string;
    session_user: string;
    operator_member: boolean;
    terminal_writer_member: boolean;
  }>;
  const ordinaryHandle = ordinaryHandleRows[0];
  if (!row || !ordinary || row.session_user !== input.operatorLogin ||
      !ordinaryHandle || ordinaryHandle.session_user !== input.ordinaryApplicationLogin ||
      ordinary.session_user !== input.ordinaryApplicationLogin ||
      row.session_user === ordinary.session_user || row.database_name !== ordinary.database_name ||
      row.database_oid !== ordinary.database_oid || ordinaryHandle.database_name !== ordinary.database_name ||
      ordinaryHandle.database_oid !== ordinary.database_oid || ordinaryHandle.operator_member ||
      !ordinaryHandle.terminal_writer_member || !row.operator_member || !row.operator_login ||
      row.operator_superuser || row.operator_create_role || row.operator_bypass_rls ||
      row.operator_replication || ordinary.operator_member || !ordinary.terminal_writer_member) {
    throw new Error('Account erasure PostgreSQL role attestation failed');
  }
  return Object.freeze({
    [erasureDatabaseBoundary]: true as const,
    client: input.operatorClient,
    ordinaryApplicationClient: input.ordinaryApplicationClient,
    ordinaryApplicationDb: input.ordinaryApplicationDb,
    databaseName: row.database_name,
    databaseOid: row.database_oid,
    operatorLogin: row.session_user,
    ordinaryApplicationLogin: input.ordinaryApplicationLogin,
  });
}

export function isAttestedAccountErasureDatabaseBoundary(
  value: object | undefined,
): value is AccountErasureDatabaseBoundary {
  return Boolean(value && (value as AccountErasureDatabaseBoundary)[erasureDatabaseBoundary] === true);
}

export interface AccountErasureLegacyMediaBoundary {
  readonly [legacyMediaBoundaryBrand]: true;
  readonly root: string;
}

/** Resolve aliases once; store and executor must share this exact object. */
export function attestAccountErasureLegacyMediaBoundary(
  root: string,
): AccountErasureLegacyMediaBoundary {
  const canonical = realpathSync(resolve(root));
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Account erasure legacy media root must be a real directory');
  }
  return Object.freeze({ [legacyMediaBoundaryBrand]: true as const, root: canonical });
}

function isLegacyMediaBoundary(value: object | undefined): value is AccountErasureLegacyMediaBoundary {
  return Boolean(value && (value as AccountErasureLegacyMediaBoundary)[legacyMediaBoundaryBrand] === true);
}

/** PostgreSQL implementation of both route admission and provider-free recovery. */
export class PostgresAccountErasureStore implements AccountErasureRecoveryStore {
  private readonly client: PgClient;
  private readonly reconciler: AccountErasurePresealReconciler;
  readonly claimLeaseMs: number;
  readonly databaseBoundary: object;
  private readonly maxRecoveryAttempts: number;

  constructor(options: AccountErasureStoreOptions) {
    if (!isAttestedAccountErasureDatabaseBoundary(options?.databaseBoundary)) {
      throw new Error('Account erasure requires an attested dedicated PostgreSQL operator boundary');
    }
    this.client = options.databaseBoundary.client;
    this.databaseBoundary = options.databaseBoundary;
    this.reconciler = options.reconciler ?? new PostgresAccountErasurePresealReconciler(this.client);
    this.claimLeaseMs = options.claimLeaseMs ?? 60_000;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 20;
    if (!Number.isSafeInteger(this.claimLeaseMs) || this.claimLeaseMs < 45_000 || this.claimLeaseMs > 300_000) {
      throw new Error('Account erasure claim lease must be between 45 seconds and 5 minutes');
    }
    if (!Number.isSafeInteger(this.maxRecoveryAttempts) || this.maxRecoveryAttempts < 1 || this.maxRecoveryAttempts > 100) {
      throw new Error('Account erasure max attempts must be between 1 and 100');
    }
  }

  async acceptIntent(input: { accountId: string; confirmUsername: string }): Promise<AccountErasureIntent> {
    const jobId = randomUUID();
    return await this.client.begin(async (tx) => {
      // REQUIRED statement one. Never add a query above this call.
      await tx`select account_erasure_begin_operation()`;
      const [account] = await tx<{ id: string; username: string; type: string; deleted: boolean }[]>`
        select id, username::text as username, type, deleted
        from accounts where id = ${input.accountId} for update`;
      if (!account || account.type !== 'user' || account.deleted) {
        throw new ApiError(404, 'account_not_found', 'Account not found');
      }
      if (account.username.toLowerCase() === DEFAULT_EVE_USERNAME ||
          account.username.toLocaleLowerCase('en-US') !== input.confirmUsername.trim().toLocaleLowerCase('en-US')) {
        throw new ApiError(403, 'protected_account', 'Account cannot be deleted');
      }
      await tx`
        select a.id from accounts a join agents ag on ag.account_id=a.id
        where ag.owner_id=${input.accountId} order by a.id for update of a`;
      await tx`select a.account_id from agents a where a.owner_id = ${input.accountId} order by a.account_id for update`;
      const [existing] = await tx<JobRow[]>`
        select * from account_erasure_jobs
        where account_id = ${input.accountId} and state <> 'succeeded'
        order by created_at limit 1 for update`;
      if (existing) {
        if (existing.state !== 'intent_pending') {
          throw new ApiError(409, 'erasure_recovery_claimed', 'Account erasure recovery is in progress');
        }
        return {
          jobId: existing.id,
          accountId: existing.account_id,
          acceptedAt: iso(existing.accepted_at),
          state: 'intent_pending',
        };
      }
      const [openVoice] = await tx<{ open: boolean }[]>`
        with principals as (select ${input.accountId}::uuid id union all
          select account_id from agents where owner_id=${input.accountId})
        select exists(
          select 1 from voice_executions v join principals p on p.id in (v.owner_account_id,v.agent_account_id)
            where v.status in ('pending','provider_started','transcoding','refund_pending','artifact_cleanup_pending')
          union all select 1 from voice_clones v join principals p on p.id=v.owner_account_id
            where v.status in ('pending_validation','cloning','provider_create_ambiguous','provider_delete_pending','provider_delete_failed')
        ) open`;
      if (openVoice?.open) {
        throw new ApiError(409, 'erasure_work_in_flight', 'Voice work requires provider-free reconciliation before erasure');
      }
      await tx`select set_config('eden3.erasure_job_id', ${jobId}, true)`;
      await tx`select set_config('eden3.erasure_inventory_mode', 'accept_intent', true)`;
      const [created] = await tx<JobRow[]>`
        insert into account_erasure_jobs (id, account_id)
        values (${jobId}, ${input.accountId}) returning *`;
      await tx`
        insert into account_erasure_targets (job_id, kind, resource_id)
        values (${jobId}, 'backup_tombstone', ${jobId})`;
      if (!created) throw new Error('account erasure intent insert returned no row');
      return { jobId, accountId: input.accountId, acceptedAt: iso(created.accepted_at), state: 'intent_pending' };
    });
  }

  async sealUnclaimedAfterLedgerConfirmation(input: {
    jobId: string; accountId: string; acceptedAt: string; confirmedAt: string;
    ledgerSha256: string; ledgerMacSha256: string;
  }): Promise<AccountErasureClaimResult> {
    await this.reconciler.reconcile({
      accountId: input.accountId,
      jobId: input.jobId,
      mode: 'unclaimed',
    });
    return await this.sealInventory({ ...input, mode: 'unclaimed' });
  }

  async sealClaimedAfterLedgerConfirmation(input: {
    jobId: string; accountId: string; acceptedAt: string; confirmedAt: string;
    ledgerSha256: string; ledgerMacSha256: string; claimToken: string; claimExpiresAt: string;
  }): Promise<AccountErasureClaimResult> {
    await this.reconciler.reconcile({
      accountId: input.accountId,
      jobId: input.jobId,
      mode: 'claimed',
      claimToken: input.claimToken,
      claimExpiresAt: input.claimExpiresAt,
    });
    return await this.sealInventory({ ...input, mode: 'claimed' });
  }

  private async sealInventory(input: {
    jobId: string; accountId: string; acceptedAt: string; confirmedAt: string;
    ledgerSha256: string; ledgerMacSha256: string;
    mode: 'unclaimed' | 'claimed'; claimToken?: string; claimExpiresAt?: string;
  }): Promise<AccountErasureClaimResult> {
    return await this.client.begin(async (tx) => {
      await tx`select account_erasure_begin_operation()`;
      await tx`select set_config('eden3.erasure_job_id', ${input.jobId}, true)`;
      await tx`select set_config('eden3.erasure_inventory_mode', 'seal_inventory', true)`;
      if (input.mode === 'claimed') {
        await tx`select set_config('eden3.erasure_job_claim_token', ${input.claimToken!}, true)`;
        await tx`select set_config('eden3.erasure_job_claim_expires_at', ${input.claimExpiresAt!}, true)`;
      }
      const [account] = await tx<{ id: string }[]>`
        select id from accounts where id = ${input.accountId} and type = 'user' for update`;
      if (!account) return { jobId: input.jobId, status: 'stale' };
      await tx`
        select a.id from accounts a join agents ag on ag.account_id=a.id
        where ag.owner_id=${input.accountId} order by a.id for update of a`;
      await tx`select a.account_id from agents a where a.owner_id = ${input.accountId} order by a.account_id for update`;
      const [job] = await tx<JobRow[]>`
        select * from account_erasure_jobs where id = ${input.jobId}
          and (${input.mode}::text <> 'claimed' or claim_expires_at > statement_timestamp())
        for update`;
      if (!job || job.account_id !== input.accountId || iso(job.accepted_at) !== iso(input.acceptedAt) ||
          (input.mode === 'unclaimed' && job.state !== 'intent_pending') ||
          (input.mode === 'claimed' && (job.state !== 'claimed' || job.claim_token !== input.claimToken ||
            iso(job.claim_expires_at!) !== iso(input.claimExpiresAt!)))) {
        return { jobId: input.jobId, status: 'stale' };
      }
      await tx`select id from account_erasure_targets where job_id = ${input.jobId} order by id for update`;

      const [open] = await tx<{ open_count: number }[]>`
        with principals as (
          select ${input.accountId}::uuid id
          union all select account_id from agents where owner_id = ${input.accountId}::uuid
        ), open_work as (
          select a.turn_id::text id from turn_authorizations a join principals p on p.id in (a.account_id,a.agent_account_id) where a.state='reserved'
          union all select c.turn_id::text from channel_turns c join principals p on p.id in (c.account_id,c.agent_id)
            where c.status in ('reserving','reserved','settling','refunding','delivery_pending','error')
          union all select u.id::text from usage_events u join principals p on p.id in (u.user_id,u.agent_id)
            where u.status in ('pending','provider_admitted','running','refund_pending')
          union all select v.id::text from voice_executions v join principals p on p.id in (v.owner_account_id,v.agent_account_id)
            where v.status in ('pending','provider_started','transcoding','refund_pending','artifact_cleanup_pending')
          union all select v.id::text from voice_clones v join principals p on p.id=v.owner_account_id
            where v.status in ('pending_validation','cloning','provider_create_ambiguous','provider_delete_pending','provider_delete_failed')
          union all select r.id::text from memory_dream_runs r join principals p on p.id=r.agent_account_id
            where r.status in ('running','recovery_pending') or r.provider_status in ('started','indeterminate')
          union all select q.agent_account_id::text from agent_provision_jobs q join principals p on p.id=q.agent_account_id where q.state in ('pending','running')
          union all select c.id::text from stripe_checkout_intents c join principals p on p.id=c.account_id
            where c.state in ('preparing','provider_started')
          union all select o.id::text from channel_outbound_post_intents o join principals p on p.id=o.account_id
            where o.state in ('preparing','provider_started')
          union all select t.id::text from triggers t join principals p on p.id in (t.user_id,t.agent_id) where t.pending_occurrence_id is not null
        ) select count(*)::int as open_count from open_work`;
      if ((open?.open_count ?? 0) > 0) {
        throw new ApiError(409, 'erasure_work_in_flight', 'Account has work requiring provider-free reconciliation');
      }

      const targets: InventoryTarget[] = [];
      const storage = await tx<{
        id: string; backing_store: string; backing_key: string; sha256: string | null;
      }[]>`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        select o.id,o.backing_store,o.backing_key,
          coalesce(o.verified_sha256,o.declared_sha256) sha256
        from storage_objects o
        join principals p on p.id=o.owner_account_id order by o.id for update`;
      targets.push(...storage.map((row) => ({
        kind: 'storage_object' as const,
        resourceId: row.id,
        locator: locator('storage_object', {
          backingStore: row.backing_store,
          backingKey: row.backing_key,
          sha256: row.sha256,
        }),
      })));
      const media = await tx<{
        id: string; source_path: string | null; local_path: string | null;
        url: string | null; sha256: string | null;
      }[]>`
        select m.id,m.source_path,m.local_path,m.url,m.sha256 from media_assets m
        where account_erasure_legacy_media_owned(${input.jobId}, m.id)
        order by m.id for update`;
      targets.push(...media.map((row) => ({
        kind: 'legacy_media_asset' as const,
        resourceId: row.id,
        locator: locator('legacy_media_asset', {
          sourcePath: row.source_path,
          localPath: row.local_path,
          url: row.url,
          sha256: row.sha256,
        }),
      })));
      const conceptAssets = await tx<{
        id: string; local_path: string | null; url: string; sha256: string;
      }[]>`
        select ci.id,ci.local_path,ci.url,ci.sha256 from concept_images ci
        join concepts c on c.id=ci.concept_id
        join agents a on a.account_id=c.agent_id
        where a.owner_id=${input.accountId}
        order by ci.id for update of ci`;
      targets.push(...conceptAssets.map((row) => ({
        kind: 'legacy_concept_asset' as const,
        resourceId: row.id,
        locator: locator('legacy_concept_asset', {
          localPath: row.local_path,
          url: row.url,
          sha256: row.sha256,
        }),
      })));
      const avatarAssets = await tx<{
        id: string; local_path: string | null; url: string; sha256: string;
      }[]>`
        select av.id,av.local_path,av.url,av.sha256
        from agent_avatar_assets av
        where av.owner_account_id=${input.accountId}
        order by av.id for update`;
      targets.push(...avatarAssets.map((row) => ({
        kind: 'legacy_avatar_asset' as const,
        resourceId: row.id,
        locator: locator('legacy_avatar_asset', {
          localPath: row.local_path,
          url: row.url,
          sha256: row.sha256,
        }),
      })));
      const voiceClones = await tx<{
        id: string; provider: string; provider_voice_id: string | null; status: string;
        clip_manifest_sha256: string;
      }[]>`
        select id,provider,provider_voice_id,status,clip_manifest_sha256
        from voice_clones where owner_account_id=${input.accountId}
        order by id for update`;
      targets.push(...voiceClones.map((row) => ({
        kind: 'voice_clone' as const,
        resourceId: row.id,
        locator: JSON.stringify({
          kind: 'voice_clone', provider: row.provider, providerVoiceId: row.provider_voice_id,
          status: row.status, clipManifestSha256: row.clip_manifest_sha256,
        }),
      })));
      const voiceOutputs = await tx<{
        id: string; output_local_path: string; output_url: string; output_sha256: string; delete_physical: boolean;
      }[]>`
        select ve.id,ve.output_local_path,ve.output_url,ve.output_sha256,
          not exists(select 1 from voice_executions other where other.id<>ve.id
            and other.status='completed' and other.output_sha256=ve.output_sha256
            and other.owner_account_id<>${input.accountId}) delete_physical
        from voice_executions ve where ve.owner_account_id=${input.accountId} and ve.status='completed'
          and ve.output_local_path is not null and ve.output_url is not null and ve.output_sha256 is not null
        order by id for update`;
      targets.push(...voiceOutputs.map((row) => ({
        kind: 'voice_output' as const,
        resourceId: row.id,
        locator: JSON.stringify({
          kind: 'voice_output', localPath: row.output_local_path,
          url: row.output_url, sha256: row.output_sha256, deletePhysical: row.delete_physical,
        }),
      })));
      const agents = await tx<{ account_id: string; openclaw_id: string | null; workspace_path: string | null }[]>`
        select account_id, openclaw_id, workspace_path from agents
        where owner_id=${input.accountId} order by account_id for update`;
      for (const row of agents) {
        if (row.openclaw_id || row.workspace_path) targets.push({
          kind: 'agent_runtime', resourceId: row.account_id,
          locator: locator('agent_runtime', { openclawId: row.openclaw_id, workspacePath: row.workspace_path }),
        });
      }
      const channels = await tx<{ id: string; runtime_account_id: string | null; channel: string }[]>`
        select id, runtime_account_id, channel from channel_connections
        where account_id=${input.accountId} order by id for update`;
      for (const row of channels) {
        const outbound = await tx<{ id: string; state: string; provider_post_id: string | null }[]>`
          select id,state,provider_post_id from channel_outbound_post_intents
          where connection_id=${row.id} order by id for update`;
        targets.push({
          kind: 'channel_runtime', resourceId: row.id,
          locator: JSON.stringify({
            kind: 'channel_runtime',
            channel: row.channel,
            ...(row.runtime_account_id ? { runtimeAccountId: row.runtime_account_id } : {}),
            outboundIntents: outbound.map((entry) => ({
              intentId: entry.id,
              state: entry.state,
              providerPostId: entry.provider_post_id,
            })),
          }),
        });
      }
      const [identity] = await tx<{ clerk_user_id: string | null }[]>`
        select clerk_user_id from accounts where id=${input.accountId}`;
      if (identity?.clerk_user_id) targets.push({
        kind: 'clerk_identity', resourceId: input.accountId,
        locator: locator('clerk_identity', { clerkUserId: identity.clerk_user_id }),
      });
      const stripeLocator = await stripeErasureLocator(tx, input.accountId);
      if (stripeLocator) targets.push({
        kind: 'stripe_customer', resourceId: input.accountId,
        locator: JSON.stringify(stripeLocator),
      });

      const tombstones = await tx<TombstoneRow[]>`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        select m.session_id, m.id as message_id, m.sender_id as author_principal_id
        from messages m join principals p on p.id=m.sender_id
        order by m.id for update`;
      const inventorySha256 = stableInventoryHash(targets, tombstones);
      for (const target of targets) {
        await tx`
          insert into account_erasure_targets (job_id,kind,resource_id)
          values (${input.jobId},${target.kind},${target.resourceId})
          on conflict (job_id,kind,resource_id) do nothing`;
      }
      for (const row of tombstones) {
        await tx`
          insert into account_erasure_message_tombstones
            (job_id,session_id,message_id,author_principal_id)
          values (${input.jobId},${row.session_id},${row.message_id},${row.author_principal_id})
          on conflict (job_id,message_id) do nothing`;
      }

      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId}),
        affected as (
          select s.id from sessions s where s.owner_id in (select id from principals)
          union select su.session_id from session_users su where su.user_account_id in (select id from principals)
          union select sa.session_id from session_agents sa where sa.agent_account_id in (select id from principals)
          union select m.session_id from messages m where m.sender_id in (select id from principals)
        ) delete from session_share_links where session_id in (select id from affected)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId}),
        affected as (
          select s.id from sessions s where s.owner_id in (select id from principals)
          union select su.session_id from session_users su where su.user_account_id in (select id from principals)
          union select sa.session_id from session_agents sa where sa.agent_account_id in (select id from principals)
          union select session_id from account_erasure_message_tombstones where job_id=${input.jobId}
        ) update sessions set is_public=false,updated_at=statement_timestamp()
          where id in (select id from affected)`;
      await tx`
        with principals as materialized (
          select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId}
        ), affected as materialized (
          select s.id from sessions s where s.owner_id in (select id from principals)
          union select su.session_id from session_users su where su.user_account_id in (select id from principals)
          union select sa.session_id from session_agents sa where sa.agent_account_id in (select id from principals)
          union select session_id from account_erasure_message_tombstones where job_id=${input.jobId}
        ), private_sessions as materialized (
          select s.id from sessions s join affected x on x.id=s.id
          where (s.owner_id in (select id from principals) or exists (
              select 1 from accounts owner where owner.id=s.owner_id and owner.deleted=true
            ))
            and not exists (
              select 1 from session_users su join accounts a on a.id=su.user_account_id
              where su.session_id=s.id and su.user_account_id not in (select id from principals)
                and a.deleted=false
            )
            and not exists (
              select 1 from session_agents sa join accounts a on a.id=sa.agent_account_id
              where sa.session_id=s.id and sa.agent_account_id not in (select id from principals)
                and a.deleted=false
            )
        ), scrub_messages as (
          update messages set sender_id=null,external_id=null,content=null,eden_message_data=null,
            thought=null,tool_call_id=null,name=null,tool_calls=null,attachments=null,
            reactions=null,reply_to_external_id=null
          where session_id in (select id from private_sessions) returning id
        ), delete_users as (
          delete from session_users where user_account_id in (select id from principals) returning session_id
        ), delete_agents as (
          delete from session_agents where agent_account_id in (select id from principals) returning session_id
        ) update sessions set external_id=null,title=null,status=null,session_type=null,
          platform=null,visible=false,pinned=false,trigger_external_id=null,
          parent_session_external_id=null,is_public=false,channel=null,
          channel_connection_id=null,channel_peer_fingerprint=null,
          channel_conversation_fingerprint=null,gateway_session_key=null,
          gateway_primed_at=null,last_message_at=null,message_count=0,deleted=true,
          updated_at=statement_timestamp()
        where id in (select id from private_sessions)`;
      await tx`
        update messages set sender_id=null, external_id=null, content=null, eden_message_data=null,
          thought=null, tool_call_id=null, name=null, tool_calls=null, attachments=null,
          reactions=null, reply_to_external_id=null
        where id in (select message_id from account_erasure_message_tombstones where job_id=${input.jobId})`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        update creations set external_id=null,task_external_id=null,tool=null,args=null,
          attributes=null,filename=null,url=null,thumbnail_url=null,media_attributes=null,
          like_count=0,public=false,deleted=true,updated_at=statement_timestamp()
        where user_id in (select id from principals) or agent_id in (select id from principals)`;
      await tx`
        update agents set name=null,description=null,persona=null,is_persona_public=false,
          greeting=null,voice=null,tool_groups='[]'::jsonb,public=false
        where owner_id=${input.accountId}`;
      await tx`
        delete from agent_voice_assignments where agent_account_id in (
          select account_id from agents where owner_id=${input.accountId}
        )`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        delete from voice_executions where status<>'completed'
          and (owner_account_id in (select id from principals) or agent_account_id in (select id from principals))`;
      await tx`delete from voice_quotes where owner_account_id=${input.accountId}`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        delete from content_reports where reporter_id in (select id from principals)
          or reviewer_id in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        delete from creation_likes l where l.user_id in (select id from principals)
          or exists (select 1 from creations c where c.id=l.creation_id
            and (c.user_id in (select id from principals) or c.agent_id in (select id from principals)))`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        delete from agent_likes where user_id in (select id from principals)
          or agent_id in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        delete from collection_creations cc where exists (
          select 1 from collections c where c.id=cc.collection_id and c.user_id in (select id from principals)
        ) or exists (
          select 1 from creations c where c.id=cc.creation_id
            and (c.user_id in (select id from principals) or c.agent_id in (select id from principals))
        )`;
      const [invalidCollectionContributors] = await tx<{ invalid: boolean }[]>`
        with principals as (
          select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId}
        ), deleting_external_ids as materialized (
          select external_id from accounts
          where id in (select id from principals) and external_id is not null
        )
        select exists (
          select 1 from collections c
          where (c.user_id is null or c.user_id not in (select id from principals))
            and c.contributors is not null
            and (jsonb_typeof(c.contributors)<>'array' or exists (
              select 1 from jsonb_array_elements(c.contributors) item(value)
              where jsonb_typeof(item.value)<>'string'
            ))
            and exists (select 1 from deleting_external_ids)
        ) invalid`;
      if (invalidCollectionContributors?.invalid) {
        throw new Error('account_erasure_collection_contributors_invalid');
      }
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        , deleting_external_ids as materialized (
          select external_id from accounts
          where id in (select id from principals) and external_id is not null
        )
        update collections c set contributors=(
          select coalesce(jsonb_agg(item.value order by item.ordinality),'[]'::jsonb)
          from jsonb_array_elements(c.contributors) with ordinality item(value,ordinality)
          where not exists (
            select 1 from deleting_external_ids d where item.value=to_jsonb(d.external_id)
          )
        ),updated_at=statement_timestamp()
        where (c.user_id is null or c.user_id not in (select id from principals))
          and jsonb_typeof(c.contributors)='array'
          and exists (
            select 1 from jsonb_array_elements(c.contributors) item(value)
            join deleting_external_ids d on item.value=to_jsonb(d.external_id)
          )`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        update collections set external_id=null,name=null,description=null,
          cover_creation_external_id=null,contributors=null,public=false,deleted=true,
          updated_at=statement_timestamp()
        where user_id in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        update concept_images i set filename=null
        from concepts c where c.id=i.concept_id and c.agent_id in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        update concepts set name='[deleted]',slug=('deleted-'||replace(id::text,'-','')),
          description=null,instructions=null,deleted=true,updated_at=statement_timestamp()
        where agent_id in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        update skill_definitions set slug=('deleted-'||replace(id::text,'-','')),
          name='[deleted]',description=null,body='',status='rejected',owner_id=null,
          reviewer_id=null,reviewed_at=null,updated_at=statement_timestamp()
        where source='user' and owner_id in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        update skill_definitions set reviewer_id=null,reviewed_at=null,updated_at=statement_timestamp()
        where reviewer_id in (select id from principals)
          and (owner_id is null or owner_id not in (select id from principals))`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        delete from etl_social_edges e where e.user_id in (select id from principals)
          or (e.edge_kind='agent_like' and e.target_id in (select id from principals))
          or (e.edge_kind='creation_like' and exists (
            select 1 from creations c where c.id=e.target_id
              and (c.user_id in (select id from principals) or c.agent_id in (select id from principals))
          ))`;
      await tx`
        with principals as (select account_id id from agents where owner_id=${input.accountId})
        delete from agent_skills where agent_id in (select id from principals)`;
      await tx`
        delete from channel_pairing_requests where connection_id in (
          select id from channel_connections where account_id=${input.accountId}
        ) or decided_by_account_id=${input.accountId}`;
      await tx`
        delete from channel_external_identities where connection_id in (
          select id from channel_connections where account_id=${input.accountId}
        ) or linked_account_id=${input.accountId}`;
      await tx`delete from channel_onboarding_intents where account_id=${input.accountId}`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        update channel_turns set external_message_id=null,runtime_account_id=null,
          agent_runtime=null,error_code=null,updated_at=statement_timestamp()
        where account_id in (select id from principals) or agent_id in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        update usage_events set session_id=null,message_id=null,error_message=null,metadata=null
        where user_id in (select id from principals) or agent_id in (select id from principals)`;
      await tx`
        update manna_accounts set external_id=null,updated_at=statement_timestamp()
        where account_id=${input.accountId}`;
      await tx`
        update manna_transactions t set external_id=null,task_external_id=null,
          voucher_external_id=null,code=null,stripe_event_data=
            case when t.type in ('credit:stripe','credit:subscription')
                and jsonb_typeof(t.stripe_event_data)='object'
              then jsonb_strip_nulls(jsonb_build_object(
                'customerId',t.stripe_event_data->'customerId',
                'subscriptionId',t.stripe_event_data->'subscriptionId',
                'objectId',t.stripe_event_data->'objectId'))
              else null end
        from manna_accounts m where m.id=t.manna_account_id and m.account_id=${input.accountId}`;
      await tx`
        update memory_dream_runs set openclaw_id='erased',agent_runtime=null,
          provenance=null,error=null,previous_sha256=null,sha256=null
        where agent_account_id in (select account_id from agents where owner_id=${input.accountId})`;
      await tx`
        with principals as (
          select ${input.accountId}::uuid id union all
          select account_id from agents where owner_id=${input.accountId}
        ), deleting_runtime as (
          select openclaw_id from agents where owner_id=${input.accountId} and openclaw_id is not null
        )
        update memory_dream_sweeps s set skipped_agents=coalesce((
          select jsonb_agg(entry order by ordinality)
          from jsonb_array_elements(s.skipped_agents) with ordinality as x(entry,ordinality)
          where nullif(entry->>'agentAccountId','')::uuid not in (select id from principals)
            and coalesce(entry->>'openclawId','') not in (select openclaw_id from deleting_runtime)
        ),'[]'::jsonb)
        where exists (
          select 1 from jsonb_array_elements(s.skipped_agents) entry
          where nullif(entry->>'agentAccountId','')::uuid in (select id from principals)
            or coalesce(entry->>'openclawId','') in (select openclaw_id from deleting_runtime)
        )`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        delete from distill_state where agent_account_id in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        update memory_revisions set actor_account_id=null,metadata=null
        where actor_account_id in (select id from principals)
          and agent_account_id not in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        delete from memory_revisions where agent_account_id in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        delete from memory_retrieval_probes where agent_account_id in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        delete from claude_session_turn_claims c using turn_authorizations a
        where a.turn_id=c.turn_id and (a.account_id in (select id from principals)
          or a.agent_account_id in (select id from principals))`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        delete from app_notifications where account_id in (select id from principals)
          or source_agent_id in (select id from principals)`;
      await tx`
        with principals as (select ${input.accountId}::uuid id union all select account_id from agents where owner_id=${input.accountId})
        update triggers set external_id=null,name=null,prompt=null,schedule=null,
          session_external_id=null,session_target=null,next_scheduled_run=null,
          last_error=null,openclaw_job_id=null,deleted=true,updated_at=statement_timestamp()
        where user_id in (select id from principals) or agent_id in (select id from principals)`;
      await tx`
        with principals as (
          select ${input.accountId}::uuid id
          union all select account_id from agents where owner_id=${input.accountId}
        )
        update storage_uploads set state='aborted', updated_at=statement_timestamp()
        where owner_account_id in (select id from principals) and state in ('initiated','uploading')`;
      await tx`
        update channel_connections set desired_state='inactive', updated_at=statement_timestamp()
        where account_id=${input.accountId}`;
      await tx`
        update accounts set deleted=true, username=('deleted-' || replace(id::text,'-',''))::citext,
          external_id=null,user_image=null,updated_at=statement_timestamp()
        where id=${input.accountId} or id in (select account_id from agents where owner_id=${input.accountId})`;
      await tx`
        update account_erasure_targets set state='succeeded', next_attempt_at=null,
          completed_at=statement_timestamp(), updated_at=statement_timestamp()
        where job_id=${input.jobId} and kind='backup_tombstone' and resource_id=${input.jobId} and state='pending'`;
      await tx`
        update account_erasure_jobs set state='manifest_pending',
          ledger_confirmed_at=${input.confirmedAt}::timestamptz,
          ledger_sha256=${input.ledgerSha256}, ledger_mac_sha256=${input.ledgerMacSha256},
          inventoried_at=statement_timestamp(), inventory_sha256=${inventorySha256},
          next_attempt_at=statement_timestamp(), claim_token=null, claim_expires_at=null,
          last_error_code=null, updated_at=statement_timestamp()
        where id=${input.jobId}`;
      const [sealed] = await tx<{ inventoried_at: Date }[]>`
        select inventoried_at from account_erasure_jobs where id=${input.jobId}`;
      const recoveryManifest: AccountErasureRecoveryManifest = {
        schemaVersion: ACCOUNT_ERASURE_RECOVERY_MANIFEST_SCHEMA_VERSION,
        jobId: input.jobId,
        accountId: input.accountId,
        inventoriedAt: iso(sealed!.inventoried_at),
        inventorySha256,
        locators: targets.flatMap((target) => target.locator ? [{
          kind: target.kind as AccountErasureRecoveryLocator['kind'],
          resourceId: target.resourceId,
          locator: target.locator,
        }] : []),
      };
      return { jobId: input.jobId, accountId: input.accountId, status: 'recovery_manifest_pending', recoveryManifest };
    });
  }

  async confirmRecoveryManifestUnclaimed(input: {
    jobId: string; accountId: string; confirmation: AccountErasureRecoveryManifestConfirmation;
  }): Promise<AccountErasureRequestResult | { jobId: string; status: 'stale' }> {
    return await this.confirmManifest({ ...input, mode: 'unclaimed' });
  }

  async confirmClaimedRecoveryManifest(input: {
    jobId: string; accountId: string; confirmation: AccountErasureRecoveryManifestConfirmation;
    claimToken: string; claimExpiresAt: string;
  }): Promise<AccountErasureRequestResult | { jobId: string; status: 'stale' }> {
    // 0040's claimed ledger seal atomically publishes manifest_pending and
    // releases the claim tuple. Confirmation therefore uses the exact
    // unclaimed manifest_pending CAS; a replacement worker that claims first
    // makes this stale instead of permitting the old lease to overwrite it.
    return await this.confirmManifest({ ...input, mode: 'unclaimed' });
  }

  private async confirmManifest(input: {
    jobId: string; accountId: string; confirmation: AccountErasureRecoveryManifestConfirmation;
    mode: 'unclaimed' | 'claimed'; claimToken?: string; claimExpiresAt?: string;
  }): Promise<AccountErasureRequestResult | { jobId: string; status: 'stale' }> {
    return await this.client.begin(async (tx) => {
      await tx`select account_erasure_begin_operation()`;
      await tx`select set_config('eden3.erasure_job_id', ${input.jobId}, true)`;
      await tx`select set_config('eden3.erasure_inventory_mode', 'confirm_manifest', true)`;
      if (input.mode === 'claimed') {
        await tx`select set_config('eden3.erasure_job_claim_token', ${input.claimToken!}, true)`;
        await tx`select set_config('eden3.erasure_job_claim_expires_at', ${input.claimExpiresAt!}, true)`;
      }
      await tx`select id from accounts where id=${input.accountId} for update`;
      await tx`
        select a.id from accounts a join agents ag on ag.account_id=a.id
        where ag.owner_id=${input.accountId} order by a.id for update of a`;
      await tx`select account_id from agents where owner_id=${input.accountId} order by account_id for update`;
      const [job] = await tx<JobRow[]>`
        select * from account_erasure_jobs where id=${input.jobId}
          and (${input.mode}::text <> 'claimed' or claim_expires_at > statement_timestamp())
        for update`;
      const expectedState = input.mode === 'claimed' ? 'claimed' : 'manifest_pending';
      if (!job || job.account_id !== input.accountId || job.state !== expectedState ||
          job.inventory_sha256 !== input.confirmation.inventorySha256 ||
          (input.mode === 'claimed' && (job.claim_token !== input.claimToken || iso(job.claim_expires_at!) !== iso(input.claimExpiresAt!)))) {
        return { jobId: input.jobId, status: 'stale' };
      }
      await tx`
        update account_erasure_jobs set state='pending', next_attempt_at=null,
          claim_token=null, claim_expires_at=null, last_error_code=null,
          recovery_manifest_confirmed_at=${input.confirmation.confirmedAt}::timestamptz,
          recovery_manifest_sha256=${input.confirmation.manifestSha256},
          recovery_ciphertext_sha256=${input.confirmation.ciphertextSha256},
          recovery_mac_sha256=${input.confirmation.macSha256},
          recovery_key_version=${input.confirmation.keyVersion}, updated_at=statement_timestamp()
        where id=${input.jobId}`;
      await tx`
        update account_erasure_jobs j set state='succeeded',completed_at=statement_timestamp(),
          updated_at=statement_timestamp()
        where j.id=${input.jobId} and j.state='pending'
          and not exists (select 1 from account_erasure_targets t where t.job_id=j.id and t.state <> 'succeeded')`;
      return { jobId: input.jobId, status: 'pending' };
    });
  }

  async claimIntentForRecovery(): Promise<
    ClaimedAccountErasureIntent | { jobId: string; status: 'attention' } | null
  > {
    return await this.client.begin(async (tx) => {
      await tx`select account_erasure_begin_operation()`;
      const [expiredCandidate] = await tx<JobRow[]>`
        select * from account_erasure_jobs
        where state='claimed' and claim_expires_at <= statement_timestamp()
        order by claim_expires_at,id limit 1`;
      if (expiredCandidate?.claim_token && expiredCandidate.claim_expires_at) {
        await tx`select id from accounts where id=${expiredCandidate.account_id} for update`;
        await tx`
          select a.id from accounts a join agents ag on ag.account_id=a.id
          where ag.owner_id=${expiredCandidate.account_id} order by a.id for update of a`;
        await tx`select account_id from agents where owner_id=${expiredCandidate.account_id} order by account_id for update`;
        const [expired] = await tx<JobRow[]>`
          select * from account_erasure_jobs where id=${expiredCandidate.id} and state='claimed'
            and claim_token=${expiredCandidate.claim_token}
            and claim_expires_at=${iso(expiredCandidate.claim_expires_at)}::timestamptz
            and claim_expires_at <= statement_timestamp() for update`;
        if (expired) {
          await tx`select set_config('eden3.erasure_job_id', ${expired.id}, true)`;
          await tx`select set_config('eden3.erasure_job_claim_token', ${expired.claim_token!}, true)`;
          await tx`select set_config('eden3.erasure_job_claim_expires_at', ${iso(expired.claim_expires_at!)}, true)`;
          const attention = Number(expired.attempt_count) >= this.maxRecoveryAttempts;
          const retryState = expired.ledger_confirmed_at ? 'manifest_pending' : 'intent_pending';
          await tx`
            update account_erasure_jobs set state=${attention ? 'attention' : retryState},
              next_attempt_at=${attention ? null : tx`statement_timestamp()`},
              claim_token=null,claim_expires_at=null,last_error_code='recovery_claim_expired',
              updated_at=statement_timestamp() where id=${expired.id}`;
          if (attention) return { jobId: expired.id, status: 'attention' };
        }
      }
      const [candidate] = await tx<JobRow[]>`
        select * from account_erasure_jobs
        where state in ('intent_pending','manifest_pending') and next_attempt_at <= statement_timestamp()
        order by next_attempt_at,id limit 1`;
      if (!candidate) return null;
      await tx`select id from accounts where id=${candidate.account_id} for update`;
      await tx`
        select a.id from accounts a join agents ag on ag.account_id=a.id
        where ag.owner_id=${candidate.account_id} order by a.id for update of a`;
      await tx`select account_id from agents where owner_id=${candidate.account_id} order by account_id for update`;
      const [job] = await tx<JobRow[]>`
        select * from account_erasure_jobs
        where id=${candidate.id} and account_id=${candidate.account_id}
          and state in ('intent_pending','manifest_pending')
          and next_attempt_at <= statement_timestamp()
        for update skip locked`;
      if (!job) return null;
      const claimToken = randomUUID();
      await tx`select set_config('eden3.erasure_job_id', ${job.id}, true)`;
      const [claimed] = await tx<JobRow[]>`
        update account_erasure_jobs set state='claimed', attempt_count=attempt_count+1,
          next_attempt_at=null, claim_token=${claimToken},
          claim_expires_at=date_trunc('milliseconds',statement_timestamp()+
            (${this.claimLeaseMs}::text || ' milliseconds')::interval),
          last_error_code=null, updated_at=statement_timestamp()
        where id=${job.id} returning *`;
      if (!claimed?.claim_expires_at) return null;
      let recoveryManifest: AccountErasureRecoveryManifest | undefined;
      if (job.state === 'manifest_pending') recoveryManifest = await this.rebuildManifest(tx, claimed);
      return {
        intent: recoveryManifest ? {
          jobId: job.id, accountId: job.account_id, acceptedAt: iso(job.accepted_at),
          state: 'manifest_pending', recoveryManifest,
        } : {
          jobId: job.id, accountId: job.account_id, acceptedAt: iso(job.accepted_at), state: 'intent_pending',
        },
        claimToken,
        claimExpiresAt: iso(claimed.claim_expires_at),
      };
    });
  }

  async recoveryMetrics(): Promise<{ wormOverdue: number; targetOverdue: number }> {
    const [row] = await this.client<{ worm_overdue: number; target_overdue: number }[]>`
      select
        count(*) filter (
          where state in ('intent_pending','claimed','attention')
            and ledger_confirmed_at is null
            and accepted_at <= statement_timestamp() - interval '5 minutes'
        )::int as worm_overdue,
        count(*) filter (
          where state in ('pending','attention')
            and recovery_manifest_confirmed_at is not null
            and accepted_at <= statement_timestamp() - interval '24 hours'
            and exists (
              select 1 from account_erasure_targets t
              where t.job_id=account_erasure_jobs.id
                and t.kind <> 'backup_tombstone' and t.state <> 'succeeded'
            )
        )::int as target_overdue
      from account_erasure_jobs`;
    return {
      wormOverdue: row?.worm_overdue ?? 0,
      targetOverdue: row?.target_overdue ?? 0,
    };
  }

  private async rebuildManifest(tx: PgTransaction, job: JobRow): Promise<AccountErasureRecoveryManifest> {
    const rows = await tx<{
      kind: ErasureKind;
      resource_id: string;
      clerk_user_id: string | null;
      channel: string | null;
      runtime_account_id: string | null;
      openclaw_id: string | null;
      workspace_path: string | null;
      backing_store: string | null;
      backing_key: string | null;
      storage_sha256: string | null;
      source_path: string | null;
      media_local_path: string | null;
      media_url: string | null;
      media_sha256: string | null;
      concept_local_path: string | null;
      concept_url: string | null;
      concept_sha256: string | null;
      avatar_local_path: string | null;
      avatar_url: string | null;
      avatar_sha256: string | null;
    }[]>`
      select t.kind,t.resource_id,a.clerk_user_id,c.channel,c.runtime_account_id,
        ag.openclaw_id,ag.workspace_path,
        so.backing_store,so.backing_key,
        coalesce(so.verified_sha256,so.declared_sha256) storage_sha256,
        ma.source_path,ma.local_path media_local_path,ma.url media_url,ma.sha256 media_sha256,
        ci.local_path concept_local_path,ci.url concept_url,ci.sha256 concept_sha256,
        av.local_path avatar_local_path,av.url avatar_url,av.sha256 avatar_sha256
      from account_erasure_targets t
      left join accounts a on t.kind='clerk_identity' and a.id=t.resource_id
      left join channel_connections c on t.kind='channel_runtime' and c.id=t.resource_id
      left join agents ag on t.kind='agent_runtime' and ag.account_id=t.resource_id
      left join storage_objects so on t.kind='storage_object' and so.id=t.resource_id
      left join media_assets ma on t.kind='legacy_media_asset' and ma.id=t.resource_id
      left join concept_images ci on t.kind='legacy_concept_asset' and ci.id=t.resource_id
      left join agent_avatar_assets av on t.kind='legacy_avatar_asset' and av.id=t.resource_id
      where t.job_id=${job.id}
        and t.kind in ('clerk_identity','stripe_customer','channel_runtime','agent_runtime',
          'storage_object','legacy_media_asset','legacy_concept_asset','legacy_avatar_asset')
      order by t.kind,t.resource_id`;
    const locators: AccountErasureRecoveryLocator[] = [];
    for (const row of rows) {
      let rebuilt: string | undefined;
      if (row.kind === 'clerk_identity') {
        rebuilt = locator(row.kind, { clerkUserId: row.clerk_user_id });
      } else if (row.kind === 'channel_runtime') {
        const outbound = await tx<{ id: string; state: string; provider_post_id: string | null }[]>`
          select id,state,provider_post_id from channel_outbound_post_intents
          where connection_id=${row.resource_id} order by id for update`;
        rebuilt = JSON.stringify({
          kind: row.kind,
          ...(row.channel ? { channel: row.channel } : {}),
          ...(row.runtime_account_id ? { runtimeAccountId: row.runtime_account_id } : {}),
          outboundIntents: outbound.map((entry: (typeof outbound)[number]) => ({
            intentId: entry.id,
            state: entry.state,
            providerPostId: entry.provider_post_id,
          })),
        });
      } else if (row.kind === 'agent_runtime') {
        rebuilt = locator(row.kind, {
          openclawId: row.openclaw_id,
          workspacePath: row.workspace_path,
        });
      } else if (row.kind === 'stripe_customer') {
        const stripe = await stripeErasureLocator(tx, row.resource_id);
        rebuilt = stripe ? JSON.stringify(stripe) : undefined;
      } else if (row.kind === 'storage_object') {
        rebuilt = locator(row.kind, {
          backingStore: row.backing_store,
          backingKey: row.backing_key,
          sha256: row.storage_sha256,
        });
      } else if (row.kind === 'legacy_media_asset') {
        rebuilt = locator(row.kind, {
          sourcePath: row.source_path,
          localPath: row.media_local_path,
          url: row.media_url,
          sha256: row.media_sha256,
        });
      } else if (row.kind === 'legacy_concept_asset') {
        rebuilt = locator(row.kind, {
          localPath: row.concept_local_path,
          url: row.concept_url,
          sha256: row.concept_sha256,
        });
      } else if (row.kind === 'legacy_avatar_asset') {
        rebuilt = locator(row.kind, {
          localPath: row.avatar_local_path,
          url: row.avatar_url,
          sha256: row.avatar_sha256,
        });
      }
      if (rebuilt) locators.push({
        kind: row.kind as AccountErasureRecoveryManifest['locators'][number]['kind'],
        resourceId: row.resource_id,
        locator: rebuilt,
      });
    }
    return {
      schemaVersion: ACCOUNT_ERASURE_RECOVERY_MANIFEST_SCHEMA_VERSION,
      jobId: job.id,
      accountId: job.account_id,
      inventoriedAt: iso(job.inventoried_at!),
      inventorySha256: job.inventory_sha256!,
      locators,
    };
  }

  async recordRecoveryFailure(input: {
    jobId: string; claimToken: string; claimExpiresAt: string; errorCode: 'erasure_recovery_failed';
  }): Promise<'retried' | 'attention' | 'stale'> {
    return await this.client.begin(async (tx) => {
      await tx`select account_erasure_begin_operation()`;
      const [candidate] = await tx<JobRow[]>`
        select * from account_erasure_jobs where id=${input.jobId}`;
      if (!candidate) return 'stale';
      await tx`select id from accounts where id=${candidate.account_id} for update`;
      await tx`
        select a.id from accounts a join agents ag on ag.account_id=a.id
        where ag.owner_id=${candidate.account_id} order by a.id for update of a`;
      await tx`
        select account_id from agents where owner_id=${candidate.account_id}
        order by account_id for update`;
      const [job] = await tx<JobRow[]>`
        select * from account_erasure_jobs where id=${input.jobId}
          and state='claimed' and claim_token=${input.claimToken}
          and claim_expires_at=${input.claimExpiresAt}::timestamptz
          and claim_expires_at > statement_timestamp()
        for update`;
      if (!job || job.state !== 'claimed' || job.claim_token !== input.claimToken ||
          iso(job.claim_expires_at!) !== iso(input.claimExpiresAt)) return 'stale';
      await tx`select set_config('eden3.erasure_job_id', ${input.jobId}, true)`;
      await tx`select set_config('eden3.erasure_job_claim_token', ${input.claimToken}, true)`;
      await tx`select set_config('eden3.erasure_job_claim_expires_at', ${input.claimExpiresAt}, true)`;
      const attempts = Number(job.attempt_count);
      const attention = attempts >= this.maxRecoveryAttempts;
      const retryState = job.ledger_confirmed_at ? 'manifest_pending' : 'intent_pending';
      const retryDelayMs = Math.min(3_600_000, 1000 * 2 ** Math.min(attempts, 12));
      await tx`
        update account_erasure_jobs set state=${attention ? 'attention' : retryState},
          next_attempt_at=${attention ? null : tx`statement_timestamp()+(${retryDelayMs}::text || ' milliseconds')::interval`},
          claim_token=null, claim_expires_at=null, last_error_code=${input.errorCode},
          updated_at=statement_timestamp() where id=${input.jobId}`;
      return attention ? 'attention' : 'retried';
    });
  }
}

export interface AccountErasureTargetClaim {
  targetId: string;
  jobId: string;
  accountId: string;
  kind: ErasureKind;
  resourceId: string;
  claimToken: string;
  claimExpiresAt: string;
  locator: string;
}

export interface AccountErasureTargetStore {
  readonly databaseBoundary?: object;
  readonly legacyMediaBoundary?: AccountErasureLegacyMediaBoundary;
  readonly claimLeaseMs?: number;
  claimTarget(): Promise<AccountErasureTargetClaim | { targetId: string; status: 'attention' } | null>;
  completeTarget(claim: AccountErasureTargetClaim): Promise<'completed' | 'stale'>;
  failTarget(claim: AccountErasureTargetClaim, errorCode: string): Promise<'retried' | 'attention' | 'stale'>;
}

interface TargetCandidate {
  id: string;
  job_id: string;
  account_id: string;
  kind: ErasureKind;
  resource_id: string;
  attempt_count: string;
}

interface LegacySourceLocator {
  sha256: string | null;
  url: string | null;
  local_path: string | null;
  source_path?: string | null;
}

type LegacyDisposition =
  | { kind: 'local'; key: string; canonicalUrl: string; localPath: string | null }
  | { kind: 'external'; key: string; locator: string }
  | { kind: 'ambiguous' };

/** SHA proves the canonical local basename; it never aliases remote objects. */
function legacyDisposition(row: LegacySourceLocator, mediaRoot: string): LegacyDisposition {
  const sha256 = row.sha256;
  let localPath = row.local_path;
  if (localPath) {
    try {
      // Canonicalize the existing parent, not merely the lexical pathname:
      // macOS `/var` and deployment bind aliases must converge to the one
      // attested root, while a symlinked/nested parent remains fail-closed.
      localPath = resolve(realpathSync(dirname(resolve(localPath))), basename(localPath));
    } catch {
      return { kind: 'ambiguous' };
    }
  }
  const localBasename = localPath ? basename(localPath) : null;
  const canonicalFromPath = sha256 && localBasename &&
    new RegExp(`^${sha256}(?:\\.[a-z0-9]{1,10})?$`).test(localBasename)
    ? `/media/${localBasename}`
    : null;
  const canonicalFromUrl = sha256 && row.url &&
    new RegExp(`^/media/${sha256}(?:\\.[a-z0-9]{1,10})?$`).test(row.url)
    ? row.url
    : null;
  if (localPath && (!canonicalFromPath || dirname(resolve(localPath)) !== mediaRoot)) {
    return { kind: 'ambiguous' };
  }
  if (canonicalFromPath || canonicalFromUrl) {
    if (canonicalFromPath && canonicalFromUrl && canonicalFromPath !== canonicalFromUrl) {
      return { kind: 'ambiguous' };
    }
    const canonicalUrl = canonicalFromPath ?? canonicalFromUrl!;
    const otherLocators = [
      row.url && row.url !== canonicalUrl ? row.url : null,
      row.source_path && row.source_path !== localPath && row.source_path !== canonicalUrl
        ? row.source_path
        : null,
    ].filter((value): value is string => value !== null && value !== undefined);
    if (otherLocators.length > 0) return { kind: 'ambiguous' };
    return {
      kind: 'local',
      key: `local:${canonicalUrl}`,
      canonicalUrl,
      localPath: canonicalFromPath ? resolve(localPath!) : null,
    };
  }
  const remote = [...new Set([row.url, row.source_path].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  ))];
  if (remote.length !== 1) return { kind: 'ambiguous' };
  return { kind: 'external', key: `external:${remote[0]}`, locator: remote[0]! };
}

interface LegacyMatchingSource extends LegacySourceLocator {
  source_kind: 'legacy_media_asset' | 'legacy_concept_asset' | 'legacy_avatar_asset';
  source_id: string;
  active_target_ids: string[];
}

export class PostgresAccountErasureTargetStore implements AccountErasureTargetStore {
  readonly databaseBoundary: object;
  readonly legacyMediaBoundary: AccountErasureLegacyMediaBoundary;

  constructor(options: {
    databaseBoundary: AccountErasureDatabaseBoundary;
    legacyMediaBoundary: AccountErasureLegacyMediaBoundary;
    claimLeaseMs?: number;
    maxAttempts?: number;
  }) {
    if (!isAttestedAccountErasureDatabaseBoundary(options?.databaseBoundary)) {
      throw new Error('Account erasure targets require an attested dedicated PostgreSQL operator boundary');
    }
    if (!isLegacyMediaBoundary(options.legacyMediaBoundary)) {
      throw new Error('Account erasure targets require an attested legacy media boundary');
    }
    this.client = options.databaseBoundary.client;
    this.legacyMediaBoundary = options.legacyMediaBoundary;
    this.legacyMediaRoot = options.legacyMediaBoundary.root;
    this.databaseBoundary = options.databaseBoundary;
    this.claimLeaseMs = options.claimLeaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 20;
    if (!Number.isSafeInteger(this.claimLeaseMs) || this.claimLeaseMs < 5_000 || this.claimLeaseMs > 300_000) {
      throw new Error('Account erasure target lease must be between 5 seconds and 5 minutes');
    }
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 100) {
      throw new Error('Account erasure target max attempts must be between 1 and 100');
    }
  }

  private readonly client: PgClient;
  private readonly legacyMediaRoot: string;
  readonly claimLeaseMs: number;
  private readonly maxAttempts: number;

  private async legacyDispositionElection(
    tx: PgTransaction,
    target: TargetCandidate,
    disposition: Exclude<LegacyDisposition, { kind: 'ambiguous' }>,
  ): Promise<{ elected: boolean; foreignShared: boolean }> {
    const matchValue = disposition.kind === 'local' ? disposition.canonicalUrl : disposition.locator;
    const localPath = disposition.kind === 'local' ? disposition.localPath : null;
    const media = disposition.kind === 'local'
      ? await tx<LegacyMatchingSource[]>`
          select 'legacy_media_asset'::text source_kind,m.id source_id,
            m.sha256,m.url,m.local_path,m.source_path,
            coalesce(array(select t.id::text from account_erasure_targets t
              join account_erasure_jobs j on j.id=t.job_id
              where t.kind='legacy_media_asset' and t.resource_id=m.id
                and t.state<>'succeeded' and j.state<>'succeeded'),array[]::text[]) active_target_ids
          from media_assets m where m.url=${matchValue}
            or (${localPath}::text is not null and ${localPath}::text in (m.local_path,m.source_path))`
      : await tx<LegacyMatchingSource[]>`
          select 'legacy_media_asset'::text source_kind,m.id source_id,
            m.sha256,m.url,m.local_path,m.source_path,
            coalesce(array(select t.id::text from account_erasure_targets t
              join account_erasure_jobs j on j.id=t.job_id
              where t.kind='legacy_media_asset' and t.resource_id=m.id
                and t.state<>'succeeded' and j.state<>'succeeded'),array[]::text[]) active_target_ids
          from media_assets m where ${matchValue} in (m.url,m.local_path,m.source_path)`;
    const concepts = disposition.kind === 'local'
      ? await tx<LegacyMatchingSource[]>`
          select 'legacy_concept_asset'::text source_kind,i.id source_id,
            i.sha256,i.url,i.local_path,null::text source_path,
            coalesce(array(select t.id::text from account_erasure_targets t
              join account_erasure_jobs j on j.id=t.job_id
              where t.kind='legacy_concept_asset' and t.resource_id=i.id
                and t.state<>'succeeded' and j.state<>'succeeded'),array[]::text[]) active_target_ids
          from concept_images i where i.url=${matchValue}
            or (${localPath}::text is not null and i.local_path=${localPath})`
      : await tx<LegacyMatchingSource[]>`
          select 'legacy_concept_asset'::text source_kind,i.id source_id,
            i.sha256,i.url,i.local_path,null::text source_path,
            coalesce(array(select t.id::text from account_erasure_targets t
              join account_erasure_jobs j on j.id=t.job_id
              where t.kind='legacy_concept_asset' and t.resource_id=i.id
                and t.state<>'succeeded' and j.state<>'succeeded'),array[]::text[]) active_target_ids
          from concept_images i where ${matchValue} in (i.url,i.local_path)`;
    const avatars = disposition.kind === 'local'
      ? await tx<LegacyMatchingSource[]>`
          select 'legacy_avatar_asset'::text source_kind,av.id source_id,
            av.sha256,av.url,av.local_path,null::text source_path,
            coalesce(array(select t.id::text from account_erasure_targets t
              join account_erasure_jobs j on j.id=t.job_id
              where t.kind='legacy_avatar_asset' and t.resource_id=av.id
                and t.state<>'succeeded' and j.state<>'succeeded'),array[]::text[]) active_target_ids
          from agent_avatar_assets av where av.url=${matchValue}
            or (${localPath}::text is not null and av.local_path=${localPath})`
      : await tx<LegacyMatchingSource[]>`
          select 'legacy_avatar_asset'::text source_kind,av.id source_id,
            av.sha256,av.url,av.local_path,null::text source_path,
            coalesce(array(select t.id::text from account_erasure_targets t
              join account_erasure_jobs j on j.id=t.job_id
              where t.kind='legacy_avatar_asset' and t.resource_id=av.id
                and t.state<>'succeeded' and j.state<>'succeeded'),array[]::text[]) active_target_ids
          from agent_avatar_assets av where ${matchValue} in (av.url,av.local_path)`;
    const [creation] = await tx<{ shared: boolean }[]>`
      select exists(select 1 from creations c where ${matchValue} in (c.url,c.thumbnail_url)) shared`;
    const [avatarShared] = await tx<{ shared: boolean }[]>`
      select exists(
        select 1 from accounts a
        where a.user_image=${matchValue} and a.deleted=false
          and not exists (
            select 1 from agent_avatar_assets av
            where av.agent_account_id=a.id and av.url=${matchValue}
          )
      ) shared`;
    const classifiedSources = [...media, ...concepts, ...avatars].map((source) => ({
      source,
      disposition: legacyDisposition(source, this.legacyMediaRoot),
    }));
    const exactSources = classifiedSources.filter(({ disposition: sourceDisposition }) => {
      return sourceDisposition.kind !== 'ambiguous' && sourceDisposition.key === disposition.key;
    }).map(({ source }) => source);
    const foreignShared = creation?.shared === true || avatarShared?.shared === true || classifiedSources.some(
      ({ source, disposition: sourceDisposition }) =>
        sourceDisposition.kind === 'ambiguous' || sourceDisposition.key !== disposition.key ||
        source.active_target_ids.length === 0,
    );
    const targetIds = [...new Set(exactSources.flatMap((source) => source.active_target_ids))].sort();
    return { foreignShared, elected: !foreignShared && targetIds[0] === target.id };
  }

  private async resolveLocator(tx: PgTransaction, target: TargetCandidate): Promise<string | null> {
    if (target.kind === 'storage_object') {
      const [row] = await tx<{ backing_store: string; backing_key: string }[]>`
        select backing_store,backing_key from storage_objects where id=${target.resource_id} for update`;
      return row ? JSON.stringify({ backingStore: row.backing_store, backingKey: row.backing_key }) : null;
    }
    if (target.kind === 'legacy_media_asset') {
      const [row] = await tx<{
        source_path: string | null; local_path: string | null; url: string | null; sha256: string | null;
      }[]>`
        select m.source_path,m.local_path,m.url,m.sha256
        from media_assets m where m.id=${target.resource_id} for update`;
      if (!row) return null;
      const disposition = legacyDisposition(row, this.legacyMediaRoot);
      if (disposition.kind === 'ambiguous') return null;
      const canonicalMediaUrl = disposition.kind === 'local' ? disposition.canonicalUrl : null;
      await tx`select account_erasure_lock_legacy_content(
        ${row.sha256},${row.url},${canonicalMediaUrl},${row.local_path},${row.source_path},
        ${null},${null},${null},${null},${null})`;
      const election = await this.legacyDispositionElection(tx, target, disposition);
      return JSON.stringify({
        sourcePath: row.source_path,
        localPath: row.local_path,
        url: row.url,
        sha256: row.sha256,
        dispositionKey: disposition.key,
        deletePhysical: election.elected && disposition.kind === 'local',
        externalDisposition: election.elected && disposition.kind === 'external',
      });
    }
    if (target.kind === 'legacy_concept_asset') {
      const [row] = await tx<{
        local_path: string | null; url: string; sha256: string;
      }[]>`
        select i.local_path,i.url,i.sha256
        from concept_images i where i.id=${target.resource_id} for update`;
      if (!row) return null;
      const disposition = legacyDisposition({ ...row, source_path: null }, this.legacyMediaRoot);
      if (disposition.kind === 'ambiguous') return null;
      await tx`select account_erasure_lock_legacy_content(
        ${row.sha256},${row.url},${null},${row.local_path},${null},
        ${null},${null},${null},${null},${null})`;
      const election = await this.legacyDispositionElection(tx, target, disposition);
      return JSON.stringify({
        localPath: row.local_path,
        url: row.url,
        sha256: row.sha256,
        dispositionKey: disposition.key,
        deletePhysical: election.elected && disposition.kind === 'local',
        externalDisposition: election.elected && disposition.kind === 'external',
      });
    }
    if (target.kind === 'legacy_avatar_asset') {
      const [row] = await tx<{
        local_path: string | null; url: string; sha256: string;
      }[]>`
        select av.local_path,av.url,av.sha256
        from agent_avatar_assets av where av.id=${target.resource_id} for update`;
      if (!row) return null;
      const disposition = legacyDisposition({ ...row, source_path: null }, this.legacyMediaRoot);
      if (disposition.kind === 'ambiguous') return null;
      await tx`select account_erasure_lock_legacy_content(
        ${row.sha256},${row.url},${null},${row.local_path},${null},
        ${null},${null},${null},${null},${null})`;
      const election = await this.legacyDispositionElection(tx, target, disposition);
      return JSON.stringify({
        localPath: row.local_path,
        url: row.url,
        sha256: row.sha256,
        dispositionKey: disposition.key,
        deletePhysical: election.elected && disposition.kind === 'local',
        externalDisposition: election.elected && disposition.kind === 'external',
      });
    }
    if (target.kind === 'voice_clone') {
      const [row] = await tx<{
        provider: string; provider_voice_id: string | null; status: string; clip_manifest_sha256: string;
      }[]>`
        select provider,provider_voice_id,status,clip_manifest_sha256
        from voice_clones where id=${target.resource_id} for update`;
      return row ? JSON.stringify({
        kind: 'voice_clone', provider: row.provider, providerVoiceId: row.provider_voice_id,
        status: row.status, clipManifestSha256: row.clip_manifest_sha256,
      }) : null;
    }
    if (target.kind === 'voice_output') {
      const [row] = await tx<{
        output_local_path: string | null; output_url: string | null; output_sha256: string | null;
      }[]>`
        select output_local_path,output_url,output_sha256 from voice_executions
        where id=${target.resource_id} and status='completed' for update`;
      if (!row?.output_local_path || !row.output_url || !row.output_sha256) return null;
      await tx`select pg_advisory_xact_lock(hashtextextended('voice-output:'||${row.output_sha256},0))`;
      const [election] = await tx<{ foreign_shared: boolean; elected_target_id: string | null }[]>`
        with matching as materialized (
          select ve.id,coalesce(array(select t.id::text from account_erasure_targets t
            join account_erasure_jobs j on j.id=t.job_id
            where t.kind='voice_output' and t.resource_id=ve.id
              and t.state<>'succeeded' and j.state<>'succeeded'),array[]::text[]) active_target_ids
          from voice_executions ve
          where ve.status='completed' and ve.output_sha256=${row.output_sha256}
        ), target_ids as (
          select distinct unnest(active_target_ids) id from matching
        )
        select exists(select 1 from matching where cardinality(active_target_ids)=0) foreign_shared,
          (select min(id) from target_ids) elected_target_id`;
      return JSON.stringify({
        kind: 'voice_output', localPath: row.output_local_path, url: row.output_url,
        sha256: row.output_sha256,
        deletePhysical: election?.foreign_shared === false && election.elected_target_id === target.id,
      });
    }
    if (target.kind === 'agent_runtime') {
      const [row] = await tx<{ openclaw_id: string | null; workspace_path: string | null }[]>`
        select openclaw_id,workspace_path from agents where account_id=${target.resource_id} for update`;
      return row ? JSON.stringify({ openclawId: row.openclaw_id, workspacePath: row.workspace_path }) : null;
    }
    if (target.kind === 'channel_runtime') {
      const [row] = await tx<{ channel: string; runtime_account_id: string | null }[]>`
        select channel,runtime_account_id from channel_connections where id=${target.resource_id} for update`;
      if (!row) return null;
      const outbound = await tx<{ id: string; state: string; provider_post_id: string | null }[]>`
        select id,state,provider_post_id from channel_outbound_post_intents
        where connection_id=${target.resource_id} order by id for update`;
      return JSON.stringify({
        channel: row.channel,
        runtimeAccountId: row.runtime_account_id,
        outboundIntents: outbound.map((entry: (typeof outbound)[number]) => ({
          intentId: entry.id,
          state: entry.state,
          providerPostId: entry.provider_post_id,
        })),
      });
    }
    if (target.kind === 'clerk_identity') {
      const [row] = await tx<{ clerk_user_id: string | null }[]>`
        select clerk_user_id from accounts where id=${target.resource_id} for update`;
      return row?.clerk_user_id ? JSON.stringify({ clerkUserId: row.clerk_user_id }) : null;
    }
    if (target.kind === 'stripe_customer') {
      const rebuilt = await stripeErasureLocator(tx, target.resource_id);
      return rebuilt ? JSON.stringify(rebuilt) : null;
    }
    return null;
  }

  private async lockTargetHierarchy(
    tx: PgTransaction,
    candidate: TargetCandidate,
  ): Promise<TargetCandidate | null> {
    const [account] = await tx<{ id: string }[]>`
      select id from accounts where id=${candidate.account_id} for update`;
    if (!account) return null;
    await tx`
      select a.id from accounts a join agents ag on ag.account_id=a.id
      where ag.owner_id=${candidate.account_id} order by a.id for update of a`;
    await tx`
      select account_id from agents where owner_id=${candidate.account_id}
      order by account_id for update`;
    const [job] = await tx<{ id: string }[]>`
      select id from account_erasure_jobs where id=${candidate.job_id}
        and account_id=${candidate.account_id} and state='pending' for update`;
    if (!job) return null;
    const [target] = await tx<TargetCandidate[]>`
      select t.id,t.job_id,j.account_id,t.kind,t.resource_id,t.attempt_count
      from account_erasure_targets t join account_erasure_jobs j on j.id=t.job_id
      where t.id=${candidate.id} and t.job_id=${candidate.job_id}
        and t.kind=${candidate.kind} and t.resource_id=${candidate.resource_id}
        and t.state='pending'
      for update of t`;
    return target ?? null;
  }

  async claimTarget(): Promise<AccountErasureTargetClaim | { targetId: string; status: 'attention' } | null> {
    return await this.client.begin(async (tx) => {
      await tx`select account_erasure_begin_operation()`;
      const [expiredCandidate] = await tx<{
        id: string; job_id: string; account_id: string; kind: ErasureKind; resource_id: string;
        claim_token: string; claim_expires_at: Date; attempt_count: string;
      }[]>`
        select t.id,t.job_id,j.account_id,t.kind,t.resource_id,t.claim_token,
          t.claim_expires_at,t.attempt_count
        from account_erasure_targets t join account_erasure_jobs j on j.id=t.job_id
        where j.state='pending' and t.state='claimed' and t.claim_expires_at <= statement_timestamp()
        order by t.claim_expires_at,t.id limit 1`;
      if (expiredCandidate) {
        await tx`select id from accounts where id=${expiredCandidate.account_id} for update`;
        await tx`
          select a.id from accounts a join agents ag on ag.account_id=a.id
          where ag.owner_id=${expiredCandidate.account_id} order by a.id for update of a`;
        await tx`select account_id from agents where owner_id=${expiredCandidate.account_id} order by account_id for update`;
        await tx`select id from account_erasure_jobs where id=${expiredCandidate.job_id} for update`;
        const [expired] = await tx<{ id: string }[]>`
          select id from account_erasure_targets where id=${expiredCandidate.id} and state='claimed'
            and claim_token=${expiredCandidate.claim_token}
            and claim_expires_at=${iso(expiredCandidate.claim_expires_at)}::timestamptz
            and claim_expires_at <= statement_timestamp() for update`;
        if (expired) {
          await tx`select set_config('eden3.erasure_job_id', ${expiredCandidate.job_id}, true)`;
          await tx`select set_config('eden3.erasure_target_kind', ${expiredCandidate.kind}, true)`;
          await tx`select set_config('eden3.erasure_target_resource_id', ${expiredCandidate.resource_id}, true)`;
          await tx`select set_config('eden3.erasure_target_claim_token', ${expiredCandidate.claim_token}, true)`;
          await tx`select set_config('eden3.erasure_target_claim_expires_at', ${iso(expiredCandidate.claim_expires_at)}, true)`;
          const attention = Number(expiredCandidate.attempt_count) >= this.maxAttempts;
          await tx`
            update account_erasure_targets set state=${attention ? 'attention' : 'pending'},
              next_attempt_at=${attention ? null : tx`statement_timestamp()`},
              claim_token=null,claim_expires_at=null,last_error_code='target_claim_expired',
              updated_at=statement_timestamp() where id=${expiredCandidate.id}`;
          if (attention) return { targetId: expiredCandidate.id, status: 'attention' };
        }
      }
      const [failedStorageCandidate] = await tx<TargetCandidate[]>`
        select t.id,t.job_id,j.account_id,t.kind,t.resource_id,t.attempt_count
        from account_erasure_targets t join account_erasure_jobs j on j.id=t.job_id
        where j.state='pending' and t.state='pending' and t.kind='storage_object'
          and exists (
            select 1 from storage_uploads u
            where u.object_id=t.resource_id and u.cleanup_state='failed'
          )
        order by case when t.kind in ('voice_clone','voice_output') then 0 when t.kind='storage_object' then 2 else 1 end,
          t.next_attempt_at,t.id limit 1`;
      if (failedStorageCandidate) {
        const failedTarget = await this.lockTargetHierarchy(tx, failedStorageCandidate);
        if (failedTarget) {
          const [stillFailed] = await tx<{ failed: boolean }[]>`
            select exists (
              select 1 from storage_uploads u
              where u.object_id=${failedTarget.resource_id} and u.cleanup_state='failed'
            ) as failed`;
          if (stillFailed?.failed) {
            await tx`
              update account_erasure_targets set state='attention',attempt_count=attempt_count+1,
                next_attempt_at=null,claim_token=null,claim_expires_at=null,
                last_error_code='multipart_cleanup_failed',updated_at=statement_timestamp()
              where id=${failedTarget.id}`;
            return { targetId: failedTarget.id, status: 'attention' };
          }
        }
      }

      const [candidate] = await tx<TargetCandidate[]>`
        select t.id,t.job_id,j.account_id,t.kind,t.resource_id,t.attempt_count
        from account_erasure_targets t join account_erasure_jobs j on j.id=t.job_id
        where j.state='pending' and t.state='pending' and t.next_attempt_at <= statement_timestamp()
          and t.kind <> 'backup_tombstone'
          and (t.kind <> 'storage_object' or not exists (
            select 1 from storage_uploads u where u.object_id=t.resource_id and not (
              (u.state='completed' and u.cleanup_state='not_required')
              or (u.state in ('aborted','expired') and u.cleanup_state='succeeded')
            )
          ))
        order by t.next_attempt_at,t.id limit 1`;
      if (!candidate) return null;
      const target = await this.lockTargetHierarchy(tx, candidate);
      if (!target) return null;
      const token = randomUUID();
      await tx`select set_config('eden3.erasure_job_id', ${target.job_id}, true)`;
      const [claimed] = await tx<{ claim_expires_at: Date }[]>`
        update account_erasure_targets set state='claimed',attempt_count=attempt_count+1,
          next_attempt_at=null,claim_token=${token},
          claim_expires_at=date_trunc('milliseconds',statement_timestamp()+
            (${this.claimLeaseMs}::text || ' milliseconds')::interval),
          last_error_code=null,updated_at=statement_timestamp()
        where id=${target.id} returning claim_expires_at`;
      if (!claimed) return null;
      let resolvedLocator = await this.resolveLocator(tx, target);
      if (!resolvedLocator && [
        'storage_object', 'legacy_media_asset', 'legacy_concept_asset', 'legacy_avatar_asset', 'voice_output', 'voice_clone', 'agent_runtime',
        'channel_runtime', 'clerk_identity', 'stripe_customer',
      ].includes(target.kind)) {
        const [sealed] = await tx<{ recovery_manifest_sha256: string | null }[]>`
          select recovery_manifest_sha256 from account_erasure_jobs where id=${target.job_id}`;
        if (sealed?.recovery_manifest_sha256) {
          resolvedLocator = JSON.stringify({
            sealedRecoveryLocator: {
              jobId: target.job_id,
              manifestSha256: sealed.recovery_manifest_sha256,
              kind: target.kind,
              resourceId: target.resource_id,
            },
          });
        }
      }
      if (!resolvedLocator) {
        await tx`select set_config('eden3.erasure_target_kind', ${target.kind}, true)`;
        await tx`select set_config('eden3.erasure_target_resource_id', ${target.resource_id}, true)`;
        await tx`select set_config('eden3.erasure_target_claim_token', ${token}, true)`;
        await tx`select set_config('eden3.erasure_target_claim_expires_at', ${iso(claimed.claim_expires_at)}, true)`;
        await tx`
          update account_erasure_targets set state='attention',next_attempt_at=null,
            claim_token=null,claim_expires_at=null,last_error_code='source_missing',
            updated_at=statement_timestamp() where id=${target.id}`;
        return { targetId: target.id, status: 'attention' };
      }
      return {
        targetId: target.id, jobId: target.job_id, accountId: target.account_id,
        kind: target.kind, resourceId: target.resource_id, claimToken: token,
        claimExpiresAt: iso(claimed.claim_expires_at), locator: resolvedLocator,
      };
    });
  }

  private async setClaim(tx: PgTransaction, claim: AccountErasureTargetClaim): Promise<void> {
    await tx`select set_config('eden3.erasure_job_id', ${claim.jobId}, true)`;
    await tx`select set_config('eden3.erasure_target_kind', ${claim.kind}, true)`;
    await tx`select set_config('eden3.erasure_target_resource_id', ${claim.resourceId}, true)`;
    await tx`select set_config('eden3.erasure_target_claim_token', ${claim.claimToken}, true)`;
    await tx`select set_config('eden3.erasure_target_claim_expires_at', ${claim.claimExpiresAt}, true)`;
  }

  private async lockClaimTuple(tx: PgTransaction, claim: AccountErasureTargetClaim): Promise<boolean> {
    const [account] = await tx<{ id: string }[]>`
      select id from accounts where id=${claim.accountId} for update`;
    if (!account) return false;
    await tx`
      select a.id from accounts a join agents ag on ag.account_id=a.id
      where ag.owner_id=${claim.accountId} order by a.id for update of a`;
    await tx`select account_id from agents where owner_id=${claim.accountId} order by account_id for update`;
    const [job] = await tx<{ id: string }[]>`
      select id from account_erasure_jobs where id=${claim.jobId} and account_id=${claim.accountId} for update`;
    if (!job) return false;
    const [target] = await tx<{ id: string }[]>`
      select id from account_erasure_targets where id=${claim.targetId} and job_id=${claim.jobId}
        and kind=${claim.kind} and resource_id=${claim.resourceId} and state='claimed'
        and claim_token=${claim.claimToken} and claim_expires_at=${claim.claimExpiresAt}::timestamptz
        and claim_expires_at > statement_timestamp()
      for update`;
    return target !== undefined;
  }

  async completeTarget(claim: AccountErasureTargetClaim): Promise<'completed' | 'stale'> {
    return await this.client.begin(async (tx) => {
      await tx`select account_erasure_begin_operation()`;
      await this.setClaim(tx, claim);
      if (!await this.lockClaimTuple(tx, claim)) return 'stale';
      if (claim.kind === 'storage_object') {
        await tx`select set_config('eden3.erasure_external_absence_id', ${claim.resourceId}, true)`;
        await tx`delete from storage_policy_events where object_id=${claim.resourceId}`;
        await tx`delete from storage_objects where id=${claim.resourceId}`;
      } else if (claim.kind === 'legacy_media_asset') {
        await tx`select set_config('eden3.erasure_external_absence_id', ${claim.resourceId}, true)`;
        await tx`delete from media_assets where id=${claim.resourceId}`;
      } else if (claim.kind === 'legacy_concept_asset') {
        await tx`select set_config('eden3.erasure_external_absence_id', ${claim.resourceId}, true)`;
        await tx`delete from concept_images where id=${claim.resourceId}`;
      } else if (claim.kind === 'legacy_avatar_asset') {
        await tx`select set_config('eden3.erasure_external_absence_id', ${claim.resourceId}, true)`;
        await tx`delete from agent_avatar_assets where id=${claim.resourceId}`;
      } else if (claim.kind === 'voice_clone') {
        await tx`delete from agent_voice_assignments where voice_id='clone:'||${claim.resourceId}::text`;
        await tx`delete from voice_clones where id=${claim.resourceId}`;
      } else if (claim.kind === 'voice_output') {
        await tx`select set_config('eden3.erasure_external_absence_id', ${claim.resourceId}, true)`;
        await tx`delete from voice_executions where id=${claim.resourceId}`;
      } else if (claim.kind === 'agent_runtime') {
        await tx`update agents set openclaw_id=null,workspace_path=null where account_id=${claim.resourceId}`;
      } else if (claim.kind === 'channel_runtime') {
        await tx`
          update secret_access_audit_events set actor_account_id=null,owner_account_id=null,metadata='{}'::jsonb
          where secret_kind='channel_token' and secret_id=${claim.resourceId}`;
        await tx`delete from channel_outbound_post_intents where connection_id=${claim.resourceId}`;
        await tx`delete from channel_connections where id=${claim.resourceId}`;
      } else if (claim.kind === 'clerk_identity') {
        await tx`update accounts set clerk_user_id=null,updated_at=statement_timestamp() where id=${claim.resourceId}`;
      } else if (claim.kind === 'stripe_customer') {
        await tx`delete from stripe_checkout_intents where account_id=${claim.resourceId}`;
        await tx`delete from billing_subscriptions where account_id=${claim.resourceId}`;
        await tx`
          update manna_transactions t set stripe_event_data=
            t.stripe_event_data-'customerId'-'customer'-'stripeCustomerId'-'subscriptionId'-'stripeSubscriptionId'-'objectId'
          from manna_accounts m where m.id=t.manna_account_id
            and m.account_id=${claim.resourceId} and t.type in ('credit:stripe','credit:subscription')
            and t.stripe_event_data ?| array[
              'customerId','customer','stripeCustomerId','subscriptionId','stripeSubscriptionId','objectId'
            ]`;
      }
      await tx`
        update account_erasure_targets set state='succeeded',next_attempt_at=null,
          claim_token=null,claim_expires_at=null,completed_at=statement_timestamp(),
          last_error_code=null,updated_at=statement_timestamp() where id=${claim.targetId}`;
      await tx`
        update account_erasure_jobs j set state='succeeded',completed_at=statement_timestamp(),
          updated_at=statement_timestamp()
        where j.id=${claim.jobId} and j.state='pending'
          and not exists (select 1 from account_erasure_targets t where t.job_id=j.id and t.state <> 'succeeded')`;
      return 'completed';
    });
  }

  async failTarget(claim: AccountErasureTargetClaim, errorCode: string): Promise<'retried' | 'attention' | 'stale'> {
    return await this.client.begin(async (tx) => {
      await tx`select account_erasure_begin_operation()`;
      await this.setClaim(tx, claim);
      if (!await this.lockClaimTuple(tx, claim)) return 'stale';
      const [target] = await tx<{ attempt_count: string }[]>`
        select attempt_count from account_erasure_targets where id=${claim.targetId}`;
      if (!target) return 'stale';
      const attemptCount = Number(target.attempt_count);
      const attention = attemptCount >= this.maxAttempts;
      const retryDelayMs = Math.min(3_600_000, 1000 * 2 ** Math.min(attemptCount, 12));
      await tx`
        update account_erasure_targets set state=${attention ? 'attention' : 'pending'},
          next_attempt_at=${attention ? null : tx`statement_timestamp()+(${retryDelayMs}::text || ' milliseconds')::interval`},
          claim_token=null,claim_expires_at=null,last_error_code=${errorCode},
          updated_at=statement_timestamp() where id=${claim.targetId}`;
      return attention ? 'attention' : 'retried';
    });
  }
}

export interface AccountErasureTargetExecutor {
  readonly legacyMediaBoundary?: AccountErasureLegacyMediaBoundary;
  readonly voiceCloneCustody?: true;
  erase(input: Pick<AccountErasureTargetClaim, 'targetId' | 'jobId' | 'kind' | 'resourceId' | 'locator'> & {
    signal: AbortSignal;
  }): Promise<{ confirmedAbsent: true }>;
}

/**
 * Provider-free deletion for the legacy MEDIA_DIR content-addressed store.
 * The database's active-target ingest fence serializes same-locator creation;
 * this boundary independently rejects caller paths, symlinks, and non-files.
 */
export class LocalLegacyErasureExecutor implements AccountErasureTargetExecutor {
  readonly legacyMediaBoundary: AccountErasureLegacyMediaBoundary;
  readonly voiceCloneCustody: true | undefined;

  constructor(
    boundary: AccountErasureLegacyMediaBoundary,
    private readonly external: AccountErasureTargetExecutor,
  ) {
    if (!isLegacyMediaBoundary(boundary)) {
      throw new Error('Local legacy erasure requires an attested media boundary');
    }
    this.legacyMediaBoundary = boundary;
    this.voiceCloneCustody = external.voiceCloneCustody;
    this.mediaRoot = boundary.root;
  }

  private readonly mediaRoot: string;

  async erase(input: Parameters<AccountErasureTargetExecutor['erase']>[0]): Promise<{ confirmedAbsent: true }> {
    if (input.kind !== 'legacy_media_asset' && input.kind !== 'legacy_concept_asset' &&
        input.kind !== 'legacy_avatar_asset' && input.kind !== 'voice_output') {
      return await this.external.erase(input);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(input.locator); } catch { throw new Error('legacy erasure locator is invalid'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('legacy erasure locator is invalid');
    }
    if ('sealedRecoveryLocator' in parsed) return await this.external.erase(input);
    const locator = parsed as Record<string, unknown>;
    if (locator.externalDisposition === true) return await this.external.erase(input);
    if (locator.deletePhysical !== true) return { confirmedAbsent: true };
    if (typeof locator.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(locator.sha256)) {
      throw new Error('legacy erasure locator is invalid');
    }
    const root = await realpath(this.mediaRoot);
    let candidate: string;
    if (typeof locator.localPath === 'string') {
      candidate = resolve(locator.localPath);
    } else if (typeof locator.url === 'string' &&
        new RegExp(`^/media/${locator.sha256}(?:\\.[a-z0-9]{1,10})?$`).test(locator.url)) {
      candidate = resolve(root, basename(locator.url));
    } else {
      throw new Error('legacy erasure locator is invalid');
    }
    const parent = await realpath(dirname(candidate));
    if (parent !== root) throw new Error('legacy erasure path must use the flat media root');
    if (!new RegExp(`^${locator.sha256}(?:\\.[a-z0-9]{1,10})?$`).test(basename(candidate))) {
      throw new Error('legacy erasure path is not canonical');
    }
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('legacy erasure path is not a regular file');
      const actual = await realpath(candidate);
      if (actual !== root && !actual.startsWith(root + sep)) {
        throw new Error('legacy erasure path escaped media root');
      }
      await unlink(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { confirmedAbsent: true };
  }
}

/** Confirms Cartesia clone absence before the erasure worker may delete custody rows. */
export class CartesiaVoiceCloneErasureExecutor implements AccountErasureTargetExecutor {
  readonly legacyMediaBoundary: AccountErasureLegacyMediaBoundary | undefined;
  readonly voiceCloneCustody = true as const;

  constructor(
    private readonly cartesia: VoiceProviderClient,
    private readonly fallback: AccountErasureTargetExecutor,
  ) {
    if (cartesia.provider !== 'cartesia' || !cartesia.deleteClone) {
      throw new Error('Cartesia clone erasure requires a delete-capable Cartesia provider');
    }
    this.legacyMediaBoundary = fallback.legacyMediaBoundary;
  }

  async erase(input: Parameters<AccountErasureTargetExecutor['erase']>[0]): Promise<{ confirmedAbsent: true }> {
    if (input.kind !== 'voice_clone') return await this.fallback.erase(input);
    let value: unknown;
    try { value = JSON.parse(input.locator); } catch { throw new Error('voice clone erasure locator is invalid'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('voice clone erasure locator is invalid');
    }
    const locator = value as Record<string, unknown>;
    if (locator.kind !== 'voice_clone' || locator.provider !== 'cartesia') {
      throw new Error('voice clone erasure locator is invalid');
    }
    if (locator.providerVoiceId === null) {
      if (locator.status === 'provider_create_ambiguous') {
        throw new Error('voice clone provider absence requires reconciliation');
      }
      return { confirmedAbsent: true };
    }
    if (typeof locator.providerVoiceId !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(locator.providerVoiceId)) {
      throw new Error('voice clone erasure locator is invalid');
    }
    await this.cartesia.deleteClone!(locator.providerVoiceId);
    return { confirmedAbsent: true };
  }
}

export interface AccountErasureTargetTickResult {
  claimed: number;
  completed: number;
  retried: number;
  attention: number;
  stale: number;
}

export class AccountErasureTargetWorker {
  private running = false;

  constructor(
    private readonly store: AccountErasureTargetStore,
    private readonly executor: AccountErasureTargetExecutor,
    private readonly batchSize = 25,
    private readonly timeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error('Account erasure target batch size must be between 1 and 100');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      throw new Error('Account erasure target timeout must be between 1 second and 5 minutes');
    }
    if (store.claimLeaseMs !== undefined && store.claimLeaseMs <= timeoutMs + 5_000) {
      throw new Error('Account erasure target lease must outlive the external cleanup deadline');
    }
  }

  async tick(): Promise<AccountErasureTargetTickResult> {
    if (this.running) return { claimed: 0, completed: 0, retried: 0, attention: 0, stale: 0 };
    this.running = true;
    const result: AccountErasureTargetTickResult = { claimed: 0, completed: 0, retried: 0, attention: 0, stale: 0 };
    try {
      for (let index = 0; index < this.batchSize; index += 1) {
        const claim = await this.store.claimTarget();
        if (!claim) break;
        result.claimed += 1;
        if ('status' in claim) {
          result.attention += 1;
          continue;
        }
        const controller = new AbortController();
        let rejectTimeout!: (error: Error) => void;
        const deadline = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
        const timer = setTimeout(() => {
          controller.abort();
          rejectTimeout(new Error('account erasure target cleanup timed out'));
        }, this.timeoutMs);
        timer.unref();
        try {
          const evidence = await Promise.race([
            this.executor.erase({
              targetId: claim.targetId, jobId: claim.jobId, kind: claim.kind,
              resourceId: claim.resourceId, locator: claim.locator,
              signal: controller.signal,
            }),
            deadline,
          ]);
          if (evidence.confirmedAbsent !== true) throw new Error('external absence was not confirmed');
          const outcome = await this.store.completeTarget(claim);
          result[outcome] += 1;
        } catch {
          const outcome = await this.store.failTarget(claim, 'target_cleanup_failed');
          result[outcome] += 1;
        } finally {
          clearTimeout(timer);
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
