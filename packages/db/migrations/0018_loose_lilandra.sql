ALTER TABLE "usage_events" ADD COLUMN "pricing_basis" text DEFAULT 'provider-api' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "cache_write_tokens" integer;