CREATE TABLE "memory_dream_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sweep_id" uuid NOT NULL,
	"agent_account_id" uuid NOT NULL,
	"openclaw_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"last_activity_at" timestamp with time zone,
	"agent_runtime" text,
	"pricing_basis" text,
	"deep_candidates" integer,
	"promoted_count" integer,
	"usage_event_id" uuid,
	"previous_sha256" text,
	"sha256" text,
	"provenance" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_dream_sweeps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sweep_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"eligible_count" integer DEFAULT 0 NOT NULL,
	"active_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_agents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_dream_sweeps_sweep_key_unique" UNIQUE("sweep_key")
);
--> statement-breakpoint
CREATE TABLE "memory_retrieval_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_account_id" uuid NOT NULL,
	"openclaw_id" text NOT NULL,
	"query_sha256" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"top_score" numeric(8, 6),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_account_id" uuid NOT NULL,
	"openclaw_id" text NOT NULL,
	"actor_account_id" uuid,
	"operation" text NOT NULL,
	"previous_sha256" text,
	"sha256" text NOT NULL,
	"chars" integer NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_dream_runs" ADD CONSTRAINT "memory_dream_runs_sweep_id_memory_dream_sweeps_id_fk" FOREIGN KEY ("sweep_id") REFERENCES "public"."memory_dream_sweeps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_dream_runs" ADD CONSTRAINT "memory_dream_runs_agent_account_id_accounts_id_fk" FOREIGN KEY ("agent_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_dream_runs" ADD CONSTRAINT "memory_dream_runs_usage_event_id_usage_events_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrieval_probes" ADD CONSTRAINT "memory_retrieval_probes_agent_account_id_accounts_id_fk" FOREIGN KEY ("agent_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_agent_account_id_accounts_id_fk" FOREIGN KEY ("agent_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_dream_runs_sweep_agent_uq" ON "memory_dream_runs" USING btree ("sweep_id","agent_account_id");--> statement-breakpoint
CREATE INDEX "memory_dream_runs_agent_created_idx" ON "memory_dream_runs" USING btree ("agent_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memory_dream_sweeps_window_idx" ON "memory_dream_sweeps" USING btree ("window_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memory_retrieval_probes_agent_created_idx" ON "memory_retrieval_probes" USING btree ("agent_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memory_revisions_agent_created_idx" ON "memory_revisions" USING btree ("agent_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memory_revisions_openclaw_created_idx" ON "memory_revisions" USING btree ("openclaw_id","created_at" DESC NULLS LAST);