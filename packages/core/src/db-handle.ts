import type { Db } from '@eden3/db';

/** The transaction handle produced by `db.transaction(cb)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Either the root drizzle client or a transaction — everything in core that
 * queries accepts this so callers can compose operations into one transaction.
 */
export type DbHandle = Db | Tx;
