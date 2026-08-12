import { pg } from '@eden3/db';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  resolveLoadPostgresMetricsOutput,
  summarizeLoadPostgresSamples,
  type LoadPostgresSample,
} from './load-postgres-metrics';
import { parseLoadScratchDatabaseUrl } from './load-scratch-fixture';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function durationMs(raw: string | undefined): number {
  const value = Number(raw ?? 120_000);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3 * 60 * 60_000) {
    throw new Error('LOAD_POSTGRES_SAMPLE_DURATION_MS must be 1000..10800000');
  }
  return value;
}

async function sample(): Promise<LoadPostgresSample> {
  const [activity] = await pg<{
    sessions: number;
    activeSessions: number;
    waitingSessions: number;
    oldestTransactionMs: number;
  }[]>`
    select count(*) filter (where pid <> pg_backend_pid())::int as sessions,
           count(*) filter (where pid <> pg_backend_pid() and state = 'active')::int as "activeSessions",
           count(*) filter (where pid <> pg_backend_pid() and state = 'active' and wait_event_type is not null)::int as "waitingSessions",
           coalesce(max(extract(epoch from (clock_timestamp() - xact_start)) * 1000)
             filter (where pid <> pg_backend_pid() and xact_start is not null), 0)::float8 as "oldestTransactionMs"
    from pg_stat_activity
    where datname = current_database()
  `;
  const [database] = await pg<{
    commits: number;
    rollbacks: number;
    blockReads: number;
    blockHits: number;
    tempBytes: number;
    deadlocks: number;
  }[]>`
    select xact_commit::float8 as commits,
           xact_rollback::float8 as rollbacks,
           blks_read::float8 as "blockReads",
           blks_hit::float8 as "blockHits",
           temp_bytes::float8 as "tempBytes",
           deadlocks::float8 as deadlocks
    from pg_stat_database
    where datname = current_database()
  `;
  if (!activity || !database) throw new Error('PostgreSQL load metric sample was empty');
  return { atMs: Date.now(), ...activity, ...database };
}

async function main() {
  const rawDatabaseUrl = process.env.DATABASE_URL;
  if (!rawDatabaseUrl) throw new Error('DATABASE_URL is required');
  const { databaseName } = parseLoadScratchDatabaseUrl(rawDatabaseUrl);
  const runMs = durationMs(process.env.LOAD_POSTGRES_SAMPLE_DURATION_MS);
  const samples: LoadPostgresSample[] = [];
  const deadline = Date.now() + runMs;
  do {
    samples.push(await sample());
    if (Date.now() < deadline) await delay(Math.min(1_000, deadline - Date.now()));
  } while (Date.now() < deadline);
  samples.push(await sample());
  const report = {
    kind: 'eden3-load-postgres-metrics',
    ranAt: new Date().toISOString(),
    databaseName,
    requestedDurationMs: runMs,
    summary: summarizeLoadPostgresSamples(samples),
  };
  const out = process.env.LOAD_POSTGRES_SAMPLE_OUT;
  if (out) {
    const resolved = resolveLoadPostgresMetricsOutput(ROOT, out);
    await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
    await writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return report;
}

main()
  .then((report) => console.log(JSON.stringify(report)))
  .catch(() => {
    console.error(JSON.stringify({ ok: false, error: 'load_postgres_metrics_failed' }));
    process.exitCode = 1;
  })
  .finally(() => pg.end({ timeout: 5 }));
