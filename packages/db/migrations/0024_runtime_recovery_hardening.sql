DROP INDEX "channel_turns_open_updated_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_sync_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_synced_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_sync_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_sync_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_sync_error" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_sync_versions_check" CHECK ("runtime_sync_version" >= 0 AND "runtime_synced_version" >= 0 AND "runtime_synced_version" <= "runtime_sync_version");--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "pending_occurrence_id" uuid;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "pending_occurrence_kind" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "pending_occurrence_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_pending_occurrence_shape_check" CHECK (
  ("pending_occurrence_id" IS NULL AND "pending_occurrence_kind" IS NULL AND "pending_occurrence_at" IS NULL)
  OR
  ("pending_occurrence_id" IS NOT NULL AND (
    ("pending_occurrence_kind" = 'manual' AND "pending_occurrence_at" IS NULL)
    OR
    ("pending_occurrence_kind" = 'scheduled' AND "pending_occurrence_at" IS NOT NULL)
  ))
);--> statement-breakpoint
CREATE INDEX "agents_runtime_sync_pending_idx" ON "agents" USING btree ("runtime_sync_version","runtime_sync_lease_expires_at") WHERE "agents"."provision_status" = 'ready' and "agents"."openclaw_id" is not null and "agents"."workspace_path" is not null and "agents"."runtime_sync_version" > "agents"."runtime_synced_version";--> statement-breakpoint
CREATE INDEX "triggers_pending_occurrence_idx" ON "triggers" USING btree ("pending_occurrence_id","updated_at") WHERE "triggers"."pending_occurrence_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_dream_runs_live_agent_uq" ON "memory_dream_runs" USING btree ("agent_account_id") WHERE "memory_dream_runs"."status" in ('running', 'recovery_pending');--> statement-breakpoint
CREATE INDEX "channel_turns_open_updated_idx" ON "channel_turns" USING btree ("status","updated_at") WHERE "channel_turns"."status" in ('reserving', 'reserved', 'settling', 'delivery_pending', 'refunding', 'error');
