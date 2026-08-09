import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  accountErasureJobs,
  accountErasureTargets,
  channelOutboundPostIntents,
  stripeCheckoutIntents,
} from '../src/schema';

const MIGRATION = fileURLToPath(new URL(
  '../migrations/0041_account_erasure_reconciliation.sql', import.meta.url,
));
const PREVIOUS = fileURLToPath(new URL('../migrations/meta/0040_snapshot.json', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('../migrations/meta/0041_snapshot.json', import.meta.url));
const JOURNAL = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

describe('0041 account erasure reconciliation', () => {
  it('is the exact additive journal successor with the sealed outbound-effect catalogs', async () => {
    const previous = JSON.parse(await readFile(PREVIOUS, 'utf8')) as {
      id: string; tables: Record<string, { columns: Record<string, unknown> }>;
    };
    const next = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      prevId: string; tables: Record<string, { columns: Record<string, unknown> }>;
    };
    expect(next.prevId).toBe(previous.id);
    expect(new Set(Object.keys(next.tables))).toEqual(new Set([
      ...Object.keys(previous.tables),
      'public.stripe_checkout_intents',
      'public.channel_outbound_post_intents',
    ]));
    const oldColumns = previous.tables['public.account_erasure_jobs']!.columns;
    const newColumns = next.tables['public.account_erasure_jobs']!.columns;
    expect(Object.keys(newColumns).filter((name) => !(name in oldColumns))).toEqual([
      'recovery_manifest_sha256',
    ]);
    expect(getTableConfig(stripeCheckoutIntents).columns.map((column) => column.name)).toEqual([
      'id', 'account_id', 'kind', 'state', 'request_key_sha256', 'stripe_session_id',
      'last_error_code', 'created_at', 'updated_at',
    ]);
    expect(getTableConfig(channelOutboundPostIntents).columns.map((column) => column.name)).toEqual([
      'id', 'account_id', 'connection_id', 'state', 'provider_post_id', 'last_error_code',
      'created_at', 'updated_at',
    ]);
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.at(-1)).toEqual({
      idx: 41,
      version: '7',
      when: expect.any(Number),
      tag: '0041_account_erasure_reconciliation',
      breakpoints: true,
    });
  });

  it('pins digest evidence and the one new owner-verified concept-byte target', async () => {
    const jobs = getTableConfig(accountErasureJobs);
    const targets = getTableConfig(accountErasureTargets);
    expect(jobs.columns.some((column) => column.name === 'recovery_manifest_sha256')).toBe(true);
    expect(targets.columns.find((column) => column.name === 'kind')?.enumValues)
      .toContain('legacy_concept_asset');
    const sql = await readFile(MIGRATION, 'utf8');
    expect(sql).toContain('recovery plaintext manifest digest is immutable');
    expect(sql).toContain('manifest digest requires the exact confirmation transition');
    expect(sql).toContain("WHEN 'legacy_concept_asset'");
    expect(sql).toContain('JOIN public.concepts c ON c.id=i.concept_id');
    expect(sql).toContain('account_erasure_concept_source_guard');
    expect(sql).toContain('account_erasure_concept_target_success_guard');
    expect(sql).toContain("EXISTS (SELECT 1 FROM public.concept_images WHERE id=NEW.resource_id)");
    expect(sql).toContain('positive storage absence must precede source disposal');
  });

  it('allows only claim-bound split-exact reconciliation and fail-closed open work', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    const reconcileSql = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.account_erasure_reconcile_open_work'),
      sql.indexOf('CREATE OR REPLACE FUNCTION public.account_erasure_assert_no_open_work'),
    );
    expect(sql).toContain('account_erasure_reverse_reservation');
    expect(sql).toContain('reversal requires exact sealing job');
    expect(sql).toContain('reservation provenance mismatch');
    expect(sql).toContain("v_subscription:=least(greatest(COALESCE(p_subscription,0),0),v_remainder)");
    expect(sql).toContain("u.turn_id=v_auth.turn_id AND u.status='error'");
    expect(sql).toContain("u.error_code='provider_terminal_no_output'");
    expect(sql).toContain('AND COALESCE(u.manna,0)=0 AND u.metadata IS NULL');
    expect(sql).toContain("AND v_new->'metadata'='null'::jsonb");
    expect(sql).toContain("'rule','full-reserve-v1','chargedManna'");
    expect(sql).toContain("WHEN 'settled' THEN a.authorized_max_manna::integer ELSE 0 END");
    expect(sql).not.toContain("v_auth.created_at <= statement_timestamp()-interval '1 hour'");
    expect(sql).toContain("WHEN 'settled' THEN 'settled' ELSE 'refunded'");
    expect(sql).toContain("u.status IN ('pending','provider_admitted','running','refund_pending')");
    expect(sql).toContain("WHERE c.state IN ('preparing','provider_started')");
    expect(sql).toContain("WHERE o.state IN ('preparing','provider_started')");
    expect(sql).toContain('account_erasure_record_stripe_checkout_terminal');
    expect(sql).toContain('account_erasure_record_outbound_post_terminal');
    expect(sql).toContain("p_error_code IN ('erasure_cancelled_before_provider','provider_confirmed_failed')");
    expect(sql).toContain("p_error_code IN ('erasure_cancelled_before_provider','invalid_credentials','revoked',");
    expect(sql).toContain("current_user='eden3_erasure_guard'");
    expect(sql).toContain("pg_has_role(session_user,'eden3_erasure_terminal_writer','member')");
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.account_erasure_record_stripe_checkout_terminal');
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.account_erasure_record_outbound_post_terminal');
    expect(sql).not.toContain('UNION ALL SELECT 1 FROM public.stripe_checkout_intents c JOIN principals p ON p.id=c.account_id\n\t\tUNION ALL');
    expect(reconcileSql).toContain('EXISTS (SELECT 1 FROM principals p WHERE p.id IN (a.account_id,a.agent_account_id))');
    expect(reconcileSql).toContain('EXISTS (SELECT 1 FROM principals p WHERE p.id IN (u.user_id,u.agent_id))');
    expect(reconcileSql).not.toContain('JOIN principals p ON p.id IN (a.account_id,a.agent_account_id)');
    expect(reconcileSql).not.toContain('JOIN principals p ON p.id IN (u.user_id,u.agent_id)');
    expect(sql).not.toContain('erasure_bypass');
  });

  it('serializes legacy content ingestion and permits only exact privacy reduction', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(sql).toContain('legacy content is fenced by active erasure');
    expect(sql).toContain("account_erasure_target_claim_matches(v_target_account,'legacy_concept_asset'");
    for (const table of ['media_assets', 'concept_images', 'creations']) {
      expect(sql).toContain(`ON ${table}`);
    }
    expect(sql).toContain('CREATE TRIGGER zz_account_erasure_media_ingest_fence');
    expect(sql).toContain("TG_TABLE_NAME='collections'");
    expect(sql).toContain("jsonb_typeof(v_old->'contributors')='array'");
    expect(sql).toContain("TG_TABLE_NAME='etl_social_edges'");
    expect(sql).toContain("v_row->>'edge_kind'='creation_like'");
    expect(sql).toContain("TG_TABLE_NAME='skill_definitions'");
    expect(sql).toContain("TG_TABLE_NAME='concepts'");
    expect(sql).toContain("(v_new->>'public')::boolean=false AND (v_new->>'deleted')::boolean=true");
    expect(sql).toContain("v_new->>'body'=''\n");
    expect(sql).toContain("CREATE ROLE eden3_erasure_operator NOLOGIN");
    expect(sql).toContain('rolcanlogin OR rolsuper OR rolcreaterole OR rolbypassrls OR rolreplication');
    expect(sql).toContain("r.rolname='eden3_erasure_operator' AND m.admin_option");
    expect(sql).not.toContain('SET search_path=pg_catalog,public AS');
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)?.length).toBe(
      sql.match(/SET search_path=pg_catalog,public,pg_temp/g)?.length,
    );
    expect(sql).toContain('SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp');
    expect(sql).toContain('ALTER FUNCTION public.account_erasure_legacy_source_guard()');
    expect(sql).toContain('SET search_path TO pg_catalog, public, pg_temp');
    expect(sql).toContain('OWNER TO eden3_erasure_guard');
    expect(sql).toContain("pg_has_role(session_user,'eden3_erasure_operator','member')");
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.account_erasure_reconcile_open_work(uuid) FROM PUBLIC');
    expect(sql).toContain("restore replay may recreate an erased account only as deleted");
  });
});
