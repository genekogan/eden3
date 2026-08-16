import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  claimGate3DatabaseOwnership,
  dropOwnedGate3Database,
  verifyGate3DatabaseOwnership,
} from '../../../e2e/gate3-database-ownership';

const runId = 'gate3-scratch-20260815-a1b2c3d4e5f60708';
const head = 'a'.repeat(40);
const databaseName = 'eden3_runtime_e2e_contract_1234';
const markerHash = 'b'.repeat(64);
const clusterIdentity = createHash('sha256').update(JSON.stringify({
  systemIdentifier: '1234567890123456789', port: 5432, version: '180000',
})).digest('hex');

function environment(identity: { databaseOid?: string; clusterIdentity?: string } = {}) {
  Object.assign(process.env, {
    E2E_GATE3_DATABASE_RUN_ID: runId,
    E2E_GATE3_DATABASE_INTEGRATION_HEAD: head,
    E2E_GATE3_DATABASE_NAME: databaseName,
    E2E_GATE3_DATABASE_MARKER_HASH: markerHash,
    ...(identity.databaseOid ? { E2E_GATE3_DATABASE_OID: identity.databaseOid } : {}),
    ...(identity.clusterIdentity ? { E2E_GATE3_DATABASE_CLUSTER_IDENTITY: identity.clusterIdentity } : {}),
  });
}

function fakeDatabase(options: {
  oid?: string;
  operatorDatabase?: string;
  systemIdentifier?: string;
  serverPort?: number;
  replaceAfterTerminate?: boolean;
} = {}) {
  const state = {
    oid: options.oid ?? '16384',
    marker: null as null | Record<string, string>,
    terminate: 0,
    drop: 0,
    released: 0,
  };
  const sql: any = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase();
    if (query.includes('from pg_control_system')) return [{
      systemIdentifier: options.systemIdentifier ?? '1234567890123456789',
      port: options.serverPort ?? 5432,
      version: '180000',
    }];
    if (query.includes('current_database()') && query.includes('pg_database')) {
      return [{ databaseName, databaseOid: state.oid }];
    }
    if (query.includes('from pg_namespace')) return [{ count: state.marker ? 1 : 0 }];
    if (query.startsWith('insert into eden3_gate3_database_ownership.claim')) {
      state.marker = {
        runId: String(values[0]), integrationHead: String(values[1]), databaseName: String(values[2]),
        databaseOid: String(values[3]), clusterIdentity: String(values[4]), ownershipMarkerHash: String(values[5]),
      };
      return [];
    }
    if (query.includes('from eden3_gate3_database_ownership.claim')) return state.marker ? [state.marker] : [];
    if (query.includes('pg_advisory_lock') || query.includes('pg_advisory_unlock')) return [];
    if (query === 'select current_database()::text as name') {
      return [{ name: options.operatorDatabase ?? 'postgres' }];
    }
    if (query.includes('select oid::text as "databaseoid" from pg_database')) return [{ databaseOid: state.oid }];
    if (query.includes('select datname::text as name from pg_database')) return [{ name: 'postgres' }, { name: 'template0' }];
    if (query.includes('pg_terminate_backend')) {
      state.terminate += 1;
      if (options.replaceAfterTerminate) state.oid = '32768';
      return [];
    }
    if (query.includes('select count(*)::int as count from pg_database')) return [{ count: state.drop ? 0 : 1 }];
    throw new Error(`unexpected modeled SQL: ${query}`);
  };
  sql.unsafe = async (query: string) => {
    if (query.startsWith('drop database')) { state.drop += 1; return []; }
    if (query.startsWith('create schema') || query.startsWith('create table')) return [];
    throw new Error(`unexpected unsafe SQL: ${query}`);
  };
  sql.begin = async (callback: (transaction: any) => unknown) => callback(sql);
  sql.reserve = async () => Object.assign(sql, { release: async () => { state.released += 1; } });
  return { sql, state };
}

afterEach(() => {
  for (const name of Object.keys(process.env).filter((name) => name.startsWith('E2E_GATE3_DATABASE_'))) {
    delete process.env[name];
  }
});

describe('Gate 3 physical database ownership', () => {
  it('claims, verifies, and drops only the exact physical database', async () => {
    environment();
    const model = fakeDatabase();
    const claim = await claimGate3DatabaseOwnership(model.sql);
    expect(claim).toMatchObject({ phase: 'claim', databaseName, databaseOid: '16384' });
    expect(await verifyGate3DatabaseOwnership(model.sql)).toEqual({ ...claim, phase: 'verify' });
    environment({ databaseOid: claim.databaseOid, clusterIdentity: claim.clusterIdentity });
    const receipt = await dropOwnedGate3Database(model.sql);
    expect(receipt).toMatchObject({ ok: true, phase: 'teardown', databaseName, databaseOid: '16384', scratchDatabaseAbsent: true });
    expect(model.state).toMatchObject({ terminate: 1, drop: 1, released: 1 });
  });

  it('refuses wrong coordinates, operator DB, cluster, server port, and OID replacement without DROP', async () => {
    for (const mutation of [
      { env: { E2E_GATE3_DATABASE_RUN_ID: 'wrong' } },
      { env: { E2E_GATE3_DATABASE_INTEGRATION_HEAD: 'f'.repeat(39) } },
      { env: { E2E_GATE3_DATABASE_NAME: 'eden3' } },
      { env: { E2E_GATE3_DATABASE_MARKER_HASH: '0' } },
      { model: { operatorDatabase: 'template1' } },
      { model: { systemIdentifier: 'invalid' } },
      { model: { serverPort: 5433 } },
      { model: { replaceAfterTerminate: true } },
    ]) {
      environment({ databaseOid: '16384', clusterIdentity });
      Object.assign(process.env, mutation.env ?? {});
      const model = fakeDatabase(mutation.model);
      await expect(dropOwnedGate3Database(model.sql)).rejects.toThrow();
      expect(model.state.drop).toBe(0);
      expect(model.state.terminate).toBe(mutation.model?.replaceAfterTerminate ? 1 : 0);
    }
  });

  it('cross-binds every marker coordinate and physical OID/cluster during verification', async () => {
    environment();
    const claimed = fakeDatabase();
    await claimGate3DatabaseOwnership(claimed.sql);
    const mutations: Array<() => void> = [
      () => { process.env.E2E_GATE3_DATABASE_RUN_ID = 'gate3-scratch-20260815-b1b2c3d4e5f60708'; },
      () => { process.env.E2E_GATE3_DATABASE_INTEGRATION_HEAD = 'f'.repeat(40); },
      () => { process.env.E2E_GATE3_DATABASE_NAME = 'eden3_runtime_e2e_other_1234'; },
      () => { process.env.E2E_GATE3_DATABASE_MARKER_HASH = 'f'.repeat(64); },
      () => { claimed.state.oid = '32768'; },
      () => { if (claimed.state.marker) claimed.state.marker.clusterIdentity = 'f'.repeat(64); },
    ];
    for (const mutate of mutations) {
      environment();
      claimed.state.oid = '16384';
      if (claimed.state.marker) claimed.state.marker.clusterIdentity = clusterIdentity;
      mutate();
      await expect(verifyGate3DatabaseOwnership(claimed.sql)).rejects.toThrow();
    }
  });
});
