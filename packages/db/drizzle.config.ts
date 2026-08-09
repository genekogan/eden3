import { defineConfig } from 'drizzle-kit';

import { loadRootEnv } from './src/env';
import { assertMigrationDatabaseBoundary } from './src/migrate';

loadRootEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for Drizzle tooling');
}
assertMigrationDatabaseBoundary(databaseUrl, process.env.EDEN3_DATABASE_NAME);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: databaseUrl,
  },
});
