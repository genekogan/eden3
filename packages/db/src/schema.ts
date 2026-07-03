import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  customType,
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
  public: boolean('public').notNull().default(false),
  openclawId: text('openclaw_id').unique(),
  workspacePath: text('workspace_path'),
  isPilot: boolean('is_pilot').notNull().default(false),
  isSynthetic: boolean('is_synthetic').notNull().default(false),
  provisionStatus: text('provision_status').notNull().default('pending'),
  provisionedAt: timestamptz('provisioned_at'),
});

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
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_session_external_uq').on(t.sessionId, t.externalId),
    index('messages_session_created_idx').on(t.sessionId, t.createdAt),
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
    index('creations_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('creations_agent_created_idx').on(t.agentId, t.createdAt.desc()),
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
    type: text('type').notNull(),
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
  ],
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
export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type CollectionCreation = typeof collectionCreations.$inferSelect;
export type MannaAccount = typeof mannaAccounts.$inferSelect;
export type NewMannaAccount = typeof mannaAccounts.$inferInsert;
export type MannaTransaction = typeof mannaTransactions.$inferSelect;
export type NewMannaTransaction = typeof mannaTransactions.$inferInsert;
export type Trigger = typeof triggers.$inferSelect;
export type NewTrigger = typeof triggers.$inferInsert;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;
export type EtlState = typeof etlState.$inferSelect;
export type NewEtlState = typeof etlState.$inferInsert;
