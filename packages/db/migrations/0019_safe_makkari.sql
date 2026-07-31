CREATE TABLE "channel_external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"peer_fingerprint" text NOT NULL,
	"peer_ciphertext" text NOT NULL,
	"peer_iv" text NOT NULL,
	"peer_auth_tag" text NOT NULL,
	"peer_preview" text,
	"key_version" text DEFAULT 'v1' NOT NULL,
	"linked_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_pairing_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_account_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_turns" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid,
	"account_id" uuid,
	"agent_id" uuid,
	"session_id" uuid,
	"external_message_id" text,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_manna" integer NOT NULL,
	"metered_manna" integer,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "runtime_account_id" text;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "desired_state" text DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "observed_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "last_error_message" text;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "last_validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source_sequence" bigint;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "channel_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "channel_peer_fingerprint" text;--> statement-breakpoint
ALTER TABLE "channel_external_identities" ADD CONSTRAINT "channel_external_identities_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_external_identities" ADD CONSTRAINT "channel_external_identities_linked_account_id_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pairing_requests" ADD CONSTRAINT "channel_pairing_requests_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pairing_requests" ADD CONSTRAINT "channel_pairing_requests_identity_id_channel_external_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."channel_external_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pairing_requests" ADD CONSTRAINT "channel_pairing_requests_decided_by_account_id_accounts_id_fk" FOREIGN KEY ("decided_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_turns" ADD CONSTRAINT "channel_turns_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_turns" ADD CONSTRAINT "channel_turns_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_turns" ADD CONSTRAINT "channel_turns_agent_id_accounts_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_turns" ADD CONSTRAINT "channel_turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_external_identities_peer_uq" ON "channel_external_identities" USING btree ("connection_id","peer_fingerprint");--> statement-breakpoint
CREATE INDEX "channel_external_identities_linked_account_idx" ON "channel_external_identities" USING btree ("linked_account_id");--> statement-breakpoint
CREATE INDEX "channel_pairing_requests_connection_status_idx" ON "channel_pairing_requests" USING btree ("connection_id","status","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "channel_pairing_requests_pending_uq" ON "channel_pairing_requests" USING btree ("connection_id","identity_id") WHERE "channel_pairing_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "channel_turns_connection_created_idx" ON "channel_turns" USING btree ("connection_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "channel_turns_external_message_uq" ON "channel_turns" USING btree ("connection_id","external_message_id") WHERE "channel_turns"."connection_id" is not null and "channel_turns"."external_message_id" is not null;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_channel_connection_id_channel_connections_id_fk" FOREIGN KEY ("channel_connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_runtime_account_uq" ON "channel_connections" USING btree ("channel","runtime_account_id") WHERE "channel_connections"."runtime_account_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_channel_order_idx" ON "messages" USING btree ("session_id","created_at","source_sequence","id");--> statement-breakpoint
CREATE INDEX "sessions_channel_connection_idx" ON "sessions" USING btree ("channel_connection_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_channel_peer_uq" ON "sessions" USING btree ("channel_connection_id","channel_peer_fingerprint") WHERE "sessions"."channel_connection_id" is not null and "sessions"."channel_peer_fingerprint" is not null;
