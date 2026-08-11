import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import postgres from 'postgres';

import { parseManagedPostgresUrl } from './managed-postgres-preflight';

const RUNTIME_ROLE = /^eden3_runtime_[a-z0-9_]{1,43}$/;
const STEADY_WORKERS = 10;
const QUERIES_PER_WORKER = 20;
const BURST_REQUESTS = 50;

export interface ManagedRuntimeRehearsalEvidence {
  schema: 'eden3.managed-runtime-rehearsal@v1';
  ranAt: string;
  databaseName: string;
  hostSha256: string;
  roleSha256: string;
  tlsMode: 'verify-full';
  serverVersionNum: number;
  maxConnections: number;
  steadyWorkers: 10;
  burstRequests: 50;
  queryCount: 250;
  successfulQueries: 250;
  latencyMs: { p50: number; p95: number; max: number };
  connectionFailureObserved: true;
  recovered: true;
  backendChanged: true;
  recoveryMs: number;
}

export function latencySummary(samples: readonly number[]): {
  p50: number;
  p95: number;
  max: number;
} {
  if (samples.length === 0 || samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('managed runtime latency samples are invalid');
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value: number) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)]!;
  return {
    p50: Number(percentile(0.5).toFixed(3)),
    p95: Number(percentile(0.95).toFixed(3)),
    max: Number(sorted.at(-1)!.toFixed(3)),
  };
}

function runtimeRoleFromUrl(databaseUrl: string): string {
  let username: string;
  try {
    username = decodeURIComponent(new URL(databaseUrl).username);
  } catch {
    throw new Error('managed runtime authority is invalid');
  }
  if (!RUNTIME_ROLE.test(username)) throw new Error('managed runtime authority is not a runtime role');
  return username;
}

async function runtimeIdentity(sql: postgres.Sql): Promise<{
  databaseName: string;
  roleName: string;
  backendPid: number;
  serverVersionNum: number;
  maxConnections: number;
}> {
  const [row] = await sql<{
    databaseName: string;
    roleName: string;
    backendPid: number;
    serverVersionNum: string;
    maxConnections: string;
  }[]>`
    select current_database()::text as "databaseName",
           current_user::text as "roleName",
           pg_backend_pid()::int as "backendPid",
           current_setting('server_version_num')::text as "serverVersionNum",
           current_setting('max_connections')::text as "maxConnections"
  `;
  const serverVersionNum = Number(row?.serverVersionNum);
  const maxConnections = Number(row?.maxConnections);
  if (
    !row ||
    !Number.isSafeInteger(row.backendPid) || row.backendPid < 1 ||
    !Number.isSafeInteger(serverVersionNum) || serverVersionNum < 160000 ||
    !Number.isSafeInteger(maxConnections) || maxConnections < STEADY_WORKERS
  ) {
    throw new Error('managed runtime identity did not meet the rehearsal contract');
  }
  return { ...row, serverVersionNum, maxConnections };
}

async function timedIdentityQuery(
  sql: postgres.Sql,
  expectedDatabaseName: string,
  expectedRoleName: string,
): Promise<number> {
  const started = performance.now();
  const [row] = await sql<{ databaseName: string; roleName: string }[]>`
    select current_database()::text as "databaseName", current_user::text as "roleName"
  `;
  if (row?.databaseName !== expectedDatabaseName || row.roleName !== expectedRoleName) {
    throw new Error('managed runtime load query reached the wrong authority');
  }
  return performance.now() - started;
}

export async function runManagedRuntimeRehearsal(
  databaseUrl: string,
  expectedDatabaseName: string,
): Promise<ManagedRuntimeRehearsalEvidence> {
  const authority = parseManagedPostgresUrl(databaseUrl, expectedDatabaseName);
  const roleName = runtimeRoleFromUrl(databaseUrl);
  const latencySamples: number[] = [];
  const load = postgres(databaseUrl, {
    max: STEADY_WORKERS,
    ssl: 'verify-full',
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
  });
  let identity: Awaited<ReturnType<typeof runtimeIdentity>>;
  try {
    identity = await runtimeIdentity(load);
    if (identity.databaseName !== expectedDatabaseName || identity.roleName !== roleName) {
      throw new Error('managed runtime identity differs from the requested authority');
    }
    await Promise.all(Array.from({ length: STEADY_WORKERS }, async () => {
      for (let index = 0; index < QUERIES_PER_WORKER; index += 1) {
        latencySamples.push(await timedIdentityQuery(load, expectedDatabaseName, roleName));
      }
    }));
    latencySamples.push(...await Promise.all(Array.from({ length: BURST_REQUESTS }, () =>
      timedIdentityQuery(load, expectedDatabaseName, roleName))));
  } finally {
    await load.end({ timeout: 5 });
  }

  const recovery = postgres(databaseUrl, {
    max: 1,
    ssl: 'verify-full',
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
  });
  let connectionFailureObserved = false;
  let recoveredPid = 0;
  const recoveryStarted = performance.now();
  try {
    const before = await runtimeIdentity(recovery);
    try {
      await recovery`select pg_terminate_backend(pg_backend_pid()) as terminated`;
      await delay(25);
    } catch {
      connectionFailureObserved = true;
    }
    const deadline = Date.now() + 10_000;
    let lastFailure: unknown;
    while (Date.now() < deadline) {
      try {
        const after = await runtimeIdentity(recovery);
        if (after.databaseName === expectedDatabaseName && after.roleName === roleName) {
          recoveredPid = after.backendPid;
          break;
        }
      } catch (error) {
        connectionFailureObserved = true;
        lastFailure = error;
      }
      await delay(100);
    }
    if (recoveredPid === 0) throw lastFailure ?? new Error('managed runtime did not reconnect');
    if (recoveredPid === before.backendPid) {
      throw new Error('managed runtime failure did not replace the terminated backend');
    }
    // PostgreSQL may return the termination result immediately before closing
    // the socket. A changed backend is the authoritative failure observation.
    connectionFailureObserved = true;
  } finally {
    await recovery.end({ timeout: 5 });
  }

  if (latencySamples.length !== 250 || !connectionFailureObserved) {
    throw new Error('managed runtime rehearsal evidence is incomplete');
  }
  return {
    schema: 'eden3.managed-runtime-rehearsal@v1',
    ranAt: new Date().toISOString(),
    databaseName: expectedDatabaseName,
    hostSha256: authority.hostSha256,
    roleSha256: createHash('sha256').update(roleName).digest('hex'),
    tlsMode: authority.tlsMode,
    serverVersionNum: identity.serverVersionNum,
    maxConnections: identity.maxConnections,
    steadyWorkers: STEADY_WORKERS,
    burstRequests: BURST_REQUESTS,
    queryCount: 250,
    successfulQueries: 250,
    latencyMs: latencySummary(latencySamples),
    connectionFailureObserved: true,
    recovered: true,
    backendChanged: true,
    recoveryMs: Number((performance.now() - recoveryStarted).toFixed(3)),
  };
}
