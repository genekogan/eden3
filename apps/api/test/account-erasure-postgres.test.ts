import type { PgClient } from '@eden3/db';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  attestAccountErasureDatabaseBoundary,
  PostgresAccountErasureStore,
  stripeErasureLocator,
} from '../src/services/account-erasure-postgres';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const ACCEPTED_AT = new Date('2026-08-08T20:00:00.000Z');
const source = readFileSync(fileURLToPath(
  new URL('../src/services/account-erasure-postgres.ts', import.meta.url),
), 'utf8');

function fakeClient(account: { username: string; type: string; deleted: boolean }, existing = false) {
  const statements: string[] = [];
  const tag = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const statement = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push(statement);
    if (statement.includes('pg_has_role(session_user')) {
      return [{
        database_name: 'scratch',
        database_oid: '4242',
        session_user: 'eden3_erasure_test',
        operator_member: true,
        operator_login: true,
        operator_superuser: false,
        operator_create_role: false,
        operator_bypass_rls: false,
        operator_replication: false,
      }];
    }
    if (statement.includes('select id, username::text as username')) {
      return [{ id: ACCOUNT_ID, ...account }];
    }
    if (statement.includes('select * from account_erasure_jobs')) {
      return existing ? [{
        id: JOB_ID,
        account_id: ACCOUNT_ID,
        state: 'intent_pending',
        accepted_at: ACCEPTED_AT,
      }] : [];
    }
    if (statement.includes('insert into account_erasure_jobs')) {
      return [{ id: JOB_ID, account_id: ACCOUNT_ID, accepted_at: ACCEPTED_AT }];
    }
    return [];
  };
  const client = Object.assign(tag, {
    begin: async (callback: (tx: typeof tag) => Promise<unknown>) => await callback(tag),
  }) as unknown as PgClient;
  return { client, statements };
}

async function boundary(client: PgClient) {
  const ordinaryApplicationClient = (async () => [{
    database_name: 'scratch',
    database_oid: '4242',
    session_user: 'eden3_app_test',
    operator_member: false,
    terminal_writer_member: true,
  }]) as unknown as PgClient;
  const ordinaryApplicationDb = {
    execute: async () => [{
      database_name: 'scratch', database_oid: '4242', session_user: 'eden3_app_test',
      operator_member: false, terminal_writer_member: true,
    }],
  } as never;
  return await attestAccountErasureDatabaseBoundary({
    operatorClient: client,
    ordinaryApplicationClient,
    ordinaryApplicationDb,
    operatorLogin: 'eden3_erasure_test',
    ordinaryApplicationLogin: 'eden3_app_test',
  });
}

