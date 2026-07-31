ALTER TABLE "channel_turns" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "channel_turns" ADD COLUMN "runtime_account_id" text;--> statement-breakpoint
ALTER TABLE "channel_turns" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "channel_turns" ADD COLUMN "agent_runtime" text;--> statement-breakpoint
ALTER TABLE "channel_turns" ADD COLUMN "pricing_basis" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "channel_conversation_fingerprint" text;--> statement-breakpoint
UPDATE "sessions"
SET "channel_conversation_fingerprint" = "channel_peer_fingerprint"
WHERE "channel_connection_id" IS NOT NULL
  AND "channel_conversation_fingerprint" IS NULL
  AND "channel_peer_fingerprint" IS NOT NULL;--> statement-breakpoint
UPDATE "channel_turns" AS t
SET "channel" = c."channel",
    "runtime_account_id" = c."runtime_account_id",
    "model" = COALESCE(
      (SELECT a."model" FROM "agents" AS a WHERE a."account_id" = t."agent_id"),
      'anthropic/claude-haiku-4-5'
    ),
    "agent_runtime" = 'openclaw',
    "pricing_basis" = 'provider-api'
FROM "channel_connections" AS c
WHERE t."connection_id" = c."id";--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_channel_conversation_uq" ON "sessions" USING btree ("channel_connection_id","channel_conversation_fingerprint") WHERE "sessions"."channel_connection_id" is not null and "sessions"."channel_conversation_fingerprint" is not null;
