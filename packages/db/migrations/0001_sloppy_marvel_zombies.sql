ALTER TABLE "agents" ADD COLUMN "is_persona_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "cover_creation_external_id" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "contributors" jsonb;--> statement-breakpoint
ALTER TABLE "creations" ADD COLUMN "task_external_id" text;--> statement-breakpoint
ALTER TABLE "creations" ADD COLUMN "args" jsonb;--> statement-breakpoint
ALTER TABLE "creations" ADD COLUMN "attributes" jsonb;--> statement-breakpoint
ALTER TABLE "manna_transactions" ADD COLUMN "stripe_event_id" text;--> statement-breakpoint
ALTER TABLE "manna_transactions" ADD COLUMN "stripe_event_type" text;--> statement-breakpoint
ALTER TABLE "manna_transactions" ADD COLUMN "stripe_event_data" jsonb;--> statement-breakpoint
ALTER TABLE "manna_transactions" ADD COLUMN "voucher_external_id" text;--> statement-breakpoint
ALTER TABLE "manna_transactions" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "eden_message_data" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "thought" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "visible" boolean;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pinned" boolean;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "trigger_external_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "parent_session_external_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "is_public" boolean;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "channel" jsonb;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "session_external_id" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "session_target" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "last_run_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "next_scheduled_run" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "error_count" integer;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "manna_transactions_stripe_event_uq" ON "manna_transactions" USING btree ("stripe_event_id","stripe_event_type") WHERE "manna_transactions"."stripe_event_id" is not null;