describe('PostgresAccountErasureStore transaction boundary', () => {
  it('blocks unresolved Stripe and outbound-post effects before inventory', () => {
    expect(source).toContain("from stripe_checkout_intents c join principals p on p.id=c.account_id");
    expect(source).toContain("from channel_outbound_post_intents o join principals p on p.id=o.account_id");
    expect(source.match(/where c\.state in \('preparing','provider_started'\)/g)).toHaveLength(1);
    expect(source.match(/where o\.state in \('preparing','provider_started'\)/g)).toHaveLength(1);
    expect(source).toContain("'erasure_work_in_flight'");
  });

  it('blocks active direct voice and deletes every terminal job before message scrubbing', () => {
    expect(source).toContain("from direct_voice_jobs v join principals p on p.id in (v.owner_account_id,v.agent_account_id)");
    expect(source.match(/where v\.status in \('queued','generating','attachment_pending'\)/g)).toHaveLength(2);
    const deletion = source.indexOf('delete from direct_voice_jobs v');
    const scrub = source.indexOf('), scrub_messages as (');
    const executionDeletion = source.indexOf("delete from voice_executions where status<>'completed'");
    expect(deletion).toBeGreaterThan(0);
    expect(deletion).toBeLessThan(scrub);
    expect(deletion).toBeLessThan(executionDeletion);
    expect(source.slice(deletion, deletion + 400)).toContain('v.owner_account_id in (select id from principals)');
    expect(source.slice(deletion, deletion + 400)).toContain('v.agent_account_id in (select id from principals)');
  });

  it('rejects malformed foreign contributor arrays before privacy mutation', () => {
    expect(source).toContain("jsonb_typeof(c.contributors)<>'array' or exists");
    expect(source).toContain("where jsonb_typeof(item.value)<>'string'");
    expect(source).toContain('account_erasure_collection_contributors_invalid');
  });

  it('attests both exact ordinary database handles and rejects identity or role drift', async () => {
    const { client: operatorClient } = fakeClient({ username: 'owner', type: 'user', deleted: false });
    const valid = {
      database_name: 'scratch', database_oid: '4242', session_user: 'eden3_app_test',
      operator_member: false, terminal_writer_member: true,
    };
    const raw = (async () => [valid]) as unknown as PgClient;
    const handle = { execute: async () => [valid] } as never;
    const attested = await attestAccountErasureDatabaseBoundary({
      operatorClient,
      ordinaryApplicationClient: raw,
      ordinaryApplicationDb: handle,
      operatorLogin: 'eden3_erasure_test',
      ordinaryApplicationLogin: 'eden3_app_test',
    });
    expect(attested.ordinaryApplicationClient).toBe(raw);
    expect(attested.ordinaryApplicationDb).toBe(handle);

    for (const mutation of [
      { side: 'raw', value: { ...valid, database_oid: '9999' } },
      { side: 'raw', value: { ...valid, session_user: 'wrong_app' } },
      { side: 'raw', value: { ...valid, operator_member: true } },
      { side: 'raw', value: { ...valid, terminal_writer_member: false } },
      { side: 'handle', value: { ...valid, database_oid: '9999' } },
      { side: 'handle', value: { ...valid, session_user: 'wrong_app' } },
      { side: 'handle', value: { ...valid, operator_member: true } },
      { side: 'handle', value: { ...valid, terminal_writer_member: false } },
    ] as const) {
      const candidateRaw = (async () => [mutation.side === 'raw' ? mutation.value : valid]) as unknown as PgClient;
      const candidateHandle = {
        execute: async () => [mutation.side === 'handle' ? mutation.value : valid],
      } as never;
      await expect(attestAccountErasureDatabaseBoundary({
        operatorClient,
        ordinaryApplicationClient: candidateRaw,
        ordinaryApplicationDb: candidateHandle,
        operatorLogin: 'eden3_erasure_test',
        ordinaryApplicationLogin: 'eden3_app_test',
      })).rejects.toThrow('role attestation failed');
    }
  });

  it.each([
    {
      name: 'top-up only',
      subscriptions: [],
      credits: [{ id: JOB_ID, type: 'credit:stripe', stripe_event_data: {
        objectId: 'cs_topup', customerId: 'cus_topup', accountId: ACCOUNT_ID,
      } }],
      customers: ['cus_topup'],
    },
    {
      name: 'subscription credit history only',
      subscriptions: [],
      credits: [{
        id: JOB_ID,
        type: 'credit:subscription',
        stripe_event_data: {
          customerId: 'cus_history', subscriptionId: 'sub_history', accountId: ACCOUNT_ID,
        },
      }],
      customers: ['cus_history'],
    },
    {
      name: 'subscription only',
      subscriptions: [{ stripe_customer_id: 'cus_subscription', stripe_subscription_id: 'sub_one' }],
      credits: [],
      customers: ['cus_subscription'],
    },
    {
      name: 'combined deduplicated',
      subscriptions: [{ stripe_customer_id: 'cus_shared', stripe_subscription_id: 'sub_one' }],
      credits: [{ id: JOB_ID, type: 'credit:stripe', stripe_event_data: {
        objectId: 'cs_shared', customerId: 'cus_shared', accountId: ACCOUNT_ID,
      } }],
      customers: ['cus_shared'],
    },
  ])('rebuilds complete immutable Stripe identity for $name', async ({ subscriptions, credits, customers }) => {
    const tx = async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('from billing_subscriptions') && sql.includes('for update')) return subscriptions;
      if (sql.includes('credit:subscription') && sql.includes('for update')) return credits;
      if (sql.includes('from stripe_checkout_intents')) return [];
      if (sql.includes('with evidence as')) return [];
      throw new Error(`unexpected SQL ${sql}`);
    };
    await expect(stripeErasureLocator(tx as never, ACCOUNT_ID)).resolves.toMatchObject({
      customerIds: customers,
      subscriptions: expect.any(Array),
    });
  });

  it('retains a customerless top-up Checkout Session as deletion identity', async () => {
    const tx = async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('from billing_subscriptions') && sql.includes('for update')) return [];
      if (sql.includes('credit:subscription') && sql.includes('for update')) return [{
        id: JOB_ID,
        type: 'credit:stripe',
        stripe_event_data: { objectId: 'cs_customerless', customerId: null, accountId: ACCOUNT_ID },
      }];
      if (sql.includes('from stripe_checkout_intents')) return [];
      if (sql.includes('with evidence as')) return [];
      throw new Error(`unexpected SQL ${sql}`);
    };
    await expect(stripeErasureLocator(tx as never, ACCOUNT_ID)).resolves.toMatchObject({
      customerIds: [], checkoutSessionIds: ['cs_customerless'], subscriptions: [],
    });
  });

  it('fails closed on malformed or cross-account Stripe ownership evidence', async () => {
    const malformed = async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('from billing_subscriptions')) return [];
      if (sql.includes('credit:subscription')) return [{ id: JOB_ID, type: 'credit:stripe', stripe_event_data: { customerId: '' } }];
      return [];
    };
    await expect(stripeErasureLocator(malformed as never, ACCOUNT_ID))
      .rejects.toMatchObject({ code: 'erasure_stripe_evidence_invalid' });

    const conflict = async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('from billing_subscriptions') && sql.includes('for update')) return [];
      if (sql.includes('credit:subscription') && sql.includes('for update')) {
        return [{ id: JOB_ID, type: 'credit:stripe', stripe_event_data: {
          objectId: 'cs_conflict', customerId: 'cus_conflict', accountId: ACCOUNT_ID,
        } }];
      }
      if (sql.includes('with evidence as')) return [{ account_id: '33333333-3333-4333-8333-333333333333' }];
      return [];
    };
    await expect(stripeErasureLocator(conflict as never, ACCOUNT_ID))
      .rejects.toMatchObject({ code: 'erasure_stripe_identity_conflict' });
  });
  it('calls account_erasure_begin_operation as statement one before every admission row lock', async () => {
    const { client, statements } = fakeClient({ username: 'gene', type: 'user', deleted: false });
    const databaseBoundary = await boundary(client);
    statements.length = 0;
    const store = new PostgresAccountErasureStore({
      databaseBoundary,
      reconciler: { reconcile: async () => undefined },
    });

    await expect(store.acceptIntent({ accountId: ACCOUNT_ID, confirmUsername: 'Gene' }))
      .resolves.toMatchObject({ accountId: ACCOUNT_ID, state: 'intent_pending' });
    expect(statements[0]).toBe('select account_erasure_begin_operation()');
    expect(statements.findIndex((statement) => statement.includes('for update'))).toBeGreaterThan(0);
    expect(statements).toContain(
      'insert into account_erasure_targets (job_id, kind, resource_id) values (?, \'backup_tombstone\', ?)',
    );
  });

  it('converges a duplicate request on the one active intent', async () => {
    const { client } = fakeClient({ username: 'gene', type: 'user', deleted: false }, true);
    const store = new PostgresAccountErasureStore({
      databaseBoundary: await boundary(client),
      reconciler: { reconcile: async () => undefined },
    });
    await expect(store.acceptIntent({ accountId: ACCOUNT_ID, confirmUsername: 'gene' }))
      .resolves.toEqual({
        jobId: JOB_ID,
        accountId: ACCOUNT_ID,
        acceptedAt: ACCEPTED_AT.toISOString(),
        state: 'intent_pending',
      });
  });

  it.each([
    [{ username: 'eve', type: 'user', deleted: false }, 'protected_account'],
    [{ username: 'gene', type: 'agent', deleted: false }, 'account_not_found'],
    [{ username: 'gene', type: 'user', deleted: true }, 'account_not_found'],
  ] as const)('refuses protected/non-user/deleted principals under lock', async (account, code) => {
    const { client, statements } = fakeClient(account);
    const store = new PostgresAccountErasureStore({
      databaseBoundary: await boundary(client),
      reconciler: { reconcile: async () => undefined },
    });
    await expect(store.acceptIntent({ accountId: ACCOUNT_ID, confirmUsername: account.username }))
      .rejects.toMatchObject({ code });
    expect(statements.some((statement) => statement.includes('insert into account_erasure_jobs'))).toBe(false);
  });

  it('pins live claim CAS, multipart gating, DB age truth, and global lock order in production SQL', () => {
    expect(source).toContain('claim_expires_at > statement_timestamp()');
    expect(source).toContain("u.cleanup_state='failed'");
    expect(source).toContain("last_error_code='multipart_cleanup_failed'");
    expect(source).toContain("u.state='completed' and u.cleanup_state='not_required'");
    expect(source).toContain("u.state in ('aborted','expired') and u.cleanup_state='succeeded'");
    expect(source).toContain("accepted_at <= statement_timestamp() - interval '5 minutes'");
    expect(source).toContain("accepted_at <= statement_timestamp() - interval '24 hours'");
    expect(source).toContain('and ledger_confirmed_at is null');
    expect(source).toContain('and recovery_manifest_confirmed_at is not null');
    expect(source).toContain("t.kind <> 'backup_tombstone' and t.state <> 'succeeded'");
    expect(source).toContain('Math.min(3_600_000, 1000 * 2 ** Math.min(attemptCount, 12))');
    expect(source).toContain('select id from accounts where id=${candidate.account_id} for update');
    expect(source).toContain('select id from account_erasure_jobs where id=${candidate.job_id}');
  });

  it('refuses construction without an attested dedicated operator boundary', () => {
    const { client } = fakeClient({ username: 'gene', type: 'user', deleted: false });
    expect(() => new PostgresAccountErasureStore({ client } as never)).toThrow(
      'requires an attested dedicated PostgreSQL operator boundary',
    );
  });

  it('rechecks shared references and delegates deletion only under the durable ingest fence', () => {
    expect(source).toContain('account_erasure_lock_legacy_content');
    expect(source).toContain("key: `local:${canonicalUrl}`");
    expect(source).toContain('dirname(resolve(localPath)) !== mediaRoot');
    expect(source).toContain("key: `external:${remote[0]}`");
    expect(source).toContain('sourceDisposition.key === disposition.key');
    expect(source).toContain('targetIds[0] === target.id');
    expect(source).toContain("deletePhysical: election.elected && disposition.kind === 'local'");
    expect(source).toContain("externalDisposition: election.elected && disposition.kind === 'external'");
    expect(source).toContain('legacy erasure path is not canonical');
  });
});
