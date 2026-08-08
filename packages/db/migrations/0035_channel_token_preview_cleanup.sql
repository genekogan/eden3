UPDATE "channel_connections"
SET "token_preview" = NULL
WHERE "token_preview" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_connections" DROP COLUMN "token_preview";
