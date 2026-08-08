CREATE TABLE "storage_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"display_name" text,
	"declared_mime" text NOT NULL,
	"declared_size_bytes" bigint NOT NULL,
	"declared_sha256" text NOT NULL,
	"verified_mime" text,
	"verified_size_bytes" bigint,
	"verified_sha256" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"backing_store" text NOT NULL,
	"backing_key" text NOT NULL,
	"legacy_source_url" text,
	"quarantine_reason" text,
	"available_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_objects_state_check" CHECK ("storage_objects"."state" in ('pending', 'uploaded', 'verified', 'available', 'quarantined', 'failed')),
	CONSTRAINT "storage_objects_purpose_check" CHECK ("storage_objects"."purpose" in ('chat', 'training-set', 'skill-asset', 'voice-clip', 'concept-reference', 'generated', 'account-export')),
	CONSTRAINT "storage_objects_backing_check" CHECK (("storage_objects"."backing_store" = 'legacy' and "storage_objects"."legacy_source_url" is not null and "storage_objects"."legacy_source_url" ~ '^https://[^[:space:]]+$') or ("storage_objects"."backing_store" in ('local', 'r2') and "storage_objects"."legacy_source_url" is null)),
	CONSTRAINT "storage_objects_key_check" CHECK ("storage_objects"."backing_key" = 'objects/' || left("storage_objects"."id"::text, 2) || '/' || "storage_objects"."id"::text),
	CONSTRAINT "storage_objects_checksum_check" CHECK ("storage_objects"."declared_sha256" ~ '^[0-9a-f]{64}$' and ("storage_objects"."verified_sha256" is null or "storage_objects"."verified_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "storage_objects_metadata_check" CHECK (length("storage_objects"."declared_mime") > 0 and "storage_objects"."declared_size_bytes" >= 0 and (("storage_objects"."verified_mime" is null and "storage_objects"."verified_size_bytes" is null and "storage_objects"."verified_sha256" is null) or ("storage_objects"."verified_mime" is not null and length("storage_objects"."verified_mime") > 0 and "storage_objects"."verified_size_bytes" is not null and "storage_objects"."verified_size_bytes" >= 0 and "storage_objects"."verified_sha256" is not null))),
	CONSTRAINT "storage_objects_lifecycle_shape_check" CHECK (("storage_objects"."state" in ('pending', 'uploaded') and "storage_objects"."verified_mime" is null and "storage_objects"."verified_size_bytes" is null and "storage_objects"."verified_sha256" is null and "storage_objects"."available_at" is null) or ("storage_objects"."state" = 'verified' and "storage_objects"."verified_mime" = "storage_objects"."declared_mime" and "storage_objects"."verified_size_bytes" = "storage_objects"."declared_size_bytes" and "storage_objects"."verified_sha256" = "storage_objects"."declared_sha256" and "storage_objects"."available_at" is null) or ("storage_objects"."state" = 'available' and "storage_objects"."verified_mime" = "storage_objects"."declared_mime" and "storage_objects"."verified_size_bytes" = "storage_objects"."declared_size_bytes" and "storage_objects"."verified_sha256" = "storage_objects"."declared_sha256" and "storage_objects"."available_at" is not null) or ("storage_objects"."state" in ('quarantined', 'failed') and "storage_objects"."available_at" is null)),
	CONSTRAINT "storage_objects_quarantine_reason_check" CHECK (("storage_objects"."state" = 'quarantined' and "storage_objects"."quarantine_reason" is not null and length("storage_objects"."quarantine_reason") > 0) or ("storage_objects"."state" <> 'quarantined' and "storage_objects"."quarantine_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "storage_upload_parts" (
	"upload_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"backend_etag" text NOT NULL,
	"checksum_sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_upload_parts_upload_id_part_number_pk" PRIMARY KEY("upload_id","part_number"),
	CONSTRAINT "storage_upload_parts_number_check" CHECK ("storage_upload_parts"."part_number" between 1 and 10000),
	CONSTRAINT "storage_upload_parts_size_check" CHECK ("storage_upload_parts"."size_bytes" > 0 and "storage_upload_parts"."size_bytes" <= 5368709120),
	CONSTRAINT "storage_upload_parts_checksum_check" CHECK ("storage_upload_parts"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "storage_upload_parts_etag_check" CHECK (length("storage_upload_parts"."backend_etag") > 0)
);
--> statement-breakpoint
CREATE TABLE "storage_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" uuid NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"backend_multipart_id" text NOT NULL,
	"state" text DEFAULT 'initiated' NOT NULL,
	"part_size_bytes" bigint NOT NULL,
	"max_parts" integer DEFAULT 10000 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"capability_expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_uploads_state_check" CHECK ("storage_uploads"."state" in ('initiated', 'uploading', 'completed', 'aborted', 'expired')),
	CONSTRAINT "storage_uploads_part_bounds_check" CHECK ("storage_uploads"."part_size_bytes" > 0 and "storage_uploads"."part_size_bytes" <= 5368709120 and "storage_uploads"."max_parts" between 1 and 10000),
	CONSTRAINT "storage_uploads_expiry_check" CHECK ("storage_uploads"."capability_expires_at" > "storage_uploads"."created_at" and "storage_uploads"."capability_expires_at" <= "storage_uploads"."expires_at"),
	CONSTRAINT "storage_uploads_terminal_shape_check" CHECK (("storage_uploads"."state" = 'completed' and "storage_uploads"."completed_at" is not null) or ("storage_uploads"."state" <> 'completed' and "storage_uploads"."completed_at" is null)),
	CONSTRAINT "storage_uploads_backend_id_check" CHECK (length("storage_uploads"."backend_multipart_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_upload_parts" ADD CONSTRAINT "storage_upload_parts_upload_id_storage_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."storage_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_objects_id_owner_uq" ON "storage_objects" USING btree ("id","owner_account_id");--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD CONSTRAINT "storage_uploads_object_owner_fk" FOREIGN KEY ("object_id","owner_account_id") REFERENCES "public"."storage_objects"("id","owner_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_objects_owner_state_idx" ON "storage_objects" USING btree ("owner_account_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_uploads_object_uq" ON "storage_uploads" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "storage_uploads_owner_state_idx" ON "storage_uploads" USING btree ("owner_account_id","state","created_at");--> statement-breakpoint
CREATE INDEX "storage_uploads_expiry_idx" ON "storage_uploads" USING btree ("expires_at") WHERE "storage_uploads"."state" in ('initiated', 'uploading');--> statement-breakpoint

-- T20-U01: database-side immutability and serving-lifecycle fence.
CREATE OR REPLACE FUNCTION "storage_object_transition_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."owner_account_id" IS DISTINCT FROM OLD."owner_account_id"
		OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
		OR NEW."declared_mime" IS DISTINCT FROM OLD."declared_mime"
		OR NEW."declared_size_bytes" IS DISTINCT FROM OLD."declared_size_bytes"
		OR NEW."declared_sha256" IS DISTINCT FROM OLD."declared_sha256"
		OR NEW."backing_store" IS DISTINCT FROM OLD."backing_store"
		OR NEW."backing_key" IS DISTINCT FROM OLD."backing_key"
		OR NEW."legacy_source_url" IS DISTINCT FROM OLD."legacy_source_url"
	THEN
		RAISE EXCEPTION 'storage object identity, declaration, and backing locator are immutable'
			USING ERRCODE = '23514';
	END IF;

	IF NEW."state" IS DISTINCT FROM OLD."state" THEN
		IF OLD."state" IN ('quarantined', 'failed') THEN
			RAISE EXCEPTION 'terminal storage object state is immutable'
				USING ERRCODE = '23514';
		ELSIF (OLD."state" = 'pending' AND NEW."state" = 'uploaded')
			OR (OLD."state" = 'uploaded' AND NEW."state" = 'verified')
			OR (OLD."state" = 'verified' AND NEW."state" = 'available')
			OR (OLD."state" IN ('pending', 'uploaded', 'verified') AND NEW."state" IN ('quarantined', 'failed'))
		THEN
			IF OLD."state" = 'verified' AND NEW."state" = 'available' THEN
				NEW."available_at" := now();
			END IF;
		ELSE
			RAISE EXCEPTION 'illegal storage object lifecycle transition: % -> %', OLD."state", NEW."state"
				USING ERRCODE = '23514';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "storage_objects_transition_guard"
BEFORE UPDATE ON "storage_objects"
FOR EACH ROW EXECUTE FUNCTION "storage_object_transition_guard"();--> statement-breakpoint

-- T21b-U01: session identity and capability geometry cannot be rebound after
-- reservation. Terminal session states cannot be reopened.
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

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "storage_uploads_transition_guard"
BEFORE UPDATE ON "storage_uploads"
FOR EACH ROW EXECUTE FUNCTION "storage_upload_transition_guard"();--> statement-breakpoint

-- Completed-part rows may be replaced for retry/resumption only while the
-- parent session is non-terminal. The row lock serializes this check with a
-- concurrent terminal transition of the parent upload.
CREATE OR REPLACE FUNCTION "storage_upload_part_mutation_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_upload_id uuid;
	parent_state text;
	parent_part_size bigint;
	parent_max_parts integer;
BEGIN
	IF TG_OP = 'DELETE' THEN
		target_upload_id := OLD."upload_id";
	ELSE
		target_upload_id := NEW."upload_id";
	END IF;

	IF TG_OP = 'UPDATE' AND (
		NEW."upload_id" IS DISTINCT FROM OLD."upload_id"
		OR NEW."part_number" IS DISTINCT FROM OLD."part_number"
	) THEN
		RAISE EXCEPTION 'storage upload part identity is immutable'
			USING ERRCODE = '23514';
	END IF;

	SELECT "state", "part_size_bytes", "max_parts"
	INTO parent_state, parent_part_size, parent_max_parts
	FROM "storage_uploads"
	WHERE "id" = target_upload_id
	FOR UPDATE;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'storage upload parent does not exist'
			USING ERRCODE = '23503';
	END IF;

	IF parent_state IN ('completed', 'aborted', 'expired') THEN
		RAISE EXCEPTION 'parts of a terminal storage upload are immutable'
			USING ERRCODE = '23514';
	END IF;

	IF TG_OP <> 'DELETE' AND (
		NEW."part_number" > parent_max_parts
		OR NEW."size_bytes" > parent_part_size
	) THEN
		RAISE EXCEPTION 'storage upload part exceeds its session bounds'
			USING ERRCODE = '23514';
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "storage_upload_parts_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "storage_upload_parts"
FOR EACH ROW EXECUTE FUNCTION "storage_upload_part_mutation_guard"();
