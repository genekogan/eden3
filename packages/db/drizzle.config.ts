import { defineConfig } from 'drizzle-kit';

import { loadRootEnv } from './src/env';

loadRootEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://eden3:eden3@localhost:5433/eden3',
  },
});
