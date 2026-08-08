CREATE TABLE "turn_provider_runs" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"provider_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"usable_output_at" timestamp with time zone,
	CONSTRAINT "turn_provider_runs_output_after_start_chk" CHECK ("turn_provider_runs"."usable_output_at" is null or "turn_provider_runs"."usable_output_at" >= "turn_provider_runs"."provider_started_at")
);
--> statement-breakpoint
ALTER TABLE "turn_provider_runs" ADD CONSTRAINT "turn_provider_runs_turn_id_turn_authorizations_turn_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turn_authorizations"("turn_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "turn_provider_run_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_state text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "state" INTO parent_state
      FROM "turn_authorizations"
      WHERE "turn_id" = NEW."turn_id"
      FOR UPDATE;
    IF parent_state IS DISTINCT FROM 'reserved' THEN
      RAISE EXCEPTION 'provider start requires a reserved turn authorization';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."turn_id" IS DISTINCT FROM OLD."turn_id"
     OR NEW."provider_started_at" IS DISTINCT FROM OLD."provider_started_at" THEN
    RAISE EXCEPTION 'turn provider run identity/start timestamp are immutable';
  END IF;
  IF OLD."usable_output_at" IS NOT NULL
     AND NEW."usable_output_at" IS DISTINCT FROM OLD."usable_output_at" THEN
    RAISE EXCEPTION 'usable output timestamp is immutable once recorded';
  END IF;
  IF OLD."usable_output_at" IS NULL AND NEW."usable_output_at" IS NOT NULL THEN
    SELECT "state" INTO parent_state
      FROM "turn_authorizations"
      WHERE "turn_id" = NEW."turn_id"
      FOR UPDATE;
    IF parent_state IS DISTINCT FROM 'reserved' THEN
      RAISE EXCEPTION 'usable output requires a reserved turn authorization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "turn_provider_runs_guard"
BEFORE INSERT OR UPDATE ON "turn_provider_runs"
FOR EACH ROW EXECUTE FUNCTION "turn_provider_run_guard"();
