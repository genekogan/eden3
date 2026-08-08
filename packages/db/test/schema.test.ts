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
  etl_social_edges: schema.etlSocialEdges,
  collections: schema.collections,
  collection_creations: schema.collectionCreations,
  concepts: schema.concepts,
  concept_images: schema.conceptImages,
  manna_accounts: schema.mannaAccounts,
  manna_transactions: schema.mannaTransactions,
  usage_events: schema.usageEvents,
  claude_session_turn_claims: schema.claudeSessionTurnClaims,
  triggers: schema.triggers,
  media_assets: schema.mediaAssets,
  billing_subscriptions: schema.billingSubscriptions,
  manna_vouchers: schema.mannaVouchers,
  channel_connections: schema.channelConnections,
  channel_external_identities: schema.channelExternalIdentities,
  channel_pairing_requests: schema.channelPairingRequests,
  channel_turns: schema.channelTurns,
  secret_access_audit_events: schema.secretAccessAuditEvents,
  skill_definitions: schema.skillDefinitions,
  agent_skills: schema.agentSkills,
  distill_state: schema.distillState,
  etl_runs: schema.etlRuns,
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
    expect(schema.agents.runtimeSyncVersion.getSQLType()).toBe('integer');
    expect(schema.agents.runtimeSyncedVersion.getSQLType()).toBe('integer');
    expect(schema.agents.runtimeSyncClaimToken.getSQLType()).toBe('uuid');
  });

  it('uses timestamptz for timestamps', () => {
    expect(schema.accounts.createdAt.getSQLType()).toBe('timestamp with time zone');
    expect(schema.etlRuns.startedAt.getSQLType()).toBe('timestamp with time zone');
    expect(schema.etlState.watermark.getSQLType()).toBe('timestamp with time zone');
  });

  it('persists bounded ETL run manifests separately from warning state', () => {
    expect(schema.etlRuns.id.getSQLType()).toBe('uuid');
    expect(schema.etlRuns.selectedCollections.getSQLType()).toBe('jsonb');
    expect(schema.etlRuns.sourceCutoffs.getSQLType()).toBe('jsonb');
    expect(schema.etlRuns.status.default).toBe('running');
  });

  it('uses numeric(20,4) for manna amounts', () => {
    expect(schema.mannaAccounts.balance.getSQLType()).toBe('numeric(20, 4)');
    expect(schema.mannaTransactions.amount.getSQLType()).toBe('numeric(20, 4)');
  });

  it('models isolated channel lifecycle, sync-back, pairing, and metering state', () => {
    expect(schema.channelConnections.runtimeAccountId.getSQLType()).toBe('text');
    expect(schema.channelConnections.desiredState.getSQLType()).toBe('text');
    expect(schema.channelConnections).not.toHaveProperty('tokenPreview');
    expect(schema.channelExternalIdentities.peerCiphertext.getSQLType()).toBe('text');
    expect(schema.channelExternalIdentities.peerPreview.getSQLType()).toBe('text');
    expect(schema.channelPairingRequests.status.getSQLType()).toBe('text');
    expect(schema.channelTurns.reservedManna.getSQLType()).toBe('integer');
    expect(schema.triggers.pendingOccurrenceId.getSQLType()).toBe('uuid');
    expect(schema.triggers.pendingOccurrenceAt.getSQLType()).toBe('timestamp with time zone');
    expect(schema.triggers.pendingOccurrenceClaimId.getSQLType()).toBe('uuid');
    expect(schema.sessions.channelConnectionId.getSQLType()).toBe('uuid');
    expect(schema.sessions.channelPeerFingerprint.getSQLType()).toBe('text');
    expect(schema.sessions.channelConversationFingerprint.getSQLType()).toBe('text');
    expect(schema.messages.sourceSequence.getSQLType()).toBe('bigint');
  });

  it('freezes channel turn execution provenance for exact settlement', () => {
    expect(schema.channelTurns.channel.getSQLType()).toBe('text');
    expect(schema.channelTurns.runtimeAccountId.getSQLType()).toBe('text');
    expect(schema.channelTurns.model.getSQLType()).toBe('text');
    expect(schema.channelTurns.agentRuntime.getSQLType()).toBe('text');
    expect(schema.channelTurns.pricingBasis.getSQLType()).toBe('text');
    expect(schema.channelTurns.provenanceStatus.getSQLType()).toBe('text');
    expect(schema.channelTurns.provenanceStatus.default).toBe('unknown');
  });

  it('models durable Claude turn leases and source-owned social provenance', () => {
    expect(schema.claudeSessionTurnClaims.sessionKey.getSQLType()).toBe('text');
    expect(schema.claudeSessionTurnClaims.leaseExpiresAt.getSQLType()).toBe(
      'timestamp with time zone',
    );
    expect(schema.etlSocialEdges.sourceCollection.getSQLType()).toBe('text');
    expect(schema.etlSocialEdges.sourceExternalId.getSQLType()).toBe('text');
    expect(schema.etlSocialEdges.lastSeenRunId.getSQLType()).toBe('uuid');
    expect(schema.memoryDreamSweeps.claimToken.getSQLType()).toBe('uuid');
    expect(schema.memoryDreamSweeps.leaseExpiresAt.getSQLType()).toBe(
      'timestamp with time zone',
    );
    expect(schema.memoryDreamRuns.claimToken.getSQLType()).toBe('uuid');
    expect(schema.memoryDreamRuns.leaseExpiresAt.getSQLType()).toBe(
      'timestamp with time zone',
    );
    expect(schema.memoryDreamRuns.providerStatus.getSQLType()).toBe('text');
  });
});
