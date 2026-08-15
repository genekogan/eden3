import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Postgres `citext` (case-insensitive text). The extension is created in the
 * first migration (`CREATE EXTENSION IF NOT EXISTS citext`).
 */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/** Every timestamp in eden3 is a `timestamptz`. */
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---------------------------------------------------------------------------
// accounts — unified principals (eden1 users3 discriminator: user | agent).
// external_id = Mongo hex id, preserved for permalinks; partial-unique so
// eden3-native rows may leave it null.
// ---------------------------------------------------------------------------
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id'),
    clerkUserId: text('clerk_user_id'),
    type: text('type').$type<'user' | 'agent'>().notNull(),
    username: citext('username').notNull().unique(),
    userImage: text('user_image'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    deleted: boolean('deleted').notNull().default(false),
  },
  (t) => [
    uniqueIndex('accounts_external_id_uq')
      .on(t.externalId)
      .where(sql`${t.externalId} is not null`),
    uniqueIndex('accounts_clerk_user_id_uq')
      .on(t.clerkUserId)
      .where(sql`${t.clerkUserId} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// agents — 1:1 extension of accounts(type='agent').
// ---------------------------------------------------------------------------
export const agents = pgTable('agents', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id),
  ownerId: uuid('owner_id').references(() => accounts.id),
  name: text('name'),
  description: text('description'),
  persona: text('persona'),
  /** eden1 `isPersonaPublic` — whether the persona text is viewable by non-owners. */
  isPersonaPublic: boolean('is_persona_public').notNull().default(false),
  greeting: text('greeting'),
  voice: text('voice'),
  model: text('model').notNull().default('anthropic/claude-haiku-4-5'),
  thinkingLevel: text('thinking_level').notNull().default('balanced'),
  toolGroups: jsonb('tool_groups')
    .$type<string[]>()
    .notNull()
    .default(
      sql`'["group:runtime","group:fs","group:web","group:sessions","group:memory","group:media","group:ui","group:automation","group:agents","group:plugins"]'::jsonb`,
    ),
  public: boolean('public').notNull().default(false),
  openclawId: text('openclaw_id').unique(),
  workspacePath: text('workspace_path'),
  isPilot: boolean('is_pilot').notNull().default(false),
  isSynthetic: boolean('is_synthetic').notNull().default(false),
  provisionStatus: text('provision_status').notNull().default('pending'),
  provisionedAt: timestamptz('provisioned_at'),
  /** Monotonic desired runtime/workspace configuration revision. */
  runtimeSyncVersion: integer('runtime_sync_version').notNull().default(0),
  /** Highest desired revision fully read back from the runtime. */
  runtimeSyncedVersion: integer('runtime_synced_version').notNull().default(0),
  /** Fenced, renewable claim for crash-safe asynchronous convergence. */
  runtimeSyncClaimToken: uuid('runtime_sync_claim_token'),
  runtimeSyncLeaseExpiresAt: timestamptz('runtime_sync_lease_expires_at'),
  runtimeSyncError: text('runtime_sync_error'),
}, (t) => [
  index('agents_runtime_sync_pending_idx')
    .on(t.runtimeSyncVersion, t.runtimeSyncLeaseExpiresAt)
    .where(
      sql`${t.provisionStatus} = 'ready' and ${t.openclawId} is not null and ${t.workspacePath} is not null and ${t.runtimeSyncVersion} > ${t.runtimeSyncedVersion}`,
    ),
]);

// ---------------------------------------------------------------------------
// agent_avatar_assets — immutable local-media custody for every avatar
// generation. Retired rows remain durable until reference-safe cleanup or
// owner erasure confirms physical absence.
// ---------------------------------------------------------------------------
export const agentAvatarAssets = pgTable(
  'agent_avatar_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    agentAccountId: uuid('agent_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    url: text('url').notNull(),
    localPath: text('local_path'),
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    state: text('state', { enum: ['current', 'retired'] }).notNull().default('current'),
    retiredAt: timestamptz('retired_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_avatar_assets_one_current_uq')
      .on(t.agentAccountId)
      .where(sql`${t.state} = 'current'`),
    index('agent_avatar_assets_owner_state_idx').on(t.ownerAccountId, t.state, t.createdAt),
    index('agent_avatar_assets_content_idx').on(t.sha256, t.url),
    check('agent_avatar_assets_sha_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('agent_avatar_assets_url_check', sql`${t.url} ~ '^/media/[0-9a-f]{64}[.][a-z0-9]{1,10}$'`),
    check('agent_avatar_assets_path_check', sql`${t.localPath} is null or length(${t.localPath}) between 1 and 4096`),
    check('agent_avatar_assets_mime_check', sql`${t.mime} in ('image/png','image/jpeg','image/webp')`),
    check('agent_avatar_assets_size_check', sql`${t.sizeBytes} is null or ${t.sizeBytes} between 1 and 8388608`),
    check('agent_avatar_assets_state_check', sql`${t.state} in ('current','retired')`),
    check(
      'agent_avatar_assets_retired_shape_check',
      sql`(${t.state}='current' and ${t.retiredAt} is null) or (${t.state}='retired' and ${t.retiredAt} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id'),
    ownerId: uuid('owner_id').references(() => accounts.id),
    title: text('title'),
    status: text('status'),
    sessionType: text('session_type'),
    platform: text('platform'),
    /**
     * eden1 hidden-session flag, migrated VERBATIM: `false` = hidden
     * agent-workspace/moderator session, null (source missing/null) = visible.
     */
    visible: boolean('visible'),
    /** eden1 pin flag, verbatim (null = source doc predates the field). */
    pinned: boolean('pinned'),
    /** Source `trigger` ref (triggers2 hex id) — plain string, no FK. */
    triggerExternalId: text('trigger_external_id'),
    /** Source `parent_session` ref (sessions hex id) — plain string, no FK. */
    parentSessionExternalId: text('parent_session_external_id'),
    /** eden1 `extras.is_public` — public share-link flag (null = unset). */
    isPublic: boolean('is_public'),
    /** Platform channel descriptor ({type, key, …}); objects in real docs. */
    channel: jsonb('channel'),
    /** Hosted Discord/Telegram connection mirrored by this read-only session. */
    channelConnectionId: uuid('channel_connection_id').references(
      (): AnyPgColumn => channelConnections.id,
      { onDelete: 'set null' },
    ),
    /** Non-reversible connection-scoped identifier for the external peer. */
    channelPeerFingerprint: text('channel_peer_fingerprint'),
    /**
     * Non-reversible connection-scoped identifier for the provider
     * conversation. Unlike `channelPeerFingerprint`, this is stable for a
     * group conversation whose individual senders change from message to
     * message.
     */
    channelConversationFingerprint: text('channel_conversation_fingerprint'),
    gatewaySessionKey: text('gateway_session_key').unique(),
    gatewayPrimedAt: timestamptz('gateway_primed_at'),
    lastMessageAt: timestamptz('last_message_at'),
    messageCount: integer('message_count').notNull().default(0),
    /** User-managed reversible archive state; distinct from legacy `visible=false`. */
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    deleted: boolean('deleted').notNull().default(false),
  },
  (t) => [
    uniqueIndex('sessions_external_id_uq')
      .on(t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('sessions_owner_last_message_idx').on(t.ownerId, t.lastMessageAt.desc()),
    index('sessions_channel_connection_idx').on(t.channelConnectionId, t.lastMessageAt.desc()),
    uniqueIndex('sessions_channel_peer_uq')
      .on(t.channelConnectionId, t.channelPeerFingerprint)
      .where(sql`${t.channelConnectionId} is not null and ${t.channelPeerFingerprint} is not null`),
    uniqueIndex('sessions_channel_conversation_uq')
      .on(t.channelConnectionId, t.channelConversationFingerprint)
      .where(
        sql`${t.channelConnectionId} is not null and ${t.channelConversationFingerprint} is not null`,
      ),
  ],
);

// ---------------------------------------------------------------------------
// session_share_links — opaque-token, non-discoverable session sharing.
// Snapshot identity/payload are immutable; public lookup is always by
// token_hash with revoked_at IS NULL, never by a sequential public identifier.
// ---------------------------------------------------------------------------
export const sessionShareLinks = pgTable(
  'session_share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    mode: text('mode', { enum: ['snapshot', 'live'] }).notNull(),
    title: text('title'),
    /** Opaque message UUID captured by the snapshot service; deliberately no FK. */
    snapshotBoundaryMessageId: uuid('snapshot_boundary_message_id'),
    snapshotPayload: jsonb('snapshot_payload').$type<Record<string, unknown>>().notNull(),
    revokedAt: timestamptz('revoked_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('session_share_links_token_uq').on(t.tokenHash),
    index('session_share_links_session_created_idx').on(t.sessionId, t.createdAt.desc()),
    check(
      'session_share_links_token_hash_check',
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('session_share_links_mode_check', sql`${t.mode} in ('snapshot', 'live')`),
    check(
      'session_share_links_title_check',
      sql`${t.title} is null or char_length(${t.title}) between 1 and 200`,
    ),
    check(
      'session_share_links_snapshot_payload_check',
      sql`jsonb_typeof(${t.snapshotPayload}) = 'object'`,
    ),
    check(
      'session_share_links_revoked_at_check',
      sql`${t.revokedAt} is null or ${t.revokedAt} >= ${t.createdAt}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// session_agents / session_users — m2m membership.
// ---------------------------------------------------------------------------
export const sessionAgents = pgTable(
  'session_agents',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    agentAccountId: uuid('agent_account_id')
      .notNull()
      .references(() => accounts.id),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.agentAccountId] }),
    index('session_agents_agent_idx').on(t.agentAccountId),
  ],
);

export const sessionUsers = pgTable(
  'session_users',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    userAccountId: uuid('user_account_id')
      .notNull()
      .references(() => accounts.id),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.userAccountId] }),
    index('session_users_user_idx').on(t.userAccountId),
  ],
);

// ---------------------------------------------------------------------------
// messages — one row per (message, session) pair; source `session` is an
// array in Mongo, hence unique(session_id, external_id) rather than a global
// unique external_id.
// ---------------------------------------------------------------------------
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id'),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    senderId: uuid('sender_id').references(() => accounts.id),
    role: text('role'),
    content: text('content'), // nullable — tool results and eden banners may carry none
    /** eden1 `eden_message_data` — system-banner payload for role='eden' rows. */
    edenMessageData: jsonb('eden_message_data'),
    /** Assistant thinking blocks (array of {type, thinking, signature, …}). */
    thought: jsonb('thought'),
    /** Pairs a role='tool' row with the originating tool call. */
    toolCallId: text('tool_call_id'),
    /** Sender label (multi-agent sessions name the speaking agent). */
    name: text('name'),
    toolCalls: jsonb('tool_calls'),
    attachments: jsonb('attachments'),
    reactions: jsonb('reactions'),
    replyToExternalId: text('reply_to_external_id'),
    /** Provider sequence/update id when supplied; breaks equal-timestamp ties. */
    sourceSequence: bigint('source_sequence', { mode: 'number' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_session_external_uq').on(t.sessionId, t.externalId),
    index('messages_session_created_idx').on(t.sessionId, t.createdAt),
    index('messages_channel_order_idx').on(t.sessionId, t.createdAt, t.sourceSequence, t.id),
  ],
);

// ---------------------------------------------------------------------------
// creations — media artifacts; feed reads the partial index.
// ---------------------------------------------------------------------------
export const creations = pgTable(
  'creations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id'),
    userId: uuid('user_id').references(() => accounts.id),
    agentId: uuid('agent_id').references(() => accounts.id),
    /** Source `task` ref (tasks3 hex id) — tasks are not migrated as a table. */
    taskExternalId: text('task_external_id'),
    tool: text('tool'),
    /** Generation args (TaskV2Args), verbatim. */
    args: jsonb('args'),
    /** Source `attributes` — carries `nsfw_score`, needed for feed moderation. */
    attributes: jsonb('attributes'),
    filename: text('filename'),
    url: text('url'),
    thumbnailUrl: text('thumbnail_url'),
    mediaAttributes: jsonb('media_attributes'),
    likeCount: integer('like_count').notNull().default(0),
    public: boolean('public').notNull().default(false),
    deleted: boolean('deleted').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('creations_external_id_uq')
      .on(t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('creations_feed_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.public} = true and ${t.deleted} = false`),
    // Composite keyset index matching the explore feed's exact ORDER BY
    // (created_at desc, id desc) + cursor predicate. Turns the first page of
    // the 1.78M-row public feed from a ~1.5s parallel-sort into a sub-ms
    // index top-N. Partial to stay small (public, non-deleted only).
    index('creations_feed_keyset_idx')
      .on(t.createdAt.desc(), t.id.desc())
      .where(sql`${t.public} = true and ${t.deleted} = false`),
    index('creations_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('creations_agent_created_idx').on(t.agentId, t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// content_reports — lightweight public/social moderation queue.
// target_id is polymorphic (creation/agent/etc.) so it intentionally does not
// carry a foreign key; reporter/reviewer are normal account references.
// ---------------------------------------------------------------------------
export const contentReports = pgTable(
  'content_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => accounts.id),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    reason: text('reason'),
    status: text('status').notNull().default('open'),
    reviewerId: uuid('reviewer_id').references(() => accounts.id),
    reviewedAt: timestamptz('reviewed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('content_reports_target_idx').on(t.targetType, t.targetId),
    index('content_reports_status_created_idx').on(t.status, t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// likes — per-user v1 social interactions.
// ---------------------------------------------------------------------------
export const creationLikes = pgTable(
  'creation_likes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    creationId: uuid('creation_id')
      .notNull()
      .references(() => creations.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.creationId] }),
    index('creation_likes_creation_idx').on(t.creationId),
  ],
);

export const agentLikes = pgTable(
  'agent_likes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.agentId] }),
    index('agent_likes_agent_idx').on(t.agentId),
  ],
);

// Durable source ownership for legacy social edges. A source document can
// change target over time, so the composite key includes the resolved edge;
// `last_seen_run_id` lets a full source pass retire the prior mapping and
// remove the target relation only when no other legacy source still owns it.
// `target_id` is polymorphic (creation/account) and intentionally has no FK.
export const etlSocialEdges = pgTable(
  'etl_social_edges',
  {
    sourceCollection: text('source_collection').notNull(),
    sourceExternalId: text('source_external_id').notNull(),
    edgeKind: text('edge_kind').$type<'creation_like' | 'agent_like'>().notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id').notNull(),
    lastSeenRunId: uuid('last_seen_run_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.sourceCollection,
        t.sourceExternalId,
        t.edgeKind,
        t.userId,
        t.targetId,
      ],
    }),
    index('etl_social_edges_source_run_idx').on(
      t.sourceCollection,
      t.lastSeenRunId,
    ),
    index('etl_social_edges_target_idx').on(t.edgeKind, t.userId, t.targetId),
  ],
);

// ---------------------------------------------------------------------------
// collections + members
// ---------------------------------------------------------------------------
export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id'),
    userId: uuid('user_id').references(() => accounts.id),
    name: text('name'),
    description: text('description'),
    /** Source `coverCreation` ref (creations3 hex id) — plain string, no FK. */
    coverCreationExternalId: text('cover_creation_external_id'),
    /** Source `contributors` (users3 refs) as an array of account external ids. */
    contributors: jsonb('contributors'),
    public: boolean('public').notNull().default(false),
    deleted: boolean('deleted').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('collections_external_id_uq')
      .on(t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
);

export const collectionCreations = pgTable(
  'collection_creations',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id),
    creationId: uuid('creation_id')
      .notNull()
      .references(() => creations.id),
    position: integer('position'),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.creationId] })],
);

