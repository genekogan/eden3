import postgres from 'postgres';
import type { ReservedSql, Sql, TransactionSql } from 'postgres';

/**
 * Repository-wide PostgreSQL catalog mutation lease.
 *
 * The two-int form is deliberate: the identity is exact and inspectable in
 * pg_locks without relying on PostgreSQL's text hash implementation. The
 * values are the ASCII words EDEN / DDL1 interpreted as big-endian int32s.
 */
export const CATALOG_ADVISORY_LOCK = Object.freeze({
  classId: 0x4544454e,
  objectId: 0x44444c31,
  label: 'EDEN/DDL1',
});

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 50;
const UNLOCK_TIMEOUT_MS = 5_000;

export class CatalogLockTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`catalog advisory lock acquisition timed out after ${timeoutMs}ms`);
    this.name = 'CatalogLockTimeoutError';
  }
}

export function catalogLockTimeoutMs(
  value: string | undefined = process.env.DB_CATALOG_LOCK_TIMEOUT_MS,
): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error('catalog lock timeout must be a positive integer in milliseconds');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_TIMEOUT_MS) {
    throw new Error(`catalog lock timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return parsed;
}

export interface CatalogAdvisoryLockOptions {
  databaseUrl: string;
  timeoutMs?: number;
}

export type CatalogLockedSql = Omit<ReservedSql, 'begin'> & {
  <T extends readonly (object | undefined)[] = postgres.Row[]>(
    template: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ): postgres.PendingQuery<T>;
  begin<T>(callback: (sql: TransactionSql) => T | Promise<T>): Promise<Awaited<T>>;
};

/** @internal Exported only so the no-hang cleanup invariant is deterministic. */
export async function boundedCatalogCleanup<T>(
  operation: PromiseLike<T>,
  timeoutMs: number = UNLOCK_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('catalog cleanup timeout must be a positive integer');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`catalog advisory unlock timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * postgres.js 3.4.9 omits begin() from ReservedSql at runtime even though the
 * declared type inherits Sql. Drizzle's PostgreSQL migrator needs only the
 * callback form of begin(), with no transaction options or nesting. This
 * adapter implements exactly that form on the already-reserved connection so
 * a disconnect fails the operation instead of silently moving it to a new
 * backend after the session advisory lock disappears.
 */
export function adaptReservedSqlForDrizzle(
  connection: ReservedSql,
  rootClient: Pick<Sql, 'options'>,
): CatalogLockedSql {
  const adapted = connection as CatalogLockedSql;
  // Drizzle installs transparent timestamp/JSON codecs through this root
  // postgres.js property, which ReservedSql also omits at runtime.
  Object.defineProperty(adapted, 'options', {
    configurable: false,
    enumerable: false,
    value: rootClient.options,
    writable: false,
  });
  adapted.begin = (async (
    callbackOrOptions: ((sql: TransactionSql) => unknown) | string,
    unexpectedCallback?: unknown,
  ): Promise<unknown> => {
    if (typeof callbackOrOptions !== 'function' || unexpectedCallback !== undefined) {
      throw new Error('catalog transaction adapter supports callback-only begin()');
    }
    await connection.unsafe('begin');
    try {
      const result = await callbackOrOptions(connection as unknown as TransactionSql);
      await connection.unsafe('commit');
      return result;
    } catch (error) {
      try {
        await connection.unsafe('rollback');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'catalog transaction failed and rollback did not complete',
        );
      }
      throw error;
    }
  }) as CatalogLockedSql['begin'];
  return adapted;
}

function validateTimeoutMs(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`catalog lock timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function cleanupFailure(primary: unknown, cleanup: unknown[]): never {
  if (primary !== undefined && cleanup.length === 0) throw primary;
  if (primary === undefined && cleanup.length === 1) throw cleanup[0];
  throw new AggregateError(
    primary === undefined ? cleanup : [primary, ...cleanup],
    'catalog advisory lock operation and/or cleanup failed',
  );
}

/**
 * Run one migration or operational catalog/DDL operation on a dedicated,
 * reserved PostgreSQL session while holding the shared catalog mutation lock.
 *
 * Callers must execute every catalog guard, DDL statement, verification, and
 * journal write through the supplied handle. The handle has the narrow
 * callback-only transaction adapter Drizzle requires. A separate connection
 * is not protected by this lease. The reserved session and its private pool
 * are always released/closed before return.
 */
export async function withCatalogAdvisoryLock<T>(
  options: CatalogAdvisoryLockOptions,
  operation: (sql: CatalogLockedSql) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? catalogLockTimeoutMs();
  validateTimeoutMs(timeoutMs);
  if (options.databaseUrl.length === 0) throw new Error('database URL is required for catalog lock');

  const startedAt = Date.now();
  const pool = postgres(options.databaseUrl, {
    max: 1,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1_000)),
    max_lifetime: null,
    onnotice: () => undefined,
  });

  let connection: ReservedSql | undefined;
  let lockedSql: CatalogLockedSql | undefined;
  let acquired = false;
  let result: T | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    connection = await pool.reserve();
    lockedSql = adaptReservedSqlForDrizzle(connection, pool);
    const deadline = startedAt + timeoutMs;

    while (Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      await lockedSql`
        select set_config('statement_timeout', ${`${remainingMs}ms`}, false)`;
      const [row] = await lockedSql<{ acquired: boolean }[]>`
        select pg_try_advisory_lock(
          ${CATALOG_ADVISORY_LOCK.classId}::int,
          ${CATALOG_ADVISORY_LOCK.objectId}::int
        ) as acquired`;
      if (row?.acquired === true) {
        acquired = true;
        if (Date.now() > deadline) throw new CatalogLockTimeoutError(timeoutMs);
        await lockedSql`select set_config('statement_timeout', '0', false)`;
        break;
      }
      await wait(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }

    if (!acquired) throw new CatalogLockTimeoutError(timeoutMs);
    result = await operation(lockedSql);
  } catch (error) {
    primaryError = error;
  } finally {
    if (lockedSql && acquired) {
      try {
        const [row] = await boundedCatalogCleanup(
          lockedSql<{ unlocked: boolean }[]>`
            select pg_advisory_unlock(
              ${CATALOG_ADVISORY_LOCK.classId}::int,
              ${CATALOG_ADVISORY_LOCK.objectId}::int
            ) as unlocked`,
        );
        if (row?.unlocked !== true) {
          throw new Error('catalog advisory lock was not held by the reserved session at cleanup');
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      connection?.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await pool.end({ timeout: 5 });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError !== undefined || cleanupErrors.length > 0) {
    cleanupFailure(primaryError, cleanupErrors);
  }
  return result as T;
}
