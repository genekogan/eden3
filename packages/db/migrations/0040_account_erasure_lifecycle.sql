CREATE TABLE "account_erasure_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"state" text DEFAULT 'intent_pending' NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ledger_confirmed_at" timestamp with time zone,
	"ledger_sha256" text,
	"ledger_mac_sha256" text,
	"inventoried_at" timestamp with time zone,
	"inventory_sha256" text,
	"recovery_manifest_confirmed_at" timestamp with time zone,
	"recovery_ciphertext_sha256" text,
	"recovery_mac_sha256" text,
	"recovery_key_version" integer,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_erasure_jobs_state_check" CHECK ("account_erasure_jobs"."state" in ('intent_pending', 'claimed', 'manifest_pending', 'pending', 'attention', 'succeeded')),
	CONSTRAINT "account_erasure_jobs_attempt_check" CHECK ("account_erasure_jobs"."attempt_count" >= 0),
	CONSTRAINT "account_erasure_jobs_hash_check" CHECK (("account_erasure_jobs"."ledger_sha256" is null or "account_erasure_jobs"."ledger_sha256" ~ '^[0-9a-f]{64}$') and ("account_erasure_jobs"."ledger_mac_sha256" is null or "account_erasure_jobs"."ledger_mac_sha256" ~ '^[0-9a-f]{64}$') and ("account_erasure_jobs"."inventory_sha256" is null or "account_erasure_jobs"."inventory_sha256" ~ '^[0-9a-f]{64}$') and ("account_erasure_jobs"."recovery_ciphertext_sha256" is null or "account_erasure_jobs"."recovery_ciphertext_sha256" ~ '^[0-9a-f]{64}$') and ("account_erasure_jobs"."recovery_mac_sha256" is null or "account_erasure_jobs"."recovery_mac_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "account_erasure_jobs_error_check" CHECK ("account_erasure_jobs"."last_error_code" is null or "account_erasure_jobs"."last_error_code" ~ '^[a-z][a-z0-9_]{0,99}$'),
	CONSTRAINT "account_erasure_jobs_evidence_group_check" CHECK ((("account_erasure_jobs"."ledger_confirmed_at" is null and "account_erasure_jobs"."ledger_sha256" is null and "account_erasure_jobs"."ledger_mac_sha256" is null) or ("account_erasure_jobs"."ledger_confirmed_at" is not null and "account_erasure_jobs"."ledger_sha256" is not null and "account_erasure_jobs"."ledger_mac_sha256" is not null)) and (("account_erasure_jobs"."inventoried_at" is null and "account_erasure_jobs"."inventory_sha256" is null) or ("account_erasure_jobs"."inventoried_at" is not null and "account_erasure_jobs"."inventory_sha256" is not null)) and (("account_erasure_jobs"."recovery_manifest_confirmed_at" is null and "account_erasure_jobs"."recovery_ciphertext_sha256" is null and "account_erasure_jobs"."recovery_mac_sha256" is null and "account_erasure_jobs"."recovery_key_version" is null) or ("account_erasure_jobs"."recovery_manifest_confirmed_at" is not null and "account_erasure_jobs"."recovery_ciphertext_sha256" is not null and "account_erasure_jobs"."recovery_mac_sha256" is not null and "account_erasure_jobs"."recovery_key_version" >= 1))),
	CONSTRAINT "account_erasure_jobs_shape_check" CHECK (("account_erasure_jobs"."state" = 'intent_pending' and "account_erasure_jobs"."ledger_confirmed_at" is null and "account_erasure_jobs"."inventoried_at" is null and "account_erasure_jobs"."recovery_manifest_confirmed_at" is null and "account_erasure_jobs"."next_attempt_at" is not null and "account_erasure_jobs"."claim_token" is null and "account_erasure_jobs"."claim_expires_at" is null and "account_erasure_jobs"."completed_at" is null) or ("account_erasure_jobs"."state" = 'claimed' and "account_erasure_jobs"."claim_token" is not null and "account_erasure_jobs"."claim_expires_at" is not null and "account_erasure_jobs"."next_attempt_at" is null and "account_erasure_jobs"."completed_at" is null and "account_erasure_jobs"."last_error_code" is null and (("account_erasure_jobs"."ledger_confirmed_at" is null and "account_erasure_jobs"."inventoried_at" is null and "account_erasure_jobs"."recovery_manifest_confirmed_at" is null) or ("account_erasure_jobs"."ledger_confirmed_at" is not null and "account_erasure_jobs"."inventoried_at" is not null and "account_erasure_jobs"."recovery_manifest_confirmed_at" is null))) or ("account_erasure_jobs"."state" = 'manifest_pending' and "account_erasure_jobs"."ledger_confirmed_at" is not null and "account_erasure_jobs"."inventoried_at" is not null and "account_erasure_jobs"."recovery_manifest_confirmed_at" is null and "account_erasure_jobs"."next_attempt_at" is not null and "account_erasure_jobs"."claim_token" is null and "account_erasure_jobs"."claim_expires_at" is null and "account_erasure_jobs"."completed_at" is null) or ("account_erasure_jobs"."state" = 'pending' and "account_erasure_jobs"."ledger_confirmed_at" is not null and "account_erasure_jobs"."inventoried_at" is not null and "account_erasure_jobs"."recovery_manifest_confirmed_at" is not null and "account_erasure_jobs"."next_attempt_at" is null and "account_erasure_jobs"."claim_token" is null and "account_erasure_jobs"."claim_expires_at" is null and "account_erasure_jobs"."completed_at" is null and "account_erasure_jobs"."last_error_code" is null) or ("account_erasure_jobs"."state" = 'attention' and "account_erasure_jobs"."next_attempt_at" is null and "account_erasure_jobs"."claim_token" is null and "account_erasure_jobs"."claim_expires_at" is null and "account_erasure_jobs"."completed_at" is null and "account_erasure_jobs"."last_error_code" is not null) or ("account_erasure_jobs"."state" = 'succeeded' and "account_erasure_jobs"."ledger_confirmed_at" is not null and "account_erasure_jobs"."inventoried_at" is not null and "account_erasure_jobs"."recovery_manifest_confirmed_at" is not null and "account_erasure_jobs"."next_attempt_at" is null and "account_erasure_jobs"."claim_token" is null and "account_erasure_jobs"."claim_expires_at" is null and "account_erasure_jobs"."completed_at" is not null and "account_erasure_jobs"."last_error_code" is null))
);
--> statement-breakpoint
CREATE TABLE "account_erasure_message_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"author_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_erasure_target_requeues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"prior_attempt_count" bigint NOT NULL,
	"operator_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_erasure_target_requeues_attempt_check" CHECK ("account_erasure_target_requeues"."prior_attempt_count" >= 0),
	CONSTRAINT "account_erasure_target_requeues_operator_check" CHECK ("account_erasure_target_requeues"."operator_id" ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
	CONSTRAINT "account_erasure_target_requeues_reason_check" CHECK ("account_erasure_target_requeues"."reason_code" ~ '^[a-z][a-z0-9_]{0,99}$')
);
--> statement-breakpoint
CREATE TABLE "account_erasure_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_erasure_targets_kind_check" CHECK ("account_erasure_targets"."kind" in ('storage_object', 'legacy_media_asset', 'agent_runtime', 'channel_runtime', 'clerk_identity', 'stripe_customer', 'backup_tombstone')),
	CONSTRAINT "account_erasure_targets_state_check" CHECK ("account_erasure_targets"."state" in ('pending', 'claimed', 'attention', 'succeeded')),
	CONSTRAINT "account_erasure_targets_attempt_check" CHECK ("account_erasure_targets"."attempt_count" >= 0),
	CONSTRAINT "account_erasure_targets_error_check" CHECK ("account_erasure_targets"."last_error_code" is null or "account_erasure_targets"."last_error_code" ~ '^[a-z][a-z0-9_]{0,99}$'),
	CONSTRAINT "account_erasure_targets_shape_check" CHECK (("account_erasure_targets"."state" = 'pending' and "account_erasure_targets"."next_attempt_at" is not null and "account_erasure_targets"."claim_token" is null and "account_erasure_targets"."claim_expires_at" is null and "account_erasure_targets"."completed_at" is null) or ("account_erasure_targets"."state" = 'claimed' and "account_erasure_targets"."next_attempt_at" is null and "account_erasure_targets"."claim_token" is not null and "account_erasure_targets"."claim_expires_at" is not null and "account_erasure_targets"."completed_at" is null and "account_erasure_targets"."last_error_code" is null) or ("account_erasure_targets"."state" = 'attention' and "account_erasure_targets"."next_attempt_at" is null and "account_erasure_targets"."claim_token" is null and "account_erasure_targets"."claim_expires_at" is null and "account_erasure_targets"."completed_at" is null and "account_erasure_targets"."last_error_code" is not null) or ("account_erasure_targets"."state" = 'succeeded' and "account_erasure_targets"."next_attempt_at" is null and "account_erasure_targets"."claim_token" is null and "account_erasure_targets"."claim_expires_at" is null and "account_erasure_targets"."completed_at" is not null and "account_erasure_targets"."last_error_code" is null))
);
--> statement-breakpoint
ALTER TABLE "account_erasure_message_tombstones" ADD CONSTRAINT "account_erasure_message_tombstones_job_id_account_erasure_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."account_erasure_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_erasure_target_requeues" ADD CONSTRAINT "account_erasure_target_requeues_job_id_account_erasure_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."account_erasure_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_erasure_target_requeues" ADD CONSTRAINT "account_erasure_target_requeues_target_id_account_erasure_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."account_erasure_targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_erasure_targets" ADD CONSTRAINT "account_erasure_targets_job_id_account_erasure_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."account_erasure_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_jobs_account_active_uq" ON "account_erasure_jobs" USING btree ("account_id") WHERE "account_erasure_jobs"."state" <> 'succeeded';--> statement-breakpoint
CREATE INDEX "account_erasure_jobs_due_idx" ON "account_erasure_jobs" USING btree ("next_attempt_at","id") WHERE "account_erasure_jobs"."state" in ('intent_pending', 'manifest_pending');--> statement-breakpoint
CREATE INDEX "account_erasure_jobs_claim_expiry_idx" ON "account_erasure_jobs" USING btree ("claim_expires_at","id") WHERE "account_erasure_jobs"."state" = 'claimed';--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_message_tombstones_job_message_uq" ON "account_erasure_message_tombstones" USING btree ("job_id","message_id");--> statement-breakpoint
CREATE INDEX "account_erasure_message_tombstones_session_idx" ON "account_erasure_message_tombstones" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_target_requeues_attempt_uq" ON "account_erasure_target_requeues" USING btree ("target_id","prior_attempt_count");--> statement-breakpoint
CREATE INDEX "account_erasure_target_requeues_job_idx" ON "account_erasure_target_requeues" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_targets_job_kind_resource_uq" ON "account_erasure_targets" USING btree ("job_id","kind","resource_id");--> statement-breakpoint
CREATE INDEX "account_erasure_targets_due_idx" ON "account_erasure_targets" USING btree ("next_attempt_at","id") WHERE "account_erasure_targets"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "account_erasure_targets_claim_expiry_idx" ON "account_erasure_targets" USING btree ("claim_expires_at","id") WHERE "account_erasure_targets"."state" = 'claimed';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_principal_matches(p_human_id uuid, p_principal_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
	SELECT p_principal_id = p_human_id OR EXISTS (
		SELECT 1 FROM agents a WHERE a.account_id = p_principal_id AND a.owner_id = p_human_id
	)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_legacy_media_owned(
	p_job_id uuid,
	p_resource_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
	v_account_id uuid;
	v_media media_assets%ROWTYPE;
BEGIN
	SELECT account_id INTO v_account_id FROM account_erasure_jobs WHERE id = p_job_id;
	SELECT * INTO v_media FROM media_assets WHERE id = p_resource_id;
	IF v_account_id IS NULL OR NOT FOUND
		OR (v_media.session_id IS NULL AND v_media.message_id IS NULL AND v_media.creation_id IS NULL)
	THEN RETURN false; END IF;
	IF v_media.message_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM messages m WHERE m.id = v_media.message_id
			AND account_erasure_principal_matches(v_account_id, m.sender_id)
	) THEN RETURN false; END IF;
	IF v_media.creation_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM creations c WHERE c.id = v_media.creation_id
			AND (c.user_id IS NULL OR account_erasure_principal_matches(v_account_id, c.user_id))
			AND (c.agent_id IS NULL OR account_erasure_principal_matches(v_account_id, c.agent_id))
			AND (c.user_id IS NOT NULL OR c.agent_id IS NOT NULL)
	) THEN RETURN false; END IF;
	IF v_media.session_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM sessions s WHERE s.id = v_media.session_id
			AND account_erasure_principal_matches(v_account_id, s.owner_id)
			AND NOT EXISTS (
				SELECT 1 FROM session_users su WHERE su.session_id = s.id
					AND NOT account_erasure_principal_matches(v_account_id, su.user_account_id)
			)
			AND NOT EXISTS (
				SELECT 1 FROM session_agents sa WHERE sa.session_id = s.id
					AND NOT account_erasure_principal_matches(v_account_id, sa.agent_account_id)
			)
	) THEN RETURN false; END IF;
	RETURN true;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_target_owned(
	p_job_id uuid,
	p_kind text,
	p_resource_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
	v_account_id uuid;
BEGIN
	SELECT account_id INTO v_account_id FROM account_erasure_jobs WHERE id = p_job_id;
	IF v_account_id IS NULL THEN RETURN false; END IF;
	CASE p_kind
		WHEN 'backup_tombstone' THEN RETURN p_resource_id = p_job_id;
		WHEN 'storage_object' THEN RETURN EXISTS (
			SELECT 1 FROM storage_objects o WHERE o.id = p_resource_id AND (
				o.owner_account_id = v_account_id OR EXISTS (
					SELECT 1 FROM agents a WHERE a.account_id = o.owner_account_id AND a.owner_id = v_account_id
				)
			)
		);
		WHEN 'agent_runtime' THEN RETURN EXISTS (
			SELECT 1 FROM agents WHERE account_id = p_resource_id AND owner_id = v_account_id
		);
		WHEN 'channel_runtime' THEN RETURN EXISTS (
			SELECT 1 FROM channel_connections WHERE id = p_resource_id AND account_id = v_account_id
		);
		WHEN 'clerk_identity' THEN RETURN p_resource_id = v_account_id AND EXISTS (
			SELECT 1 FROM accounts WHERE id = v_account_id AND clerk_user_id IS NOT NULL
		);
		WHEN 'stripe_customer' THEN RETURN p_resource_id = v_account_id AND EXISTS (
			SELECT 1 FROM billing_subscriptions WHERE account_id = v_account_id
		);
		WHEN 'legacy_media_asset' THEN RETURN account_erasure_legacy_media_owned(p_job_id, p_resource_id);
		ELSE RETURN false;
	END CASE;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_job_claim_matches(p_account_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
	SELECT EXISTS (
		SELECT 1 FROM account_erasure_jobs j
		WHERE j.account_id = p_account_id
			AND j.id::text = nullif(current_setting('eden3.erasure_job_id', true), '')
			AND j.state = 'claimed'
			AND j.claim_token::text = nullif(current_setting('eden3.erasure_job_claim_token', true), '')
			AND j.claim_expires_at = nullif(current_setting('eden3.erasure_job_claim_expires_at', true), '')::timestamptz
			AND j.claim_expires_at > statement_timestamp()
	)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_restore_authorized()
RETURNS boolean LANGUAGE sql STABLE AS $$
	-- Deployment must provision this non-login/least-privilege role only to the
	-- isolated restore ceremony. A caller-set custom GUC is never sufficient.
	SELECT current_user = 'eden3_erasure_restore'
		AND nullif(current_setting('eden3.erasure_restore_mode', true), '') = 'verified_offline'
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_unclaimed_seal_matches(p_account_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
	SELECT nullif(current_setting('eden3.erasure_inventory_mode', true), '') = 'seal_inventory'
		AND EXISTS (
			SELECT 1 FROM account_erasure_jobs j
			WHERE account_erasure_principal_matches(j.account_id, p_account_id)
				AND j.id::text = nullif(current_setting('eden3.erasure_job_id', true), '')
				AND j.state = 'intent_pending' AND j.inventoried_at IS NULL
				AND j.claim_token IS NULL AND j.claim_expires_at IS NULL
		)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_job_claim_tuple_matches(p_account_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
	SELECT EXISTS (
		SELECT 1 FROM account_erasure_jobs j
		WHERE j.account_id = p_account_id
			AND j.id::text = nullif(current_setting('eden3.erasure_job_id', true), '')
			AND j.state = 'claimed'
			AND j.claim_token::text = nullif(current_setting('eden3.erasure_job_claim_token', true), '')
			AND j.claim_expires_at = nullif(current_setting('eden3.erasure_job_claim_expires_at', true), '')::timestamptz
	)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_target_claim_matches(
	p_account_id uuid, p_kind text, p_resource_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
	SELECT EXISTS (
		SELECT 1 FROM account_erasure_targets t
		JOIN account_erasure_jobs j ON j.id = t.job_id
		WHERE account_erasure_principal_matches(j.account_id, p_account_id)
			AND t.job_id::text = nullif(current_setting('eden3.erasure_job_id', true), '')
			AND t.kind = p_kind AND t.resource_id = p_resource_id
			AND t.kind = nullif(current_setting('eden3.erasure_target_kind', true), '')
			AND t.resource_id::text = nullif(current_setting('eden3.erasure_target_resource_id', true), '')
			AND t.state = 'claimed'
			AND t.claim_token::text = nullif(current_setting('eden3.erasure_target_claim_token', true), '')
			AND t.claim_expires_at = nullif(current_setting('eden3.erasure_target_claim_expires_at', true), '')::timestamptz
			AND t.claim_expires_at > statement_timestamp()
	)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_target_claim_tuple_matches(
	p_account_id uuid, p_kind text, p_resource_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
	SELECT EXISTS (
		SELECT 1 FROM account_erasure_targets t
		JOIN account_erasure_jobs j ON j.id = t.job_id
		WHERE account_erasure_principal_matches(j.account_id, p_account_id)
			AND t.job_id::text = nullif(current_setting('eden3.erasure_job_id', true), '')
			AND t.kind = p_kind AND t.resource_id = p_resource_id
			AND t.kind = nullif(current_setting('eden3.erasure_target_kind', true), '')
			AND t.resource_id::text = nullif(current_setting('eden3.erasure_target_resource_id', true), '')
			AND t.state = 'claimed'
			AND t.claim_token::text = nullif(current_setting('eden3.erasure_target_claim_token', true), '')
			AND t.claim_expires_at = nullif(current_setting('eden3.erasure_target_claim_expires_at', true), '')::timestamptz
	)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_assert_account_writable(p_account_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
	v_deleted boolean;
	v_human_id uuid;
	v_job account_erasure_jobs%ROWTYPE;
BEGIN
	IF p_account_id IS NULL THEN RETURN; END IF;
	SELECT deleted INTO v_deleted FROM accounts WHERE id = p_account_id FOR KEY SHARE;
	IF NOT FOUND THEN RETURN; END IF;
	SELECT owner_id INTO v_human_id FROM agents WHERE account_id = p_account_id;
	v_human_id := COALESCE(v_human_id, p_account_id);
	IF v_human_id <> p_account_id THEN
		PERFORM 1 FROM accounts WHERE id = v_human_id FOR KEY SHARE;
	END IF;
	SELECT * INTO v_job FROM account_erasure_jobs
	WHERE account_id = v_human_id AND state <> 'succeeded'
	ORDER BY created_at LIMIT 1 FOR SHARE;
	IF NOT v_deleted AND NOT FOUND THEN RETURN; END IF;
	IF account_erasure_job_claim_matches(v_human_id) THEN RETURN; END IF;
	RAISE EXCEPTION 'account is deleted or has an active erasure job'
		USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_resolve_owner(p_mode text, p_resource_id uuid)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE AS $$
BEGIN
	IF p_resource_id IS NULL THEN RETURN; END IF;
	CASE p_mode
		WHEN 'account' THEN RETURN NEXT p_resource_id;
		WHEN 'agent' THEN RETURN QUERY SELECT a.account_id FROM agents a WHERE a.account_id = p_resource_id
			UNION SELECT a.owner_id FROM agents a WHERE a.account_id = p_resource_id AND a.owner_id IS NOT NULL;
		WHEN 'session' THEN RETURN QUERY SELECT s.owner_id FROM sessions s WHERE s.id = p_resource_id AND s.owner_id IS NOT NULL
			UNION SELECT su.user_account_id FROM session_users su WHERE su.session_id = p_resource_id
			UNION SELECT sa.agent_account_id FROM session_agents sa WHERE sa.session_id = p_resource_id;
		WHEN 'message' THEN RETURN QUERY SELECT m.sender_id FROM messages m WHERE m.id = p_resource_id AND m.sender_id IS NOT NULL
			UNION SELECT * FROM account_erasure_resolve_owner('session', (SELECT m.session_id FROM messages m WHERE m.id = p_resource_id));
		WHEN 'creation' THEN RETURN QUERY SELECT c.user_id FROM creations c WHERE c.id = p_resource_id AND c.user_id IS NOT NULL
			UNION SELECT c.agent_id FROM creations c WHERE c.id = p_resource_id AND c.agent_id IS NOT NULL;
		WHEN 'collection' THEN RETURN QUERY SELECT c.user_id FROM collections c WHERE c.id = p_resource_id AND c.user_id IS NOT NULL;
		WHEN 'concept' THEN RETURN QUERY SELECT * FROM account_erasure_resolve_owner('agent', (SELECT c.agent_id FROM concepts c WHERE c.id = p_resource_id));
		WHEN 'connection' THEN RETURN QUERY SELECT c.account_id FROM channel_connections c WHERE c.id = p_resource_id
			UNION SELECT c.agent_id FROM channel_connections c WHERE c.id = p_resource_id;
		WHEN 'object' THEN RETURN QUERY SELECT o.owner_account_id FROM storage_objects o WHERE o.id = p_resource_id;
		WHEN 'upload' THEN RETURN QUERY SELECT u.owner_account_id FROM storage_uploads u WHERE u.id = p_resource_id;
		WHEN 'manna' THEN RETURN QUERY SELECT m.account_id FROM manna_accounts m WHERE m.id = p_resource_id;
		WHEN 'turn' THEN RETURN QUERY SELECT a.account_id FROM turn_authorizations a WHERE a.turn_id = p_resource_id
			UNION SELECT a.agent_account_id FROM turn_authorizations a WHERE a.turn_id = p_resource_id AND a.agent_account_id IS NOT NULL;
		WHEN 'media' THEN RETURN QUERY
			SELECT owner FROM (
				SELECT * FROM account_erasure_resolve_owner('session', (SELECT session_id FROM media_assets WHERE id = p_resource_id))
				UNION SELECT * FROM account_erasure_resolve_owner('message', (SELECT message_id FROM media_assets WHERE id = p_resource_id))
				UNION SELECT * FROM account_erasure_resolve_owner('creation', (SELECT creation_id FROM media_assets WHERE id = p_resource_id))
			) owners(owner);
	END CASE;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_write_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_row jsonb;
	v_arg text;
	v_mode text;
	v_column text;
	v_resource uuid;
	v_owner uuid;
	v_owners uuid[] := ARRAY[]::uuid[];
	v_unclaimed_allowed boolean := false;
BEGIN
	-- The channel-runtime target owns the connection. PostgreSQL's exact
	-- ON DELETE SET NULL update is part of that claimed source disposal, but
	-- no other session field may ride the cascade exemption.
	IF TG_TABLE_NAME = 'sessions' AND TG_OP = 'UPDATE'
		AND to_jsonb(OLD)->>'channel_connection_id' IS NOT NULL
		AND to_jsonb(NEW)->>'channel_connection_id' IS NULL
		AND (to_jsonb(NEW) - 'channel_connection_id') = (to_jsonb(OLD) - 'channel_connection_id')
		AND account_erasure_target_claim_matches(
			(SELECT account_id FROM account_erasure_jobs
				WHERE id::text = nullif(current_setting('eden3.erasure_job_id', true), '')),
			'channel_runtime', (to_jsonb(OLD)->>'channel_connection_id')::uuid)
	THEN RETURN NEW;
	END IF;
	IF TG_TABLE_NAME IN ('channel_onboarding_intents','channel_turns') AND TG_OP = 'UPDATE'
		AND to_jsonb(OLD)->>'connection_id' IS NOT NULL
		AND to_jsonb(NEW)->>'connection_id' IS NULL
		AND (to_jsonb(NEW) - 'connection_id') = (to_jsonb(OLD) - 'connection_id')
		AND account_erasure_target_claim_matches(
			(SELECT account_id FROM account_erasure_jobs
				WHERE id::text = nullif(current_setting('eden3.erasure_job_id', true), '')),
			'channel_runtime', (to_jsonb(OLD)->>'connection_id')::uuid)
	THEN RETURN NEW;
	END IF;
	-- Existing provider-free cleanup must remain able to terminalize after the
	-- account seal. Earlier storage triggers validate the exact cleanup CAS.
	IF TG_TABLE_NAME = 'storage_uploads' THEN
		IF TG_OP = 'UPDATE' AND to_jsonb(OLD)->>'state' IN ('aborted','expired')
			AND to_jsonb(NEW)->>'state' = to_jsonb(OLD)->>'state'
		THEN RETURN NEW; END IF;
	END IF;
	IF TG_TABLE_NAME = 'storage_policy_events' THEN
		IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
	END IF;
	IF TG_TABLE_NAME = 'accounts' THEN
		IF TG_OP = 'INSERT'
			AND EXISTS (SELECT 1 FROM account_erasure_jobs WHERE account_id = (to_jsonb(NEW)->>'id')::uuid)
			AND COALESCE((to_jsonb(NEW)->>'deleted')::boolean, false) = false
		THEN RAISE EXCEPTION 'restore replay may recreate an erased account only as deleted' USING ERRCODE = '55000';
		END IF;
	END IF;
	v_unclaimed_allowed := (
		(TG_OP = 'UPDATE' AND TG_TABLE_NAME IN (
			'accounts','agents','sessions','messages','creations','storage_uploads',
			'channel_connections','channel_turns','turn_authorizations','usage_events',
			'memory_dream_runs','triggers','agent_provision_jobs'
		)) OR (TG_OP = 'DELETE' AND TG_TABLE_NAME IN (
			'session_agents','session_users','session_share_links','content_reports',
			'creation_likes','agent_likes','collection_creations','agent_skills',
			'channel_onboarding_intents','channel_external_identities','channel_pairing_requests'
		))
	);
	FOR v_row IN SELECT value FROM jsonb_array_elements(
		CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
			WHEN 'DELETE' THEN jsonb_build_array(to_jsonb(OLD))
			ELSE jsonb_build_array(to_jsonb(OLD), to_jsonb(NEW)) END
	) LOOP
		IF (TG_TABLE_NAME = 'accounts' AND account_erasure_target_claim_matches(
			(v_row->>'id')::uuid, 'clerk_identity', (v_row->>'id')::uuid))
			OR (TG_TABLE_NAME = 'billing_subscriptions' AND account_erasure_target_claim_matches(
			(v_row->>'account_id')::uuid, 'stripe_customer', (v_row->>'account_id')::uuid))
			OR (TG_TABLE_NAME = 'agents' AND account_erasure_target_claim_matches(
			(v_row->>'owner_id')::uuid, 'agent_runtime', (v_row->>'account_id')::uuid))
			OR (TG_TABLE_NAME = 'channel_connections' AND account_erasure_target_claim_matches(
			(v_row->>'account_id')::uuid, 'channel_runtime', (v_row->>'id')::uuid))
			OR (TG_TABLE_NAME IN ('storage_objects','storage_uploads','storage_policy_events')
				AND account_erasure_target_claim_matches(
				(v_row->>'owner_account_id')::uuid, 'storage_object',
				COALESCE((v_row->>'object_id')::uuid, (v_row->>'id')::uuid)))
			OR (TG_TABLE_NAME = 'media_assets' AND account_erasure_target_claim_matches(
			(SELECT account_id FROM account_erasure_jobs
				WHERE id::text = nullif(current_setting('eden3.erasure_job_id', true), '')),
			'legacy_media_asset', (v_row->>'id')::uuid))
		THEN CONTINUE; END IF;
		FOREACH v_arg IN ARRAY TG_ARGV LOOP
			v_mode := split_part(v_arg, ':', 1);
			v_column := split_part(v_arg, ':', 2);
			BEGIN v_resource := nullif(v_row ->> v_column, '')::uuid;
			EXCEPTION WHEN invalid_text_representation THEN
				RAISE EXCEPTION 'invalid erasure fence UUID source';
			END;
			IF v_resource IS NOT NULL THEN
				FOR v_owner IN SELECT owner FROM account_erasure_resolve_owner(v_mode, v_resource) owner LOOP
					v_owners := array_append(v_owners, v_owner);
				END LOOP;
			END IF;
		END LOOP;
	END LOOP;
	FOR v_owner IN
		SELECT owners.owner
		FROM (SELECT DISTINCT unnest(v_owners) AS owner) owners
		LEFT JOIN accounts a ON a.id = owners.owner
		ORDER BY CASE WHEN a.type = 'user' THEN 0 ELSE 1 END, owners.owner
	LOOP
		IF account_erasure_restore_authorized()
			OR (v_unclaimed_allowed AND account_erasure_unclaimed_seal_matches(v_owner))
		THEN CONTINUE; END IF;
		PERFORM account_erasure_assert_account_writable(v_owner);
	END LOOP;
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_assert_no_open_work(p_account_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (
		WITH principals AS (SELECT p_account_id id UNION SELECT account_id FROM agents WHERE owner_id = p_account_id)
		SELECT 1 FROM turn_authorizations a JOIN principals p ON p.id IN (a.account_id, a.agent_account_id) WHERE a.state = 'reserved'
		UNION ALL SELECT 1 FROM channel_turns c JOIN principals p ON p.id IN (c.account_id, c.agent_id)
			WHERE c.status IN ('reserving','reserved','settling','refunding','delivery_pending','error')
		UNION ALL SELECT 1 FROM memory_dream_runs r JOIN principals p ON p.id = r.agent_account_id
			WHERE r.status IN ('running','recovery_pending') OR r.provider_status IN ('started','indeterminate')
		UNION ALL SELECT 1 FROM usage_events u JOIN principals p ON p.id IN (u.user_id, u.agent_id)
			WHERE u.status IN ('pending','running','refund_pending')
		UNION ALL SELECT 1 FROM agent_provision_jobs q JOIN principals p ON p.id = q.agent_account_id
			WHERE q.state IN ('pending','running')
		UNION ALL SELECT 1 FROM storage_uploads u JOIN principals p ON p.id = u.owner_account_id
			WHERE (u.state IN ('initiated','uploading') OR u.cleanup_state IN ('pending','claimed','failed'))
		UNION ALL SELECT 1 FROM triggers t JOIN principals p ON p.id IN (t.user_id, t.agent_id)
			WHERE t.pending_occurrence_id IS NOT NULL
	) THEN
		RAISE EXCEPTION 'open money, provider, or multipart work blocks erasure completion'
			USING ERRCODE = '55000';
	END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_job_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'erasure jobs are retained for restore replay';
	END IF;
	IF TG_OP = 'INSERT' THEN
		IF account_erasure_restore_authorized() THEN
			IF NEW.state <> 'succeeded' THEN RAISE EXCEPTION 'restore replay job must be terminal'; END IF;
			RETURN NEW;
		END IF;
		IF NEW.state <> 'intent_pending' THEN RAISE EXCEPTION 'new erasure job must start intent_pending'; END IF;
		PERFORM 1 FROM accounts WHERE id = NEW.account_id AND type = 'user' AND deleted = false FOR UPDATE;
		IF NOT FOUND THEN RAISE EXCEPTION 'erasure job requires one live user account'; END IF;
		RETURN NEW;
	END IF;
	IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id
		OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR (OLD.ledger_confirmed_at IS NOT NULL AND ROW(NEW.ledger_confirmed_at,NEW.ledger_sha256,NEW.ledger_mac_sha256) IS DISTINCT FROM ROW(OLD.ledger_confirmed_at,OLD.ledger_sha256,OLD.ledger_mac_sha256))
		OR (OLD.inventoried_at IS NOT NULL AND ROW(NEW.inventoried_at,NEW.inventory_sha256) IS DISTINCT FROM ROW(OLD.inventoried_at,OLD.inventory_sha256))
		OR (OLD.recovery_manifest_confirmed_at IS NOT NULL AND ROW(NEW.recovery_manifest_confirmed_at,NEW.recovery_ciphertext_sha256,NEW.recovery_mac_sha256,NEW.recovery_key_version) IS DISTINCT FROM ROW(OLD.recovery_manifest_confirmed_at,OLD.recovery_ciphertext_sha256,OLD.recovery_mac_sha256,OLD.recovery_key_version))
	THEN RAISE EXCEPTION 'recovery evidence and erasure identity are immutable'; END IF;
	IF NEW.attempt_count < OLD.attempt_count THEN RAISE EXCEPTION 'erasure attempts are monotonic'; END IF;
	IF OLD.state = 'succeeded' THEN RAISE EXCEPTION 'succeeded erasure job is terminal'; END IF;
	IF NEW.state IS DISTINCT FROM OLD.state THEN
		IF OLD.state IN ('intent_pending','manifest_pending','attention') AND NEW.state = 'claimed' THEN
			IF NEW.attempt_count <> OLD.attempt_count + 1 OR NEW.claim_expires_at <= statement_timestamp()
				OR NEW.last_error_code IS NOT NULL
				OR ROW(NEW.ledger_confirmed_at,NEW.ledger_sha256,NEW.ledger_mac_sha256,NEW.inventoried_at,NEW.inventory_sha256,
					NEW.recovery_manifest_confirmed_at,NEW.recovery_ciphertext_sha256,NEW.recovery_mac_sha256,NEW.recovery_key_version)
					IS DISTINCT FROM ROW(OLD.ledger_confirmed_at,OLD.ledger_sha256,OLD.ledger_mac_sha256,OLD.inventoried_at,OLD.inventory_sha256,
					OLD.recovery_manifest_confirmed_at,OLD.recovery_ciphertext_sha256,OLD.recovery_mac_sha256,OLD.recovery_key_version)
			THEN
				RAISE EXCEPTION 'invalid erasure recovery claim'; END IF;
		ELSIF OLD.state = 'intent_pending' AND NEW.state = 'manifest_pending' THEN
			IF OLD.claim_token IS NOT NULL OR NEW.attempt_count <> OLD.attempt_count
				OR NEW.ledger_confirmed_at IS NULL OR NEW.inventoried_at IS NULL
				OR NEW.id::text IS DISTINCT FROM nullif(current_setting('eden3.erasure_job_id', true), '')
				OR nullif(current_setting('eden3.erasure_inventory_mode', true), '') <> 'seal_inventory'
			THEN RAISE EXCEPTION 'invalid unclaimed ledger seal'; END IF;
		ELSIF OLD.state = 'manifest_pending' AND NEW.state = 'pending' THEN
			IF OLD.claim_token IS NOT NULL OR NEW.attempt_count <> OLD.attempt_count
				OR NEW.recovery_manifest_confirmed_at IS NULL OR NEW.last_error_code IS NOT NULL
				OR NEW.id::text IS DISTINCT FROM nullif(current_setting('eden3.erasure_job_id', true), '')
				OR nullif(current_setting('eden3.erasure_inventory_mode', true), '') <> 'confirm_manifest'
			THEN RAISE EXCEPTION 'invalid unclaimed recovery manifest seal'; END IF;
		ELSIF OLD.state = 'claimed' AND NEW.state IN ('intent_pending','manifest_pending','pending','attention') THEN
			IF NEW.attempt_count <> OLD.attempt_count THEN RAISE EXCEPTION 'claimed erasure attempt is immutable'; END IF;
			IF NOT account_erasure_job_claim_tuple_matches(OLD.account_id)
			THEN RAISE EXCEPTION 'late or mismatched erasure job claim'; END IF;
			IF OLD.claim_expires_at <= statement_timestamp() THEN
				IF NEW.state NOT IN ('intent_pending','manifest_pending','attention')
					OR NEW.last_error_code IS NULL OR NEW.attempt_count <> OLD.attempt_count
				THEN RAISE EXCEPTION 'expired erasure job claim may only recover for retry or attention'; END IF;
			END IF;
			IF NEW.state = 'intent_pending' AND NEW.last_error_code IS NULL
			THEN RAISE EXCEPTION 'erasure recovery retry requires a safe error code'; END IF;
			IF NEW.state = 'manifest_pending' AND OLD.ledger_confirmed_at IS NULL
				AND (NEW.ledger_confirmed_at IS NULL OR NEW.inventoried_at IS NULL OR NEW.last_error_code IS NOT NULL)
			THEN RAISE EXCEPTION 'claimed ledger seal requires complete inventory evidence'; END IF;
			IF NEW.state = 'manifest_pending' AND OLD.ledger_confirmed_at IS NOT NULL
				AND NEW.last_error_code IS NULL
			THEN RAISE EXCEPTION 'manifest retry requires a safe error code'; END IF;
			IF NEW.state = 'pending' AND (NEW.recovery_manifest_confirmed_at IS NULL OR NEW.last_error_code IS NOT NULL)
			THEN RAISE EXCEPTION 'recovery completion requires confirmed manifest evidence'; END IF;
			IF NEW.state = 'attention' AND ROW(NEW.ledger_confirmed_at,NEW.ledger_sha256,NEW.ledger_mac_sha256,NEW.inventoried_at,NEW.inventory_sha256,
				NEW.recovery_manifest_confirmed_at,NEW.recovery_ciphertext_sha256,NEW.recovery_mac_sha256,NEW.recovery_key_version)
				IS DISTINCT FROM ROW(OLD.ledger_confirmed_at,OLD.ledger_sha256,OLD.ledger_mac_sha256,OLD.inventoried_at,OLD.inventory_sha256,
				OLD.recovery_manifest_confirmed_at,OLD.recovery_ciphertext_sha256,OLD.recovery_mac_sha256,OLD.recovery_key_version)
			THEN RAISE EXCEPTION 'failed recovery cannot manufacture evidence'; END IF;
		ELSIF OLD.state = 'pending' AND NEW.state = 'succeeded' THEN
			IF NEW.attempt_count <> OLD.attempt_count THEN RAISE EXCEPTION 'completed job cannot change recovery attempts'; END IF;
		ELSE RAISE EXCEPTION 'illegal erasure job transition % -> %', OLD.state, NEW.state;
		END IF;
	ELSIF ROW(NEW.attempt_count,NEW.next_attempt_at,NEW.claim_token,NEW.claim_expires_at,NEW.completed_at,NEW.last_error_code,
		NEW.ledger_confirmed_at,NEW.ledger_sha256,NEW.ledger_mac_sha256,NEW.inventoried_at,NEW.inventory_sha256,
		NEW.recovery_manifest_confirmed_at,NEW.recovery_ciphertext_sha256,NEW.recovery_mac_sha256,NEW.recovery_key_version)
		IS DISTINCT FROM ROW(OLD.attempt_count,OLD.next_attempt_at,OLD.claim_token,OLD.claim_expires_at,OLD.completed_at,OLD.last_error_code,
		OLD.ledger_confirmed_at,OLD.ledger_sha256,OLD.ledger_mac_sha256,OLD.inventoried_at,OLD.inventory_sha256,
		OLD.recovery_manifest_confirmed_at,OLD.recovery_ciphertext_sha256,OLD.recovery_mac_sha256,OLD.recovery_key_version)
	THEN RAISE EXCEPTION 'erasure lifecycle fields may change only with state CAS';
	END IF;
	IF NEW.state = 'succeeded' AND OLD.state <> 'succeeded' THEN
		IF NOT EXISTS (
			SELECT 1 FROM account_erasure_targets
			WHERE job_id = NEW.id AND kind = 'backup_tombstone'
				AND resource_id = NEW.id AND state = 'succeeded'
		) OR EXISTS (SELECT 1 FROM account_erasure_targets WHERE job_id = NEW.id AND state <> 'succeeded')
		THEN RAISE EXCEPTION 'all erasure targets must succeed before the job'; END IF;
		PERFORM account_erasure_assert_no_open_work(NEW.account_id);
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_erasure_jobs_guard BEFORE INSERT OR UPDATE OR DELETE ON "account_erasure_jobs"
FOR EACH ROW EXECUTE FUNCTION account_erasure_job_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_target_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_job account_erasure_jobs%ROWTYPE;
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'erasure targets are retained for restore replay'; END IF;
	IF TG_OP = 'INSERT' THEN
		IF account_erasure_restore_authorized()
			AND NEW.state = 'succeeded'
			AND EXISTS (SELECT 1 FROM account_erasure_jobs WHERE id = NEW.job_id AND state = 'succeeded' FOR SHARE)
		THEN RETURN NEW;
		END IF;
		SELECT * INTO v_job FROM account_erasure_jobs WHERE id = NEW.job_id FOR SHARE;
		IF NEW.state <> 'pending' OR NOT FOUND OR v_job.inventoried_at IS NOT NULL
			OR NOT account_erasure_target_owned(NEW.job_id, NEW.kind, NEW.resource_id)
			OR v_job.id::text IS DISTINCT FROM nullif(current_setting('eden3.erasure_job_id', true), '')
			OR (NEW.kind = 'backup_tombstone' AND (
				v_job.state <> 'intent_pending'
				OR nullif(current_setting('eden3.erasure_inventory_mode', true), '') <> 'accept_intent'
			))
			OR (NEW.kind <> 'backup_tombstone' AND NOT (
				(v_job.state = 'intent_pending'
					AND nullif(current_setting('eden3.erasure_inventory_mode', true), '') = 'seal_inventory')
				OR (v_job.state = 'claimed' AND account_erasure_job_claim_tuple_matches(v_job.account_id))
			))
		THEN RAISE EXCEPTION 'erasure target kind ownership mismatch'; END IF;
		RETURN NEW;
	END IF;
	IF ROW(NEW.id,NEW.job_id,NEW.kind,NEW.resource_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.job_id,OLD.kind,OLD.resource_id,OLD.created_at)
	THEN RAISE EXCEPTION 'erasure target identity is immutable'; END IF;
	IF NEW.attempt_count < OLD.attempt_count THEN RAISE EXCEPTION 'erasure target attempts are monotonic'; END IF;
	IF OLD.state = 'succeeded' THEN RAISE EXCEPTION 'succeeded erasure target is terminal'; END IF;
	IF NEW.state IS DISTINCT FROM OLD.state THEN
		IF OLD.state = 'pending' AND NEW.state = 'succeeded'
			AND NEW.kind = 'backup_tombstone' AND NEW.resource_id = NEW.job_id THEN
			IF NEW.attempt_count <> OLD.attempt_count OR NEW.last_error_code IS NOT NULL
				OR NOT EXISTS (
					SELECT 1 FROM account_erasure_jobs j
					WHERE j.id = NEW.job_id
						AND j.id::text = nullif(current_setting('eden3.erasure_job_id', true), '')
					AND ((j.state = 'intent_pending'
						AND nullif(current_setting('eden3.erasure_inventory_mode', true), '') = 'seal_inventory')
						OR account_erasure_job_claim_matches(j.account_id))
					FOR SHARE
				)
			THEN RAISE EXCEPTION 'backup tombstone success requires exact sealing job'; END IF;
		ELSIF OLD.state = 'pending' AND NEW.state = 'attention' AND NEW.kind = 'storage_object' THEN
			IF NEW.attempt_count <> OLD.attempt_count + 1 OR NEW.last_error_code IS NULL
				OR NOT EXISTS (
					SELECT 1 FROM storage_uploads
					WHERE object_id = NEW.resource_id AND cleanup_state = 'failed'
				)
			THEN RAISE EXCEPTION 'storage target attention requires failed multipart cleanup'; END IF;
		ELSIF OLD.state = 'pending' AND NEW.state = 'claimed' THEN
			IF NOT account_erasure_target_owned(NEW.job_id, NEW.kind, NEW.resource_id)
				OR NOT EXISTS (
					SELECT 1 FROM account_erasure_jobs
					WHERE id = NEW.job_id AND state = 'pending'
						AND recovery_manifest_confirmed_at IS NOT NULL FOR SHARE
				)
				OR (NEW.kind = 'storage_object' AND EXISTS (
					SELECT 1 FROM storage_uploads u WHERE u.object_id = NEW.resource_id AND NOT (
						(u.state = 'completed' AND u.cleanup_state = 'not_required')
						OR (u.state IN ('aborted','expired') AND u.cleanup_state = 'succeeded')
					)
				))
				OR NEW.attempt_count <> OLD.attempt_count + 1 OR NEW.claim_expires_at <= statement_timestamp()
			THEN RAISE EXCEPTION 'invalid erasure target claim'; END IF;
		ELSIF OLD.state = 'claimed' AND NEW.state IN ('pending','attention','succeeded') THEN
			IF NEW.attempt_count <> OLD.attempt_count THEN RAISE EXCEPTION 'claimed target attempt is immutable'; END IF;
			SELECT * INTO v_job FROM account_erasure_jobs WHERE id = OLD.job_id FOR SHARE;
			IF NOT FOUND OR NOT account_erasure_target_claim_tuple_matches(v_job.account_id, OLD.kind, OLD.resource_id)
			THEN RAISE EXCEPTION 'late or mismatched erasure target claim'; END IF;
			IF OLD.claim_expires_at <= statement_timestamp() THEN
				IF NEW.state NOT IN ('pending','attention') OR NEW.last_error_code IS NULL
					OR NEW.attempt_count <> OLD.attempt_count
				THEN RAISE EXCEPTION 'expired erasure target claim may only recover for retry or attention'; END IF;
			END IF;
			IF NEW.state = 'pending' AND NEW.last_error_code IS NULL
			THEN RAISE EXCEPTION 'erasure target retry requires a safe error code'; END IF;
			IF NEW.state = 'succeeded' AND NEW.kind IN ('storage_object','legacy_media_asset')
				AND nullif(current_setting('eden3.erasure_external_absence_id', true), '') IS DISTINCT FROM NEW.resource_id::text
			THEN RAISE EXCEPTION 'positive storage absence must precede source disposal'; END IF;
			IF NEW.state = 'succeeded' AND (
				(NEW.kind = 'storage_object' AND EXISTS (SELECT 1 FROM storage_objects WHERE id = NEW.resource_id))
				OR (NEW.kind = 'legacy_media_asset' AND EXISTS (SELECT 1 FROM media_assets WHERE id = NEW.resource_id))
				OR (NEW.kind = 'clerk_identity' AND EXISTS (
					SELECT 1 FROM accounts WHERE id = NEW.resource_id AND clerk_user_id IS NOT NULL))
				OR (NEW.kind = 'stripe_customer' AND EXISTS (
					SELECT 1 FROM billing_subscriptions WHERE account_id = NEW.resource_id))
				OR (NEW.kind = 'agent_runtime' AND EXISTS (
					SELECT 1 FROM agents WHERE account_id = NEW.resource_id
						AND (openclaw_id IS NOT NULL OR workspace_path IS NOT NULL)))
				OR (NEW.kind = 'channel_runtime' AND EXISTS (
					SELECT 1 FROM channel_connections WHERE id = NEW.resource_id))
			) THEN RAISE EXCEPTION 'source row must be disposed before target success'; END IF;
		ELSIF OLD.state = 'attention' AND NEW.state = 'pending' THEN
			IF NOT EXISTS (SELECT 1 FROM account_erasure_target_requeues r WHERE r.target_id = OLD.id AND r.job_id = OLD.job_id AND r.prior_attempt_count = OLD.attempt_count)
			THEN RAISE EXCEPTION 'attention target requires audited operator requeue'; END IF;
			IF NEW.attempt_count <> OLD.attempt_count THEN RAISE EXCEPTION 'operator requeue cannot reset attempts'; END IF;
			IF NEW.last_error_code IS NOT NULL THEN RAISE EXCEPTION 'operator requeue must clear target error'; END IF;
		ELSE RAISE EXCEPTION 'illegal erasure target transition % -> %', OLD.state, NEW.state;
		END IF;
	ELSIF ROW(NEW.attempt_count,NEW.next_attempt_at,NEW.claim_token,NEW.claim_expires_at,NEW.completed_at,NEW.last_error_code)
		IS DISTINCT FROM ROW(OLD.attempt_count,OLD.next_attempt_at,OLD.claim_token,OLD.claim_expires_at,OLD.completed_at,OLD.last_error_code)
	THEN RAISE EXCEPTION 'erasure target lifecycle fields may change only with state CAS';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_erasure_targets_guard BEFORE INSERT OR UPDATE OR DELETE ON "account_erasure_targets"
FOR EACH ROW EXECUTE FUNCTION account_erasure_target_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_target_requeue_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_target account_erasure_targets%ROWTYPE;
BEGIN
	IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'erasure target requeue audit is append-only'; END IF;
	SELECT * INTO v_target FROM account_erasure_targets WHERE id = NEW.target_id FOR UPDATE;
	IF NOT FOUND OR v_target.job_id <> NEW.job_id OR v_target.state <> 'attention' OR v_target.attempt_count <> NEW.prior_attempt_count
	THEN RAISE EXCEPTION 'requeue must bind the exact attention target attempt'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_erasure_target_requeues_guard BEFORE INSERT OR UPDATE OR DELETE ON "account_erasure_target_requeues"
FOR EACH ROW EXECUTE FUNCTION account_erasure_target_requeue_guard();
--> statement-breakpoint

-- Preserve the 0037 cleanup machine and add one audited operator escape from
-- terminal failure. The account/target/requeue tuple is independently checked;
-- no provider locator or authorization material enters the audit row.
CREATE OR REPLACE FUNCTION "storage_upload_transition_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."object_id" IS DISTINCT FROM OLD."object_id"
		OR NEW."owner_account_id" IS DISTINCT FROM OLD."owner_account_id"
		OR NEW."backend_multipart_id" IS DISTINCT FROM OLD."backend_multipart_id"
		OR NEW."part_size_bytes" IS DISTINCT FROM OLD."part_size_bytes"
		OR NEW."max_parts" IS DISTINCT FROM OLD."max_parts"
		OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
		OR NEW."capability_expires_at" IS DISTINCT FROM OLD."capability_expires_at"
	THEN RAISE EXCEPTION 'storage upload identity and capability geometry are immutable' USING ERRCODE = '23514'; END IF;

	IF NEW."state" IS DISTINCT FROM OLD."state" THEN
		IF OLD."state" IN ('completed','aborted','expired') THEN
			RAISE EXCEPTION 'terminal storage upload state is immutable' USING ERRCODE = '23514';
		ELSIF (OLD."state" = 'initiated' AND NEW."state" IN ('uploading','completed','aborted','expired'))
			OR (OLD."state" = 'uploading' AND NEW."state" IN ('completed','aborted','expired')) THEN NULL;
		ELSE RAISE EXCEPTION 'illegal storage upload lifecycle transition: % -> %', OLD."state", NEW."state" USING ERRCODE = '23514';
		END IF;
	END IF;

	IF NEW."state" IS DISTINCT FROM OLD."state" AND NEW."state" IN ('aborted','expired') THEN
		NEW."cleanup_state" := 'pending';
		NEW."cleanup_attempt_count" := 0;
		NEW."cleanup_next_attempt_at" := statement_timestamp();
		NEW."cleanup_claim_token" := NULL;
		NEW."cleanup_claim_expires_at" := NULL;
		NEW."cleanup_enqueued_at" := statement_timestamp();
		NEW."cleanup_succeeded_at" := NULL;
		NEW."cleanup_last_error_code" := NULL;
	ELSIF NEW."state" IN ('initiated','uploading','completed') THEN
		IF ROW(NEW."cleanup_state",NEW."cleanup_attempt_count",NEW."cleanup_next_attempt_at",NEW."cleanup_claim_token",NEW."cleanup_claim_expires_at",NEW."cleanup_enqueued_at",NEW."cleanup_succeeded_at",NEW."cleanup_last_error_code")
			IS DISTINCT FROM ROW(OLD."cleanup_state",OLD."cleanup_attempt_count",OLD."cleanup_next_attempt_at",OLD."cleanup_claim_token",OLD."cleanup_claim_expires_at",OLD."cleanup_enqueued_at",OLD."cleanup_succeeded_at",OLD."cleanup_last_error_code")
		THEN RAISE EXCEPTION 'active or completed upload cannot carry cleanup state' USING ERRCODE = '23514'; END IF;
	ELSIF OLD."cleanup_state" = 'not_required' AND NEW."cleanup_state" = 'pending' THEN
		IF OLD."state" NOT IN ('aborted','expired') OR NEW."cleanup_attempt_count" <> 0
			OR NEW."cleanup_next_attempt_at" IS NULL OR NEW."cleanup_claim_token" IS NOT NULL
			OR NEW."cleanup_claim_expires_at" IS NOT NULL OR NEW."cleanup_enqueued_at" IS NULL
			OR NEW."cleanup_succeeded_at" IS NOT NULL OR NEW."cleanup_last_error_code" IS NOT NULL
		THEN RAISE EXCEPTION 'invalid legacy multipart cleanup enqueue' USING ERRCODE = '23514'; END IF;
	ELSIF OLD."cleanup_state" = 'pending' AND NEW."cleanup_state" = 'claimed' THEN
		IF NEW."cleanup_attempt_count" <> OLD."cleanup_attempt_count" + 1
			OR NEW."cleanup_next_attempt_at" IS NOT NULL OR NEW."cleanup_claim_token" IS NULL
			OR NEW."cleanup_claim_expires_at" IS NULL OR NEW."cleanup_claim_expires_at" <= statement_timestamp()
			OR NEW."cleanup_succeeded_at" IS NOT NULL
		THEN RAISE EXCEPTION 'invalid multipart cleanup claim' USING ERRCODE = '23514'; END IF;
	ELSIF OLD."cleanup_state" = 'claimed' AND NEW."cleanup_state" = 'pending' THEN
		IF NEW."cleanup_attempt_count" <> OLD."cleanup_attempt_count"
			OR NEW."cleanup_next_attempt_at" IS NULL OR NEW."cleanup_claim_token" IS NOT NULL
			OR NEW."cleanup_claim_expires_at" IS NOT NULL OR NEW."cleanup_succeeded_at" IS NOT NULL
			OR NEW."cleanup_last_error_code" IS NULL
		THEN RAISE EXCEPTION 'invalid multipart cleanup retry' USING ERRCODE = '23514'; END IF;
	ELSIF OLD."cleanup_state" = 'claimed' AND NEW."cleanup_state" = 'succeeded' THEN
		IF NEW."cleanup_attempt_count" <> OLD."cleanup_attempt_count"
			OR NEW."cleanup_next_attempt_at" IS NOT NULL OR NEW."cleanup_claim_token" IS NOT NULL
			OR NEW."cleanup_claim_expires_at" IS NOT NULL OR NEW."cleanup_succeeded_at" IS NULL
			OR NEW."cleanup_last_error_code" IS NOT NULL
		THEN RAISE EXCEPTION 'invalid multipart cleanup success' USING ERRCODE = '23514'; END IF;
	ELSIF OLD."cleanup_state" = 'claimed' AND NEW."cleanup_state" = 'failed' THEN
		IF NEW."cleanup_attempt_count" <> OLD."cleanup_attempt_count"
			OR NEW."cleanup_next_attempt_at" IS NOT NULL OR NEW."cleanup_claim_token" IS NOT NULL
			OR NEW."cleanup_claim_expires_at" IS NOT NULL OR NEW."cleanup_succeeded_at" IS NOT NULL
			OR NEW."cleanup_last_error_code" IS NULL
		THEN RAISE EXCEPTION 'invalid multipart cleanup terminal failure' USING ERRCODE = '23514'; END IF;
	ELSIF OLD."cleanup_state" = 'failed' AND NEW."cleanup_state" = 'pending' THEN
		IF NEW."cleanup_attempt_count" <> OLD."cleanup_attempt_count"
			OR NEW."cleanup_next_attempt_at" IS NULL OR NEW."cleanup_claim_token" IS NOT NULL
			OR NEW."cleanup_claim_expires_at" IS NOT NULL OR NEW."cleanup_succeeded_at" IS NOT NULL
			OR NEW."cleanup_last_error_code" IS NOT NULL
			OR NOT EXISTS (
				SELECT 1 FROM account_erasure_target_requeues r
				JOIN account_erasure_targets t ON t.id = r.target_id AND t.job_id = r.job_id
				JOIN account_erasure_jobs j ON j.id = t.job_id
				WHERE r.id::text = nullif(current_setting('eden3.erasure_requeue_id', true), '')
					AND j.account_id = NEW."owner_account_id" AND t.kind = 'storage_object'
					AND t.resource_id = NEW."object_id" AND t.state = 'attention'
					AND r.prior_attempt_count = t.attempt_count
			)
		THEN RAISE EXCEPTION 'failed multipart cleanup requires exact audited erasure requeue' USING ERRCODE = '23514'; END IF;
	ELSIF ROW(NEW."cleanup_state",NEW."cleanup_attempt_count",NEW."cleanup_next_attempt_at",NEW."cleanup_claim_token",NEW."cleanup_claim_expires_at",NEW."cleanup_enqueued_at",NEW."cleanup_succeeded_at",NEW."cleanup_last_error_code")
		IS DISTINCT FROM ROW(OLD."cleanup_state",OLD."cleanup_attempt_count",OLD."cleanup_next_attempt_at",OLD."cleanup_claim_token",OLD."cleanup_claim_expires_at",OLD."cleanup_enqueued_at",OLD."cleanup_succeeded_at",OLD."cleanup_last_error_code")
	THEN RAISE EXCEPTION 'illegal multipart cleanup state transition: % -> %', OLD."cleanup_state", NEW."cleanup_state" USING ERRCODE = '23514';
	END IF;

	IF OLD."cleanup_enqueued_at" IS NOT NULL AND NEW."cleanup_enqueued_at" IS DISTINCT FROM OLD."cleanup_enqueued_at"
	THEN RAISE EXCEPTION 'multipart cleanup enqueue time is immutable' USING ERRCODE = '23514'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_message_tombstone_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_job account_erasure_jobs%ROWTYPE;
BEGIN
	IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'message erasure tombstones are append-only'; END IF;
	SELECT * INTO v_job FROM account_erasure_jobs WHERE id = NEW.job_id FOR SHARE;
	IF FOUND AND account_erasure_restore_authorized()
	THEN RETURN NEW; END IF;
	IF NOT FOUND OR v_job.inventoried_at IS NOT NULL
		OR v_job.id::text IS DISTINCT FROM nullif(current_setting('eden3.erasure_job_id', true), '')
		OR NOT ((v_job.state = 'intent_pending'
			AND nullif(current_setting('eden3.erasure_inventory_mode', true), '') = 'seal_inventory')
			OR (v_job.state = 'claimed' AND account_erasure_job_claim_tuple_matches(v_job.account_id)))
		OR NOT (NEW.author_principal_id = v_job.account_id OR EXISTS (
		SELECT 1 FROM agents WHERE account_id = NEW.author_principal_id AND owner_id = v_job.account_id
	)) THEN RAISE EXCEPTION 'message tombstone author is outside erasure principal'; END IF;
	IF NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.message_id
		AND session_id = NEW.session_id AND sender_id = NEW.author_principal_id)
	THEN RAISE EXCEPTION 'message tombstone source author/session mismatch'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_erasure_message_tombstones_guard BEFORE INSERT OR UPDATE OR DELETE ON "account_erasure_message_tombstones"
FOR EACH ROW EXECUTE FUNCTION account_erasure_message_tombstone_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_storage_source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP <> 'DELETE' THEN RETURN NEW; END IF;
	IF NOT EXISTS (
		SELECT 1 FROM account_erasure_targets t
		JOIN account_erasure_jobs j ON j.id = t.job_id
		WHERE t.kind = 'storage_object' AND t.resource_id = OLD.id
			AND t.state <> 'succeeded' AND j.state <> 'succeeded'
			AND account_erasure_principal_matches(j.account_id, OLD.owner_account_id)
	) THEN RETURN OLD; END IF;
	IF NOT account_erasure_target_claim_matches(OLD.owner_account_id, 'storage_object', OLD.id)
	THEN RAISE EXCEPTION 'storage source deletion requires exact live erasure target claim'; END IF;
	IF nullif(current_setting('eden3.erasure_external_absence_id', true), '') IS DISTINCT FROM OLD.id::text
	THEN RAISE EXCEPTION 'positive storage absence must precede source disposal'; END IF;
	IF EXISTS (SELECT 1 FROM storage_uploads u WHERE u.object_id = OLD.id AND NOT (
		(u.state = 'completed' AND u.cleanup_state = 'not_required')
		OR (u.state IN ('aborted','expired') AND u.cleanup_state = 'succeeded')
	)) THEN RAISE EXCEPTION 'multipart cleanup must succeed before storage erasure'; END IF;
	IF EXISTS (SELECT 1 FROM storage_policy_events WHERE object_id = OLD.id)
	THEN RAISE EXCEPTION 'storage policy audit must be disposed before its object'; END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_erasure_storage_source_delete BEFORE DELETE ON "storage_objects"
FOR EACH ROW EXECUTE FUNCTION account_erasure_storage_source_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_legacy_source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_account uuid;
BEGIN
	IF TG_OP <> 'DELETE' THEN RETURN NEW; END IF;
	IF NOT EXISTS (
		SELECT 1 FROM account_erasure_targets t
		JOIN account_erasure_jobs j ON j.id = t.job_id
		WHERE t.kind = 'legacy_media_asset' AND t.resource_id = OLD.id
			AND t.state <> 'succeeded' AND j.state <> 'succeeded'
	) THEN RETURN OLD; END IF;
	SELECT j.account_id INTO v_account FROM account_erasure_jobs j
	WHERE j.id::text = nullif(current_setting('eden3.erasure_job_id', true), '');
	IF v_account IS NULL OR NOT account_erasure_target_claim_matches(v_account, 'legacy_media_asset', OLD.id)
	THEN RAISE EXCEPTION 'legacy source deletion requires exact live erasure target claim'; END IF;
	IF NOT account_erasure_legacy_media_owned(
		(nullif(current_setting('eden3.erasure_job_id', true), ''))::uuid, OLD.id)
	THEN RAISE EXCEPTION 'legacy source retains a foreign or mixed-owner association'; END IF;
	IF nullif(current_setting('eden3.erasure_external_absence_id', true), '') IS DISTINCT FROM OLD.id::text
	THEN RAISE EXCEPTION 'positive storage absence must precede source disposal'; END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_erasure_legacy_source_delete BEFORE DELETE ON "media_assets"
FOR EACH ROW EXECUTE FUNCTION account_erasure_legacy_source_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_message record;
BEGIN
	IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
	PERFORM 1 FROM sessions WHERE id = NEW.session_id FOR SHARE;
	FOR v_message IN SELECT id, sender_id FROM messages WHERE session_id = NEW.session_id ORDER BY id FOR KEY SHARE LOOP
		IF v_message.sender_id IS NOT NULL THEN PERFORM account_erasure_assert_account_writable(v_message.sender_id); END IF;
	END LOOP;
	IF EXISTS (
		SELECT 1 FROM account_erasure_message_tombstones t
		WHERE t.session_id = NEW.session_id AND EXISTS (
			SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.snapshot_payload->'messages','[]'::jsonb)) item
			WHERE item->>'id' = t.message_id::text
		)
	) THEN RAISE EXCEPTION 'snapshot contains an erased message tombstone'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_erasure_snapshot_capture BEFORE INSERT ON "session_share_links"
FOR EACH ROW EXECUTE FUNCTION account_erasure_snapshot_guard();
--> statement-breakpoint

-- EDEN/ERAS = (1162102094, 1163023187). The erasure repository MUST invoke
-- account_erasure_begin_operation() as its first transaction statement,
-- before any SELECT ... FOR UPDATE. Statement triggers also acquire the same
-- exclusive lock as defense in depth for DML-first worker paths. Ordinary
-- writes deliberately do not take this advisory lock: they may already hold
-- an account row, and making them wait here would create a lock inversion.
CREATE OR REPLACE FUNCTION account_erasure_begin_operation() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(1162102094, 1163023187);
	PERFORM set_config('eden3.erasure_operation_lock', 'held', true);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION account_erasure_statement_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_erasure_context boolean;
BEGIN
	v_erasure_context := TG_TABLE_NAME LIKE 'account_erasure_%'
		OR nullif(current_setting('eden3.erasure_job_id', true), '') IS NOT NULL
		OR nullif(current_setting('eden3.erasure_target_kind', true), '') IS NOT NULL
		OR nullif(current_setting('eden3.erasure_target_resource_id', true), '') IS NOT NULL
		OR nullif(current_setting('eden3.erasure_job_claim_token', true), '') IS NOT NULL
		OR nullif(current_setting('eden3.erasure_target_claim_token', true), '') IS NOT NULL
		OR nullif(current_setting('eden3.erasure_inventory_mode', true), '') IS NOT NULL
		OR nullif(current_setting('eden3.erasure_restore_mode', true), '') IS NOT NULL;
	IF v_erasure_context THEN
		PERFORM pg_advisory_xact_lock(1162102094, 1163023187);
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "account_erasure_jobs" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "account_erasure_targets" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "account_erasure_target_requeues" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "account_erasure_message_tombstones" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
--> statement-breakpoint

-- Frozen exhaustive M3 tenant-write inventory. Trigger arguments are
-- <resolver>:<uuid-column>; every OLD and NEW owner is checked in UUID order.
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "accounts" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "agents" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "sessions" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "session_agents" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "session_users" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "messages" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "session_share_links" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "creations" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "content_reports" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "creation_likes" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "agent_likes" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "etl_social_edges" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "collections" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "collection_creations" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "concepts" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "concept_images" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "manna_accounts" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "manna_transactions" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "turn_authorizations" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "turn_provider_runs" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "billing_subscriptions" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "channel_connections" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "channel_onboarding_intents" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "channel_external_identities" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "channel_pairing_requests" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "channel_turns" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "secret_access_audit_events" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "skill_definitions" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "agent_skills" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "distill_state" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "usage_events" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "claude_session_turn_claims" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "memory_revisions" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "memory_dream_runs" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "memory_retrieval_probes" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "triggers" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "media_assets" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "storage_objects" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "storage_uploads" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "storage_upload_parts" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "storage_upload_part_authorizations" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "storage_policy_events" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "app_notifications" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "agent_provision_jobs" FOR EACH STATEMENT EXECUTE FUNCTION account_erasure_statement_lock();
--> statement-breakpoint

CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "accounts" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "agents" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('agent:account_id','account:owner_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "sessions" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:owner_id','session:id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "session_agents" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('session:session_id','agent:agent_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "session_users" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('session:session_id','account:user_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "messages" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('session:session_id','account:sender_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "session_share_links" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('session:session_id','account:created_by');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "creations" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:user_id','agent:agent_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "content_reports" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:reporter_id','account:reviewer_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "creation_likes" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:user_id','creation:creation_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "agent_likes" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:user_id','agent:agent_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "etl_social_edges" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:user_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "collections" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:user_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "collection_creations" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('collection:collection_id','creation:creation_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "concepts" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('agent:agent_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "concept_images" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('concept:concept_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "manna_accounts" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "manna_transactions" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('manna:manna_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "turn_authorizations" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:account_id','agent:agent_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "turn_provider_runs" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('turn:turn_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "billing_subscriptions" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "channel_connections" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('connection:id','account:account_id','agent:agent_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "channel_onboarding_intents" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:account_id','connection:connection_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "channel_external_identities" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('connection:connection_id','account:linked_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "channel_pairing_requests" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('connection:connection_id','account:decided_by_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "channel_turns" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('connection:connection_id','account:account_id','agent:agent_id','session:session_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "secret_access_audit_events" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:actor_account_id','account:owner_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "skill_definitions" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:owner_id','account:reviewer_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "agent_skills" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('agent:agent_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "distill_state" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('agent:agent_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "usage_events" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:user_id','agent:agent_id','session:session_id','message:message_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "claude_session_turn_claims" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('turn:turn_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "memory_revisions" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('agent:agent_account_id','account:actor_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "memory_dream_runs" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('agent:agent_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "memory_retrieval_probes" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('agent:agent_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "triggers" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:user_id','agent:agent_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "media_assets" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('media:id','session:session_id','message:message_id','creation:creation_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "storage_objects" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('object:id','account:owner_account_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "storage_uploads" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:owner_account_id','object:object_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "storage_upload_parts" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('upload:upload_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "storage_upload_part_authorizations" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('upload:upload_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "storage_policy_events" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:owner_account_id','object:object_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "app_notifications" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('account:account_id','agent:source_agent_id');
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "agent_provision_jobs" FOR EACH ROW EXECUTE FUNCTION account_erasure_write_fence('agent:agent_account_id');
