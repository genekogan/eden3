/**
 * Connectivity smoke check: selects from accounts and etl_state (empty ok).
 * Run with: pnpm --filter @eden3/db ping   (tsx src/ping.ts)
 */
import { db, pg } from './client';
import { accounts, etlState } from './schema';

const accountRows = await db.select({ id: accounts.id }).from(accounts).limit(1);
const etlRows = await db.select({ collection: etlState.collection }).from(etlState).limit(1);

console.log(
  `db ping ok — accounts reachable (${accountRows.length} sampled), etl_state reachable (${etlRows.length} sampled)`,
);

await pg.end();
