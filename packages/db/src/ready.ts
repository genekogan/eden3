import { pg } from './client';
import { checkSchemaReadiness } from './readiness';

const result = await checkSchemaReadiness();
console.log(
  JSON.stringify({
    status: result.status,
    expectedMigration: result.expectedMigration,
    expectedCount: result.expectedCount,
    appliedCount: result.appliedCount,
    missingCount: result.missingCount,
    unexpectedCount: result.unexpectedCount,
  }),
);
await pg.end();

if (result.status !== 'ready') process.exitCode = 1;
