CREATE TABLE "claude_session_turn_claims" (
	"session_key" text PRIMARY KEY NOT NULL,
	"turn_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_session_turn_claims_turn_id_unique" UNIQUE("turn_id")
);
--> statement-breakpoint
CREATE TABLE "etl_social_edges" (
	"source_collection" text NOT NULL,
	"source_external_id" text NOT NULL,
	"edge_kind" text NOT NULL,
	"user_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"last_seen_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "etl_social_edges_source_collection_source_external_id_edge_kind_user_id_target_id_pk" PRIMARY KEY("source_collection","source_external_id","edge_kind","user_id","target_id")
);
--> statement-breakpoint
ALTER TABLE "memory_dream_runs" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "memory_dream_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_dream_runs" ADD COLUMN "provider_status" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_dream_runs" ADD COLUMN "provider_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_dream_sweeps" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "memory_dream_sweeps" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "etl_social_edges" ADD CONSTRAINT "etl_social_edges_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claude_session_turn_claims_expiry_idx" ON "claude_session_turn_claims" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "etl_social_edges_source_run_idx" ON "etl_social_edges" USING btree ("source_collection","last_seen_run_id");--> statement-breakpoint
CREATE INDEX "etl_social_edges_target_idx" ON "etl_social_edges" USING btree ("edge_kind","user_id","target_id");--> statement-breakpoint
CREATE INDEX "memory_dream_runs_lease_idx" ON "memory_dream_runs" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "memory_dream_sweeps_lease_idx" ON "memory_dream_sweeps" USING btree ("lease_expires_at");