// ---------------------------------------------------------------------------
// concepts + concept_images — per-agent reference-image aesthetics (the
// eden1 "concepts" successor). A concept is an owner-curated named style:
// name/description/instructions plus up to 8 reference images. Rows are
// projected into the agent's OpenClaw workspace (concepts/<slug>/) so the
// runtime can pass the reference files to image tools. Soft-deleted rows
// release their slug via the partial unique index.
// ---------------------------------------------------------------------------
export const concepts = pgTable(
  'concepts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Kebab-case, unique per agent among non-deleted rows; doubles as the workspace dir name. */
    slug: text('slug').notNull(),
    description: text('description'),
    /** Optional "how to use these references" note, rendered into CONCEPT.md. */
    instructions: text('instructions'),
    deleted: boolean('deleted').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('concepts_agent_slug_uq')
      .on(t.agentId, t.slug)
      .where(sql`${t.deleted} = false`),
    index('concepts_agent_created_idx').on(t.agentId, t.createdAt.desc()),
  ],
);

export const conceptImages = pgTable(
  'concept_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conceptId: uuid('concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    /** Servable URL (`<MEDIA_BASE_URL>/<sha256><ext>`) from the media store. */
    url: text('url').notNull(),
    /** Absolute path of the content-addressed file — workspace projection copies from here. */
    localPath: text('local_path'),
    /** Content address (media store sha256). NOT unique: two concepts may share a file. */
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** Original upload filename (display only). */
    filename: text('filename'),
    position: integer('position').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('concept_images_concept_position_idx').on(t.conceptId, t.position)],
);

// ---------------------------------------------------------------------------
// manna — balances + append-only ledger.
// ---------------------------------------------------------------------------
export const mannaAccounts = pgTable('manna_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalId: text('external_id'),
  accountId: uuid('account_id')
    .notNull()
    .unique()
    .references(() => accounts.id),
  balance: numeric('balance', { precision: 20, scale: 4 }).notNull().default('0'),
  subscriptionBalance: numeric('subscription_balance', { precision: 20, scale: 4 })
    .notNull()
    .default('0'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const mannaTransactions = pgTable(
  'manna_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id'),
    mannaAccountId: uuid('manna_account_id')
      .notNull()
      .references(() => mannaAccounts.id),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    /**
     * Transaction type (spend/refund/credit_stripe/…). Nullable on purpose:
     * ~57% of migrated v1-era ledger rows predate the field and carry no type
     * in the source — that absence is preserved as NULL, never coerced to a
     * sentinel. The eden3 spend path always writes an explicit type.
     */
    type: text('type'),
    taskExternalId: text('task_external_id'),
    /** Stripe webhook provenance (credit_stripe rows) — audit/reconciliation. */
    stripeEventId: text('stripe_event_id'),
    stripeEventType: text('stripe_event_type'),
    stripeEventData: jsonb('stripe_event_data'),
    /** Source `voucher` ref (mannavouchers hex id) — plain string, no FK. */
    voucherExternalId: text('voucher_external_id'),
    /** Voucher redemption code (credit_voucher rows). */
    code: text('code'),
    idempotencyKey: text('idempotency_key').unique(),
    refundsTransactionId: uuid('refunds_transaction_id').references(
      (): AnyPgColumn => mannaTransactions.id,
    ),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('manna_transactions_external_id_uq')
      .on(t.externalId)
      .where(sql`${t.externalId} is not null`),
    // Mirrors the mongo sparse unique index — one ledger row per stripe event.
    uniqueIndex('manna_transactions_stripe_event_uq')
      .on(t.stripeEventId, t.stripeEventType)
      .where(sql`${t.stripeEventId} is not null`),
    index('manna_transactions_account_created_idx').on(t.mannaAccountId, t.createdAt.desc()),
    // Refund-correlation index behind netSpendSince's lateral (the per-turn
    // daily/rolling-cap computation): without it every spend row seq-scans the
    // whole ledger (5.6s/query at 1.14M rows → 10s+ pre-stream latency).
    // Name deliberately breaks the local `<table>_*_idx` convention: it must
    // match the index created live on the prod box on 2026-08-05 (RUNBOOK §12
    // "Missing ledger index"), so migration 0027's exists-guard recognizes it
    // instead of forcing a drop/recreate on a live database. (T08-U01)
    index('idx_manna_tx_refunds_tx')
      .on(t.refundsTransactionId)
      .where(sql`${t.refundsTransactionId} is not null`),
  ],
);

/**
 * Turn economic authorizations — the durable state machine behind the
 * worst-case-reserve kernel (MVP gap 42, T08-U02). One row per metered LLM
 * turn, inserted in the SAME transaction as the reservation debit, before any
 * provider call or emitted byte. Money truth lives in `state`:
 *
 *   reserved  -> the worst-case reservation is committed; the provider may run.
 *   settled   -> actual cost (<= authorized max) charged, unused refunded, and
 *                the assistant/usage rows persisted — one transaction.
 *   reversed  -> the turn failed; the reservation was fully reversed.
 *   reaped    -> the compensation reaper reversed an orphaned reservation
 *                (process died between reserve and terminal persistence).
 *
 * The reaper acts ONLY on `state='reserved'` + age; it never infers from
 * usage-event rows (a swallowed telemetry insert must not move money).
 */
