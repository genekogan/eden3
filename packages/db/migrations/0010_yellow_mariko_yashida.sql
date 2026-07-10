ALTER TABLE "agents" ADD COLUMN "model" text DEFAULT 'anthropic/claude-haiku-4-5' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "thinking_level" text DEFAULT 'balanced' NOT NULL;