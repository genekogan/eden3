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
  content_reports: schema.contentReports,
  creation_likes: schema.creationLikes,
  agent_likes: schema.agentLikes,
  collections: schema.collections,
  collection_creations: schema.collectionCreations,
  manna_accounts: schema.mannaAccounts,
  manna_transactions: schema.mannaTransactions,
  usage_events: schema.usageEvents,
  triggers: schema.triggers,
  media_assets: schema.mediaAssets,
  billing_subscriptions: schema.billingSubscriptions,
  manna_vouchers: schema.mannaVouchers,
  channel_connections: schema.channelConnections,
  secret_access_audit_events: schema.secretAccessAuditEvents,
  skill_definitions: schema.skillDefinitions,
  agent_skills: schema.agentSkills,
  distill_state: schema.distillState,
  etl_state: schema.etlState,
} as const;

describe('@eden3/db schema', () => {
  it('defines all expected tables under their SQL names', () => {
    for (const [sqlName, table] of Object.entries(expectedTables)) {
      expect(getTableName(table)).toBe(sqlName);
    }
  });

  it('uses citext for accounts.username', () => {
    expect(schema.accounts.username.getSQLType()).toBe('citext');
  });

  it('stores Clerk subject separately from legacy external id', () => {
    expect(schema.accounts.externalId.getSQLType()).toBe('text');
    expect(schema.accounts.clerkUserId.getSQLType()).toBe('text');
  });

  it('stores agent runtime configuration', () => {
    expect(schema.agents.model.getSQLType()).toBe('text');
    expect(schema.agents.thinkingLevel.getSQLType()).toBe('text');
    expect(schema.agents.toolGroups.getSQLType()).toBe('jsonb');
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
