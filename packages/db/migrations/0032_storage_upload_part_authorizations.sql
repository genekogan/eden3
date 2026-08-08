CREATE TABLE "storage_policy_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" uuid NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"policy_code" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "storage_policy_events_event_type_check" CHECK ("storage_policy_events"."event_type" = 'quarantine_required'),
	CONSTRAINT "storage_policy_events_policy_code_check" CHECK ("storage_policy_events"."policy_code" ~ '^[a-z0-9_:-]{1,100}$'),
	CONSTRAINT "storage_policy_events_state_check" CHECK ("storage_policy_events"."state" in ('pending', 'delivering', 'delivered', 'failed')),
	CONSTRAINT "storage_policy_events_attempt_count_check" CHECK ("storage_policy_events"."attempt_count" >= 0),
	CONSTRAINT "storage_policy_events_last_error_code_check" CHECK ("storage_policy_events"."last_error_code" is null or "storage_policy_events"."last_error_code" ~ '^[a-z0-9_:-]{1,100}$'),
	CONSTRAINT "storage_policy_events_claim_shape_check" CHECK (("storage_policy_events"."state" = 'delivering' and "storage_policy_events"."claim_token" is not null and "storage_policy_events"."claim_expires_at" is not null) or ("storage_policy_events"."state" <> 'delivering' and "storage_policy_events"."claim_token" is null and "storage_policy_events"."claim_expires_at" is null)),
	CONSTRAINT "storage_policy_events_schedule_shape_check" CHECK (("storage_policy_events"."state" = 'pending' and "storage_policy_events"."next_attempt_at" is not null) or ("storage_policy_events"."state" <> 'pending' and "storage_policy_events"."next_attempt_at" is null)),
	CONSTRAINT "storage_policy_events_delivery_shape_check" CHECK (("storage_policy_events"."state" = 'delivered' and "storage_policy_events"."delivered_at" is not null) or ("storage_policy_events"."state" <> 'delivered' and "storage_policy_events"."delivered_at" is null))
);
--> statement-breakpoint
CREATE TABLE "storage_upload_part_authorizations" (
	"upload_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_upload_part_authorizations_upload_id_part_number_pk" PRIMARY KEY("upload_id","part_number"),
	CONSTRAINT "storage_upload_part_authorizations_number_check" CHECK ("storage_upload_part_authorizations"."part_number" between 1 and 10000),
	CONSTRAINT "storage_upload_part_authorizations_checksum_check" CHECK ("storage_upload_part_authorizations"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "storage_upload_part_authorizations_size_check" CHECK ("storage_upload_part_authorizations"."size_bytes" > 0),
	CONSTRAINT "storage_upload_part_authorizations_expiry_check" CHECK ("storage_upload_part_authorizations"."expires_at" > "storage_upload_part_authorizations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "storage_policy_events" ADD CONSTRAINT "storage_policy_events_object_id_storage_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."storage_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_policy_events" ADD CONSTRAINT "storage_policy_events_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_policy_events" ADD CONSTRAINT "storage_policy_events_object_owner_fk" FOREIGN KEY ("object_id","owner_account_id") REFERENCES "public"."storage_objects"("id","owner_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_upload_part_authorizations" ADD CONSTRAINT "storage_upload_part_authorizations_upload_id_storage_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."storage_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_policy_events_object_type_policy_uq" ON "storage_policy_events" USING btree ("object_id","event_type","policy_code");--> statement-breakpoint
CREATE INDEX "storage_policy_events_due_idx" ON "storage_policy_events" USING btree ("next_attempt_at") WHERE "storage_policy_events"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "storage_policy_events_claim_expiry_idx" ON "storage_policy_events" USING btree ("claim_expires_at") WHERE "storage_policy_events"."state" = 'delivering';--> statement-breakpoint

-- T21b-U01/U02: the durable claim stores signed capability geometry, never the
-- bearer. Locking the parent serializes authorization with upload completion.
CREATE OR REPLACE FUNCTION "storage_upload_part_authorization_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_upload_id uuid;
	parent_state text;
	parent_part_size bigint;
	parent_expires_at timestamptz;
	parent_capability_expires_at timestamptz;
	declared_size bigint;
	declared_part_count bigint;
	expected_part_size bigint;
BEGIN
	IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
		RETURN OLD;
	END IF;

	IF TG_OP = 'DELETE' THEN
		target_upload_id := OLD."upload_id";
	ELSE
		target_upload_id := NEW."upload_id";
	END IF;

	SELECT u."state", u."part_size_bytes", u."expires_at", u."capability_expires_at",
		o."declared_size_bytes"
	INTO parent_state, parent_part_size, parent_expires_at,
		parent_capability_expires_at, declared_size
	FROM "storage_uploads" u
	JOIN "storage_objects" o ON o."id" = u."object_id"
	WHERE u."id" = target_upload_id
	FOR UPDATE OF u;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'storage upload authorization parent does not exist'
			USING ERRCODE = '23503';
	END IF;

	IF TG_OP = 'DELETE' THEN
		IF parent_state IN ('completed', 'aborted', 'expired') THEN
			RAISE EXCEPTION 'terminal storage upload authorizations are immutable'
				USING ERRCODE = '23514';
		END IF;
		RETURN OLD;
	END IF;

	IF parent_state NOT IN ('initiated', 'uploading') THEN
		RAISE EXCEPTION 'storage upload is not active'
			USING ERRCODE = '23514';
	END IF;

	IF declared_size <= 0 THEN
		RAISE EXCEPTION 'empty objects have no upload part authorizations'
			USING ERRCODE = '23514';
	END IF;

	declared_part_count := (declared_size + parent_part_size - 1) / parent_part_size;
	IF NEW."part_number" > declared_part_count THEN
		RAISE EXCEPTION 'upload part number exceeds declared object geometry'
			USING ERRCODE = '23514';
	END IF;
	IF NEW."part_number" < declared_part_count THEN
		expected_part_size := parent_part_size;
	ELSE
		expected_part_size := declared_size - (parent_part_size * (declared_part_count - 1));
	END IF;
	IF NEW."size_bytes" IS DISTINCT FROM expected_part_size THEN
		RAISE EXCEPTION 'upload part size does not match declared object geometry'
			USING ERRCODE = '23514';
	END IF;

	IF NEW."expires_at" > LEAST(parent_expires_at, parent_capability_expires_at) THEN
		RAISE EXCEPTION 'upload part authorization exceeds parent expiry'
			USING ERRCODE = '23514';
	END IF;

	IF TG_OP = 'UPDATE' THEN
		IF NEW."upload_id" IS DISTINCT FROM OLD."upload_id"
			OR NEW."part_number" IS DISTINCT FROM OLD."part_number"
			OR NEW."checksum_sha256" IS DISTINCT FROM OLD."checksum_sha256"
			OR NEW."size_bytes" IS DISTINCT FROM OLD."size_bytes"
		THEN
			RAISE EXCEPTION 'upload part authorization claims are immutable'
				USING ERRCODE = '23514';
		END IF;
		IF NEW."expires_at" < OLD."expires_at" THEN
			RAISE EXCEPTION 'upload part authorization expiry cannot shrink'
				USING ERRCODE = '23514';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "storage_upload_part_authorizations_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "storage_upload_part_authorizations"
FOR EACH ROW EXECUTE FUNCTION "storage_upload_part_authorization_guard"();--> statement-breakpoint

-- T21b-U03: minimal quarantine notification outbox. Row updates are the CAS;
-- the stable event id is the downstream delivery idempotency key.
CREATE OR REPLACE FUNCTION "storage_policy_event_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW."state" <> 'pending' OR NEW."attempt_count" <> 0 THEN
			RAISE EXCEPTION 'storage policy event must start pending at attempt zero'
				USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW."object_id" IS DISTINCT FROM OLD."object_id"
		OR NEW."owner_account_id" IS DISTINCT FROM OLD."owner_account_id"
		OR NEW."event_type" IS DISTINCT FROM OLD."event_type"
		OR NEW."policy_code" IS DISTINCT FROM OLD."policy_code"
	THEN
		RAISE EXCEPTION 'storage policy event identity is immutable'
			USING ERRCODE = '23514';
	END IF;

	IF NEW."attempt_count" < OLD."attempt_count" THEN
		RAISE EXCEPTION 'storage policy event attempt count cannot decrease'
			USING ERRCODE = '23514';
	END IF;

	IF NEW."state" IS DISTINCT FROM OLD."state" THEN
		IF OLD."state" IN ('delivered', 'failed') THEN
			RAISE EXCEPTION 'terminal storage policy event state is immutable'
				USING ERRCODE = '23514';
		ELSIF (OLD."state" = 'pending' AND NEW."state" = 'delivering')
			OR (OLD."state" = 'delivering' AND NEW."state" IN ('delivered', 'pending', 'failed'))
		THEN
			NULL;
		ELSE
			RAISE EXCEPTION 'illegal storage policy event transition: % -> %', OLD."state", NEW."state"
				USING ERRCODE = '23514';
		END IF;
	END IF;

	IF OLD."state" = 'pending' AND NEW."state" = 'delivering'
		AND NEW."attempt_count" <> OLD."attempt_count" + 1
	THEN
		RAISE EXCEPTION 'claiming a storage policy event increments attempt count once'
			USING ERRCODE = '23514';
	END IF;

	IF OLD."state" = 'delivering' AND NEW."state" = 'delivering'
		AND (NEW."claim_token" IS DISTINCT FROM OLD."claim_token"
			OR NEW."claim_expires_at" IS DISTINCT FROM OLD."claim_expires_at")
	THEN
		RAISE EXCEPTION 'active storage policy event claim is immutable'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "storage_policy_events_guard"
BEFORE INSERT OR UPDATE ON "storage_policy_events"
FOR EACH ROW EXECUTE FUNCTION "storage_policy_event_guard"();
