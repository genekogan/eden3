ALTER TABLE "storage_uploads" ADD COLUMN "cleanup_state" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD COLUMN "cleanup_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD COLUMN "cleanup_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD COLUMN "cleanup_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD COLUMN "cleanup_claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD COLUMN "cleanup_enqueued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD COLUMN "cleanup_succeeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD COLUMN "cleanup_last_error_code" text;--> statement-breakpoint
CREATE INDEX "storage_uploads_cleanup_due_idx" ON "storage_uploads" USING btree ("cleanup_next_attempt_at","id") WHERE "storage_uploads"."cleanup_state" = 'pending';--> statement-breakpoint
CREATE INDEX "storage_uploads_cleanup_claim_expiry_idx" ON "storage_uploads" USING btree ("cleanup_claim_expires_at","id") WHERE "storage_uploads"."cleanup_state" = 'claimed';--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD CONSTRAINT "storage_uploads_cleanup_state_check" CHECK ("storage_uploads"."cleanup_state" in ('not_required', 'pending', 'claimed', 'succeeded', 'failed'));--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD CONSTRAINT "storage_uploads_cleanup_attempt_bounds_check" CHECK ("storage_uploads"."cleanup_attempt_count" between 0 and 100);--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD CONSTRAINT "storage_uploads_cleanup_error_code_check" CHECK ("storage_uploads"."cleanup_last_error_code" is null or "storage_uploads"."cleanup_last_error_code" ~ '^[a-z][a-z0-9_]{0,99}$');--> statement-breakpoint

