import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  check,
  customType,
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
      .$type<'unknown' | 'validating' | 'verified' | 'starting' | 'live' | 'stopped' | 'error'>()
      .notNull()
      .default('unknown'),
    status: text('status').notNull().default('connected'),
    tokenCiphertext: text('token_ciphertext').notNull(),
    tokenIv: text('token_iv').notNull(),
    tokenAuthTag: text('token_auth_tag').notNull(),
    tokenSha256: text('token_sha256').notNull(),
    tokenPreview: text('token_preview'),
    keyVersion: text('key_version').notNull().default('v1'),
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
    uniqueIndex('channel_connections_runtime_account_uq')
      .on(t.channel, t.runtimeAccountId)
      .where(sql`${t.runtimeAccountId} is not null`),
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
      sql`(${t.state} in ('pending', 'uploaded') and ${t.verifiedMime} is null and ${t.verifiedSizeBytes} is null and ${t.verifiedSha256} is null and ${t.availableAt} is null) or (${t.state} = 'verified' and ${t.verifiedMime} = ${t.declaredMime} and ${t.verifiedSizeBytes} = ${t.declaredSizeBytes} and ${t.verifiedSha256} = ${t.declaredSha256} and ${t.availableAt} is null) or (${t.state} = 'available' and ${t.verifiedMime} = ${t.declaredMime} and ${t.verifiedSizeBytes} = ${t.declaredSizeBytes} and ${t.verifiedSha256} = ${t.declaredSha256} and ${t.availableAt} is not null) or (${t.state} in ('quarantined', 'failed') and ${t.availableAt} is null)`,
    ),
    check(
      'storage_objects_quarantine_reason_check',
      sql`(${t.state} = 'quarantined' and ${t.quarantineReason} is not null and length(${t.quarantineReason}) > 0) or (${t.state} <> 'quarantined' and ${t.quarantineReason} is null)`,
    ),
  ],
);

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
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('storage_uploads_object_uq').on(t.objectId),
    index('storage_uploads_owner_state_idx').on(t.ownerAccountId, t.state, t.createdAt),
    index('storage_uploads_expiry_idx').on(t.expiresAt).where(
      sql`${t.state} in ('initiated', 'uploading')`,
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
export type MannaAccount = typeof mannaAccounts.$inferSelect;
export type NewMannaAccount = typeof mannaAccounts.$inferInsert;
export type MannaTransaction = typeof mannaTransactions.$inferSelect;
export type NewMannaTransaction = typeof mannaTransactions.$inferInsert;
export type TurnAuthorization = typeof turnAuthorizations.$inferSelect;
export type NewTurnAuthorization = typeof turnAuthorizations.$inferInsert;
export type BillingSubscription = typeof billingSubscriptions.$inferSelect;
export type NewBillingSubscription = typeof billingSubscriptions.$inferInsert;
export type MannaVoucher = typeof mannaVouchers.$inferSelect;
export type NewMannaVoucher = typeof mannaVouchers.$inferInsert;
export type ChannelConnection = typeof channelConnections.$inferSelect;
export type NewChannelConnection = typeof channelConnections.$inferInsert;
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
export type StorageUpload = typeof storageUploads.$inferSelect;
export type NewStorageUpload = typeof storageUploads.$inferInsert;
export type StorageUploadPart = typeof storageUploadParts.$inferSelect;
export type NewStorageUploadPart = typeof storageUploadParts.$inferInsert;
export type EtlRun = typeof etlRuns.$inferSelect;
export type NewEtlRun = typeof etlRuns.$inferInsert;
export type EtlState = typeof etlState.$inferSelect;
export type NewEtlState = typeof etlState.$inferInsert;
