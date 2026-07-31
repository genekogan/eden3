import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { loadRootEnv } from './env';
import * as schema from './schema';

loadRootEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set (expected in the environment or the repo-root .env)');
}

/**
 * Raw postgres.js client. Import this for raw SQL or to close the pool
 * (`await pg.end()`) in scripts/tests. Connections are opened lazily on the
 * first query.
 */
export const pg = postgres(databaseUrl, {
  max: 10,
  onnotice: () => {},
});
export type PgClient = typeof pg;

/** Drizzle client bound to the eden3 schema. */
export const db = drizzle(pg, { schema });

export type Db = typeof db;