-- DEBT-018: terminal multipart sessions carry a durable, lease-fenced provider
-- cleanup obligation. No provider authorization material, URL, or payload is stored.
CREATE OR REPLACE FUNCTION "storage_upload_transition_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."object_id" IS DISTINCT FROM OLD."object_id"
		OR NEW."owner_account_id" IS DISTINCT FROM OLD."owner_account_id"
		OR NEW."backend_multipart_id" IS DISTINCT FROM OLD."backend_multipart_id"
		OR NEW."part_size_bytes" IS DISTINCT FROM OLD."part_size_bytes"
		OR NEW."max_parts" IS DISTINCT FROM OLD."max_parts"
		OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
		OR NEW."capability_expires_at" IS DISTINCT FROM OLD."capability_expires_at"
	THEN
		RAISE EXCEPTION 'storage upload identity and capability geometry are immutable'
			USING ERRCODE = '23514';
	END IF;

	IF NEW."state" IS DISTINCT FROM OLD."state" THEN
		IF OLD."state" IN ('completed', 'aborted', 'expired') THEN
			RAISE EXCEPTION 'terminal storage upload state is immutable'
				USING ERRCODE = '23514';
		ELSIF (OLD."state" = 'initiated' AND NEW."state" IN ('uploading', 'completed', 'aborted', 'expired'))
			OR (OLD."state" = 'uploading' AND NEW."state" IN ('completed', 'aborted', 'expired'))
		THEN
			NULL;
		ELSE
			RAISE EXCEPTION 'illegal storage upload lifecycle transition: % -> %', OLD."state", NEW."state"
				USING ERRCODE = '23514';
		END IF;
	END IF;

	IF NEW."state" IS DISTINCT FROM OLD."state" AND NEW."state" IN ('aborted', 'expired') THEN
		NEW."cleanup_state" := 'pending';
		NEW."cleanup_attempt_count" := 0;
		NEW."cleanup_next_attempt_at" := statement_timestamp();
		NEW."cleanup_claim_token" := NULL;
		NEW."cleanup_claim_expires_at" := NULL;
		NEW."cleanup_enqueued_at" := statement_timestamp();
		NEW."cleanup_succeeded_at" := NULL;
		NEW."cleanup_last_error_code" := NULL;
	ELSIF NEW."state" IN ('initiated', 'uploading', 'completed') THEN
		IF NEW."cleanup_state" IS DISTINCT FROM OLD."cleanup_state"
			OR NEW."cleanup_attempt_count" IS DISTINCT FROM OLD."cleanup_attempt_count"
			OR NEW."cleanup_next_attempt_at" IS DISTINCT FROM OLD."cleanup_next_attempt_at"
			OR NEW."cleanup_claim_token" IS DISTINCT FROM OLD."cleanup_claim_token"
			OR NEW."cleanup_claim_expires_at" IS DISTINCT FROM OLD."cleanup_claim_expires_at"
			OR NEW."cleanup_enqueued_at" IS DISTINCT FROM OLD."cleanup_enqueued_at"
			OR NEW."cleanup_succeeded_at" IS DISTINCT FROM OLD."cleanup_succeeded_at"
			OR NEW."cleanup_last_error_code" IS DISTINCT FROM OLD."cleanup_last_error_code"
		THEN
			RAISE EXCEPTION 'active or completed upload cannot carry cleanup state'
				USING ERRCODE = '23514';
		END IF;
	ELSIF OLD."cleanup_state" = 'not_required' AND NEW."cleanup_state" = 'pending' THEN
		IF OLD."state" NOT IN ('aborted', 'expired')
			OR NEW."cleanup_attempt_count" <> 0
			OR NEW."cleanup_next_attempt_at" IS NULL
			OR NEW."cleanup_claim_token" IS NOT NULL
			OR NEW."cleanup_claim_expires_at" IS NOT NULL
			OR NEW."cleanup_enqueued_at" IS NULL
			OR NEW."cleanup_succeeded_at" IS NOT NULL
			OR NEW."cleanup_last_error_code" IS NOT NULL
		THEN
			RAISE EXCEPTION 'invalid legacy multipart cleanup enqueue'
				USING ERRCODE = '23514';
		END IF;
	ELSIF OLD."cleanup_state" = 'pending' AND NEW."cleanup_state" = 'claimed' THEN
		IF NEW."cleanup_attempt_count" <> OLD."cleanup_attempt_count" + 1
			OR NEW."cleanup_next_attempt_at" IS NOT NULL
			OR NEW."cleanup_claim_token" IS NULL
			OR NEW."cleanup_claim_expires_at" IS NULL
			OR NEW."cleanup_claim_expires_at" <= statement_timestamp()
			OR NEW."cleanup_succeeded_at" IS NOT NULL
		THEN
			RAISE EXCEPTION 'invalid multipart cleanup claim'
				USING ERRCODE = '23514';
		END IF;
	ELSIF OLD."cleanup_state" = 'claimed' AND NEW."cleanup_state" = 'pending' THEN
		IF NEW."cleanup_attempt_count" <> OLD."cleanup_attempt_count"
			OR NEW."cleanup_next_attempt_at" IS NULL
			OR NEW."cleanup_claim_token" IS NOT NULL
			OR NEW."cleanup_claim_expires_at" IS NOT NULL
			OR NEW."cleanup_succeeded_at" IS NOT NULL
			OR NEW."cleanup_last_error_code" IS NULL
		THEN
			RAISE EXCEPTION 'invalid multipart cleanup retry'
				USING ERRCODE = '23514';
		END IF;
	ELSIF OLD."cleanup_state" = 'claimed' AND NEW."cleanup_state" = 'succeeded' THEN
		IF NEW."cleanup_attempt_count" <> OLD."cleanup_attempt_count"
			OR NEW."cleanup_next_attempt_at" IS NOT NULL
			OR NEW."cleanup_claim_token" IS NOT NULL
			OR NEW."cleanup_claim_expires_at" IS NOT NULL
			OR NEW."cleanup_succeeded_at" IS NULL
			OR NEW."cleanup_last_error_code" IS NOT NULL
		THEN
			RAISE EXCEPTION 'invalid multipart cleanup success'
				USING ERRCODE = '23514';
		END IF;
	ELSIF OLD."cleanup_state" = 'claimed' AND NEW."cleanup_state" = 'failed' THEN
		IF NEW."cleanup_attempt_count" <> OLD."cleanup_attempt_count"
			OR NEW."cleanup_next_attempt_at" IS NOT NULL
			OR NEW."cleanup_claim_token" IS NOT NULL
			OR NEW."cleanup_claim_expires_at" IS NOT NULL
			OR NEW."cleanup_succeeded_at" IS NOT NULL
			OR NEW."cleanup_last_error_code" IS NULL
		THEN
			RAISE EXCEPTION 'invalid multipart cleanup terminal failure'
				USING ERRCODE = '23514';
		END IF;
	ELSIF NEW."cleanup_state" IS DISTINCT FROM OLD."cleanup_state"
		OR NEW."cleanup_attempt_count" IS DISTINCT FROM OLD."cleanup_attempt_count"
		OR NEW."cleanup_next_attempt_at" IS DISTINCT FROM OLD."cleanup_next_attempt_at"
		OR NEW."cleanup_claim_token" IS DISTINCT FROM OLD."cleanup_claim_token"
		OR NEW."cleanup_claim_expires_at" IS DISTINCT FROM OLD."cleanup_claim_expires_at"
		OR NEW."cleanup_enqueued_at" IS DISTINCT FROM OLD."cleanup_enqueued_at"
		OR NEW."cleanup_succeeded_at" IS DISTINCT FROM OLD."cleanup_succeeded_at"
		OR NEW."cleanup_last_error_code" IS DISTINCT FROM OLD."cleanup_last_error_code"
	THEN
		RAISE EXCEPTION 'illegal multipart cleanup state transition: % -> %', OLD."cleanup_state", NEW."cleanup_state"
			USING ERRCODE = '23514';
	END IF;

	IF OLD."cleanup_enqueued_at" IS NOT NULL
		AND NEW."cleanup_enqueued_at" IS DISTINCT FROM OLD."cleanup_enqueued_at"
	THEN
		RAISE EXCEPTION 'multipart cleanup enqueue time is immutable'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