export const turnAuthorizations = pgTable(
  'turn_authorizations',
  {
    /** The turn uuid — also the reservation debit's idempotency key. */
    turnId: uuid('turn_id').primaryKey(),
    /** Paying user account (`accounts.id`). */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    agentAccountId: uuid('agent_account_id').references(() => accounts.id),
    sessionId: uuid('session_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    pricingBasis: text('pricing_basis').notNull(),
    /** Ceiling-table version the max was computed from. */
    ceilingTableVersion: text('ceiling_table_version').notNull(),
    /** Worst-case manna reserved up front — settle may never exceed it. */
    authorizedMaxManna: numeric('authorized_max_manna', { precision: 20, scale: 4 }).notNull(),
    /** Exact share of the reservation drawn from the subscription pot. */
    reservedSubscriptionManna: numeric('reserved_subscription_manna', {
      precision: 20,
      scale: 4,
    }).notNull(),
    /** The reservation's `manna_transactions` row. */
    reservationTxId: uuid('reservation_tx_id')
      .notNull()
      .references(() => mannaTransactions.id),
    state: text('state', { enum: ['reserved', 'settled', 'reversed', 'reaped'] }).notNull(),
    /** Actual charge at settlement (null until settled). */
    chargedManna: numeric('charged_manna', { precision: 20, scale: 4 }),
    /** True when metered actual exceeded the ceiling (clamped; platform ate it). */
    overrun: boolean('overrun').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // The reaper's scan: old rows still in 'reserved'.
    index('turn_authorizations_state_created_idx').on(t.state, t.createdAt),
    // One authorization per reservation debit — a ledger row can never fund
    // two authorizations (checkpoint-#2).
    uniqueIndex('turn_authorizations_reservation_tx_uq').on(t.reservationTxId),
    // The database enforces the money state machine's arithmetic, not just
    // the application: valid state, positive max, split within the max,
    // charge within the max (settle ≤ authorized-max at the DDL level).
    check(
      'turn_authorizations_state_chk',
      sql`${t.state} in ('reserved','settled','reversed','reaped')`,
    ),
    check('turn_authorizations_max_positive_chk', sql`${t.authorizedMaxManna} > 0`),
    check(
      'turn_authorizations_split_within_max_chk',
      sql`${t.reservedSubscriptionManna} >= 0 and ${t.reservedSubscriptionManna} <= ${t.authorizedMaxManna}`,
    ),
    check(
      'turn_authorizations_charge_within_max_chk',
      sql`${t.chargedManna} is null or (${t.chargedManna} >= 0 and ${t.chargedManna} <= ${t.authorizedMaxManna})`,
    ),
  ],
);

/**
 * One-shot provider handoff + durable usable-output checkpoint for a turn.
 * Inserting this 1:1 row is the exclusive provider-start transition. The
 * first non-whitespace output timestamp is monotonic and drives the
 * full-reserve-v1 crash/error settlement rule.
 */
export const turnProviderRuns = pgTable(
  'turn_provider_runs',
  {
    turnId: uuid('turn_id')
      .primaryKey()
      .references(() => turnAuthorizations.turnId, { onDelete: 'cascade' }),
    providerStartedAt: timestamptz('provider_started_at').notNull().defaultNow(),
    usableOutputAt: timestamptz('usable_output_at'),
  },
  (t) => [
    check(
      'turn_provider_runs_output_after_start_chk',
      sql`${t.usableOutputAt} is null or ${t.usableOutputAt} >= ${t.providerStartedAt}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// billing — Stripe subscription state + Eden voucher inventory.
// ---------------------------------------------------------------------------
export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
    status: text('status').notNull(),
    tier: text('tier'),
    monthlyManna: integer('monthly_manna').notNull().default(0),
    currentPeriodEnd: timestamptz('current_period_end'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    // Stripe `event.created` of the newest event applied to this row — the
    // upsert refuses to let a late-delivered older event (e.g. an `updated`
    // arriving after `deleted`) overwrite newer state.
    lastStripeEventAt: timestamptz('last_stripe_event_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('billing_subscriptions_account_idx').on(t.accountId),
    index('billing_subscriptions_customer_idx').on(t.stripeCustomerId),
  ],
);

export const stripeCheckoutIntents = pgTable(
  'stripe_checkout_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    kind: text('kind').$type<'manna_topup' | 'subscription'>().notNull(),
    state: text('state').$type<'preparing' | 'provider_started' | 'created' | 'failed'>()
      .notNull().default('preparing'),
    requestKeySha256: text('request_key_sha256').notNull().unique(),
    stripeSessionId: text('stripe_session_id').unique(),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('stripe_checkout_intents_account_state_idx').on(t.accountId, t.state),
    check('stripe_checkout_intents_kind_chk', sql`${t.kind} in ('manna_topup','subscription')`),
    check('stripe_checkout_intents_state_chk', sql`${t.state} in ('preparing','provider_started','created','failed')`),
    check('stripe_checkout_intents_request_hash_chk', sql`${t.requestKeySha256} ~ '^[0-9a-f]{64}$'`),
    check('stripe_checkout_intents_session_chk', sql`${t.stripeSessionId} is null or ${t.stripeSessionId} ~ '^cs_[A-Za-z0-9_]{3,252}$'`),
    check('stripe_checkout_intents_error_chk', sql`${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z0-9_]{1,100}$'`),
    check('stripe_checkout_intents_shape_chk', sql`(${t.state} in ('preparing','provider_started') and ${t.stripeSessionId} is null and ${t.lastErrorCode} is null) or (${t.state}='created' and ${t.stripeSessionId} is not null and ${t.lastErrorCode} is null) or (${t.state}='failed' and ${t.stripeSessionId} is null and ${t.lastErrorCode} is not null)`) ,
  ],
);

export const mannaVouchers = pgTable(
  'manna_vouchers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: citext('code').notNull().unique(),
    amount: integer('amount').notNull(),
    maxRedemptions: integer('max_redemptions').notNull().default(1),
    redeemedCount: integer('redeemed_count').notNull().default(0),
    expiresAt: timestamptz('expires_at'),
    disabled: boolean('disabled').notNull().default(false),
    metadata: jsonb('metadata'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('manna_vouchers_expires_idx').on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// channel_connections + secret_access_audit_events — user token custody.
// ---------------------------------------------------------------------------
export const channelConnections = pgTable(
  'channel_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    agentId: uuid('agent_id').references(() => accounts.id),
    channel: text('channel').notNull(),
    label: text('label'),
    /** Stable named-account key used by OpenClaw routing bindings. */
    runtimeAccountId: text('runtime_account_id'),
    desiredState: text('desired_state')
      .$type<'inactive' | 'active'>()
      .notNull()
      .default('inactive'),
    observedState: text('observed_state')
      .$type<'unknown' | 'validating' | 'verified' | 'starting' | 'live' | 'stopping' | 'stopped' | 'error'>()
      .notNull()
      .default('unknown'),
    status: text('status').notNull().default('connected'),
    tokenCiphertext: text('token_ciphertext').notNull(),
    tokenIv: text('token_iv').notNull(),
    tokenAuthTag: text('token_auth_tag').notNull(),
    tokenSha256: text('token_sha256').notNull(),
    keyVersion: text('key_version').notNull().default('v1'),
    /** Monotonic credential generation encoded as cN in hosted SecretRefs. */
    capabilityEpoch: integer('capability_epoch').notNull().default(1),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    lastValidatedAt: timestamptz('last_validated_at'),
    retryCount: integer('retry_count').notNull().default(0),
    nextRetryAt: timestamptz('next_retry_at'),
    activatedAt: timestamptz('activated_at'),
    metadata: jsonb('metadata'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('channel_connections_account_idx').on(t.accountId),
    index('channel_connections_agent_idx').on(t.agentId),
    check(
      'channel_connections_capability_epoch_chk',
      sql`${t.capabilityEpoch} between 1 and 999999`,
    ),
    uniqueIndex('channel_connections_runtime_account_uq')
      .on(t.channel, t.runtimeAccountId)
      .where(sql`${t.runtimeAccountId} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// channel_onboarding_intents — short-lived, hashed-only state for the managed
// Telegram bot handoff. Provider ids and intent secrets are never persisted in
// raw form. Migration 0031 owns the state/connection binding trigger.
// ---------------------------------------------------------------------------
export const channelOnboardingIntents = pgTable(
  'channel_onboarding_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull().default('telegram'),
    intentSecretHash: text('intent_secret_hash').notNull(),
    providerOwnerIdHash: text('provider_owner_id_hash'),
    suggestedBotUsername: text('suggested_bot_username'),
    state: text('state', {
      enum: ['pending_owner', 'awaiting_bot', 'exchanging', 'stored', 'expired', 'failed'],
    })
      .notNull()
      .default('pending_owner'),
    expiresAt: timestamptz('expires_at').notNull(),
    connectionId: uuid('connection_id').references(() => channelConnections.id, {
      onDelete: 'set null',
    }),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_onboarding_intents_secret_uq').on(t.intentSecretHash),
    uniqueIndex('channel_onboarding_intents_active_account_uq')
      .on(t.accountId, t.channel)
      .where(sql`${t.state} in ('pending_owner', 'awaiting_bot', 'exchanging')`),
    uniqueIndex('channel_onboarding_intents_active_owner_uq')
      .on(t.channel, t.providerOwnerIdHash)
      .where(
        sql`${t.providerOwnerIdHash} is not null and ${t.state} in ('awaiting_bot', 'exchanging')`,
      ),
    index('channel_onboarding_intents_active_expiry_idx')
      .on(t.state, t.expiresAt)
      .where(sql`${t.state} in ('pending_owner', 'awaiting_bot', 'exchanging')`),
    index('channel_onboarding_intents_connection_idx')
      .on(t.connectionId)
      .where(sql`${t.connectionId} is not null`),
    check('channel_onboarding_intents_channel_check', sql`${t.channel} = 'telegram'`),
    check(
      'channel_onboarding_intents_state_check',
      sql`${t.state} in ('pending_owner', 'awaiting_bot', 'exchanging', 'stored', 'expired', 'failed')`,
    ),
    check(
      'channel_onboarding_intents_intent_hash_check',
      sql`${t.intentSecretHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'channel_onboarding_intents_owner_hash_check',
      sql`${t.providerOwnerIdHash} is null or ${t.providerOwnerIdHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'channel_onboarding_intents_expiry_check',
      sql`${t.expiresAt} > ${t.createdAt}`,
    ),
    check(
      'channel_onboarding_intents_username_check',
      sql`${t.suggestedBotUsername} is null or char_length(${t.suggestedBotUsername}) <= 32`,
    ),
    check(
      'channel_onboarding_intents_error_code_check',
      sql`${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z0-9_:-]{1,64}$'`,
    ),
    check(
      'channel_onboarding_intents_owner_state_check',
      sql`(${t.state} = 'pending_owner' and ${t.providerOwnerIdHash} is null) or (${t.state} in ('awaiting_bot', 'exchanging', 'stored') and ${t.providerOwnerIdHash} is not null) or ${t.state} in ('expired', 'failed')`,
    ),
    check(
      'channel_onboarding_intents_connection_state_check',
      sql`${t.connectionId} is null or ${t.state} = 'stored'`,
    ),
  ],
);

/**
 * External identities are connection-scoped: the same provider peer talking
 * to two Eden bots is deliberately two principals. Raw peer ids are encrypted;
 * joins and isolation use only the deterministic connection-scoped digest.
 */
export const channelExternalIdentities = pgTable(
  'channel_external_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => channelConnections.id, { onDelete: 'cascade' }),
    peerFingerprint: text('peer_fingerprint').notNull(),
    peerCiphertext: text('peer_ciphertext').notNull(),
    peerIv: text('peer_iv').notNull(),
    peerAuthTag: text('peer_auth_tag').notNull(),
    peerPreview: text('peer_preview'),
    keyVersion: text('key_version').notNull().default('v1'),
    linkedAccountId: uuid('linked_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_external_identities_peer_uq').on(
      t.connectionId,
      t.peerFingerprint,
    ),
    index('channel_external_identities_linked_account_idx').on(t.linkedAccountId),
  ],
);

export const channelPairingRequests = pgTable(
  'channel_pairing_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => channelConnections.id, { onDelete: 'cascade' }),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => channelExternalIdentities.id, { onDelete: 'cascade' }),
    status: text('status')
      .$type<'pending' | 'approved' | 'denied' | 'expired'>()
      .notNull()
      .default('pending'),
    requestedAt: timestamptz('requested_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    decidedAt: timestamptz('decided_at'),
    decidedByAccountId: uuid('decided_by_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('channel_pairing_requests_connection_status_idx').on(
      t.connectionId,
      t.status,
      t.requestedAt.desc(),
    ),
    uniqueIndex('channel_pairing_requests_pending_uq')
      .on(t.connectionId, t.identityId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/** Durable idempotency/state record for channel-originated manna settlement. */
export const channelTurns = pgTable(
  'channel_turns',
  {
    turnId: uuid('turn_id').primaryKey(),
    connectionId: uuid('connection_id').references(() => channelConnections.id, {
      onDelete: 'set null',
    }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id').references(() => accounts.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    externalMessageId: text('external_message_id'),
    status: text('status')
      .$type<
        | 'reserving'
        | 'reserved'
        | 'settling'
        | 'refunding'
        | 'settled'
        | 'delivery_pending'
        | 'delivered'
        | 'refunded'
        | 'error'
      >()
      .notNull()
      .default('reserved'),
    /** Immutable billing/routing provenance captured before provider work. */
    channel: text('channel'),
    runtimeAccountId: text('runtime_account_id'),
    model: text('model'),
    agentRuntime: text('agent_runtime'),
    pricingBasis: text('pricing_basis'),
    /**
     * Whether immutable execution provenance was frozen before work or
     * recovered from a matching terminal usage event. Any other value is
     * deliberately non-billable and may only pass through the refund path.
     */
    provenanceStatus: text('provenance_status')
      .$type<
        | 'unknown'
        | 'frozen'
        | 'recovered_usage_event'
        | 'legacy_terminal_unknown'
        | 'legacy_refund_pending'
      >()
      .notNull()
      .default('unknown'),
    reservedManna: integer('reserved_manna').notNull(),
    meteredManna: integer('metered_manna'),
    errorCode: text('error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
  },
  (t) => [
    index('channel_turns_connection_created_idx').on(t.connectionId, t.createdAt.desc()),
    index('channel_turns_open_updated_idx')
      .on(t.status, t.updatedAt)
      .where(
        sql`${t.status} in ('reserving', 'reserved', 'settling', 'delivery_pending', 'refunding', 'error')`,
      ),
    uniqueIndex('channel_turns_external_message_uq')
      .on(t.connectionId, t.externalMessageId)
      .where(sql`${t.connectionId} is not null and ${t.externalMessageId} is not null`),
  ],
);

export const channelOutboundPostIntents = pgTable(
  'channel_outbound_post_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    connectionId: uuid('connection_id').notNull().references(() => channelConnections.id),
    state: text('state').$type<'preparing' | 'provider_started' | 'succeeded' | 'failed'>()
      .notNull().default('preparing'),
    providerPostId: text('provider_post_id'),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('channel_outbound_post_intents_account_state_idx').on(t.accountId, t.state),
    index('channel_outbound_post_intents_connection_idx').on(t.connectionId),
    check('channel_outbound_post_intents_state_chk', sql`${t.state} in ('preparing','provider_started','succeeded','failed')`),
    check('channel_outbound_post_intents_post_id_chk', sql`${t.providerPostId} is null or ${t.providerPostId} ~ '^[A-Za-z0-9_:-]{1,255}$'`),
    check('channel_outbound_post_intents_error_chk', sql`${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z0-9_]{1,100}$'`),
    check('channel_outbound_post_intents_shape_chk', sql`(${t.state} in ('preparing','provider_started') and ${t.providerPostId} is null and ${t.lastErrorCode} is null) or (${t.state}='succeeded' and ${t.providerPostId} is not null and ${t.lastErrorCode} is null) or (${t.state}='failed' and ${t.providerPostId} is null and ${t.lastErrorCode} is not null)`),
  ],
);

export const secretAccessAuditEvents = pgTable(
  'secret_access_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorAccountId: uuid('actor_account_id').references(() => accounts.id),
    ownerAccountId: uuid('owner_account_id').references(() => accounts.id),
    secretKind: text('secret_kind').notNull(),
    secretId: uuid('secret_id').notNull(),
    action: text('action').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('secret_access_audit_owner_idx').on(t.ownerAccountId, t.createdAt.desc()),
    index('secret_access_audit_secret_idx').on(t.secretKind, t.secretId),
  ],
);

// ---------------------------------------------------------------------------
// skills — OpenClaw skill definitions and per-agent allowlists.
// ---------------------------------------------------------------------------
export const skillDefinitions = pgTable(
  'skill_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    body: text('body').notNull(),
    source: text('source').$type<'curated' | 'user'>().notNull().default('user'),
    status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
    ownerId: uuid('owner_id').references(() => accounts.id, { onDelete: 'set null' }),
    reviewerId: uuid('reviewer_id').references(() => accounts.id, { onDelete: 'set null' }),
    reviewedAt: timestamptz('reviewed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('skill_definitions_status_idx').on(t.status),
    index('skill_definitions_owner_idx').on(t.ownerId),
  ],
);

export const agentSkills = pgTable(
  'agent_skills',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skillDefinitions.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.skillId] }),
    index('agent_skills_skill_idx').on(t.skillId),
  ],
);

// ---------------------------------------------------------------------------
// distill_state — background MEMORY.md distillation status per OpenClaw agent.
// ---------------------------------------------------------------------------
export const distillState = pgTable(
  'distill_state',
  {
    openclawId: text('openclaw_id').primaryKey(),
    agentAccountId: uuid('agent_account_id').references(() => accounts.id, { onDelete: 'set null' }),
    username: citext('username').notNull(),
    status: text('status')
      .$type<'pending' | 'running' | 'done' | 'skipped' | 'error'>()
      .notNull()
      .default('pending'),
    sessionsSampled: integer('sessions_sampled').notNull().default(0),
    messagesSampled: integer('messages_sampled').notNull().default(0),
    mapChunks: integer('map_chunks'),
    memoryChars: integer('memory_chars'),
    model: text('model'),
    error: text('error'),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('distill_state_agent_idx').on(t.agentAccountId),
    index('distill_state_status_idx').on(t.status, t.updatedAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// usage_events — per-turn/generation metering and observability.
// ---------------------------------------------------------------------------
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    status: text('status').notNull(),
    userId: uuid('user_id').references(() => accounts.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id').references(() => accounts.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    turnId: uuid('turn_id'),
    provider: text('provider'),
    model: text('model'),
    /** Real provider invoice cost vs API-equivalent subscription notional pricing. */
    pricingBasis: text('pricing_basis')
      .$type<'provider-api' | 'notional-subscription'>()
      .notNull()
      .default('provider-api'),
    tableVersion: text('table_version'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    cachedTokens: integer('cached_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    totalTokens: integer('total_tokens'),
    costUsd: numeric('cost_usd', { precision: 20, scale: 8 }),
    manna: integer('manna'),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    metadata: jsonb('metadata'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('usage_events_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('usage_events_agent_created_idx').on(t.agentId, t.createdAt.desc()),
    index('usage_events_session_created_idx').on(t.sessionId, t.createdAt.desc()),
    index('usage_events_turn_idx').on(t.turnId),
    // Unique per (event_type, turn) — chat sets turnId, studio rows are null
    // and exempt. A crashed/retried turn pipeline cannot double-record: the
    // insert pairs with ON CONFLICT DO NOTHING against this index.
    uniqueIndex('usage_events_turn_unique')
      .on(t.eventType, t.turnId)
      .where(sql`turn_id is not null`),
  ],
);

// ---------------------------------------------------------------------------
// Private, resumable speech-to-text custody. Audio bytes live only under the
// non-public TRANSCRIPTION_AUDIO_DIR; these rows contain checkpoints and safe
// relative locators, never CDN/media URLs or provider credentials.
// ---------------------------------------------------------------------------
export const transcriptionSessions = pgTable(
  'transcription_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    createIdempotencyKey: uuid('create_idempotency_key').notNull(),
    finalizeIdempotencyKey: uuid('finalize_idempotency_key'),
    status: text('status')
      .$type<'uploading' | 'reserving' | 'queued' | 'processing' | 'completed' | 'failed' | 'deleted' | 'expired'>()
      .notNull()
      .default('uploading'),
    language: text('language').notNull().default('en'),
    encoding: text('encoding').notNull().default('pcm_s16le'),
    sampleRateHz: integer('sample_rate_hz').notNull().default(16_000),
    channels: integer('channels').notNull().default(1),
    acknowledgedThrough: integer('acknowledged_through').notNull().default(-1),
    nextChunkNumber: integer('next_chunk_number').notNull().default(0),
    receivedBytes: bigint('received_bytes', { mode: 'number' }).notNull().default(0),
    receivedDurationMs: bigint('received_duration_ms', { mode: 'number' }).notNull().default(0),
    maxDurationMs: integer('max_duration_ms').notNull().default(600_000),
    finalChunkNumber: integer('final_chunk_number'),
    provider: text('provider'),
    providerModel: text('provider_model'),
    providerRequestId: text('provider_request_id'),
    providerStartedAt: timestamptz('provider_started_at'),
    providerCompletedAt: timestamptz('provider_completed_at'),
    transcript: text('transcript'),
    errorCode: text('error_code'),
    quotedCostUsd: numeric('quoted_cost_usd', { precision: 20, scale: 8 }),
    quotedManna: integer('quoted_manna'),
    tableVersion: text('table_version'),
    reservationTransactionId: uuid('reservation_transaction_id').references(
      () => mannaTransactions.id,
      { onDelete: 'set null' },
    ),
    usageEventId: uuid('usage_event_id').references(() => usageEvents.id, { onDelete: 'set null' }),
    claimToken: uuid('claim_token'),
    claimExpiresAt: timestamptz('claim_expires_at'),
    deleteRequestedAt: timestamptz('delete_requested_at'),
    audioDeletedAt: timestamptz('audio_deleted_at'),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
  },
  (t) => [
    uniqueIndex('transcription_sessions_owner_create_key_uq').on(
      t.ownerAccountId,
      t.createIdempotencyKey,
    ),
    index('transcription_sessions_owner_created_idx').on(t.ownerAccountId, t.createdAt.desc()),
    index('transcription_sessions_worker_idx').on(t.status, t.claimExpiresAt, t.createdAt),
    index('transcription_sessions_expiry_idx').on(t.expiresAt),
    check(
      'transcription_sessions_status_check',
      sql`${t.status} in ('uploading','reserving','queued','processing','completed','failed','deleted','expired')`,
    ),
    check(
      'transcription_sessions_format_check',
      sql`${t.language}='en' and ${t.encoding}='pcm_s16le' and ${t.sampleRateHz}=16000 and ${t.channels}=1`,
    ),
    check(
      'transcription_sessions_duration_check',
      sql`${t.maxDurationMs} between 1000 and 600000 and ${t.receivedDurationMs} between 0 and ${t.maxDurationMs} and ${t.receivedBytes}=${t.receivedDurationMs}*32`,
    ),
    check(
      'transcription_sessions_checkpoint_check',
      sql`${t.acknowledgedThrough}=${t.nextChunkNumber}-1 and ${t.nextChunkNumber}>=0 and (${t.finalChunkNumber} is null or ${t.finalChunkNumber}=${t.acknowledgedThrough})`,
    ),
    check(
      'transcription_sessions_claim_check',
      sql`(${t.claimToken} is null and ${t.claimExpiresAt} is null) or (${t.status}='processing' and ${t.claimToken} is not null and ${t.claimExpiresAt} is not null)`,
    ),
    check(
      'transcription_sessions_quote_check',
      sql`(${t.quotedManna} is null and ${t.quotedCostUsd} is null and ${t.tableVersion} is null and ${t.reservationTransactionId} is null and ${t.usageEventId} is null) or (${t.quotedManna}>0 and ${t.quotedCostUsd}>0 and ${t.tableVersion} is not null and ${t.reservationTransactionId} is not null and ${t.usageEventId} is not null)`,
    ),
  ],
);

export const transcriptionChunks = pgTable(
  'transcription_chunks',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => transcriptionSessions.id, { onDelete: 'cascade' }),
    chunkNumber: integer('chunk_number').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    durationMs: integer('duration_ms').notNull(),
    sha256: text('sha256').notNull(),
    relativePath: text('relative_path').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.chunkNumber] }),
    uniqueIndex('transcription_chunks_path_uq').on(t.relativePath),
    check('transcription_chunks_number_check', sql`${t.chunkNumber}>=0`),
    check(
      'transcription_chunks_size_check',
      sql`${t.sizeBytes} between 320 and 320000 and ${t.sizeBytes}%320=0 and ${t.durationMs}=${t.sizeBytes}/32`,
    ),
    check('transcription_chunks_sha_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'transcription_chunks_path_check',
      sql`${t.relativePath} ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9]+-[0-9a-f-]{36}[.]pcm$'`,
    ),
  ],
);

// Cross-process lease for subscription-backed Claude turns. Transcript usage
// is timestamp-window based, so two concurrent turns in one gateway session
// would otherwise both claim the same provider messages. The API heartbeats a
// lease and releases it after settlement; a crashed owner becomes reclaimable
// only after lease_expires_at.
export const claudeSessionTurnClaims = pgTable(
  'claude_session_turn_claims',
  {
    sessionKey: text('session_key').primaryKey(),
    turnId: uuid('turn_id').notNull().unique(),
    claimedAt: timestamptz('claimed_at').notNull().defaultNow(),
    leaseExpiresAt: timestamptz('lease_expires_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('claude_session_turn_claims_expiry_idx').on(t.leaseExpiresAt)],
);

// ---------------------------------------------------------------------------
// Eden-managed OpenClaw memory lifecycle — provenance, active-only sweeps,
// per-agent dream runs, and privacy-preserving retrieval measurements.
// ---------------------------------------------------------------------------
export const memoryRevisions = pgTable(
  'memory_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentAccountId: uuid('agent_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    openclawId: text('openclaw_id').notNull(),
    actorAccountId: uuid('actor_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    operation: text('operation')
      .$type<'automatic-seed' | 'manual-reseed' | 'owner-correction' | 'dream-promotion'>()
      .notNull(),
    previousSha256: text('previous_sha256'),
    sha256: text('sha256').notNull(),
    chars: integer('chars').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('memory_revisions_agent_created_idx').on(t.agentAccountId, t.createdAt.desc()),
    index('memory_revisions_openclaw_created_idx').on(t.openclawId, t.createdAt.desc()),
  ],
);

export const memoryDreamSweeps = pgTable(
  'memory_dream_sweeps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sweepKey: text('sweep_key').notNull().unique(),
    windowStart: timestamptz('window_start').notNull(),
    status: text('status')
      .$type<'running' | 'done' | 'partial' | 'error'>()
      .notNull()
      .default('running'),
    eligibleCount: integer('eligible_count').notNull().default(0),
    activeCount: integer('active_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    succeededCount: integer('succeeded_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    skippedAgents: jsonb('skipped_agents').notNull().default(sql`'[]'::jsonb`),
    error: text('error'),
    /** Fencing token for the current coordinator lease (null once terminal). */
    claimToken: uuid('claim_token'),
    /** Heartbeated coordinator lease; only an expired token may be replaced. */
    leaseExpiresAt: timestamptz('lease_expires_at'),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
    durationMs: integer('duration_ms'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('memory_dream_sweeps_window_idx').on(t.windowStart.desc()),
    index('memory_dream_sweeps_lease_idx').on(t.leaseExpiresAt),
  ],
);

export const memoryDreamRuns = pgTable(
  'memory_dream_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sweepId: uuid('sweep_id')
      .notNull()
      .references(() => memoryDreamSweeps.id, { onDelete: 'cascade' }),
    agentAccountId: uuid('agent_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    openclawId: text('openclaw_id').notNull(),
    status: text('status')
      .$type<'running' | 'done' | 'skipped' | 'error' | 'recovery_pending'>()
      .notNull()
      .default('running'),
    lastActivityAt: timestamptz('last_activity_at'),
    agentRuntime: text('agent_runtime'),
    pricingBasis: text('pricing_basis'),
    deepCandidates: integer('deep_candidates'),
    promotedCount: integer('promoted_count'),
    usageEventId: uuid('usage_event_id').references(() => usageEvents.id, {
      onDelete: 'set null',
    }),
    previousSha256: text('previous_sha256'),
    sha256: text('sha256'),
    provenance: jsonb('provenance'),
    error: text('error'),
    /** Fencing token for the process currently executing this run. */
    claimToken: uuid('claim_token'),
    /** Heartbeated run lease; deliberately longer than the provider ceiling. */
    leaseExpiresAt: timestamptz('lease_expires_at'),
    /** Durable checkpoint written before the metered provider handoff. */
    providerStatus: text('provider_status')
      .$type<'not_started' | 'started' | 'terminal' | 'indeterminate'>()
      .notNull()
      .default('not_started'),
    providerStartedAt: timestamptz('provider_started_at'),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
    durationMs: integer('duration_ms'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memory_dream_runs_sweep_agent_uq').on(t.sweepId, t.agentAccountId),
    uniqueIndex('memory_dream_runs_live_agent_uq')
      .on(t.agentAccountId)
      .where(sql`${t.status} in ('running', 'recovery_pending')`),
    index('memory_dream_runs_agent_created_idx').on(t.agentAccountId, t.createdAt.desc()),
    index('memory_dream_runs_lease_idx').on(t.leaseExpiresAt),
  ],
);

export const memoryRetrievalProbes = pgTable(
  'memory_retrieval_probes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentAccountId: uuid('agent_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    openclawId: text('openclaw_id').notNull(),
    /** Hash only: probe text can itself contain private user details. */
    querySha256: text('query_sha256').notNull(),
    status: text('status').$type<'done' | 'error'>().notNull(),
    latencyMs: integer('latency_ms').notNull(),
    resultCount: integer('result_count').notNull().default(0),
    topScore: numeric('top_score', { precision: 8, scale: 6 }),
    error: text('error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('memory_retrieval_probes_agent_created_idx').on(t.agentAccountId, t.createdAt.desc())],
);

// ---------------------------------------------------------------------------
// triggers — scheduled prompts, synced to OpenClaw cron jobs.
// ---------------------------------------------------------------------------
export const triggers = pgTable(
  'triggers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id'),
    userId: uuid('user_id').references(() => accounts.id),
    agentId: uuid('agent_id').references(() => accounts.id),
    name: text('name'),
    prompt: text('prompt'),
    schedule: jsonb('schedule'),
    status: text('status'),
    /** Source `session` ref (sessions hex id) — plain string, no FK. */
    sessionExternalId: text('session_external_id'),
    /** How the run session is resolved: 'new' | 'discord_dm' | 'existing'. */
    sessionTarget: text('session_target'),
    lastRunTime: timestamptz('last_run_time'),
    nextScheduledRun: timestamptz('next_scheduled_run'),
    /**
     * Durable execution identity from active->running claim until every
     * possible debit is terminally settled/refunded. Scheduler recovery uses
     * this even if the normal due instant is old or moved.
     */
    pendingOccurrenceId: uuid('pending_occurrence_id'),
    pendingOccurrenceKind: text('pending_occurrence_kind').$type<'manual' | 'scheduled'>(),
    pendingOccurrenceAt: timestamptz('pending_occurrence_at'),
    /**
     * Per-claim generation fence. Reclaiming the same occurrence always gets a
     * new UUID, so a stale process cannot debit or finalize after quarantine.
     */
    pendingOccurrenceClaimId: uuid('pending_occurrence_claim_id'),
    errorCount: integer('error_count'),
    lastError: text('last_error'),
    openclawJobId: text('openclaw_job_id'),
    lastSyncedAt: timestamptz('last_synced_at'),
    deleted: boolean('deleted').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('triggers_external_id_uq')
      .on(t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('triggers_pending_occurrence_idx')
      .on(t.pendingOccurrenceId, t.updatedAt)
      .where(sql`${t.pendingOccurrenceId} is not null`),
    check(
      'triggers_pending_occurrence_claim_shape_check',
      sql`${t.pendingOccurrenceId} is not null or ${t.pendingOccurrenceClaimId} is null`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// media_assets — sha256 ledger of files picked up from the gateway data dir.
// Correlation ids (session/message/creation) are plain uuids on purpose: the
// watcher writes them as it correlates, possibly before/without FK targets.
// ---------------------------------------------------------------------------
export const mediaAssets = pgTable('media_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourcePath: text('source_path'),
  localPath: text('local_path'),
  url: text('url'),
  sha256: text('sha256').unique(),
  mime: text('mime'),
  width: integer('width'),
  height: integer('height'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  sessionId: uuid('session_id'),
  messageId: uuid('message_id'),
  creationId: uuid('creation_id'),
  pickedUpAt: timestamptz('picked_up_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// storage_objects — immutable tenant-owned object identity and backing
// indirection. The 0030 trigger enforces lifecycle and field immutability;
// display_name is deliberately the only editable identity-adjacent field.
// ---------------------------------------------------------------------------
export const storageObjects = pgTable(
  'storage_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    purpose: text('purpose', {
      enum: [
        'chat',
        'training-set',
        'skill-asset',
        'voice-clip',
        'concept-reference',
        'generated',
        'account-export',
      ],
    }).notNull(),
    displayName: text('display_name'),
    declaredMime: text('declared_mime').notNull(),
    declaredSizeBytes: bigint('declared_size_bytes', { mode: 'number' }).notNull(),
    declaredSha256: text('declared_sha256').notNull(),
    verifiedMime: text('verified_mime'),
    verifiedSizeBytes: bigint('verified_size_bytes', { mode: 'number' }),
    verifiedSha256: text('verified_sha256'),
    state: text('state', {
      enum: ['pending', 'uploaded', 'verified', 'available', 'quarantined', 'failed'],
    })
      .notNull()
      .default('pending'),
    backingStore: text('backing_store', { enum: ['local', 'r2', 'legacy'] }).notNull(),
    backingKey: text('backing_key').notNull(),
    legacySourceUrl: text('legacy_source_url'),
    quarantineReason: text('quarantine_reason'),
    availableAt: timestamptz('available_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('storage_objects_id_owner_uq').on(t.id, t.ownerAccountId),
    index('storage_objects_owner_state_idx').on(t.ownerAccountId, t.state, t.createdAt),
    check(
      'storage_objects_state_check',
      sql`${t.state} in ('pending', 'uploaded', 'verified', 'available', 'quarantined', 'failed')`,
    ),
    check(
      'storage_objects_purpose_check',
      sql`${t.purpose} in ('chat', 'training-set', 'skill-asset', 'voice-clip', 'concept-reference', 'generated', 'account-export')`,
    ),
    check(
      'storage_objects_backing_check',
      sql`(${t.backingStore} = 'legacy' and ${t.legacySourceUrl} is not null and ${t.legacySourceUrl} ~ '^https://[^[:space:]]+$') or (${t.backingStore} in ('local', 'r2') and ${t.legacySourceUrl} is null)`,
    ),
    check(
      'storage_objects_key_check',
      sql`${t.backingKey} = 'objects/' || left(${t.id}::text, 2) || '/' || ${t.id}::text`,
    ),
    check(
      'storage_objects_checksum_check',
      sql`${t.declaredSha256} ~ '^[0-9a-f]{64}$' and (${t.verifiedSha256} is null or ${t.verifiedSha256} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'storage_objects_metadata_check',
      sql`length(${t.declaredMime}) > 0 and ${t.declaredSizeBytes} >= 0 and ((${t.verifiedMime} is null and ${t.verifiedSizeBytes} is null and ${t.verifiedSha256} is null) or (${t.verifiedMime} is not null and length(${t.verifiedMime}) > 0 and ${t.verifiedSizeBytes} is not null and ${t.verifiedSizeBytes} >= 0 and ${t.verifiedSha256} is not null))`,
    ),
    check(
      'storage_objects_lifecycle_shape_check',
      sql`(${t.state} in ('pending', 'uploaded') and ${t.verifiedMime} is null and ${t.verifiedSizeBytes} is null and ${t.verifiedSha256} is null and ${t.availableAt} is null) or (${t.state} = 'verified' and ((${t.declaredMime} <> 'application/octet-stream' and ${t.verifiedMime} = ${t.declaredMime}) or (${t.declaredMime} = 'application/octet-stream' and ${t.verifiedMime} in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/webm', 'video/mp4', 'audio/wav', 'audio/mpeg', 'application/json', 'text/plain'))) and ${t.verifiedSizeBytes} = ${t.declaredSizeBytes} and ${t.verifiedSha256} = ${t.declaredSha256} and ${t.availableAt} is null) or (${t.state} = 'available' and ((${t.declaredMime} <> 'application/octet-stream' and ${t.verifiedMime} = ${t.declaredMime}) or (${t.declaredMime} = 'application/octet-stream' and ${t.verifiedMime} in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/webm', 'video/mp4', 'audio/wav', 'audio/mpeg', 'application/json', 'text/plain'))) and ${t.verifiedSizeBytes} = ${t.declaredSizeBytes} and ${t.verifiedSha256} = ${t.declaredSha256} and ${t.availableAt} is not null) or (${t.state} in ('quarantined', 'failed') and ${t.availableAt} is null)`,
    ),
    check(
      'storage_objects_quarantine_reason_check',
      sql`(${t.state} = 'quarantined' and ${t.quarantineReason} is not null and length(${t.quarantineReason}) > 0) or (${t.state} <> 'quarantined' and ${t.quarantineReason} is null)`,
    ),
  ],
);

export const agentVoiceAssignments = pgTable('agent_voice_assignments', {
  agentAccountId: uuid('agent_account_id').primaryKey().references(() => agents.accountId, { onDelete: 'restrict' }),
  voiceId: text('voice_id').notNull(),
  chatMode: text('chat_mode').$type<'off' | 'on_demand' | 'always'>().notNull().default('on_demand'),
  discordMode: text('discord_mode').$type<'off' | 'on_demand' | 'always'>().notNull().default('off'),
  telegramMode: text('telegram_mode').$type<'off' | 'on_demand' | 'always'>().notNull().default('off'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const voiceClones = pgTable('voice_clones', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
  voiceId: text('voice_id').generatedAlwaysAs(sql`'clone:' || "id"::text`),
  name: text('name').notNull(),
  provider: text('provider').$type<'cartesia'>().notNull(),
  providerVoiceId: text('provider_voice_id'),
  providerRequestId: text('provider_request_id'),
  status: text('status').notNull().default('pending_validation'),
  consentVersion: text('consent_version').notNull(),
  consentAttestedAt: timestamptz('consent_attested_at').notNull(),
  clipManifestSha256: text('clip_manifest_sha256').notNull(),
  requestSha256: text('request_sha256').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  quarantineCode: text('quarantine_code'),
  failureCode: text('failure_code'),
  consentRevokedAt: timestamptz('consent_revoked_at'),
  revokedAt: timestamptz('revoked_at'),
  providerDeletedAt: timestamptz('provider_deleted_at'),
  deletedAt: timestamptz('deleted_at'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('voice_clones_voice_id_uq').on(t.voiceId),
  uniqueIndex('voice_clones_owner_idempotency_uq').on(t.ownerAccountId, t.idempotencyKey),
  index('voice_clones_owner_status_idx').on(t.ownerAccountId, t.status, t.createdAt),
]);

export const voiceCloneClips = pgTable('voice_clone_clips', {
  cloneId: uuid('clone_id').notNull().references(() => voiceClones.id, { onDelete: 'cascade' }),
  objectId: uuid('object_id').notNull().references(() => storageObjects.id, { onDelete: 'restrict' }),
  position: integer('position').notNull(),
  sha256: text('sha256').notNull(),
  mime: text('mime').$type<'audio/wav' | 'audio/mpeg'>().notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  durationMs: integer('duration_ms').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'voice_clone_clips_pk', columns: [t.cloneId, t.objectId] }),
  uniqueIndex('voice_clone_clips_position_uq').on(t.cloneId, t.position),
]);

export const voiceQuotes = pgTable('voice_quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
  operation: text('operation').$type<'preview' | 'chat' | 'discord' | 'telegram'>().notNull(),
  voiceId: text('voice_id').notNull(),
  textSha256: text('text_sha256').notNull(),
  characterCount: integer('character_count').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  costUsd: numeric('cost_usd', { precision: 20, scale: 10 }).notNull(),
  manna: numeric('manna', { precision: 20, scale: 4 }).notNull(),
  tableVersion: text('table_version').notNull(),
  pricingEffectiveDate: date('pricing_effective_date', { mode: 'string' }).notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  consumedAt: timestamptz('consumed_at'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => [index('voice_quotes_owner_expiry_idx').on(t.ownerAccountId, t.expiresAt)]);

export const voiceExecutions = pgTable('voice_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
  agentAccountId: uuid('agent_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  channelTurnId: uuid('channel_turn_id').references(() => channelTurns.turnId, { onDelete: 'set null' }),
  purpose: text('purpose').$type<'preview' | 'chat' | 'discord' | 'telegram'>().notNull(),
  voiceId: text('voice_id').notNull(),
  textSha256: text('text_sha256').notNull(),
  requestSha256: text('request_sha256').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  characterCount: integer('character_count').notNull(),
  billedCharacterCount: integer('billed_character_count'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  providerRequestId: text('provider_request_id'),
  status: text('status').notNull().default('pending'),
  reservedManna: numeric('reserved_manna', { precision: 20, scale: 4 }).notNull(),
  reservedSubscriptionManna: numeric('reserved_subscription_manna', { precision: 20, scale: 4 }).notNull(),
  costUsd: numeric('cost_usd', { precision: 20, scale: 10 }).notNull(),
  tableVersion: text('table_version').notNull(),
  outputUrl: text('output_url'),
  outputLocalPath: text('output_local_path'),
  outputSha256: text('output_sha256'),
  outputMime: text('output_mime'),
  outputSizeBytes: bigint('output_size_bytes', { mode: 'number' }),
  outputDurationMs: integer('output_duration_ms'),
  waveform: text('waveform'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  completedAt: timestamptz('completed_at'),
}, (t) => [
  uniqueIndex('voice_executions_owner_idempotency_uq').on(t.ownerAccountId, t.purpose, t.idempotencyKey),
  uniqueIndex('voice_executions_channel_turn_uq').on(t.channelTurnId).where(sql`${t.channelTurnId} is not null`),
  index('voice_executions_owner_created_idx').on(t.ownerAccountId, t.createdAt),
]);

// ---------------------------------------------------------------------------
// storage_uploads — a durable resumable multipart session. The composite FK
// binds its redundant owner to the object's owner at the database boundary.
// Raw bearer/capability tokens are intentionally never persisted.
// ---------------------------------------------------------------------------
export const storageUploads = pgTable(
  'storage_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    objectId: uuid('object_id').notNull(),
    ownerAccountId: uuid('owner_account_id').notNull(),
    backendMultipartId: text('backend_multipart_id').notNull(),
    state: text('state', {
      enum: ['initiated', 'uploading', 'completed', 'aborted', 'expired'],
    })
      .notNull()
      .default('initiated'),
    partSizeBytes: bigint('part_size_bytes', { mode: 'number' }).notNull(),
    maxParts: integer('max_parts').notNull().default(10_000),
    expiresAt: timestamptz('expires_at').notNull(),
    capabilityExpiresAt: timestamptz('capability_expires_at').notNull(),
    completedAt: timestamptz('completed_at'),
    cleanupState: text('cleanup_state', {
      enum: ['not_required', 'pending', 'claimed', 'succeeded', 'failed'],
    })
      .notNull()
      .default('not_required'),
    cleanupAttemptCount: integer('cleanup_attempt_count').notNull().default(0),
    cleanupNextAttemptAt: timestamptz('cleanup_next_attempt_at'),
    cleanupClaimToken: uuid('cleanup_claim_token'),
    cleanupClaimExpiresAt: timestamptz('cleanup_claim_expires_at'),
    cleanupEnqueuedAt: timestamptz('cleanup_enqueued_at'),
    cleanupSucceededAt: timestamptz('cleanup_succeeded_at'),
    cleanupLastErrorCode: text('cleanup_last_error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('storage_uploads_object_uq').on(t.objectId),
    index('storage_uploads_owner_state_idx').on(t.ownerAccountId, t.state, t.createdAt),
    index('storage_uploads_expiry_idx').on(t.expiresAt).where(
      sql`${t.state} in ('initiated', 'uploading')`,
    ),
    index('storage_uploads_cleanup_due_idx').on(t.cleanupNextAttemptAt, t.id).where(
      sql`${t.cleanupState} = 'pending'`,
    ),
    index('storage_uploads_cleanup_claim_expiry_idx').on(t.cleanupClaimExpiresAt, t.id).where(
      sql`${t.cleanupState} = 'claimed'`,
    ),
    foreignKey({
      name: 'storage_uploads_object_owner_fk',
      columns: [t.objectId, t.ownerAccountId],
      foreignColumns: [storageObjects.id, storageObjects.ownerAccountId],
    }).onDelete('cascade'),
    check(
      'storage_uploads_state_check',
      sql`${t.state} in ('initiated', 'uploading', 'completed', 'aborted', 'expired')`,
    ),
    check(
      'storage_uploads_part_bounds_check',
      sql`${t.partSizeBytes} > 0 and ${t.partSizeBytes} <= 5368709120 and ${t.maxParts} between 1 and 10000`,
    ),
    check(
      'storage_uploads_expiry_check',
      sql`${t.capabilityExpiresAt} > ${t.createdAt} and ${t.capabilityExpiresAt} <= ${t.expiresAt}`,
    ),
    check(
      'storage_uploads_terminal_shape_check',
      sql`(${t.state} = 'completed' and ${t.completedAt} is not null) or (${t.state} <> 'completed' and ${t.completedAt} is null)`,
    ),
    check('storage_uploads_backend_id_check', sql`length(${t.backendMultipartId}) > 0`),
    check(
      'storage_uploads_cleanup_state_check',
      sql`${t.cleanupState} in ('not_required', 'pending', 'claimed', 'succeeded', 'failed')`,
    ),
    check(
      'storage_uploads_cleanup_attempt_bounds_check',
      sql`${t.cleanupAttemptCount} between 0 and 100`,
    ),
    check(
      'storage_uploads_cleanup_error_code_check',
      sql`${t.cleanupLastErrorCode} is null or ${t.cleanupLastErrorCode} ~ '^[a-z][a-z0-9_]{0,99}$'`,
    ),
    check(
      'storage_uploads_cleanup_shape_check',
      sql`(${t.state} in ('initiated', 'uploading', 'completed') and ${t.cleanupState} = 'not_required' and ${t.cleanupAttemptCount} = 0 and ${t.cleanupNextAttemptAt} is null and ${t.cleanupClaimToken} is null and ${t.cleanupClaimExpiresAt} is null and ${t.cleanupEnqueuedAt} is null and ${t.cleanupSucceededAt} is null and ${t.cleanupLastErrorCode} is null) or (${t.state} in ('aborted', 'expired') and ${t.cleanupEnqueuedAt} is not null and ${t.cleanupSucceededAt} is null and ((${t.cleanupState} = 'pending' and ${t.cleanupNextAttemptAt} is not null and ${t.cleanupClaimToken} is null and ${t.cleanupClaimExpiresAt} is null) or (${t.cleanupState} = 'claimed' and ${t.cleanupNextAttemptAt} is null and ${t.cleanupClaimToken} is not null and ${t.cleanupClaimExpiresAt} is not null) or (${t.cleanupState} = 'failed' and ${t.cleanupNextAttemptAt} is null and ${t.cleanupClaimToken} is null and ${t.cleanupClaimExpiresAt} is null and ${t.cleanupLastErrorCode} is not null))) or (${t.state} in ('aborted', 'expired') and ${t.cleanupState} = 'succeeded' and ${t.cleanupEnqueuedAt} is not null and ${t.cleanupSucceededAt} is not null and ${t.cleanupSucceededAt} >= ${t.cleanupEnqueuedAt} and ${t.cleanupNextAttemptAt} is null and ${t.cleanupClaimToken} is null and ${t.cleanupClaimExpiresAt} is null and ${t.cleanupLastErrorCode} is null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// storage_upload_parts — durable completed-part state for nonzero-offset
// resumption. The migration trigger locks/checks the parent before any insert,
// replacement, or delete so terminal sessions cannot be mutated.
// ---------------------------------------------------------------------------
export const storageUploadParts = pgTable(
  'storage_upload_parts',
  {
    uploadId: uuid('upload_id')
      .notNull()
      .references(() => storageUploads.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    backendEtag: text('backend_etag').notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.uploadId, t.partNumber] }),
    check('storage_upload_parts_number_check', sql`${t.partNumber} between 1 and 10000`),
    check(
      'storage_upload_parts_size_check',
      sql`${t.sizeBytes} > 0 and ${t.sizeBytes} <= 5368709120`,
    ),
    check(
      'storage_upload_parts_checksum_check',
      sql`${t.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check('storage_upload_parts_etag_check', sql`length(${t.backendEtag}) > 0`),
  ],
);

// ---------------------------------------------------------------------------
// storage_upload_part_authorizations — durable capability claims, never raw
// bearer material. Migration 0032 validates exact part geometry against the
// parent upload/object and fences refreshes once the parent becomes terminal.
// ---------------------------------------------------------------------------
export const storageUploadPartAuthorizations = pgTable(
  'storage_upload_part_authorizations',
  {
    uploadId: uuid('upload_id')
      .notNull()
      .references(() => storageUploads.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.uploadId, t.partNumber] }),
    check(
      'storage_upload_part_authorizations_number_check',
      sql`${t.partNumber} between 1 and 10000`,
    ),
    check(
      'storage_upload_part_authorizations_checksum_check',
      sql`${t.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check('storage_upload_part_authorizations_size_check', sql`${t.sizeBytes} > 0`),
    check(
      'storage_upload_part_authorizations_expiry_check',
      sql`${t.expiresAt} > ${t.createdAt}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// storage_policy_events — minimal durable quarantine notification outbox. The
// event UUID is the delivery idempotency key; detector text/content/payloads
// are deliberately excluded.
// ---------------------------------------------------------------------------
export const storagePolicyEvents = pgTable(
  'storage_policy_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => storageObjects.id, { onDelete: 'restrict' }),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    eventType: text('event_type', { enum: ['quarantine_required'] }).notNull(),
    policyCode: text('policy_code').notNull(),
    state: text('state', { enum: ['pending', 'delivering', 'delivered', 'failed'] })
      .notNull()
      .default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at'),
    claimToken: uuid('claim_token'),
    claimExpiresAt: timestamptz('claim_expires_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    deliveredAt: timestamptz('delivered_at'),
  },
  (t) => [
    uniqueIndex('storage_policy_events_object_type_policy_uq').on(
      t.objectId,
      t.eventType,
      t.policyCode,
    ),
    index('storage_policy_events_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.state} = 'pending'`),
    index('storage_policy_events_claim_expiry_idx')
      .on(t.claimExpiresAt)
      .where(sql`${t.state} = 'delivering'`),
    foreignKey({
      name: 'storage_policy_events_object_owner_fk',
      columns: [t.objectId, t.ownerAccountId],
      foreignColumns: [storageObjects.id, storageObjects.ownerAccountId],
    }).onDelete('restrict'),
    check(
      'storage_policy_events_event_type_check',
      sql`${t.eventType} = 'quarantine_required'`,
    ),
    check(
      'storage_policy_events_policy_code_check',
      sql`${t.policyCode} ~ '^[a-z0-9_:-]{1,100}$'`,
    ),
    check(
      'storage_policy_events_state_check',
      sql`${t.state} in ('pending', 'delivering', 'delivered', 'failed')`,
    ),
    check('storage_policy_events_attempt_count_check', sql`${t.attemptCount} >= 0`),
    check(
      'storage_policy_events_last_error_code_check',
      sql`${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z0-9_:-]{1,100}$'`,
    ),
    check(
      'storage_policy_events_claim_shape_check',
      sql`(${t.state} = 'delivering' and ${t.claimToken} is not null and ${t.claimExpiresAt} is not null) or (${t.state} <> 'delivering' and ${t.claimToken} is null and ${t.claimExpiresAt} is null)`,
    ),
    check(
      'storage_policy_events_schedule_shape_check',
      sql`(${t.state} = 'pending' and ${t.nextAttemptAt} is not null) or (${t.state} <> 'pending' and ${t.nextAttemptAt} is null)`,
    ),
    check(
      'storage_policy_events_delivery_shape_check',
      sql`(${t.state} = 'delivered' and ${t.deliveredAt} is not null) or (${t.state} <> 'delivered' and ${t.deliveredAt} is null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// app_notifications — tenant-owned, payload-free in-app notifications.
// Build notifications identify only the agent account and a constrained
// same-app path; user/provider content and secrets have no column to enter.
// ---------------------------------------------------------------------------
export const appNotifications = pgTable(
  'app_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['agent_build_ready', 'agent_build_failed', 'scheduled_task_completed'],
    }).notNull(),
    sourceAgentId: uuid('source_agent_id')
      .notNull()
      .references(() => agents.accountId, { onDelete: 'cascade' }),
    targetPath: text('target_path'),
    readAt: timestamptz('read_at'),
    dismissedAt: timestamptz('dismissed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('app_notifications_build_once_uq')
      .on(t.accountId, t.kind, t.sourceAgentId)
      .where(sql`${t.kind} in ('agent_build_ready', 'agent_build_failed')`),
    index('app_notifications_account_created_idx')
      .on(t.accountId, t.createdAt.desc())
      .where(sql`${t.dismissedAt} is null`),
    index('app_notifications_account_unread_idx')
      .on(t.accountId, t.createdAt.desc())
      .where(sql`${t.readAt} is null and ${t.dismissedAt} is null`),
    check(
      'app_notifications_kind_check',
      sql`${t.kind} in ('agent_build_ready', 'agent_build_failed', 'scheduled_task_completed')`,
    ),
    check(
      'app_notifications_build_source_check',
      sql`${t.sourceAgentId} is not null`,
    ),
    check(
      'app_notifications_target_path_check',
      sql`${t.targetPath} is null or ${t.targetPath} ~ '^/(agents/[a-z0-9][a-z0-9_-]{2,31}|sessions/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'`,
    ),
    check(
      'app_notifications_read_at_check',
      sql`${t.readAt} is null or ${t.readAt} >= ${t.createdAt}`,
    ),
    check(
      'app_notifications_dismissed_at_check',
      sql`${t.dismissedAt} is null or (${t.readAt} is not null and ${t.dismissedAt} >= ${t.createdAt})`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// agent_provision_jobs — one durable, fenced provisioning claim per agent.
// The existing agents row is the sole configuration source; this table holds
// only recovery state and safe error codes, never copied persona or secrets.
// ---------------------------------------------------------------------------
export const agentProvisionJobs = pgTable(
  'agent_provision_jobs',
  {
    agentAccountId: uuid('agent_account_id')
      .primaryKey()
      .references(() => agents.accountId, { onDelete: 'cascade' }),
    state: text('state', { enum: ['pending', 'running', 'succeeded', 'failed'] })
      .notNull()
      .default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').defaultNow(),
    claimToken: uuid('claim_token'),
    claimExpiresAt: timestamptz('claim_expires_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
  },
  (t) => [
    index('agent_provision_jobs_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.state} = 'pending'`),
    index('agent_provision_jobs_claim_expiry_idx')
      .on(t.claimExpiresAt)
      .where(sql`${t.state} = 'running'`),
    check(
      'agent_provision_jobs_state_check',
      sql`${t.state} in ('pending', 'running', 'succeeded', 'failed')`,
    ),
    check('agent_provision_jobs_attempt_check', sql`${t.attemptCount} >= 0`),
    check(
      'agent_provision_jobs_claim_shape_check',
      sql`(${t.state} = 'running' and ${t.claimToken} is not null and ${t.claimExpiresAt} is not null) or (${t.state} <> 'running' and ${t.claimToken} is null and ${t.claimExpiresAt} is null)`,
    ),
    check(
      'agent_provision_jobs_schedule_shape_check',
      sql`(${t.state} = 'pending' and ${t.nextAttemptAt} is not null) or (${t.state} <> 'pending' and ${t.nextAttemptAt} is null)`,
    ),
    check(
      'agent_provision_jobs_completion_shape_check',
      sql`(${t.state} in ('succeeded', 'failed') and ${t.completedAt} is not null) or (${t.state} not in ('succeeded', 'failed') and ${t.completedAt} is null)`,
    ),
    check(
      'agent_provision_jobs_error_code_check',
      sql`${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z0-9_:-]{1,100}$'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// account_erasure_* — payload-free, restore-replayable deletion identifiers.
// account_id intentionally has no FK: a WORM erasure ledger can be replayed
// before the corresponding account row is restored. Migration 0040 owns the
// lifecycle, ownership, write-fence, and cleanup-claim triggers.
// ---------------------------------------------------------------------------
export const accountErasureJobs = pgTable(
  'account_erasure_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull(),
    state: text('state', {
      enum: ['intent_pending', 'claimed', 'manifest_pending', 'pending', 'attention', 'succeeded'],
    }).notNull().default('intent_pending'),
    acceptedAt: timestamptz('accepted_at').notNull().defaultNow(),
    ledgerConfirmedAt: timestamptz('ledger_confirmed_at'),
    ledgerSha256: text('ledger_sha256'),
    ledgerMacSha256: text('ledger_mac_sha256'),
    inventoriedAt: timestamptz('inventoried_at'),
    inventorySha256: text('inventory_sha256'),
    recoveryManifestConfirmedAt: timestamptz('recovery_manifest_confirmed_at'),
    recoveryManifestSha256: text('recovery_manifest_sha256'),
    recoveryCiphertextSha256: text('recovery_ciphertext_sha256'),
    recoveryMacSha256: text('recovery_mac_sha256'),
    recoveryKeyVersion: integer('recovery_key_version'),
    attemptCount: bigint('attempt_count', { mode: 'number' }).notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').defaultNow(),
    claimToken: uuid('claim_token'),
    claimExpiresAt: timestamptz('claim_expires_at'),
    completedAt: timestamptz('completed_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('account_erasure_jobs_account_active_uq')
      .on(t.accountId)
      .where(sql`${t.state} <> 'succeeded'`),
    index('account_erasure_jobs_due_idx')
      .on(t.nextAttemptAt, t.id)
      .where(sql`${t.state} in ('intent_pending', 'manifest_pending')`),
    index('account_erasure_jobs_claim_expiry_idx')
      .on(t.claimExpiresAt, t.id)
      .where(sql`${t.state} = 'claimed'`),
    check(
      'account_erasure_jobs_state_check',
      sql`${t.state} in ('intent_pending', 'claimed', 'manifest_pending', 'pending', 'attention', 'succeeded')`,
    ),
    check('account_erasure_jobs_attempt_check', sql`${t.attemptCount} >= 0`),
    check(
      'account_erasure_jobs_hash_check',
      sql`(${t.ledgerSha256} is null or ${t.ledgerSha256} ~ '^[0-9a-f]{64}$') and (${t.ledgerMacSha256} is null or ${t.ledgerMacSha256} ~ '^[0-9a-f]{64}$') and (${t.inventorySha256} is null or ${t.inventorySha256} ~ '^[0-9a-f]{64}$') and (${t.recoveryManifestSha256} is null or ${t.recoveryManifestSha256} ~ '^[0-9a-f]{64}$') and (${t.recoveryCiphertextSha256} is null or ${t.recoveryCiphertextSha256} ~ '^[0-9a-f]{64}$') and (${t.recoveryMacSha256} is null or ${t.recoveryMacSha256} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'account_erasure_jobs_error_check',
      sql`${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,99}$'`,
    ),
    check(
      'account_erasure_jobs_evidence_group_check',
      sql`((${t.ledgerConfirmedAt} is null and ${t.ledgerSha256} is null and ${t.ledgerMacSha256} is null) or (${t.ledgerConfirmedAt} is not null and ${t.ledgerSha256} is not null and ${t.ledgerMacSha256} is not null)) and ((${t.inventoriedAt} is null and ${t.inventorySha256} is null) or (${t.inventoriedAt} is not null and ${t.inventorySha256} is not null)) and ((${t.recoveryManifestConfirmedAt} is null and ${t.recoveryManifestSha256} is null and ${t.recoveryCiphertextSha256} is null and ${t.recoveryMacSha256} is null and ${t.recoveryKeyVersion} is null) or (${t.recoveryManifestConfirmedAt} is not null and ${t.recoveryManifestSha256} is not null and ${t.recoveryCiphertextSha256} is not null and ${t.recoveryMacSha256} is not null and ${t.recoveryKeyVersion} >= 1))`,
    ),
    check(
      'account_erasure_jobs_shape_check',
      sql`(${t.state} = 'intent_pending' and ${t.ledgerConfirmedAt} is null and ${t.inventoriedAt} is null and ${t.recoveryManifestConfirmedAt} is null and ${t.nextAttemptAt} is not null and ${t.claimToken} is null and ${t.claimExpiresAt} is null and ${t.completedAt} is null) or (${t.state} = 'claimed' and ${t.claimToken} is not null and ${t.claimExpiresAt} is not null and ${t.nextAttemptAt} is null and ${t.completedAt} is null and ${t.lastErrorCode} is null and ((${t.ledgerConfirmedAt} is null and ${t.inventoriedAt} is null and ${t.recoveryManifestConfirmedAt} is null) or (${t.ledgerConfirmedAt} is not null and ${t.inventoriedAt} is not null and ${t.recoveryManifestConfirmedAt} is null))) or (${t.state} = 'manifest_pending' and ${t.ledgerConfirmedAt} is not null and ${t.inventoriedAt} is not null and ${t.recoveryManifestConfirmedAt} is null and ${t.nextAttemptAt} is not null and ${t.claimToken} is null and ${t.claimExpiresAt} is null and ${t.completedAt} is null) or (${t.state} = 'pending' and ${t.ledgerConfirmedAt} is not null and ${t.inventoriedAt} is not null and ${t.recoveryManifestConfirmedAt} is not null and ${t.nextAttemptAt} is null and ${t.claimToken} is null and ${t.claimExpiresAt} is null and ${t.completedAt} is null and ${t.lastErrorCode} is null) or (${t.state} = 'attention' and ${t.nextAttemptAt} is null and ${t.claimToken} is null and ${t.claimExpiresAt} is null and ${t.completedAt} is null and ${t.lastErrorCode} is not null) or (${t.state} = 'succeeded' and ${t.ledgerConfirmedAt} is not null and ${t.inventoriedAt} is not null and ${t.recoveryManifestConfirmedAt} is not null and ${t.nextAttemptAt} is null and ${t.claimToken} is null and ${t.claimExpiresAt} is null and ${t.completedAt} is not null and ${t.lastErrorCode} is null)`,
    ),
  ],
);

export const accountErasureTargets = pgTable(
  'account_erasure_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull().references(() => accountErasureJobs.id, { onDelete: 'restrict' }),
    kind: text('kind', {
      enum: ['storage_object', 'legacy_media_asset', 'legacy_concept_asset', 'legacy_avatar_asset', 'agent_runtime', 'channel_runtime', 'clerk_identity', 'stripe_customer', 'backup_tombstone'],
    }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    state: text('state', { enum: ['pending', 'claimed', 'attention', 'succeeded'] })
      .notNull().default('pending'),
    attemptCount: bigint('attempt_count', { mode: 'number' }).notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').defaultNow(),
    claimToken: uuid('claim_token'),
    claimExpiresAt: timestamptz('claim_expires_at'),
    completedAt: timestamptz('completed_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('account_erasure_targets_job_kind_resource_uq').on(t.jobId, t.kind, t.resourceId),
    index('account_erasure_targets_due_idx').on(t.nextAttemptAt, t.id).where(sql`${t.state} = 'pending'`),
    index('account_erasure_targets_claim_expiry_idx').on(t.claimExpiresAt, t.id).where(sql`${t.state} = 'claimed'`),
    check('account_erasure_targets_kind_check', sql`${t.kind} in ('storage_object', 'legacy_media_asset', 'legacy_concept_asset', 'legacy_avatar_asset', 'agent_runtime', 'channel_runtime', 'clerk_identity', 'stripe_customer', 'backup_tombstone')`),
    check('account_erasure_targets_state_check', sql`${t.state} in ('pending', 'claimed', 'attention', 'succeeded')`),
    check('account_erasure_targets_attempt_check', sql`${t.attemptCount} >= 0`),
    check('account_erasure_targets_error_check', sql`${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,99}$'`),
    check('account_erasure_targets_shape_check', sql`(${t.state} = 'pending' and ${t.nextAttemptAt} is not null and ${t.claimToken} is null and ${t.claimExpiresAt} is null and ${t.completedAt} is null) or (${t.state} = 'claimed' and ${t.nextAttemptAt} is null and ${t.claimToken} is not null and ${t.claimExpiresAt} is not null and ${t.completedAt} is null and ${t.lastErrorCode} is null) or (${t.state} = 'attention' and ${t.nextAttemptAt} is null and ${t.claimToken} is null and ${t.claimExpiresAt} is null and ${t.completedAt} is null and ${t.lastErrorCode} is not null) or (${t.state} = 'succeeded' and ${t.nextAttemptAt} is null and ${t.claimToken} is null and ${t.claimExpiresAt} is null and ${t.completedAt} is not null and ${t.lastErrorCode} is null)`),
  ],
);

export const accountErasureTargetRequeues = pgTable(
  'account_erasure_target_requeues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull().references(() => accountErasureJobs.id, { onDelete: 'restrict' }),
    targetId: uuid('target_id').notNull().references(() => accountErasureTargets.id, { onDelete: 'restrict' }),
    priorAttemptCount: bigint('prior_attempt_count', { mode: 'number' }).notNull(),
    operatorId: text('operator_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('account_erasure_target_requeues_attempt_uq').on(t.targetId, t.priorAttemptCount),
    index('account_erasure_target_requeues_job_idx').on(t.jobId, t.createdAt),
    check('account_erasure_target_requeues_attempt_check', sql`${t.priorAttemptCount} >= 0`),
    check('account_erasure_target_requeues_operator_check', sql`${t.operatorId} ~ '^[a-z][a-z0-9_.:-]{0,99}$'`),
    check('account_erasure_target_requeues_reason_check', sql`${t.reasonCode} ~ '^[a-z][a-z0-9_]{0,99}$'`),
  ],
);

export const accountErasureMessageTombstones = pgTable(
  'account_erasure_message_tombstones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull().references(() => accountErasureJobs.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').notNull(),
    messageId: uuid('message_id').notNull(),
    authorPrincipalId: uuid('author_principal_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('account_erasure_message_tombstones_job_message_uq').on(t.jobId, t.messageId),
    index('account_erasure_message_tombstones_session_idx').on(t.sessionId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// etl_runs — immutable source boundaries for one bounded ETL attempt.
//
// Every canonical Mongo collection receives one identical prior-whole-second
// ObjectId cap before the first stage starts. The contract requires append-only
// membership with globally nondecreasing ObjectId timestamps; delayed,
// backdated, or clock-skewed inserts at/below the cap remain the explicit
// no-snapshot limitation.
// Verifiers use only the latest completed compatible run, so ordinary source
// growth strictly after the cap is informational.
// ---------------------------------------------------------------------------
export const etlRuns = pgTable(
  'etl_runs',
  {
    id: uuid('id').primaryKey(),
    sourceDatabase: text('source_database').notNull(),
    mode: text('mode').$type<'full' | 'delta'>().notNull(),
    documentLimit: integer('document_limit'),
    selectedCollections: jsonb('selected_collections').$type<string[]>().notNull(),
    sourceCutoffs: jsonb('source_cutoffs')
      .$type<Record<string, string>>()
      .notNull(),
    status: text('status')
      .$type<'running' | 'completed' | 'failed'>()
      .notNull()
      .default('running'),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at'),
    error: text('error'),
  },
  (t) => [
    check('etl_runs_mode_check', sql`${t.mode} in ('full', 'delta')`),
    check(
      'etl_runs_status_check',
      sql`${t.status} in ('running', 'completed', 'failed')`,
    ),
    check(
      'etl_runs_limit_check',
      sql`${t.documentLimit} is null or ${t.documentLimit} > 0`,
    ),
    check(
      'etl_runs_terminal_shape_check',
      sql`(${t.status} = 'running' and ${t.finishedAt} is null) or (${t.status} in ('completed', 'failed') and ${t.finishedAt} is not null)`,
    ),
    index('etl_runs_latest_idx').on(t.startedAt),
  ],
);

// ---------------------------------------------------------------------------
// etl_state — per-collection watermarks; delta re-run = final-sync rehearsal.
// ---------------------------------------------------------------------------
export const etlState = pgTable('etl_state', {
  collection: text('collection').primaryKey(),
  watermark: timestamptz('watermark'),
  lastRunAt: timestamptz('last_run_at'),
  sourceCount: bigint('source_count', { mode: 'number' }),
  migratedCount: bigint('migrated_count', { mode: 'number' }),
  warnings: jsonb('warnings'),
});

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionShareLink = typeof sessionShareLinks.$inferSelect;
export type NewSessionShareLink = typeof sessionShareLinks.$inferInsert;
export type SessionAgent = typeof sessionAgents.$inferSelect;
export type SessionUser = typeof sessionUsers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Creation = typeof creations.$inferSelect;
export type NewCreation = typeof creations.$inferInsert;
export type ContentReport = typeof contentReports.$inferSelect;
export type NewContentReport = typeof contentReports.$inferInsert;
export type CreationLike = typeof creationLikes.$inferSelect;
export type NewCreationLike = typeof creationLikes.$inferInsert;
export type AgentLike = typeof agentLikes.$inferSelect;
export type NewAgentLike = typeof agentLikes.$inferInsert;
export type EtlSocialEdge = typeof etlSocialEdges.$inferSelect;
export type NewEtlSocialEdge = typeof etlSocialEdges.$inferInsert;
export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type CollectionCreation = typeof collectionCreations.$inferSelect;
export type Concept = typeof concepts.$inferSelect;
export type NewConcept = typeof concepts.$inferInsert;
export type ConceptImage = typeof conceptImages.$inferSelect;
export type NewConceptImage = typeof conceptImages.$inferInsert;
export type AccountErasureJob = typeof accountErasureJobs.$inferSelect;
export type NewAccountErasureJob = typeof accountErasureJobs.$inferInsert;
export type AccountErasureTarget = typeof accountErasureTargets.$inferSelect;
export type NewAccountErasureTarget = typeof accountErasureTargets.$inferInsert;
export type AccountErasureTargetRequeue = typeof accountErasureTargetRequeues.$inferSelect;
export type AccountErasureMessageTombstone = typeof accountErasureMessageTombstones.$inferSelect;
export type MannaAccount = typeof mannaAccounts.$inferSelect;
export type NewMannaAccount = typeof mannaAccounts.$inferInsert;
export type MannaTransaction = typeof mannaTransactions.$inferSelect;
export type NewMannaTransaction = typeof mannaTransactions.$inferInsert;
export type TurnAuthorization = typeof turnAuthorizations.$inferSelect;
export type NewTurnAuthorization = typeof turnAuthorizations.$inferInsert;
export type TurnProviderRun = typeof turnProviderRuns.$inferSelect;
export type NewTurnProviderRun = typeof turnProviderRuns.$inferInsert;
export type BillingSubscription = typeof billingSubscriptions.$inferSelect;
export type NewBillingSubscription = typeof billingSubscriptions.$inferInsert;
export type MannaVoucher = typeof mannaVouchers.$inferSelect;
export type NewMannaVoucher = typeof mannaVouchers.$inferInsert;
export type ChannelConnection = typeof channelConnections.$inferSelect;
export type NewChannelConnection = typeof channelConnections.$inferInsert;
export type ChannelOnboardingIntent = typeof channelOnboardingIntents.$inferSelect;
export type NewChannelOnboardingIntent = typeof channelOnboardingIntents.$inferInsert;
export type ChannelExternalIdentity = typeof channelExternalIdentities.$inferSelect;
export type NewChannelExternalIdentity = typeof channelExternalIdentities.$inferInsert;
export type ChannelPairingRequest = typeof channelPairingRequests.$inferSelect;
export type NewChannelPairingRequest = typeof channelPairingRequests.$inferInsert;
export type ChannelTurn = typeof channelTurns.$inferSelect;
export type NewChannelTurn = typeof channelTurns.$inferInsert;
export type SecretAccessAuditEvent = typeof secretAccessAuditEvents.$inferSelect;
export type NewSecretAccessAuditEvent = typeof secretAccessAuditEvents.$inferInsert;
export type SkillDefinition = typeof skillDefinitions.$inferSelect;
export type NewSkillDefinition = typeof skillDefinitions.$inferInsert;
export type AgentSkill = typeof agentSkills.$inferSelect;
export type NewAgentSkill = typeof agentSkills.$inferInsert;
export type DistillState = typeof distillState.$inferSelect;
export type NewDistillState = typeof distillState.$inferInsert;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type TranscriptionSession = typeof transcriptionSessions.$inferSelect;
export type NewTranscriptionSession = typeof transcriptionSessions.$inferInsert;
export type TranscriptionChunk = typeof transcriptionChunks.$inferSelect;
export type NewTranscriptionChunk = typeof transcriptionChunks.$inferInsert;
export type ClaudeSessionTurnClaim = typeof claudeSessionTurnClaims.$inferSelect;
export type NewClaudeSessionTurnClaim = typeof claudeSessionTurnClaims.$inferInsert;
export type MemoryRevision = typeof memoryRevisions.$inferSelect;
export type NewMemoryRevision = typeof memoryRevisions.$inferInsert;
export type MemoryDreamSweep = typeof memoryDreamSweeps.$inferSelect;
export type NewMemoryDreamSweep = typeof memoryDreamSweeps.$inferInsert;
export type MemoryDreamRun = typeof memoryDreamRuns.$inferSelect;
export type NewMemoryDreamRun = typeof memoryDreamRuns.$inferInsert;
export type MemoryRetrievalProbe = typeof memoryRetrievalProbes.$inferSelect;
export type NewMemoryRetrievalProbe = typeof memoryRetrievalProbes.$inferInsert;
export type Trigger = typeof triggers.$inferSelect;
export type NewTrigger = typeof triggers.$inferInsert;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;
export type StorageObject = typeof storageObjects.$inferSelect;
export type NewStorageObject = typeof storageObjects.$inferInsert;
export type AgentVoiceAssignment = typeof agentVoiceAssignments.$inferSelect;
export type NewAgentVoiceAssignment = typeof agentVoiceAssignments.$inferInsert;
export type VoiceClone = typeof voiceClones.$inferSelect;
export type NewVoiceClone = typeof voiceClones.$inferInsert;
export type VoiceCloneClip = typeof voiceCloneClips.$inferSelect;
export type NewVoiceCloneClip = typeof voiceCloneClips.$inferInsert;
export type VoiceQuote = typeof voiceQuotes.$inferSelect;
export type NewVoiceQuote = typeof voiceQuotes.$inferInsert;
export type VoiceExecution = typeof voiceExecutions.$inferSelect;
export type NewVoiceExecution = typeof voiceExecutions.$inferInsert;
export type StorageUpload = typeof storageUploads.$inferSelect;
export type NewStorageUpload = typeof storageUploads.$inferInsert;
export type StorageUploadPart = typeof storageUploadParts.$inferSelect;
export type NewStorageUploadPart = typeof storageUploadParts.$inferInsert;
export type StorageUploadPartAuthorization = typeof storageUploadPartAuthorizations.$inferSelect;
export type NewStorageUploadPartAuthorization = typeof storageUploadPartAuthorizations.$inferInsert;
export type StoragePolicyEvent = typeof storagePolicyEvents.$inferSelect;
export type NewStoragePolicyEvent = typeof storagePolicyEvents.$inferInsert;
export type AppNotification = typeof appNotifications.$inferSelect;
export type NewAppNotification = typeof appNotifications.$inferInsert;
export type AgentProvisionJob = typeof agentProvisionJobs.$inferSelect;
export type NewAgentProvisionJob = typeof agentProvisionJobs.$inferInsert;
export type EtlRun = typeof etlRuns.$inferSelect;
export type NewEtlRun = typeof etlRuns.$inferInsert;
export type EtlState = typeof etlState.$inferSelect;
export type NewEtlState = typeof etlState.$inferInsert;
