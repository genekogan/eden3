import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  accountErasureJobs,
  accountErasureMessageTombstones,
  accountErasureTargetRequeues,
  accountErasureTargets,
} from '../src/schema';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0040_account_erasure_lifecycle.sql', import.meta.url),
);
const PREVIOUS_SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0039_snapshot.json', import.meta.url),
);
const SNAPSHOT = fileURLToPath(new URL('../migrations/meta/0040_snapshot.json', import.meta.url));
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

const FENCED_TABLES = [
  'accounts',
  'agents',
  'sessions',
  'session_agents',
  'session_users',
  'messages',
  'session_share_links',
  'creations',
  'content_reports',
  'creation_likes',
  'agent_likes',
  'etl_social_edges',
  'collections',
  'collection_creations',
  'concepts',
  'concept_images',
  'manna_accounts',
  'manna_transactions',
  'turn_authorizations',
  'turn_provider_runs',
  'billing_subscriptions',
  'channel_connections',
  'channel_onboarding_intents',
  'channel_external_identities',
  'channel_pairing_requests',
  'channel_turns',
  'secret_access_audit_events',
  'skill_definitions',
  'agent_skills',
  'distill_state',
  'usage_events',
  'claude_session_turn_claims',
  'memory_revisions',
  'memory_dream_runs',
  'memory_retrieval_probes',
  'triggers',
  'media_assets',
  'storage_objects',
  'storage_uploads',
  'storage_upload_parts',
  'storage_upload_part_authorizations',
  'storage_policy_events',
  'app_notifications',
  'agent_provision_jobs',
] as const;