-- Existing terminal sessions may represent old provider orphans. Intentionally
-- enqueue every one; AbortMultipartUpload not-found is an idempotent success.
UPDATE "storage_uploads"
SET "cleanup_state" = 'pending',
	"cleanup_next_attempt_at" = statement_timestamp(),
	"cleanup_enqueued_at" = statement_timestamp(),
	"updated_at" = statement_timestamp()
WHERE "state" IN ('aborted', 'expired') AND "cleanup_state" = 'not_required';--> statement-breakpoint

ALTER TABLE "storage_uploads" ADD CONSTRAINT "storage_uploads_cleanup_shape_check" CHECK (("storage_uploads"."state" in ('initiated', 'uploading', 'completed') and "storage_uploads"."cleanup_state" = 'not_required' and "storage_uploads"."cleanup_attempt_count" = 0 and "storage_uploads"."cleanup_next_attempt_at" is null and "storage_uploads"."cleanup_claim_token" is null and "storage_uploads"."cleanup_claim_expires_at" is null and "storage_uploads"."cleanup_enqueued_at" is null and "storage_uploads"."cleanup_succeeded_at" is null and "storage_uploads"."cleanup_last_error_code" is null) or ("storage_uploads"."state" in ('aborted', 'expired') and "storage_uploads"."cleanup_enqueued_at" is not null and "storage_uploads"."cleanup_succeeded_at" is null and (("storage_uploads"."cleanup_state" = 'pending' and "storage_uploads"."cleanup_next_attempt_at" is not null and "storage_uploads"."cleanup_claim_token" is null and "storage_uploads"."cleanup_claim_expires_at" is null) or ("storage_uploads"."cleanup_state" = 'claimed' and "storage_uploads"."cleanup_next_attempt_at" is null and "storage_uploads"."cleanup_claim_token" is not null and "storage_uploads"."cleanup_claim_expires_at" is not null) or ("storage_uploads"."cleanup_state" = 'failed' and "storage_uploads"."cleanup_next_attempt_at" is null and "storage_uploads"."cleanup_claim_token" is null and "storage_uploads"."cleanup_claim_expires_at" is null and "storage_uploads"."cleanup_last_error_code" is not null))) or ("storage_uploads"."state" in ('aborted', 'expired') and "storage_uploads"."cleanup_state" = 'succeeded' and "storage_uploads"."cleanup_enqueued_at" is not null and "storage_uploads"."cleanup_succeeded_at" is not null and "storage_uploads"."cleanup_succeeded_at" >= "storage_uploads"."cleanup_enqueued_at" and "storage_uploads"."cleanup_next_attempt_at" is null and "storage_uploads"."cleanup_claim_token" is null and "storage_uploads"."cleanup_claim_expires_at" is null and "storage_uploads"."cleanup_last_error_code" is null));
