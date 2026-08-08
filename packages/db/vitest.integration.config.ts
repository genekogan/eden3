import { defineConfig } from 'vitest/config';

// Integration tests against the LIVE local Postgres (localhost:5433). Two
// kinds, both in test/integration/:
//  * scratch-DB migration-path proofs — create and drop their own transient
//    `t08u01_mig_*` databases; a hard guard refuses DDL against the shared
//    `eden3`/`eden3_stg` databases.
//  * read-only catalog verification against the DATABASE_URL target (run
//    explicitly per database; performs zero DDL).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.itest.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
