ALTER TABLE "channel_turns" ADD COLUMN "provenance_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
-- 0021 could not prove these values were frozen before provider work. Remove
-- every inferred snapshot first, then recover only terminal rows that have a
-- matching channel usage event carrying all immutable provenance explicitly.
UPDATE "channel_turns"
SET "channel" = NULL,
    "runtime_account_id" = NULL,
    "model" = NULL,
    "agent_runtime" = NULL,
    "pricing_basis" = NULL
WHERE "provenance_status" = 'unknown';--> statement-breakpoint
WITH "recoverable" AS (
  SELECT
    t."turn_id",
    u."metadata" ->> 'channel' AS "channel",
    u."metadata" ->> 'runtimeAccountId' AS "runtime_account_id",
    CASE
      WHEN position('/' IN u."model") > 0 THEN u."model"
      ELSE u."provider" || '/' || u."model"
    END AS "model",
    u."metadata" ->> 'agentRuntime' AS "agent_runtime",
    u."pricing_basis"
  FROM "channel_turns" AS t
  JOIN "usage_events" AS u
    ON u."turn_id" = t."turn_id"
   AND u."event_type" = 'channel_chat'
  WHERE t."provenance_status" = 'unknown'
    AND t."status" IN ('settled', 'refunded')
    AND u."provider" IS NOT NULL
    AND btrim(u."provider") <> ''
    AND u."model" IS NOT NULL
    AND btrim(u."model") <> ''
    AND (
      position('/' IN u."model") = 0
      OR split_part(u."model", '/', 1) = u."provider"
    )
    AND u."metadata" ->> 'channel' IN ('discord', 'telegram')
    AND COALESCE(u."metadata" ->> 'runtimeAccountId', '') <> ''
    AND (
      (u."metadata" ->> 'agentRuntime' = 'openclaw'
       AND u."pricing_basis" = 'provider-api')
      OR
      (u."metadata" ->> 'agentRuntime' = 'claude-cli'
       AND u."pricing_basis" = 'notional-subscription')
    )
    AND (t."account_id" IS NULL OR u."user_id" = t."account_id")
    AND (t."agent_id" IS NULL OR u."agent_id" = t."agent_id")
    AND (t."session_id" IS NULL OR u."session_id" = t."session_id")
    AND (
      t."connection_id" IS NULL
      OR u."metadata" ->> 'connectionId' = t."connection_id"::text
    )
)
UPDATE "channel_turns" AS t
SET "channel" = r."channel",
    "runtime_account_id" = r."runtime_account_id",
    "model" = r."model",
    "agent_runtime" = r."agent_runtime",
    "pricing_basis" = r."pricing_basis",
    "provenance_status" = 'recovered_usage_event'
FROM "recoverable" AS r
WHERE t."turn_id" = r."turn_id";--> statement-breakpoint
-- Unknown in-flight rows are never settleable. Age them into the existing
-- idempotent stale-refund path immediately; both reserve and adjustment keys
-- are refunded there without needing account/model/runtime provenance.
UPDATE "channel_turns"
SET "status" = 'error',
    "provenance_status" = 'legacy_refund_pending',
    "metered_manna" = NULL,
    "error_code" = 'legacy_provenance_unknown',
    "completed_at" = NULL,
    "updated_at" = LEAST("updated_at", now() - interval '46 minutes')
WHERE "provenance_status" = 'unknown'
  AND "status" IN ('reserving', 'reserved', 'settling', 'refunding', 'error');--> statement-breakpoint
-- A terminal row without complete usage provenance remains terminal but is
-- explicitly non-billable/unattributed. Replays fail before model validation
-- and cannot create a usage event, ledger debit, or delivered response.
UPDATE "channel_turns"
SET "provenance_status" = 'legacy_terminal_unknown',
    "error_code" = COALESCE("error_code", 'legacy_provenance_unknown')
WHERE "provenance_status" = 'unknown';--> statement-breakpoint
CREATE INDEX "channel_turns_open_updated_idx" ON "channel_turns" USING btree ("status","updated_at") WHERE "channel_turns"."status" in ('reserving', 'reserved', 'settling', 'refunding', 'error');
