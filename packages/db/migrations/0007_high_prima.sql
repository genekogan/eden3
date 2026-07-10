CREATE TABLE "channel_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_id" uuid,
	"channel" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_auth_tag" text NOT NULL,
	"token_sha256" text NOT NULL,
	"token_preview" text,
	"key_version" text DEFAULT 'v1' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_access_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_account_id" uuid,
	"owner_account_id" uuid,
	"secret_kind" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"action" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_agent_id_accounts_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_audit_events" ADD CONSTRAINT "secret_access_audit_events_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_audit_events" ADD CONSTRAINT "secret_access_audit_events_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_connections_account_idx" ON "channel_connections" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "channel_connections_agent_idx" ON "channel_connections" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "secret_access_audit_owner_idx" ON "secret_access_audit_events" USING btree ("owner_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "secret_access_audit_secret_idx" ON "secret_access_audit_events" USING btree ("secret_kind","secret_id");