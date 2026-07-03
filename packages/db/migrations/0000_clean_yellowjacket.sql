CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"type" text NOT NULL,
	"username" "citext" NOT NULL,
	"user_image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "accounts_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid,
	"name" text,
	"description" text,
	"persona" text,
	"greeting" text,
	"voice" text,
	"public" boolean DEFAULT false NOT NULL,
	"openclaw_id" text,
	"workspace_path" text,
	"is_pilot" boolean DEFAULT false NOT NULL,
	"is_synthetic" boolean DEFAULT false NOT NULL,
	"provision_status" text DEFAULT 'pending' NOT NULL,
	"provisioned_at" timestamp with time zone,
	CONSTRAINT "agents_openclaw_id_unique" UNIQUE("openclaw_id")
);
--> statement-breakpoint
CREATE TABLE "collection_creations" (
	"collection_id" uuid NOT NULL,
	"creation_id" uuid NOT NULL,
	"position" integer,
	CONSTRAINT "collection_creations_collection_id_creation_id_pk" PRIMARY KEY("collection_id","creation_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"user_id" uuid,
	"name" text,
	"description" text,
	"public" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"user_id" uuid,
	"agent_id" uuid,
	"tool" text,
	"filename" text,
	"url" text,
	"thumbnail_url" text,
	"media_attributes" jsonb,
	"like_count" integer DEFAULT 0 NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "etl_state" (
	"collection" text PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"source_count" bigint,
	"migrated_count" bigint,
	"warnings" jsonb
);
--> statement-breakpoint
CREATE TABLE "manna_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"account_id" uuid NOT NULL,
	"balance" numeric(20, 4) DEFAULT '0' NOT NULL,
	"subscription_balance" numeric(20, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manna_accounts_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "manna_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"manna_account_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"type" text NOT NULL,
	"task_external_id" text,
	"idempotency_key" text,
	"refunds_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manna_transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_path" text,
	"local_path" text,
	"url" text,
	"sha256" text,
	"mime" text,
	"width" integer,
	"height" integer,
	"size_bytes" bigint,
	"session_id" uuid,
	"message_id" uuid,
	"creation_id" uuid,
	"picked_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"session_id" uuid NOT NULL,
	"sender_id" uuid,
	"role" text,
	"content" text,
	"tool_calls" jsonb,
	"attachments" jsonb,
	"reactions" jsonb,
	"reply_to_external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_agents" (
	"session_id" uuid NOT NULL,
	"agent_account_id" uuid NOT NULL,
	CONSTRAINT "session_agents_session_id_agent_account_id_pk" PRIMARY KEY("session_id","agent_account_id")
);
--> statement-breakpoint
CREATE TABLE "session_users" (
	"session_id" uuid NOT NULL,
	"user_account_id" uuid NOT NULL,
	CONSTRAINT "session_users_session_id_user_account_id_pk" PRIMARY KEY("session_id","user_account_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"owner_id" uuid,
	"title" text,
	"status" text,
	"session_type" text,
	"platform" text,
	"gateway_session_key" text,
	"gateway_primed_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sessions_gateway_session_key_unique" UNIQUE("gateway_session_key")
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"user_id" uuid,
	"agent_id" uuid,
	"name" text,
	"prompt" text,
	"schedule" jsonb,
	"status" text,
	"openclaw_job_id" text,
	"last_synced_at" timestamp with time zone,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_creations" ADD CONSTRAINT "collection_creations_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_creations" ADD CONSTRAINT "collection_creations_creation_id_creations_id_fk" FOREIGN KEY ("creation_id") REFERENCES "public"."creations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creations" ADD CONSTRAINT "creations_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creations" ADD CONSTRAINT "creations_agent_id_accounts_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manna_accounts" ADD CONSTRAINT "manna_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manna_transactions" ADD CONSTRAINT "manna_transactions_manna_account_id_manna_accounts_id_fk" FOREIGN KEY ("manna_account_id") REFERENCES "public"."manna_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manna_transactions" ADD CONSTRAINT "manna_transactions_refunds_transaction_id_manna_transactions_id_fk" FOREIGN KEY ("refunds_transaction_id") REFERENCES "public"."manna_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_accounts_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_agents" ADD CONSTRAINT "session_agents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_agents" ADD CONSTRAINT "session_agents_agent_account_id_accounts_id_fk" FOREIGN KEY ("agent_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_users" ADD CONSTRAINT "session_users_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_users" ADD CONSTRAINT "session_users_user_account_id_accounts_id_fk" FOREIGN KEY ("user_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_agent_id_accounts_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_external_id_uq" ON "accounts" USING btree ("external_id") WHERE "accounts"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "collections_external_id_uq" ON "collections" USING btree ("external_id") WHERE "collections"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "creations_external_id_uq" ON "creations" USING btree ("external_id") WHERE "creations"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "creations_feed_idx" ON "creations" USING btree ("created_at" DESC NULLS LAST) WHERE "creations"."public" = true and "creations"."deleted" = false;--> statement-breakpoint
CREATE INDEX "creations_user_created_idx" ON "creations" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "creations_agent_created_idx" ON "creations" USING btree ("agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "manna_transactions_external_id_uq" ON "manna_transactions" USING btree ("external_id") WHERE "manna_transactions"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "manna_transactions_account_created_idx" ON "manna_transactions" USING btree ("manna_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_session_external_uq" ON "messages" USING btree ("session_id","external_id");--> statement-breakpoint
CREATE INDEX "messages_session_created_idx" ON "messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "session_agents_agent_idx" ON "session_agents" USING btree ("agent_account_id");--> statement-breakpoint
CREATE INDEX "session_users_user_idx" ON "session_users" USING btree ("user_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_external_id_uq" ON "sessions" USING btree ("external_id") WHERE "sessions"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "sessions_owner_last_message_idx" ON "sessions" USING btree ("owner_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "triggers_external_id_uq" ON "triggers" USING btree ("external_id") WHERE "triggers"."external_id" is not null;