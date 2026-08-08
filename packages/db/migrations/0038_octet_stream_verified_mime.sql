-- Fail before changing the serving lifecycle if the installed 0037 constraint
-- differs from the exact definition this migration was reviewed against. The
-- temporary constraint lets PostgreSQL canonicalize both expressions itself.
DO $$
DECLARE
	actual_definition text;
	expected_definition text;
	actual_validated boolean;
	actual_no_inherit boolean;
BEGIN
	SELECT pg_get_expr(c.conbin, c.conrelid, true), c.convalidated, c.connoinherit
	INTO actual_definition, actual_validated, actual_no_inherit
	FROM pg_constraint c
	JOIN pg_class r ON r.oid = c.conrelid
	JOIN pg_namespace n ON n.oid = r.relnamespace
	WHERE n.nspname = 'public'
		AND r.relname = 'storage_objects'
		AND c.conname = 'storage_objects_lifecycle_shape_check'
		AND c.contype = 'c';

	IF actual_definition IS NULL OR actual_validated IS DISTINCT FROM true OR actual_no_inherit THEN
		RAISE EXCEPTION 'expected validated storage_objects_lifecycle_shape_check is missing or changed'
			USING ERRCODE = '23514';
	END IF;

	CREATE TEMP TABLE eden3_expected_storage_object_lifecycle (
		state text,
		verified_mime text,
		declared_mime text,
		verified_size_bytes bigint,
		declared_size_bytes bigint,
		verified_sha256 text,
		declared_sha256 text,
		available_at timestamptz
	) ON COMMIT DROP;
	ALTER TABLE pg_temp.eden3_expected_storage_object_lifecycle
		ADD CONSTRAINT eden3_expected_storage_object_lifecycle_check CHECK (
			(state in ('pending', 'uploaded') and verified_mime is null and verified_size_bytes is null and verified_sha256 is null and available_at is null)
			or (state = 'verified' and verified_mime = declared_mime and verified_size_bytes = declared_size_bytes and verified_sha256 = declared_sha256 and available_at is null)
			or (state = 'available' and verified_mime = declared_mime and verified_size_bytes = declared_size_bytes and verified_sha256 = declared_sha256 and available_at is not null)
			or (state in ('quarantined', 'failed') and available_at is null)
		);

	SELECT pg_get_expr(c.conbin, c.conrelid, true)
	INTO expected_definition
	FROM pg_constraint c
	JOIN pg_class r ON r.oid = c.conrelid
	WHERE r.relnamespace = pg_my_temp_schema()
		AND r.relname = 'eden3_expected_storage_object_lifecycle'
		AND c.conname = 'eden3_expected_storage_object_lifecycle_check';

	DROP TABLE pg_temp.eden3_expected_storage_object_lifecycle;
	IF actual_definition IS DISTINCT FROM expected_definition THEN
		RAISE EXCEPTION 'storage_objects_lifecycle_shape_check drifted before 0038'
			USING ERRCODE = '23514';
	END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE "storage_objects" DROP CONSTRAINT "storage_objects_lifecycle_shape_check";--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_lifecycle_shape_check" CHECK (("storage_objects"."state" in ('pending', 'uploaded') and "storage_objects"."verified_mime" is null and "storage_objects"."verified_size_bytes" is null and "storage_objects"."verified_sha256" is null and "storage_objects"."available_at" is null) or ("storage_objects"."state" = 'verified' and (("storage_objects"."declared_mime" <> 'application/octet-stream' and "storage_objects"."verified_mime" = "storage_objects"."declared_mime") or ("storage_objects"."declared_mime" = 'application/octet-stream' and "storage_objects"."verified_mime" in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/webm', 'video/mp4', 'audio/wav', 'audio/mpeg', 'application/json', 'text/plain'))) and "storage_objects"."verified_size_bytes" = "storage_objects"."declared_size_bytes" and "storage_objects"."verified_sha256" = "storage_objects"."declared_sha256" and "storage_objects"."available_at" is null) or ("storage_objects"."state" = 'available' and (("storage_objects"."declared_mime" <> 'application/octet-stream' and "storage_objects"."verified_mime" = "storage_objects"."declared_mime") or ("storage_objects"."declared_mime" = 'application/octet-stream' and "storage_objects"."verified_mime" in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/webm', 'video/mp4', 'audio/wav', 'audio/mpeg', 'application/json', 'text/plain'))) and "storage_objects"."verified_size_bytes" = "storage_objects"."declared_size_bytes" and "storage_objects"."verified_sha256" = "storage_objects"."declared_sha256" and "storage_objects"."available_at" is not null) or ("storage_objects"."state" in ('quarantined', 'failed') and "storage_objects"."available_at" is null));
