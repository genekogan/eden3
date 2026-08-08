import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { CATALOG_ADVISORY_LOCK } from '../../src/catalog-lock';
import { loadRootEnv } from '../../src/env';

loadRootEnv();

const sourceDatabaseUrl = process.env.DATABASE_URL;
if (!sourceDatabaseUrl) {
  throw new Error('DATABASE_URL is required for disposable catalog-lock proof');
}

const PROTECTED_DATABASES = new Set(['eden3', 'eden3_stg']);
const PROCESS_FIXTURE = fileURLToPath(
  new URL('../fixtures/catalog-lock-process.ts', import.meta.url),
);
const scratchDatabases: string[] = [];
const tempDirectories: string[] = [];

function urlForDatabase(database: string): string {
  if (database !== 'postgres' && !/^debt001_catalog_[a-f0-9]{8}$/.test(database)) {
    throw new Error(`refusing non-disposable database ${database}`);
  }
  if (PROTECTED_DATABASES.has(database)) {
    throw new Error(`refusing protected database ${database}`);
  }
  const source = new URL(sourceDatabaseUrl!);
  const url = new URL(`${source.protocol}//${source.host}`);
  url.username = source.username;
  url.password = source.password;
  url.pathname = `/${database}`;
  return url.toString();
}

async function createScratchDatabase(): Promise<{ name: string; url: string }> {
  const name = `debt001_catalog_${randomUUID().slice(0, 8)}`;
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  scratchDatabases.push(name);
  return { name, url: urlForDatabase(name) };
}

async function buildBlockingMigrations(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'eden3-catalog-lock-'));
  tempDirectories.push(root);
  await mkdir(path.join(root, 'meta'));
  await writeFile(
    path.join(root, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [{
        idx: 0,
        version: '7',
        when: 1_783_999_999_999,
        tag: '0000_catalog_lock_probe',
        breakpoints: true,
      }],
    }),
  );
  await writeFile(
    path.join(root, '0000_catalog_lock_probe.sql'),
    [
      'create table migration_lock_probe (id integer primary key);',
      '--> statement-breakpoint',
      'select pg_sleep(3);',
      '--> statement-breakpoint',
      'insert into migration_lock_probe (id) values (1);',
    ].join('\n'),
  );
  return root;
}

function runProcess(input: {
  mode: 'runner' | 'ddl';
  databaseUrl: string;
  timeoutMs: number;
  migrationsFolder?: string;
}): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = fork(PROCESS_FIXTURE, [], {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        TEST_DATABASE_URL: input.databaseUrl,
        TEST_CATALOG_LOCK_MODE: input.mode,
        TEST_CATALOG_LOCK_TIMEOUT_MS: String(input.timeoutMs),
        ...(input.migrationsFolder
          ? { TEST_MIGRATIONS_FOLDER: input.migrationsFolder }
          : {}),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`catalog-lock ${input.mode} fixture did not cleanly exit within 10 seconds`));
    }, 10_000);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(deadline);
      resolve({ code, stderr });
    });
  });
}

async function waitForCatalogLock(sql: postgres.Sql): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from pg_locks
      where locktype = 'advisory'
        and classid = ${CATALOG_ADVISORY_LOCK.classId}::oid
        and objid = ${CATALOG_ADVISORY_LOCK.objectId}::oid
        and objsubid = 2
        and granted`;
    if (row?.count === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for migration runner advisory lock');
}

afterAll(async () => {
  for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true });
  if (scratchDatabases.length === 0) return;
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => undefined });
  try {
    for (const name of scratchDatabases) {
      if (!/^debt001_catalog_[a-f0-9]{8}$/.test(name)) throw new Error(`refusing to drop ${name}`);
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      const [remaining] = await admin<{ count: number }[]>`
        select count(*)::int as count from pg_database where datname = ${name}`;
      expect(remaining?.count).toBe(0);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('catalog lock process/concurrency proof on disposable PostgreSQL', () => {
  it('serializes two migration runners and operational DDL across guard, DDL, and journal', async () => {
    const database = await createScratchDatabase();
    const migrationsFolder = await buildBlockingMigrations();
    const observer = postgres(database.url, { max: 1, onnotice: () => undefined });
    try {
      const firstRunner = runProcess({
        mode: 'runner',
        databaseUrl: database.url,
        timeoutMs: 5_000,
        migrationsFolder,
      });
      await Promise.race([
        waitForCatalogLock(observer),
        firstRunner.then((result) => {
          throw new Error(
            `first migration runner exited before holding the lock: code=${result.code} stderr=${result.stderr}`,
          );
        }),
      ]);

      const [secondRunner, concurrentDdl] = await Promise.all([
        runProcess({
          mode: 'runner',
          databaseUrl: database.url,
          timeoutMs: 200,
          migrationsFolder,
        }),
        runProcess({ mode: 'ddl', databaseUrl: database.url, timeoutMs: 200 }),
      ]);
      expect(secondRunner).toEqual({ code: 2, stderr: '' });
      expect(concurrentDdl).toEqual({ code: 2, stderr: '' });

      expect(await firstRunner).toEqual({ code: 0, stderr: '' });

      const [migrationRows] = await observer<{ count: number }[]>`
        select count(*)::int as count from migration_lock_probe`;
      const [journalRows] = await observer<{ count: number }[]>`
        select count(*)::int as count from drizzle.__drizzle_migrations`;
      const [ddlBeforeRelease] = await observer<{ relation: string | null }[]>`
        select to_regclass('public.operational_ddl_probe')::text as relation`;
      expect(migrationRows?.count).toBe(1);
      expect(journalRows?.count).toBe(1);
      expect(ddlBeforeRelease?.relation).toBeNull();

      expect(await runProcess({ mode: 'ddl', databaseUrl: database.url, timeoutMs: 1_000 }))
        .toEqual({ code: 0, stderr: '' });
      const [ddlAfterRelease] = await observer<{ relation: string | null }[]>`
        select to_regclass('public.operational_ddl_probe')::text as relation`;
      const [remainingLocks] = await observer<{ count: number }[]>`
        select count(*)::int as count
        from pg_locks
        where locktype = 'advisory'
          and classid = ${CATALOG_ADVISORY_LOCK.classId}::oid
          and objid = ${CATALOG_ADVISORY_LOCK.objectId}::oid
          and objsubid = 2
          and granted`;
      expect(ddlAfterRelease?.relation).toBe('operational_ddl_probe');
      expect(remainingLocks?.count).toBe(0);
    } finally {
      await observer.end({ timeout: 5 });
    }
  });
});
