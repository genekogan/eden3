import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import * as schema from '../src/schema';

const expectedTables = {
  accounts: schema.accounts,
  agents: schema.agents,
  sessions: schema.sessions,
  session_agents: schema.sessionAgents,
  session_users: schema.sessionUsers,
  messages: schema.messages,
  creations: schema.creations,
  collections: schema.collections,
  collection_creations: schema.collectionCreations,
  manna_accounts: schema.mannaAccounts,
  manna_transactions: schema.mannaTransactions,
  triggers: schema.triggers,
  media_assets: schema.mediaAssets,
  etl_state: schema.etlState,
} as const;

describe('@eden3/db schema', () => {
  it('defines all 14 tables under their SQL names', () => {
    for (const [sqlName, table] of Object.entries(expectedTables)) {
      expect(getTableName(table)).toBe(sqlName);
    }
  });

  it('uses citext for accounts.username', () => {
    expect(schema.accounts.username.getSQLType()).toBe('citext');
  });

  it('uses timestamptz for timestamps', () => {
    expect(schema.accounts.createdAt.getSQLType()).toBe('timestamp with time zone');
    expect(schema.etlState.watermark.getSQLType()).toBe('timestamp with time zone');
  });

  it('uses numeric(20,4) for manna amounts', () => {
    expect(schema.mannaAccounts.balance.getSQLType()).toBe('numeric(20, 4)');
    expect(schema.mannaTransactions.amount.getSQLType()).toBe('numeric(20, 4)');
  });
});
