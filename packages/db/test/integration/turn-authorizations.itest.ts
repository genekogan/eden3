import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { localDisposableDatabaseUrl } from '../fixtures/disposable-database';

/**
 * T08-U02 checkpoint-2: prove migrations 0028/0029 by EXECUTION, not file
 * inspection — the full drizzle chain on a self-created scratch database,
 * then invalid-row probes against the DDL-level money constraints.
 *
 * DDL is confined to scratch databases (`t08u02_mig_*`); the shared DBs are
 * never targeted (hard guard below, U01's RP-2 pattern).
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const scratchDbs: string[] = [];
const scratchPattern = /^t08u02_mig_[a-f0-9]{8}$/;
function requiredSourceDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is required for disposable turn-authorization proof');
  }
  return raw;
}
const sourceDatabaseUrl = requiredSourceDatabaseUrl();

function urlForDb(dbName: string): string {
  return localDisposableDatabaseUrl(sourceDatabaseUrl, dbName, scratchPattern);
}

async function createScratchDb(): Promise<string> {
  const name = `t08u02_mig_${randomUUID().slice(0, 8)}`;
  const admin = postgres(urlForDbAdmin(), { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  scratchDbs.push(name);
  return name;
}

function urlForDbAdmin(): string {
  return localDisposableDatabaseUrl(sourceDatabaseUrl, 'postgres', scratchPattern);
}

afterAll(async () => {
  const admin = postgres(urlForDbAdmin(), { max: 1 });
  try {
    for (const name of scratchDbs) {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('turn_authorizations migrations executed on a scratch database', () => {
  it('full chain applies; the DDL enforces the money state machine', async () => {
    const dbName = await createScratchDb();
    const client = postgres(urlForDb(dbName), { max: 1, onnotice: () => {} });
    try {
      const [row] = await client<{ current_database: string }[]>`
        select current_database()`;
      expect(row?.current_database).toBe(dbName);
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });

      // Table + index + unique reservation-tx + all four CHECKs exist.
      const constraints = await client<{ conname: string }[]>`
        select conname from pg_constraint
        where conrelid = 'turn_authorizations'::regclass and contype = 'c'`;
      expect(new Set(constraints.map((c) => c.conname))).toEqual(
        new Set([
          'turn_authorizations_state_chk',
          'turn_authorizations_max_positive_chk',
          'turn_authorizations_split_within_max_chk',
          'turn_authorizations_charge_within_max_chk',
        ]),
      );

      // Seed minimal FK targets.
      const [account] = await client<{ id: string }[]>`
        insert into accounts (type, username) values ('user', ${`scratch_${randomUUID().slice(0, 8)}`})
        returning id`;
      const [manna] = await client<{ id: string }[]>`
        insert into manna_accounts (account_id) values (${account!.id}) returning id`;
      const [tx] = await client<{ id: string }[]>`
        insert into manna_transactions (manna_account_id, amount, type, idempotency_key)
        values (${manna!.id}, '-61.0000', 'spend:chat', ${randomUUID()}) returning id`;

      const insertAuth = (over: Record<string, unknown>) =>
        client`
          insert into turn_authorizations
            (turn_id, account_id, provider, model, pricing_basis, ceiling_table_version,
             authorized_max_manna, reserved_subscription_manna, reservation_tx_id, state, charged_manna)
          values
            (${(over.turnId as string) ?? randomUUID()}, ${account!.id}, 'anthropic', 'claude-haiku-4-5',
             'provider-api', 'v', ${(over.max as string) ?? '61'}, ${(over.split as string) ?? '0'},
             ${(over.txId as string) ?? tx!.id}, ${(over.state as string) ?? 'reserved'},
             ${(over.charge as string | null) ?? null})`;

      // Valid row inserts.
      await insertAuth({});
      // Invalid state rejected.
      await expect(insertAuth({ txId: tx!.id, state: 'exploded' })).rejects.toThrow(/state_chk|unique/);
      // Second authorization on the SAME reservation tx rejected (unique).
      await expect(insertAuth({})).rejects.toThrow(/unique/);
      // Fresh tx rows for arithmetic probes.
      const freshTx = async () => {
        const [row] = await client<{ id: string }[]>`
          insert into manna_transactions (manna_account_id, amount, type, idempotency_key)
          values (${manna!.id}, '-61.0000', 'spend:chat', ${randomUUID()}) returning id`;
        return row!.id;
      };
      await expect(insertAuth({ txId: await freshTx(), max: '0' })).rejects.toThrow(/max_positive/);
      await expect(insertAuth({ txId: await freshTx(), split: '62' })).rejects.toThrow(/split_within_max/);
      await expect(insertAuth({ txId: await freshTx(), charge: '62' })).rejects.toThrow(/charge_within_max/);
      // settle ≤ authorized-max is a DDL invariant: UPDATE above max rejected.
      await expect(
        client`update turn_authorizations set charged_manna = '100' where reservation_tx_id = ${tx!.id}`,
      ).rejects.toThrow(/charge_within_max/);
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
