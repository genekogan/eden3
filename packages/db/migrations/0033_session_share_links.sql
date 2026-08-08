CREATE TABLE "session_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"mode" text NOT NULL,
	"title" text,
	"snapshot_boundary_message_id" uuid,
	"snapshot_payload" jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_share_links_token_hash_check" CHECK ("session_share_links"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "session_share_links_mode_check" CHECK ("session_share_links"."mode" in ('snapshot', 'live')),
	CONSTRAINT "session_share_links_title_check" CHECK ("session_share_links"."title" is null or char_length("session_share_links"."title") between 1 and 200),
	CONSTRAINT "session_share_links_snapshot_payload_check" CHECK (jsonb_typeof("session_share_links"."snapshot_payload") = 'object'),
	CONSTRAINT "session_share_links_revoked_at_check" CHECK ("session_share_links"."revoked_at" is null or "session_share_links"."revoked_at" >= "session_share_links"."created_at")
);
--> statement-breakpoint
ALTER TABLE "session_share_links" ADD CONSTRAINT "session_share_links_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_share_links" ADD CONSTRAINT "session_share_links_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_share_links_token_uq" ON "session_share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "session_share_links_session_created_idx" ON "session_share_links" USING btree ("session_id","created_at" DESC NULLS LAST);--> statement-breakpoint

-- Opaque share identity and snapshot content are immutable. Revocation is a
-- one-way terminal transition; only updated_at remains writable afterward.
CREATE OR REPLACE FUNCTION "session_share_link_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW."revoked_at" IS NOT NULL THEN
			RAISE EXCEPTION 'new session share link must be active'
				USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
		OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
		OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
		OR NEW."mode" IS DISTINCT FROM OLD."mode"
		OR NEW."snapshot_boundary_message_id" IS DISTINCT FROM OLD."snapshot_boundary_message_id"
		OR NEW."snapshot_payload" IS DISTINCT FROM OLD."snapshot_payload"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
	THEN
		RAISE EXCEPTION 'session share identity and snapshot are immutable'
			USING ERRCODE = '23514';
	END IF;

	IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
		RAISE EXCEPTION 'session share revocation is immutable'
			USING ERRCODE = '23514';
	END IF;

	IF OLD."revoked_at" IS NOT NULL AND NEW."title" IS DISTINCT FROM OLD."title" THEN
		RAISE EXCEPTION 'revoked session share link is terminal'
			USING ERRCODE = '23514';
	END IF;

	IF NEW."title" IS DISTINCT FROM OLD."title" AND NEW."revoked_at" IS NOT NULL THEN
		RAISE EXCEPTION 'session share title is editable only before revocation'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "session_share_links_guard"
BEFORE INSERT OR UPDATE ON "session_share_links"
FOR EACH ROW EXECUTE FUNCTION "session_share_link_guard"();