describe('0040 account erasure lifecycle schema', () => {
  it('adds exactly four identifier-only tables after 0039', async () => {
    const previous = JSON.parse(await readFile(PREVIOUS_SNAPSHOT, 'utf8')) as {
      id: string;
      tables: Record<string, unknown>;
    };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      prevId: string;
      tables: Record<string, unknown>;
    };
    expect(next.prevId).toBe(previous.id);
    expect(Object.keys(next.tables).filter((name) => !(name in previous.tables)).sort()).toEqual([
      'public.account_erasure_jobs',
      'public.account_erasure_message_tombstones',
      'public.account_erasure_target_requeues',
      'public.account_erasure_targets',
    ]);
    for (const name of Object.keys(previous.tables)) expect(next.tables[name]).toEqual(previous.tables[name]);

    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    journal.entries.forEach((entry, index) => expect(entry.idx).toBe(index));
    expect(journal.entries.at(-1)).toEqual(expect.objectContaining({
      idx: 40,
      tag: '0040_account_erasure_lifecycle',
    }));
  });

  it('keeps restore identity UUID-only and stores no locator/content/secret material', () => {
    const jobs = getTableConfig(accountErasureJobs);
    const targets = getTableConfig(accountErasureTargets);
    const requeues = getTableConfig(accountErasureTargetRequeues);
    const tombstones = getTableConfig(accountErasureMessageTombstones);

    expect(jobs.foreignKeys).toHaveLength(0);
    expect(jobs.columns.find((column) => column.name === 'account_id')?.notNull).toBe(true);
    expect(targets.columns.find((column) => column.name === 'kind')?.enumValues).toEqual([
      'storage_object',
      'legacy_media_asset',
      'agent_runtime',
      'channel_runtime',
      'clerk_identity',
      'stripe_customer',
      'backup_tombstone',
    ]);
    expect(requeues.columns.map((column) => column.name).sort()).toEqual([
      'created_at', 'id', 'job_id', 'operator_id', 'prior_attempt_count', 'reason_code', 'target_id',
    ].sort());
    expect(tombstones.columns.map((column) => column.name).sort()).toEqual([
      'author_principal_id', 'created_at', 'id', 'job_id', 'message_id', 'session_id',
    ].sort());

    const allColumns = [jobs, targets, requeues, tombstones]
      .flatMap((table) => table.columns.map((column) => column.name));
    expect(allColumns.join(' ')).not.toMatch(
      /locator|payload|content|attachment|persona|credential|bearer|capability|url|external_id/i,
    );
  });

  it('pins lifecycle shapes, immutable recovery evidence, and audited requeue', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    for (const name of [
      'account_erasure_job_guard',
      'account_erasure_target_guard',
      'account_erasure_target_requeue_guard',
      'account_erasure_message_tombstone_guard',
    ]) expect(migration).toContain(name);
    expect(migration).toContain('recovery evidence and erasure identity are immutable');
    expect(migration).toContain('claim_expires_at <= statement_timestamp()');
    expect(migration).toContain("OLD.state = 'attention' AND NEW.state = 'pending'");
    expect(migration).toContain('account_erasure_target_requeues');
    expect(migration).toContain('prior_attempt_count');
    expect(migration).toContain('late or mismatched erasure target claim');
    expect(migration).toContain('expired erasure target claim may only recover for retry or attention');
    expect(migration).toContain('erasure lifecycle fields may change only with state CAS');
    expect(migration).toContain('all erasure targets must succeed before the job');
  });

  it('fences exact kind ownership on both insert and claim', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    expect(migration).toContain('account_erasure_target_owned');
    for (const source of [
      'storage_objects', 'media_assets', 'agents', 'channel_connections',
      'accounts', 'billing_subscriptions',
    ]) expect(migration).toContain(source);
    expect(migration).toContain("WHEN 'backup_tombstone' THEN RETURN p_resource_id = p_job_id");
    expect(migration.match(/account_erasure_target_owned/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('installs a complete active-account write-fence inventory', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<string, { foreignKeys?: Record<string, { tableTo: string }> }>;
    };
    expect(migration).toContain('account_erasure_assert_account_writable');
    expect(migration).toContain('FOR KEY SHARE');
    expect(migration).toContain('type = \'user\' AND deleted = false FOR UPDATE');
    expect(migration).toContain("state <> 'succeeded'");
    expect(migration).toContain("current_setting('eden3.erasure_job_id', true)");
    expect(migration).toContain("current_setting('eden3.erasure_target_claim_token', true)");
    for (const table of FENCED_TABLES) {
      expect(migration, table).toContain(`ON \"${table}\"`);
      expect(migration, `${table} statement lock`).toContain(
        `a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON \"${table}\" FOR EACH STATEMENT`,
      );
    }
    const directAccountTables = Object.entries(snapshot.tables)
      .filter(([, table]) => Object.values(table.foreignKeys ?? {})
        .some((foreignKey) => foreignKey.tableTo === 'accounts'))
      .map(([name]) => name.replace('public.', ''));
    for (const table of directAccountTables) expect(FENCED_TABLES).toContain(table as never);
    expect(migration).toContain('account_erasure_write_fence');
    expect(migration).toContain("to_jsonb(OLD)->>'state'");
    expect(migration).not.toMatch(/TG_TABLE_NAME = 'storage_uploads'[^;]+OLD\.state/s);
    expect(migration).toContain('pg_advisory_xact_lock(1162102094, 1163023187)');
    expect(migration).toContain('account_erasure_begin_operation()');
    expect(migration).not.toContain('pg_advisory_xact_lock_shared(1162102094, 1163023187)');
  });

  it('guards snapshot capture, money-open state, multipart cleanup, and source disposal', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    expect(migration).toContain('account_erasure_snapshot_guard');
    expect(migration).toContain('account_erasure_message_tombstones');
    expect(migration).toContain('account_erasure_assert_no_open_work');
    for (const source of [
      'turn_authorizations', 'turn_provider_runs', 'channel_turns', 'usage_events',
      'memory_dream_runs', 'storage_uploads',
    ]) expect(migration).toContain(source);
    expect(migration).toContain('t.pending_occurrence_id IS NOT NULL');
    expect(migration).toContain('multipart cleanup must succeed before storage erasure');
    expect(migration).toContain('positive storage absence must precede source disposal');
    expect(migration).toContain('source row must be disposed before target success');
    expect(migration).toContain("OLD.\"cleanup_state\" = 'failed' AND NEW.\"cleanup_state\" = 'pending'");
    expect(migration).toContain('account_erasure_target_requeues');
    expect(migration).toContain("current_user = 'eden3_erasure_restore'");
    expect(migration).toContain("eden3.erasure_restore_mode', true), '') = 'verified_offline'");
    expect(migration).toContain("t.state <> 'succeeded' AND j.state <> 'succeeded'");
    expect(migration).toContain("source author/session mismatch");
    expect(migration).toContain("to_jsonb(NEW) - 'channel_connection_id'");
    expect(migration).toContain("TG_TABLE_NAME IN ('channel_onboarding_intents','channel_turns')");
    expect(migration).toContain("eden3.erasure_target_claim_expires_at");
    expect(migration).toContain('account_erasure_legacy_media_owned');
    expect(migration).toContain('legacy source retains a foreign or mixed-owner association');
  });

  it('contains no destructive account cascade or copied erasure payload', async () => {
    const migration = await readFile(MIGRATION, 'utf8');
    expect(migration).not.toMatch(/account_erasure_jobs[^;]+references[^;]+accounts/is);
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM\s+accounts/i);
    expect(migration).not.toMatch(/manifest_(?:payload|ciphertext)|external_locator|provider_credential/i);
  });
});
