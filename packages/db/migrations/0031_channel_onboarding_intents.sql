CREATE TABLE "channel_onboarding_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"channel" text DEFAULT 'telegram' NOT NULL,
	"intent_secret_hash" text NOT NULL,
	"provider_owner_id_hash" text,
	"suggested_bot_username" text,
	"state" text DEFAULT 'pending_owner' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"connection_id" uuid,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_onboarding_intents_channel_check" CHECK ("channel_onboarding_intents"."channel" = 'telegram'),
	CONSTRAINT "channel_onboarding_intents_state_check" CHECK ("channel_onboarding_intents"."state" in ('pending_owner', 'awaiting_bot', 'exchanging', 'stored', 'expired', 'failed')),
	CONSTRAINT "channel_onboarding_intents_intent_hash_check" CHECK ("channel_onboarding_intents"."intent_secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "channel_onboarding_intents_owner_hash_check" CHECK ("channel_onboarding_intents"."provider_owner_id_hash" is null or "channel_onboarding_intents"."provider_owner_id_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "channel_onboarding_intents_expiry_check" CHECK ("channel_onboarding_intents"."expires_at" > "channel_onboarding_intents"."created_at"),
	CONSTRAINT "channel_onboarding_intents_username_check" CHECK ("channel_onboarding_intents"."suggested_bot_username" is null or char_length("channel_onboarding_intents"."suggested_bot_username") <= 32),
	CONSTRAINT "channel_onboarding_intents_error_code_check" CHECK ("channel_onboarding_intents"."last_error_code" is null or "channel_onboarding_intents"."last_error_code" ~ '^[a-z0-9_:-]{1,64}$'),
	CONSTRAINT "channel_onboarding_intents_owner_state_check" CHECK (("channel_onboarding_intents"."state" = 'pending_owner' and "channel_onboarding_intents"."provider_owner_id_hash" is null) or ("channel_onboarding_intents"."state" in ('awaiting_bot', 'exchanging', 'stored') and "channel_onboarding_intents"."provider_owner_id_hash" is not null) or "channel_onboarding_intents"."state" in ('expired', 'failed')),
	CONSTRAINT "channel_onboarding_intents_connection_state_check" CHECK ("channel_onboarding_intents"."connection_id" is null or "channel_onboarding_intents"."state" = 'stored')
);
--> statement-breakpoint
ALTER TABLE "channel_onboarding_intents" ADD CONSTRAINT "channel_onboarding_intents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_onboarding_intents" ADD CONSTRAINT "channel_onboarding_intents_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_onboarding_intents_secret_uq" ON "channel_onboarding_intents" USING btree ("intent_secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_onboarding_intents_active_account_uq" ON "channel_onboarding_intents" USING btree ("account_id","channel") WHERE "channel_onboarding_intents"."state" in ('pending_owner', 'awaiting_bot', 'exchanging');--> statement-breakpoint
CREATE UNIQUE INDEX "channel_onboarding_intents_active_owner_uq" ON "channel_onboarding_intents" USING btree ("channel","provider_owner_id_hash") WHERE "channel_onboarding_intents"."provider_owner_id_hash" is not null and "channel_onboarding_intents"."state" in ('awaiting_bot', 'exchanging');--> statement-breakpoint
CREATE INDEX "channel_onboarding_intents_active_expiry_idx" ON "channel_onboarding_intents" USING btree ("state","expires_at") WHERE "channel_onboarding_intents"."state" in ('pending_owner', 'awaiting_bot', 'exchanging');--> statement-breakpoint
CREATE INDEX "channel_onboarding_intents_connection_idx" ON "channel_onboarding_intents" USING btree ("connection_id") WHERE "channel_onboarding_intents"."connection_id" is not null;--> statement-breakpoint

-- T10-U04: one row-locked CAS lifecycle. Immutable lookup material prevents a
-- stale/replayed provider update from rebinding an intent. The only permitted
-- connection_id removal is the FK's ON DELETE SET NULL on a stored terminal.
CREATE OR REPLACE FUNCTION "channel_onboarding_intent_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW."state" <> 'pending_owner' THEN
			RAISE EXCEPTION 'channel onboarding intent must start pending_owner'
				USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."account_id" IS DISTINCT FROM OLD."account_id"
		OR NEW."channel" IS DISTINCT FROM OLD."channel"
		OR NEW."intent_secret_hash" IS DISTINCT FROM OLD."intent_secret_hash"
		OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
	THEN
		RAISE EXCEPTION 'channel onboarding intent identity and expiry are immutable'
			USING ERRCODE = '23514';
	END IF;

	IF OLD."provider_owner_id_hash" IS NOT NULL AND NEW."provider_owner_id_hash" IS DISTINCT FROM OLD."provider_owner_id_hash" THEN
		RAISE EXCEPTION 'channel onboarding provider owner binding is immutable'
			USING ERRCODE = '23514';
	END IF;

	IF NEW."state" IS DISTINCT FROM OLD."state" THEN
		IF OLD."state" IN ('stored', 'expired', 'failed') THEN
			RAISE EXCEPTION 'terminal channel onboarding state is immutable'
				USING ERRCODE = '23514';
		ELSIF (OLD."state" = 'pending_owner' AND NEW."state" IN ('awaiting_bot', 'expired', 'failed'))
			OR (OLD."state" = 'awaiting_bot' AND NEW."state" IN ('exchanging', 'expired', 'failed'))
			OR (OLD."state" = 'exchanging' AND NEW."state" IN ('stored', 'expired', 'failed'))
		THEN
			NULL;
		ELSE
			RAISE EXCEPTION 'illegal channel onboarding lifecycle transition: % -> %', OLD."state", NEW."state"
				USING ERRCODE = '23514';
		END IF;
	END IF;

	IF NEW."connection_id" IS DISTINCT FROM OLD."connection_id" THEN
		IF OLD."state" = 'stored' AND OLD."connection_id" IS NOT NULL AND NEW."connection_id" IS NULL THEN
			-- Required for the declared ON DELETE SET NULL referential action.
			NULL;
		ELSIF OLD."state" = 'exchanging' AND NEW."state" = 'stored'
			AND OLD."connection_id" IS NULL AND NEW."connection_id" IS NOT NULL
		THEN
			NULL;
		ELSE
			RAISE EXCEPTION 'channel onboarding connection binding is immutable'
				USING ERRCODE = '23514';
		END IF;
	END IF;

	IF NEW."state" = 'stored' AND NEW."connection_id" IS NULL
		AND NOT (OLD."state" = 'stored' AND OLD."connection_id" IS NOT NULL)
	THEN
		RAISE EXCEPTION 'stored channel onboarding intent requires a connection'
			USING ERRCODE = '23514';
	END IF;

	IF NEW."connection_id" IS NOT NULL THEN
		PERFORM 1
		FROM "channel_connections"
		WHERE "id" = NEW."connection_id"
			AND "account_id" = NEW."account_id"
			AND "channel" = 'telegram';
		IF NOT FOUND THEN
			RAISE EXCEPTION 'channel onboarding connection owner/channel mismatch'
				USING ERRCODE = '23514';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "channel_onboarding_intents_guard"
BEFORE INSERT OR UPDATE ON "channel_onboarding_intents"
FOR EACH ROW EXECUTE FUNCTION "channel_onboarding_intent_guard"();
