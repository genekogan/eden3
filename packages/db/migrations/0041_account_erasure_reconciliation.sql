ALTER TABLE "account_erasure_jobs" DROP CONSTRAINT "account_erasure_jobs_hash_check";--> statement-breakpoint
ALTER TABLE "account_erasure_jobs" DROP CONSTRAINT "account_erasure_jobs_evidence_group_check";--> statement-breakpoint
ALTER TABLE "account_erasure_targets" DROP CONSTRAINT "account_erasure_targets_kind_check";--> statement-breakpoint
ALTER TABLE "account_erasure_jobs" ADD COLUMN "recovery_manifest_sha256" text;--> statement-breakpoint
ALTER TABLE "account_erasure_jobs" ADD CONSTRAINT "account_erasure_jobs_hash_check" CHECK (("account_erasure_jobs"."ledger_sha256" is null or "account_erasure_jobs"."ledger_sha256" ~ '^[0-9a-f]{64}$') and ("account_erasure_jobs"."ledger_mac_sha256" is null or "account_erasure_jobs"."ledger_mac_sha256" ~ '^[0-9a-f]{64}$') and ("account_erasure_jobs"."inventory_sha256" is null or "account_erasure_jobs"."inventory_sha256" ~ '^[0-9a-f]{64}$') and ("account_erasure_jobs"."recovery_manifest_sha256" is null or "account_erasure_jobs"."recovery_manifest_sha256" ~ '^[0-9a-f]{64}$') and ("account_erasure_jobs"."recovery_ciphertext_sha256" is null or "account_erasure_jobs"."recovery_ciphertext_sha256" ~ '^[0-9a-f]{64}$') and ("account_erasure_jobs"."recovery_mac_sha256" is null or "account_erasure_jobs"."recovery_mac_sha256" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "account_erasure_jobs" ADD CONSTRAINT "account_erasure_jobs_evidence_group_check" CHECK ((("account_erasure_jobs"."ledger_confirmed_at" is null and "account_erasure_jobs"."ledger_sha256" is null and "account_erasure_jobs"."ledger_mac_sha256" is null) or ("account_erasure_jobs"."ledger_confirmed_at" is not null and "account_erasure_jobs"."ledger_sha256" is not null and "account_erasure_jobs"."ledger_mac_sha256" is not null)) and (("account_erasure_jobs"."inventoried_at" is null and "account_erasure_jobs"."inventory_sha256" is null) or ("account_erasure_jobs"."inventoried_at" is not null and "account_erasure_jobs"."inventory_sha256" is not null)) and (("account_erasure_jobs"."recovery_manifest_confirmed_at" is null and "account_erasure_jobs"."recovery_manifest_sha256" is null and "account_erasure_jobs"."recovery_ciphertext_sha256" is null and "account_erasure_jobs"."recovery_mac_sha256" is null and "account_erasure_jobs"."recovery_key_version" is null) or ("account_erasure_jobs"."recovery_manifest_confirmed_at" is not null and "account_erasure_jobs"."recovery_manifest_sha256" is not null and "account_erasure_jobs"."recovery_ciphertext_sha256" is not null and "account_erasure_jobs"."recovery_mac_sha256" is not null and "account_erasure_jobs"."recovery_key_version" >= 1)));--> statement-breakpoint
ALTER TABLE "account_erasure_targets" ADD CONSTRAINT "account_erasure_targets_kind_check" CHECK ("account_erasure_targets"."kind" in ('storage_object', 'legacy_media_asset', 'legacy_concept_asset', 'agent_runtime', 'channel_runtime', 'clerk_identity', 'stripe_customer', 'backup_tombstone'));
--> statement-breakpoint

CREATE TABLE "stripe_checkout_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "accounts"("id"),
	"kind" text NOT NULL,
	"state" text DEFAULT 'preparing' NOT NULL,
	"request_key_sha256" text NOT NULL UNIQUE,
	"stripe_session_id" text UNIQUE,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_checkout_intents_kind_chk" CHECK ("kind" in ('manna_topup','subscription')),
	CONSTRAINT "stripe_checkout_intents_state_chk" CHECK ("state" in ('preparing','provider_started','created','failed')),
	CONSTRAINT "stripe_checkout_intents_request_hash_chk" CHECK ("request_key_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "stripe_checkout_intents_session_chk" CHECK ("stripe_session_id" is null or "stripe_session_id" ~ '^cs_[A-Za-z0-9_]{3,252}$'),
	CONSTRAINT "stripe_checkout_intents_error_chk" CHECK ("last_error_code" is null or "last_error_code" ~ '^[a-z0-9_]{1,100}$'),
	CONSTRAINT "stripe_checkout_intents_shape_chk" CHECK (
		("state" in ('preparing','provider_started') and "stripe_session_id" is null and "last_error_code" is null)
		or ("state"='created' and "stripe_session_id" is not null and "last_error_code" is null)
		or ("state"='failed' and "stripe_session_id" is null and "last_error_code" is not null)
	)
);
--> statement-breakpoint
CREATE INDEX "stripe_checkout_intents_account_state_idx"
	ON "stripe_checkout_intents" ("account_id","state");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.account_erasure_stripe_checkout_intent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF TG_OP='DELETE' THEN RETURN OLD; END IF;
	IF TG_OP='INSERT' THEN
		IF NEW.state<>'preparing' OR NEW.stripe_session_id IS NOT NULL
			OR NEW.last_error_code IS NOT NULL THEN
			RAISE EXCEPTION 'checkout intent must begin preparing';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.kind<>OLD.kind
		OR NEW.request_key_sha256<>OLD.request_key_sha256 OR NEW.created_at<>OLD.created_at
	THEN RAISE EXCEPTION 'checkout intent identity is immutable'; END IF;
	IF NOT ((OLD.state='preparing' AND NEW.state IN ('provider_started','failed'))
		OR (OLD.state='provider_started' AND NEW.state IN ('created','failed')))
	THEN RAISE EXCEPTION 'invalid checkout intent transition'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stripe_checkout_intent_guard
BEFORE INSERT OR UPDATE OR DELETE ON "stripe_checkout_intents"
FOR EACH ROW EXECUTE FUNCTION public.account_erasure_stripe_checkout_intent_guard();
--> statement-breakpoint
CREATE TRIGGER a_account_erasure_statement_lock
BEFORE INSERT OR UPDATE OR DELETE ON "stripe_checkout_intents"
FOR EACH STATEMENT EXECUTE FUNCTION public.account_erasure_statement_lock();
--> statement-breakpoint
CREATE TRIGGER z_account_erasure_fence
BEFORE INSERT OR UPDATE OR DELETE ON "stripe_checkout_intents"
FOR EACH ROW EXECUTE FUNCTION public.account_erasure_write_fence('account:account_id');
--> statement-breakpoint

CREATE TABLE "channel_outbound_post_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "accounts"("id"),
	"connection_id" uuid NOT NULL REFERENCES "channel_connections"("id"),
	"state" text DEFAULT 'preparing' NOT NULL,
	"provider_post_id" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_outbound_post_intents_state_chk" CHECK ("state" in ('preparing','provider_started','succeeded','failed')),
	CONSTRAINT "channel_outbound_post_intents_post_id_chk" CHECK ("provider_post_id" is null or "provider_post_id" ~ '^[A-Za-z0-9_:-]{1,255}$'),
	CONSTRAINT "channel_outbound_post_intents_error_chk" CHECK ("last_error_code" is null or "last_error_code" ~ '^[a-z0-9_]{1,100}$'),
	CONSTRAINT "channel_outbound_post_intents_shape_chk" CHECK (
		("state" in ('preparing','provider_started') and "provider_post_id" is null and "last_error_code" is null)
		or ("state"='succeeded' and "provider_post_id" is not null and "last_error_code" is null)
		or ("state"='failed' and "provider_post_id" is null and "last_error_code" is not null)
	)
);
--> statement-breakpoint
CREATE INDEX "channel_outbound_post_intents_account_state_idx"
	ON "channel_outbound_post_intents" ("account_id","state");
--> statement-breakpoint
CREATE INDEX "channel_outbound_post_intents_connection_idx"
	ON "channel_outbound_post_intents" ("connection_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.account_erasure_channel_outbound_intent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF TG_OP='DELETE' THEN RETURN OLD; END IF;
	IF TG_OP='INSERT' THEN
		IF NEW.state<>'preparing' OR NEW.provider_post_id IS NOT NULL OR NEW.last_error_code IS NOT NULL
		THEN RAISE EXCEPTION 'outbound intent must begin preparing'; END IF;
		RETURN NEW;
	END IF;
	IF NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.connection_id<>OLD.connection_id
		OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'outbound intent identity is immutable'; END IF;
	IF NOT ((OLD.state='preparing' AND NEW.state IN ('provider_started','failed'))
		OR (OLD.state='provider_started' AND NEW.state IN ('succeeded','failed')))
	THEN RAISE EXCEPTION 'invalid outbound intent transition'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER channel_outbound_post_intent_guard
BEFORE INSERT OR UPDATE OR DELETE ON "channel_outbound_post_intents"
FOR EACH ROW EXECUTE FUNCTION public.account_erasure_channel_outbound_intent_guard();
--> statement-breakpoint
CREATE TRIGGER a_account_erasure_statement_lock
BEFORE INSERT OR UPDATE OR DELETE ON "channel_outbound_post_intents"
FOR EACH STATEMENT EXECUTE FUNCTION public.account_erasure_statement_lock();
--> statement-breakpoint
CREATE TRIGGER z_account_erasure_fence
BEFORE INSERT OR UPDATE OR DELETE ON "channel_outbound_post_intents"
FOR EACH ROW EXECUTE FUNCTION public.account_erasure_write_fence('account:account_id','connection:connection_id');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_concept_target_success_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF OLD.state='claimed' AND NEW.state='succeeded' AND NEW.kind='legacy_concept_asset'
		AND (nullif(current_setting('eden3.erasure_external_absence_id',true),'')
			IS DISTINCT FROM NEW.resource_id::text
			OR EXISTS (SELECT 1 FROM public.concept_images WHERE id=NEW.resource_id))
	THEN RAISE EXCEPTION 'positive concept asset absence must precede source disposal'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_erasure_concept_target_success_guard
BEFORE UPDATE ON account_erasure_targets FOR EACH ROW
EXECUTE FUNCTION public.account_erasure_concept_target_success_guard();
--> statement-breakpoint

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='eden3_erasure_operator') THEN
		CREATE ROLE eden3_erasure_operator NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='eden3_erasure_guard') THEN
		CREATE ROLE eden3_erasure_guard NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='eden3_erasure_terminal_writer') THEN
		CREATE ROLE eden3_erasure_terminal_writer NOLOGIN;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='eden3_erasure_operator'
		AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolbypassrls OR rolreplication))
		OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
			WHERE r.rolname='eden3_erasure_operator' AND m.admin_option)
	THEN RAISE EXCEPTION 'unsafe preexisting eden3_erasure_operator role'; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='eden3_erasure_guard'
		AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolbypassrls OR rolreplication))
		OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
			WHERE r.rolname='eden3_erasure_guard')
	THEN RAISE EXCEPTION 'unsafe preexisting eden3_erasure_guard role'; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='eden3_erasure_terminal_writer'
		AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolbypassrls OR rolreplication))
		OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
			WHERE r.rolname='eden3_erasure_terminal_writer' AND m.admin_option)
	THEN RAISE EXCEPTION 'unsafe preexisting eden3_erasure_terminal_writer role'; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.account_erasure_operator_authorized()
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
	SELECT pg_has_role(session_user,'eden3_erasure_operator','member')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.account_erasure_begin_operation() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF NOT public.account_erasure_operator_authorized() THEN
		RAISE EXCEPTION 'account erasure requires the dedicated operator role' USING ERRCODE='42501';
	END IF;
	PERFORM pg_advisory_xact_lock(1162102094,1163023187);
	PERFORM set_config('eden3.erasure_operation_lock','held',true);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.account_erasure_unclaimed_seal_matches(p_account_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
	SELECT public.account_erasure_operator_authorized()
		AND nullif(current_setting('eden3.erasure_inventory_mode',true),'')='seal_inventory'
		AND EXISTS (SELECT 1 FROM public.account_erasure_jobs j
			WHERE public.account_erasure_principal_matches(j.account_id,p_account_id)
			AND j.id::text=nullif(current_setting('eden3.erasure_job_id',true),'')
			AND j.state='intent_pending' AND j.inventoried_at IS NULL
			AND j.claim_token IS NULL AND j.claim_expires_at IS NULL)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.account_erasure_job_claim_tuple_matches(p_account_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
	SELECT public.account_erasure_operator_authorized() AND EXISTS (
		SELECT 1 FROM public.account_erasure_jobs j WHERE j.account_id=p_account_id
		AND j.id::text=nullif(current_setting('eden3.erasure_job_id',true),'')
		AND j.state='claimed'
		AND j.claim_token::text=nullif(current_setting('eden3.erasure_job_claim_token',true),'')
		AND j.claim_expires_at=nullif(current_setting('eden3.erasure_job_claim_expires_at',true),'')::timestamptz)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.account_erasure_target_claim_matches(
	p_account_id uuid,p_kind text,p_resource_id uuid
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
	SELECT public.account_erasure_operator_authorized() AND EXISTS (
		SELECT 1 FROM public.account_erasure_targets t JOIN public.account_erasure_jobs j ON j.id=t.job_id
		WHERE public.account_erasure_principal_matches(j.account_id,p_account_id)
		AND t.job_id::text=nullif(current_setting('eden3.erasure_job_id',true),'')
		AND t.kind=p_kind AND t.resource_id=p_resource_id
		AND t.kind=nullif(current_setting('eden3.erasure_target_kind',true),'')
		AND t.resource_id::text=nullif(current_setting('eden3.erasure_target_resource_id',true),'')
		AND t.state='claimed'
		AND t.claim_token::text=nullif(current_setting('eden3.erasure_target_claim_token',true),'')
		AND t.claim_expires_at=nullif(current_setting('eden3.erasure_target_claim_expires_at',true),'')::timestamptz
		AND t.claim_expires_at>statement_timestamp())
$$;
--> statement-breakpoint

-- Ordinary writers must be able to execute the account fence without direct
-- row-lock privileges on the erasure journal. The guard-owned assertion is
-- read-only and admits a live job only for the dedicated operator session and
-- its exact claim tuple; spoofed custom GUCs are never capabilities.
CREATE OR REPLACE FUNCTION public.account_erasure_assert_account_writable(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
	v_deleted boolean;
	v_human_id uuid;
	v_job public.account_erasure_jobs%ROWTYPE;
BEGIN
	IF p_account_id IS NULL THEN RETURN; END IF;
	SELECT deleted INTO v_deleted FROM public.accounts WHERE id=p_account_id FOR KEY SHARE;
	IF NOT FOUND THEN RETURN; END IF;
	SELECT owner_id INTO v_human_id FROM public.agents WHERE account_id=p_account_id;
	v_human_id:=COALESCE(v_human_id,p_account_id);
	IF v_human_id<>p_account_id THEN
		PERFORM 1 FROM public.accounts WHERE id=v_human_id FOR KEY SHARE;
	END IF;
	SELECT * INTO v_job FROM public.account_erasure_jobs
	WHERE account_id=v_human_id AND state<>'succeeded'
	ORDER BY created_at LIMIT 1 FOR SHARE;
	IF NOT v_deleted AND NOT FOUND THEN RETURN; END IF;
	IF public.account_erasure_job_claim_tuple_matches(v_human_id) THEN RETURN; END IF;
	RAISE EXCEPTION 'account is deleted or has an active erasure job' USING ERRCODE='55000';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.account_erasure_assert_account_writable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_erasure_assert_account_writable(uuid)
	TO eden3_erasure_operator,eden3_erasure_terminal_writer;
ALTER FUNCTION public.account_erasure_assert_account_writable(uuid) OWNER TO eden3_erasure_guard;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_manifest_digest_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF OLD.recovery_manifest_sha256 IS NOT NULL
		AND NEW.recovery_manifest_sha256 IS DISTINCT FROM OLD.recovery_manifest_sha256
	THEN RAISE EXCEPTION 'recovery plaintext manifest digest is immutable'; END IF;
	IF NEW.recovery_manifest_sha256 IS DISTINCT FROM OLD.recovery_manifest_sha256
		AND NOT (OLD.recovery_manifest_sha256 IS NULL
			AND NEW.recovery_manifest_sha256 ~ '^[0-9a-f]{64}$'
			AND OLD.recovery_manifest_confirmed_at IS NULL
			AND NEW.recovery_manifest_confirmed_at IS NOT NULL)
	THEN RAISE EXCEPTION 'manifest digest requires the exact confirmation transition'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_erasure_manifest_digest_guard
BEFORE UPDATE ON account_erasure_jobs FOR EACH ROW
EXECUTE FUNCTION public.account_erasure_manifest_digest_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_target_owned(
	p_job_id uuid, p_kind text, p_resource_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_account_id uuid;
BEGIN
	SELECT account_id INTO v_account_id FROM public.account_erasure_jobs WHERE id=p_job_id;
	IF v_account_id IS NULL THEN RETURN false; END IF;
	CASE p_kind
		WHEN 'backup_tombstone' THEN RETURN p_resource_id=p_job_id;
		WHEN 'storage_object' THEN RETURN EXISTS (
			SELECT 1 FROM public.storage_objects o WHERE o.id=p_resource_id
			AND public.account_erasure_principal_matches(v_account_id,o.owner_account_id));
		WHEN 'legacy_media_asset' THEN RETURN public.account_erasure_legacy_media_owned(p_job_id,p_resource_id);
		WHEN 'legacy_concept_asset' THEN RETURN EXISTS (
			SELECT 1 FROM public.concept_images i JOIN public.concepts c ON c.id=i.concept_id
			JOIN public.agents a ON a.account_id=c.agent_id
			WHERE i.id=p_resource_id AND a.owner_id=v_account_id);
		WHEN 'agent_runtime' THEN RETURN EXISTS (
			SELECT 1 FROM public.agents WHERE account_id=p_resource_id AND owner_id=v_account_id);
		WHEN 'channel_runtime' THEN RETURN EXISTS (
			SELECT 1 FROM public.channel_connections WHERE id=p_resource_id AND account_id=v_account_id);
		WHEN 'clerk_identity' THEN RETURN p_resource_id=v_account_id AND EXISTS (
			SELECT 1 FROM public.accounts WHERE id=v_account_id AND clerk_user_id IS NOT NULL);
		WHEN 'stripe_customer' THEN RETURN p_resource_id=v_account_id AND (
			EXISTS (SELECT 1 FROM public.billing_subscriptions WHERE account_id=v_account_id)
			OR EXISTS (SELECT 1 FROM public.stripe_checkout_intents WHERE account_id=v_account_id)
			OR EXISTS (SELECT 1 FROM public.manna_transactions t JOIN public.manna_accounts m
				ON m.id=t.manna_account_id WHERE m.account_id=v_account_id
				AND t.type IN ('credit:stripe','credit:subscription'))
		);
		ELSE RETURN false;
	END CASE;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_lock_legacy_content(
	p_sha text,p_url text,p_alt_url text,p_path text,p_alt_path text,
	p_old_sha text,p_old_url text,p_old_alt_url text,p_old_path text,p_old_alt_path text
) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_key text;
BEGIN
	FOR v_key IN
		SELECT DISTINCT key FROM unnest(ARRAY[
			CASE WHEN nullif(p_sha,'') IS NULL THEN NULL ELSE 'sha:'||p_sha END,
			CASE WHEN nullif(p_url,'') IS NULL THEN NULL ELSE 'url:'||p_url END,
			CASE WHEN nullif(p_alt_url,'') IS NULL THEN NULL ELSE 'url:'||p_alt_url END,
			CASE WHEN nullif(p_path,'') IS NULL THEN NULL ELSE 'path:'||p_path END,
			CASE WHEN nullif(p_alt_path,'') IS NULL THEN NULL ELSE 'path:'||p_alt_path END,
			CASE WHEN nullif(p_old_sha,'') IS NULL THEN NULL ELSE 'sha:'||p_old_sha END,
			CASE WHEN nullif(p_old_url,'') IS NULL THEN NULL ELSE 'url:'||p_old_url END,
			CASE WHEN nullif(p_old_alt_url,'') IS NULL THEN NULL ELSE 'url:'||p_old_alt_url END,
			CASE WHEN nullif(p_old_path,'') IS NULL THEN NULL ELSE 'path:'||p_old_path END,
			CASE WHEN nullif(p_old_alt_path,'') IS NULL THEN NULL ELSE 'path:'||p_old_alt_path END
		]) key WHERE key IS NOT NULL ORDER BY key
	LOOP
		PERFORM pg_advisory_xact_lock(hashtextextended('eden3-erasure-content:'||v_key,0));
	END LOOP;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_legacy_content_ingest_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_row jsonb := to_jsonb(NEW); v_old jsonb := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
	v_sha text; v_url text; v_alt_url text; v_path text; v_alt_path text;
	v_old_sha text; v_old_url text; v_old_alt_url text; v_old_path text; v_old_alt_path text;
BEGIN
	v_sha := nullif(v_row->>'sha256','');
	v_url := nullif(v_row->>'url','');
	v_alt_url := nullif(v_row->>'thumbnail_url','');
	v_path := nullif(v_row->>'local_path','');
	v_alt_path := nullif(v_row->>'source_path','');
	v_old_sha := nullif(v_old->>'sha256','');
	v_old_url := nullif(v_old->>'url','');
	v_old_alt_url := nullif(v_old->>'thumbnail_url','');
	v_old_path := nullif(v_old->>'local_path','');
	v_old_alt_path := nullif(v_old->>'source_path','');
	-- Privacy/status updates that leave the content identity byte-identical do
	-- not create a new reference and must remain available to the erasure job.
	IF TG_OP='UPDATE'
		AND v_row->>'sha256' IS NOT DISTINCT FROM v_old->>'sha256'
		AND v_row->>'url' IS NOT DISTINCT FROM v_old->>'url'
		AND v_row->>'thumbnail_url' IS NOT DISTINCT FROM v_old->>'thumbnail_url'
		AND v_row->>'local_path' IS NOT DISTINCT FROM v_old->>'local_path'
		AND v_row->>'source_path' IS NOT DISTINCT FROM v_old->>'source_path'
	THEN RETURN NEW; END IF;
	IF v_sha IS NULL AND v_url IS NULL AND v_alt_url IS NULL AND v_path IS NULL AND v_alt_path IS NULL
		AND v_old_sha IS NULL AND v_old_url IS NULL AND v_old_alt_url IS NULL
		AND v_old_path IS NULL AND v_old_alt_path IS NULL THEN RETURN NEW; END IF;
	PERFORM public.account_erasure_lock_legacy_content(v_sha,v_url,v_alt_url,v_path,v_alt_path,
		v_old_sha,v_old_url,v_old_alt_url,v_old_path,v_old_alt_path);
	IF EXISTS (
		SELECT 1 FROM public.account_erasure_targets t JOIN public.account_erasure_jobs j ON j.id=t.job_id
		LEFT JOIN public.media_assets m ON t.kind='legacy_media_asset' AND m.id=t.resource_id
		LEFT JOIN public.concept_images i ON t.kind='legacy_concept_asset' AND i.id=t.resource_id
		WHERE t.state <> 'succeeded' AND j.state <> 'succeeded'
		AND (v_sha IS NOT NULL AND v_sha IN (m.sha256,i.sha256)
			OR v_old_sha IS NOT NULL AND v_old_sha IN (m.sha256,i.sha256)
			OR v_url IS NOT NULL AND v_url IN (m.url,i.url)
			OR v_old_url IS NOT NULL AND v_old_url IN (m.url,i.url)
			OR v_alt_url IS NOT NULL AND v_alt_url IN (m.url,i.url)
			OR v_old_alt_url IS NOT NULL AND v_old_alt_url IN (m.url,i.url)
			OR v_url IS NOT NULL AND m.local_path IS NOT NULL
				AND v_url='/media/'||regexp_replace(m.local_path,'^.*/','')
			OR v_alt_url IS NOT NULL AND m.local_path IS NOT NULL
				AND v_alt_url='/media/'||regexp_replace(m.local_path,'^.*/','')
			OR v_path IS NOT NULL AND v_path IN (m.local_path,m.source_path,i.local_path)
			OR v_alt_path IS NOT NULL AND v_alt_path IN (m.local_path,m.source_path,i.local_path)
			OR v_old_path IS NOT NULL AND v_old_path IN (m.local_path,m.source_path,i.local_path)
			OR v_old_alt_path IS NOT NULL AND v_old_alt_path IN (m.local_path,m.source_path,i.local_path))
	) THEN RAISE EXCEPTION 'legacy content is fenced by active erasure'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.account_erasure_lock_legacy_content(text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.account_erasure_legacy_content_ingest_fence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_erasure_lock_legacy_content(text,text,text,text,text,text,text,text,text,text)
	TO eden3_erasure_operator;
GRANT SELECT ON account_erasure_targets,account_erasure_jobs,media_assets,concept_images
	TO eden3_erasure_guard;
ALTER FUNCTION public.account_erasure_lock_legacy_content(text,text,text,text,text,text,text,text,text,text)
	OWNER TO eden3_erasure_guard;
ALTER FUNCTION public.account_erasure_legacy_content_ingest_fence() OWNER TO eden3_erasure_guard;
--> statement-breakpoint
CREATE TRIGGER zz_account_erasure_media_ingest_fence BEFORE INSERT OR UPDATE ON media_assets
FOR EACH ROW EXECUTE FUNCTION public.account_erasure_legacy_content_ingest_fence();
--> statement-breakpoint
CREATE TRIGGER zz_account_erasure_concept_ingest_fence BEFORE INSERT OR UPDATE ON concept_images
FOR EACH ROW EXECUTE FUNCTION public.account_erasure_legacy_content_ingest_fence();
--> statement-breakpoint
CREATE TRIGGER zz_account_erasure_creation_ingest_fence BEFORE INSERT OR UPDATE ON creations
FOR EACH ROW EXECUTE FUNCTION public.account_erasure_legacy_content_ingest_fence();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_concept_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_account uuid;
BEGIN
	IF TG_OP <> 'DELETE' THEN RETURN NEW; END IF;
	IF NOT EXISTS (SELECT 1 FROM public.account_erasure_targets t JOIN public.account_erasure_jobs j ON j.id=t.job_id
		WHERE t.kind='legacy_concept_asset' AND t.resource_id=OLD.id
		AND t.state <> 'succeeded' AND j.state <> 'succeeded') THEN RETURN OLD; END IF;
	SELECT j.account_id INTO v_account FROM public.account_erasure_jobs j
	WHERE j.id::text=nullif(current_setting('eden3.erasure_job_id',true),'');
	IF v_account IS NULL OR NOT public.account_erasure_target_claim_matches(v_account,'legacy_concept_asset',OLD.id)
	THEN RAISE EXCEPTION 'concept source deletion requires exact live erasure target claim'; END IF;
	IF nullif(current_setting('eden3.erasure_external_absence_id',true),'') IS DISTINCT FROM OLD.id::text
	THEN RAISE EXCEPTION 'positive storage absence must precede source disposal'; END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_erasure_concept_source_delete BEFORE DELETE ON concept_images
FOR EACH ROW EXECUTE FUNCTION public.account_erasure_concept_source_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_current_seal_job()
RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
	SELECT j.id FROM public.account_erasure_jobs j
	WHERE public.account_erasure_operator_authorized()
	AND j.id::text=nullif(current_setting('eden3.erasure_job_id',true),'')
	AND ((j.state='intent_pending' AND nullif(current_setting('eden3.erasure_inventory_mode',true),'')='seal_inventory')
		OR (j.state='claimed' AND j.claim_expires_at>statement_timestamp()
			AND public.account_erasure_job_claim_tuple_matches(j.account_id)))
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_session_affected(p_job uuid,p_session uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
	SELECT EXISTS (
		SELECT 1 FROM public.account_erasure_jobs j WHERE j.id=p_job AND (
			EXISTS (SELECT 1 FROM public.sessions s WHERE s.id=p_session
				AND public.account_erasure_principal_matches(j.account_id,s.owner_id))
			OR EXISTS (SELECT 1 FROM public.session_users u WHERE u.session_id=p_session
				AND public.account_erasure_principal_matches(j.account_id,u.user_account_id))
			OR EXISTS (SELECT 1 FROM public.session_agents a WHERE a.session_id=p_session
				AND public.account_erasure_principal_matches(j.account_id,a.agent_account_id))
			OR EXISTS (SELECT 1 FROM public.account_erasure_message_tombstones m
				WHERE m.job_id=j.id AND m.session_id=p_session)
		)
	)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_principal_has_active_job(p_principal uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
	SELECT EXISTS (
		SELECT 1 FROM public.account_erasure_jobs j
		WHERE j.state <> 'succeeded' AND (
			j.account_id=p_principal OR EXISTS (
				SELECT 1 FROM public.agents a WHERE a.account_id=p_principal AND a.owner_id=j.account_id
			)
		)
	)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_write_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
	v_row jsonb; v_arg text; v_mode text; v_column text; v_resource uuid; v_owner uuid;
	v_owners uuid[] := ARRAY[]::uuid[]; v_unclaimed_allowed boolean := false;
	v_job uuid := public.account_erasure_current_seal_job(); v_job_account uuid; v_target_account uuid;
	v_old jsonb; v_new jsonb;
BEGIN
	v_old:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
	v_new:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
	IF TG_TABLE_NAME='accounts' AND TG_OP='INSERT'
		AND EXISTS (SELECT 1 FROM public.account_erasure_jobs WHERE account_id=(v_new->>'id')::uuid)
		AND COALESCE((v_new->>'deleted')::boolean,false)=false
	THEN RAISE EXCEPTION 'restore replay may recreate an erased account only as deleted' USING ERRCODE='55000'; END IF;
	IF v_job IS NOT NULL THEN SELECT account_id INTO v_job_account FROM public.account_erasure_jobs WHERE id=v_job; END IF;
	SELECT account_id INTO v_target_account FROM public.account_erasure_jobs
	WHERE id::text=nullif(current_setting('eden3.erasure_job_id',true),'');

	-- Existing provider work may write only monotonic terminal evidence after
	-- Tx1 freezes admission. The recovery worker consumes this durable evidence;
	-- it never infers no-output merely from elapsed time.
	IF TG_TABLE_NAME='stripe_checkout_intents' AND TG_OP='UPDATE'
		AND v_old->>'state'='preparing' AND v_new->>'state'='failed'
		AND v_new->>'last_error_code'='erasure_cancelled_before_provider'
		AND v_new->>'stripe_session_id' IS NULL
		AND (v_new-'state'-'last_error_code'-'updated_at')=
			(v_old-'state'-'last_error_code'-'updated_at')
		AND current_user='eden3_erasure_guard'
		AND public.account_erasure_principal_has_active_job((v_old->>'account_id')::uuid)
	THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME='channel_outbound_post_intents' AND TG_OP='UPDATE'
		AND v_old->>'state'='preparing' AND v_new->>'state'='failed'
		AND v_new->>'last_error_code'='erasure_cancelled_before_provider'
		AND v_new->>'provider_post_id' IS NULL
		AND (v_new-'state'-'last_error_code'-'updated_at')=
			(v_old-'state'-'last_error_code'-'updated_at')
		AND current_user='eden3_erasure_guard'
		AND public.account_erasure_principal_has_active_job((v_old->>'account_id')::uuid)
	THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME='stripe_checkout_intents' AND TG_OP='UPDATE'
		AND current_user='eden3_erasure_guard'
		AND v_old->>'state'='provider_started' AND v_new->>'state' IN ('created','failed')
		AND (v_new-'state'-'stripe_session_id'-'last_error_code'-'updated_at')=
			(v_old-'state'-'stripe_session_id'-'last_error_code'-'updated_at')
		AND public.account_erasure_principal_has_active_job((v_old->>'account_id')::uuid)
	THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME='channel_outbound_post_intents' AND TG_OP='UPDATE'
		AND current_user='eden3_erasure_guard'
		AND v_old->>'state'='provider_started' AND v_new->>'state' IN ('succeeded','failed')
		AND (v_new-'state'-'provider_post_id'-'last_error_code'-'updated_at')=
			(v_old-'state'-'provider_post_id'-'last_error_code'-'updated_at')
		AND public.account_erasure_principal_has_active_job((v_old->>'account_id')::uuid)
	THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME='turn_provider_runs' AND TG_OP='UPDATE'
		AND v_old->>'usable_output_at' IS NULL AND v_new->>'usable_output_at' IS NOT NULL
		AND (v_new-'usable_output_at')=(v_old-'usable_output_at')
		AND EXISTS (SELECT 1 FROM public.turn_authorizations a WHERE a.turn_id=(v_old->>'turn_id')::uuid
			AND public.account_erasure_principal_has_active_job(COALESCE(a.agent_account_id,a.account_id)))
	THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME='usage_events' AND TG_OP='UPDATE'
		AND current_user='eden3_erasure_guard'
		AND v_old->>'status' IN ('pending','provider_admitted','running','refund_pending')
		AND v_new->>'status'='error' AND v_new->>'error_code'='provider_terminal_no_output'
		AND v_new->>'error_message' IS NULL
		AND (v_new->>'manna' IS NULL OR (v_new->>'manna')::numeric=0)
		AND v_new->'metadata'='null'::jsonb
		AND (v_new-'status'-'error_code'-'error_message'-'manna'-'metadata')=
			(v_old-'status'-'error_code'-'error_message'-'manna'-'metadata')
		AND public.account_erasure_principal_has_active_job(COALESCE((v_old->>'agent_id')::uuid,(v_old->>'user_id')::uuid))
	THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME='secret_access_audit_events' AND TG_OP='UPDATE'
		AND v_old->>'secret_kind'='channel_token'
		AND v_new->>'actor_account_id' IS NULL AND v_new->>'owner_account_id' IS NULL
		AND v_new->'metadata'='{}'::jsonb
		AND (v_new-'actor_account_id'-'owner_account_id'-'metadata')=
			(v_old-'actor_account_id'-'owner_account_id'-'metadata')
		AND public.account_erasure_target_claim_matches(
			COALESCE((v_old->>'owner_account_id')::uuid,(v_old->>'actor_account_id')::uuid),
			'channel_runtime',(v_old->>'secret_id')::uuid)
	THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME='usage_events' AND TG_OP='UPDATE'
		AND current_user='eden3_erasure_guard'
		AND v_old->>'event_type' IN ('studio_generation','chat_media')
		AND v_old->>'status'='provider_admitted' AND v_new->>'status'='refund_pending'
		AND v_new->>'error_code'='refund_pending' AND v_new->>'error_message' IS NULL
		AND v_new->'metadata'->'terminalEvidence'->>'code'='provider_terminal_no_output'
		AND v_new->'metadata'->'outputQuarantine'->>'version'='1'
		AND (v_new-'status'-'error_code'-'error_message'-'metadata')=
			(v_old-'status'-'error_code'-'error_message'-'metadata')
		AND public.account_erasure_principal_has_active_job(COALESCE((v_old->>'agent_id')::uuid,(v_old->>'user_id')::uuid))
	THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME='memory_dream_runs' AND TG_OP='UPDATE'
		AND v_old->>'status' IN ('running','recovery_pending')
		AND v_new->>'status' IN ('done','skipped','error')
		AND v_new->>'provider_status'='terminal' AND v_new->>'completed_at' IS NOT NULL
		AND v_new->>'claim_token' IS NULL AND v_new->>'lease_expires_at' IS NULL
		AND (v_new-'status'-'provider_status'-'completed_at'-'claim_token'-'lease_expires_at'-'error'-'duration_ms'-'usage_event_id'-'sha256'-'provenance'-'promoted_count')
			=(v_old-'status'-'provider_status'-'completed_at'-'claim_token'-'lease_expires_at'-'error'-'duration_ms'-'usage_event_id'-'sha256'-'provenance'-'promoted_count')
		AND public.account_erasure_principal_has_active_job((v_old->>'agent_account_id')::uuid)
	THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='manna_accounts' AND TG_OP='UPDATE'
		AND public.account_erasure_reversal_authorized(
			(nullif(current_setting('eden3.erasure_reversal_reservation',true),''))::uuid,
			(nullif(current_setting('eden3.erasure_reversal_amount',true),''))::numeric,
			(nullif(current_setting('eden3.erasure_reversal_subscription',true),''))::numeric)
		AND public.account_erasure_principal_matches(v_job_account,(v_old->>'account_id')::uuid)
		AND (v_new->>'balance')::numeric=(v_old->>'balance')::numeric+
			(nullif(current_setting('eden3.erasure_reversal_amount',true),''))::numeric
		AND (v_new->>'subscription_balance')::numeric=(v_old->>'subscription_balance')::numeric+
			(nullif(current_setting('eden3.erasure_reversal_subscription',true),''))::numeric
		AND (v_new-'balance'-'subscription_balance'-'updated_at')=(v_old-'balance'-'subscription_balance'-'updated_at')
	THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='manna_transactions' AND TG_OP='INSERT'
		AND public.account_erasure_reversal_authorized(
			(v_new->>'refunds_transaction_id')::uuid,(v_new->>'amount')::numeric,
			(nullif(current_setting('eden3.erasure_reversal_subscription',true),''))::numeric)
		AND v_new->>'type'='refund:account_erasure'
		AND v_new->>'idempotency_key'='refund:'||(SELECT idempotency_key FROM public.manna_transactions
			WHERE id=(v_new->>'refunds_transaction_id')::uuid)
	THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME='manna_transactions' AND TG_OP='UPDATE'
		AND v_old->>'type' IN ('credit:stripe','credit:subscription')
		AND public.account_erasure_target_claim_matches((SELECT account_id FROM public.manna_accounts
			WHERE id=(v_old->>'manna_account_id')::uuid),'stripe_customer',
			(SELECT account_id FROM public.manna_accounts WHERE id=(v_old->>'manna_account_id')::uuid))
		AND (v_new-'stripe_event_data')=(v_old-'stripe_event_data')
		AND COALESCE(v_new->'stripe_event_data','null'::jsonb)=
			COALESCE(v_old->'stripe_event_data','null'::jsonb)-
				'customerId'-'customer'-'stripeCustomerId'-'subscriptionId'-'stripeSubscriptionId'-'objectId'
	THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='manna_accounts' AND TG_OP='UPDATE'
		AND public.account_erasure_principal_matches(v_job_account,(v_old->>'account_id')::uuid)
		AND v_new->>'external_id' IS NULL
		AND (v_new-'external_id'-'updated_at')=(v_old-'external_id'-'updated_at')
	THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='manna_transactions' AND TG_OP='UPDATE'
		AND public.account_erasure_principal_matches(v_job_account,(SELECT account_id FROM public.manna_accounts
			WHERE id=(v_old->>'manna_account_id')::uuid))
		AND v_new->>'external_id' IS NULL AND v_new->>'task_external_id' IS NULL
		AND v_new->>'voucher_external_id' IS NULL AND v_new->>'code' IS NULL
		AND (v_new-'external_id'-'task_external_id'-'voucher_external_id'-'code'-'stripe_event_data')
			=(v_old-'external_id'-'task_external_id'-'voucher_external_id'-'code'-'stripe_event_data')
		AND COALESCE(v_new->'stripe_event_data','null'::jsonb)=(CASE
			WHEN v_old->>'type' IN ('credit:stripe','credit:subscription')
				AND jsonb_typeof(v_old->'stripe_event_data')='object'
			THEN jsonb_strip_nulls(jsonb_build_object(
				'customerId',v_old->'stripe_event_data'->'customerId',
				'subscriptionId',v_old->'stripe_event_data'->'subscriptionId',
				'objectId',v_old->'stripe_event_data'->'objectId'))
			ELSE 'null'::jsonb END)
	THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='turn_authorizations' AND TG_OP='UPDATE'
		AND v_new->>'turn_id'=v_old->>'turn_id' AND v_old->>'state'='reserved'
		AND ((v_new->>'state'='reversed' AND public.account_erasure_reversal_authorized(
			(v_old->>'reservation_tx_id')::uuid,
			(nullif(current_setting('eden3.erasure_reversal_amount',true),''))::numeric,
			(v_old->>'reserved_subscription_manna')::numeric))
		OR (v_new->>'state'='settled' AND (v_new->>'charged_manna')::numeric=(v_old->>'authorized_max_manna')::numeric
			AND EXISTS (SELECT 1 FROM public.turn_provider_runs r WHERE r.turn_id=(v_old->>'turn_id')::uuid
				AND r.usable_output_at IS NOT NULL)))
	THEN RETURN NEW; END IF;

	-- Exact, privacy-reducing cross-owner operations needed to converge shared
	-- sessions. These never add content, transfer ownership, or broaden access.
	IF v_job IS NOT NULL AND TG_TABLE_NAME='session_share_links' AND TG_OP='DELETE'
		AND public.account_erasure_session_affected(v_job,(v_old->>'session_id')::uuid) THEN RETURN OLD; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='session_users' AND TG_OP='DELETE'
		AND public.account_erasure_principal_matches(v_job_account,(v_old->>'user_account_id')::uuid) THEN RETURN OLD; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='session_agents' AND TG_OP='DELETE'
		AND public.account_erasure_principal_matches(v_job_account,(v_old->>'agent_account_id')::uuid) THEN RETURN OLD; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='sessions' AND TG_OP='UPDATE'
		AND public.account_erasure_session_affected(v_job,(v_old->>'id')::uuid)
		AND v_new->>'id'=v_old->>'id' AND v_new->>'owner_id' IS NOT DISTINCT FROM v_old->>'owner_id'
		AND (v_new->>'is_public')::boolean=false
		AND (v_new-'is_public'-'updated_at')=(v_old-'is_public'-'updated_at')
	THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='messages' AND TG_OP='UPDATE'
		AND public.account_erasure_session_affected(v_job,(v_old->>'session_id')::uuid)
		AND v_new->>'id'=v_old->>'id' AND v_new->>'session_id'=v_old->>'session_id'
		AND v_new->>'sender_id' IS NULL AND v_new->>'external_id' IS NULL AND v_new->>'content' IS NULL
		AND v_new->>'eden_message_data' IS NULL AND v_new->>'thought' IS NULL AND v_new->>'tool_call_id' IS NULL
		AND v_new->>'name' IS NULL AND v_new->>'tool_calls' IS NULL AND v_new->>'attachments' IS NULL
		AND v_new->>'reactions' IS NULL AND v_new->>'reply_to_external_id' IS NULL
		AND (public.account_erasure_principal_matches(v_job_account,(v_old->>'sender_id')::uuid) OR NOT EXISTS (
			SELECT 1 FROM public.account_erasure_resolve_owner('session',(v_old->>'session_id')::uuid) o(owner)
			JOIN public.accounts a ON a.id=o.owner WHERE a.deleted=false
			AND NOT public.account_erasure_principal_matches(v_job_account,o.owner)))
	THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='sessions' AND TG_OP='UPDATE'
		AND public.account_erasure_session_affected(v_job,(v_old->>'id')::uuid) AND v_new->>'id'=v_old->>'id'
		AND v_new->>'owner_id' IS NOT DISTINCT FROM v_old->>'owner_id'
		AND (v_new->>'deleted')::boolean=true AND (v_new->>'is_public')::boolean=false
		AND v_new->>'external_id' IS NULL AND v_new->>'title' IS NULL AND v_new->>'gateway_session_key' IS NULL
		AND NOT EXISTS (SELECT 1 FROM public.account_erasure_resolve_owner('session',(v_old->>'id')::uuid) o(owner)
			JOIN public.accounts a ON a.id=o.owner WHERE a.deleted=false
			AND NOT public.account_erasure_principal_matches(v_job_account,o.owner))
	THEN RETURN NEW; END IF;

	-- Exact at-rest tombstones for tenant-owned retained tables.
	IF v_job IS NOT NULL AND TG_TABLE_NAME='collections' AND TG_OP='UPDATE'
		AND public.account_erasure_principal_matches(v_job_account,(v_old->>'user_id')::uuid)
		AND v_new->>'id'=v_old->>'id' AND v_new->>'user_id' IS NOT DISTINCT FROM v_old->>'user_id'
		AND v_new->>'external_id' IS NULL AND v_new->>'name' IS NULL AND v_new->>'description' IS NULL
		AND v_new->>'cover_creation_external_id' IS NULL AND v_new->>'contributors' IS NULL
		AND (v_new->>'public')::boolean=false AND (v_new->>'deleted')::boolean=true THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='collections' AND TG_OP='UPDATE'
		AND NOT public.account_erasure_principal_matches(v_job_account,(v_old->>'user_id')::uuid)
		AND jsonb_typeof(v_old->'contributors')='array'
		AND (v_new-'contributors'-'updated_at')=(v_old-'contributors'-'updated_at')
		AND v_new->'contributors'=(
			SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality),'[]'::jsonb)
			FROM jsonb_array_elements(v_old->'contributors') WITH ORDINALITY item(value,ordinality)
			WHERE NOT EXISTS (
				SELECT 1 FROM public.account_erasure_jobs j
				JOIN public.accounts a ON a.id=j.account_id OR EXISTS (
					SELECT 1 FROM public.agents owned
					WHERE owned.owner_id=j.account_id AND owned.account_id=a.id
				)
				WHERE j.id=v_job AND a.external_id IS NOT NULL
					AND item.value=to_jsonb(a.external_id)
			)
		)
	THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='concepts' AND TG_OP='UPDATE'
		AND public.account_erasure_principal_matches(v_job_account,(v_old->>'agent_id')::uuid)
		AND v_new->>'id'=v_old->>'id' AND v_new->>'agent_id'=v_old->>'agent_id'
		AND (v_new->>'deleted')::boolean=true
		AND v_new->>'slug'=('deleted-'||replace(v_old->>'id','-',''))
		AND v_new->>'name'='[deleted]' AND v_new->>'description' IS NULL AND v_new->>'instructions' IS NULL
	THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='concept_images' AND TG_OP='UPDATE'
		AND EXISTS (SELECT 1 FROM public.concepts c WHERE c.id=(v_old->>'concept_id')::uuid
			AND public.account_erasure_principal_matches(v_job_account,c.agent_id))
		AND v_new->>'id'=v_old->>'id' AND v_new->>'concept_id'=v_old->>'concept_id'
		AND v_new->>'filename' IS NULL AND (v_new-'filename')=(v_old-'filename') THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='skill_definitions' AND TG_OP='UPDATE'
		AND v_old->>'source'='user' AND public.account_erasure_principal_matches(v_job_account,(v_old->>'owner_id')::uuid)
		AND v_new->>'id'=v_old->>'id' AND v_new->>'slug'=('deleted-'||replace(v_old->>'id','-',''))
		AND v_new->>'name'='[deleted]' AND v_new->>'description' IS NULL AND v_new->>'body'=''
		AND v_new->>'source'='user' AND v_new->>'status'='rejected' AND v_new->>'owner_id' IS NULL
		AND v_new->>'reviewer_id' IS NULL AND v_new->>'reviewed_at' IS NULL THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='skill_definitions' AND TG_OP='UPDATE'
		AND public.account_erasure_principal_matches(v_job_account,(v_old->>'reviewer_id')::uuid)
		AND NOT public.account_erasure_principal_matches(v_job_account,(v_old->>'owner_id')::uuid)
		AND v_new->>'reviewer_id' IS NULL AND v_new->>'reviewed_at' IS NULL
		AND (v_new-'reviewer_id'-'reviewed_at'-'updated_at')=
			(v_old-'reviewer_id'-'reviewed_at'-'updated_at')
	THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='etl_social_edges' AND TG_OP='DELETE'
		AND (public.account_erasure_principal_matches(v_job_account,(v_old->>'user_id')::uuid)
			OR (v_old->>'edge_kind'='agent_like'
				AND public.account_erasure_principal_matches(v_job_account,(v_old->>'target_id')::uuid))
			OR (v_old->>'edge_kind'='creation_like' AND EXISTS (
				SELECT 1 FROM public.creations c WHERE c.id=(v_old->>'target_id')::uuid
					AND (public.account_erasure_principal_matches(v_job_account,c.user_id)
						OR public.account_erasure_principal_matches(v_job_account,c.agent_id))
			)))
	THEN RETURN OLD; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='distill_state' AND TG_OP='DELETE'
		AND public.account_erasure_principal_matches(v_job_account,(v_old->>'agent_account_id')::uuid)
	THEN RETURN OLD; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='memory_revisions' AND TG_OP='DELETE'
		AND public.account_erasure_principal_matches(v_job_account,(v_old->>'agent_account_id')::uuid)
	THEN RETURN OLD; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='memory_revisions' AND TG_OP='UPDATE'
		AND public.account_erasure_principal_matches(v_job_account,(v_old->>'actor_account_id')::uuid)
		AND NOT public.account_erasure_principal_matches(v_job_account,(v_old->>'agent_account_id')::uuid)
		AND v_new->>'actor_account_id' IS NULL AND v_new->>'metadata' IS NULL
		AND (v_new-'actor_account_id'-'metadata')=(v_old-'actor_account_id'-'metadata')
	THEN RETURN NEW; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='memory_retrieval_probes' AND TG_OP='DELETE'
		AND public.account_erasure_principal_matches(v_job_account,(v_old->>'agent_account_id')::uuid)
	THEN RETURN OLD; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='claude_session_turn_claims' AND TG_OP='DELETE'
		AND EXISTS (SELECT 1 FROM public.turn_authorizations a WHERE a.turn_id=(v_old->>'turn_id')::uuid
			AND (public.account_erasure_principal_matches(v_job_account,a.account_id)
				OR public.account_erasure_principal_matches(v_job_account,a.agent_account_id)))
	THEN RETURN OLD; END IF;
	IF v_job IS NOT NULL AND TG_TABLE_NAME='app_notifications' AND TG_OP='DELETE'
		AND (public.account_erasure_principal_matches(v_job_account,(v_old->>'account_id')::uuid)
			OR public.account_erasure_principal_matches(v_job_account,(v_old->>'source_agent_id')::uuid))
	THEN RETURN OLD; END IF;

	-- Preserve 0040's exact channel cascade and cleanup exceptions.
	IF TG_TABLE_NAME='sessions' AND TG_OP='UPDATE' AND v_old->>'channel_connection_id' IS NOT NULL
		AND v_new->>'channel_connection_id' IS NULL
		AND (v_new-'channel_connection_id')=(v_old-'channel_connection_id')
		AND public.account_erasure_target_claim_matches((SELECT account_id FROM public.account_erasure_jobs
			WHERE id::text=nullif(current_setting('eden3.erasure_job_id',true),'')),
			'channel_runtime',(v_old->>'channel_connection_id')::uuid) THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME IN ('channel_onboarding_intents','channel_turns') AND TG_OP='UPDATE'
		AND (to_jsonb(OLD)->>'connection_id') IS NOT NULL AND (to_jsonb(NEW)->>'connection_id') IS NULL
		AND (to_jsonb(NEW)-'connection_id')=(to_jsonb(OLD)-'connection_id')
		AND public.account_erasure_target_claim_matches((SELECT account_id FROM public.account_erasure_jobs
			WHERE id::text=nullif(current_setting('eden3.erasure_job_id',true),'')),
			'channel_runtime',(to_jsonb(OLD)->>'connection_id')::uuid) THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME='storage_uploads' AND TG_OP='UPDATE'
		AND v_old->>'state' IN ('aborted','expired') AND v_new->>'state'=v_old->>'state' THEN RETURN NEW; END IF;
	IF TG_TABLE_NAME='storage_policy_events' AND TG_OP='UPDATE' THEN RETURN NEW; END IF;

	v_unclaimed_allowed := ((TG_OP='UPDATE' AND TG_TABLE_NAME IN (
		'accounts','agents','sessions','messages','creations','storage_uploads','channel_connections',
		'channel_turns','turn_authorizations','usage_events','memory_dream_runs','triggers','agent_provision_jobs'))
		OR (TG_OP='DELETE' AND TG_TABLE_NAME IN ('session_agents','session_users','session_share_links',
		'content_reports','creation_likes','agent_likes','collection_creations','agent_skills',
		'channel_onboarding_intents','channel_external_identities','channel_pairing_requests')));
	FOR v_row IN SELECT value FROM jsonb_array_elements(CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
		WHEN 'DELETE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END)
	LOOP
		IF TG_TABLE_NAME='etl_social_edges' THEN
			IF v_row->>'edge_kind'='agent_like' THEN
				FOR v_owner IN SELECT owner FROM public.account_erasure_resolve_owner(
					'agent',(v_row->>'target_id')::uuid) owner
				LOOP v_owners:=array_append(v_owners,v_owner); END LOOP;
			ELSIF v_row->>'edge_kind'='creation_like' THEN
				FOR v_owner IN SELECT owner FROM public.account_erasure_resolve_owner(
					'creation',(v_row->>'target_id')::uuid) owner
				LOOP v_owners:=array_append(v_owners,v_owner); END LOOP;
			ELSE
				RAISE EXCEPTION 'invalid legacy social edge kind';
			END IF;
		END IF;
		IF (TG_TABLE_NAME='accounts' AND public.account_erasure_target_claim_matches((v_row->>'id')::uuid,'clerk_identity',(v_row->>'id')::uuid))
		OR (TG_TABLE_NAME='billing_subscriptions' AND public.account_erasure_target_claim_matches((v_row->>'account_id')::uuid,'stripe_customer',(v_row->>'account_id')::uuid))
			OR (TG_TABLE_NAME='stripe_checkout_intents' AND public.account_erasure_target_claim_matches((v_row->>'account_id')::uuid,'stripe_customer',(v_row->>'account_id')::uuid))
			OR (TG_TABLE_NAME='agents' AND public.account_erasure_target_claim_matches((v_row->>'owner_id')::uuid,'agent_runtime',(v_row->>'account_id')::uuid))
			OR (TG_TABLE_NAME='channel_connections' AND public.account_erasure_target_claim_matches((v_row->>'account_id')::uuid,'channel_runtime',(v_row->>'id')::uuid))
			OR (TG_TABLE_NAME='channel_outbound_post_intents' AND public.account_erasure_target_claim_matches((v_row->>'account_id')::uuid,'channel_runtime',(v_row->>'connection_id')::uuid))
			OR (TG_TABLE_NAME IN ('storage_objects','storage_uploads','storage_policy_events') AND public.account_erasure_target_claim_matches(
				(v_row->>'owner_account_id')::uuid,'storage_object',COALESCE((v_row->>'object_id')::uuid,(v_row->>'id')::uuid)))
			OR (TG_TABLE_NAME='media_assets' AND public.account_erasure_target_claim_matches(v_target_account,'legacy_media_asset',(v_row->>'id')::uuid))
			OR (TG_TABLE_NAME='concept_images' AND public.account_erasure_target_claim_matches(v_target_account,'legacy_concept_asset',(v_row->>'id')::uuid))
		THEN CONTINUE; END IF;
		FOREACH v_arg IN ARRAY TG_ARGV LOOP
			v_mode:=split_part(v_arg,':',1); v_column:=split_part(v_arg,':',2);
			BEGIN v_resource:=nullif(v_row->>v_column,'')::uuid;
			EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid erasure fence UUID source'; END;
			IF v_resource IS NOT NULL THEN FOR v_owner IN SELECT owner FROM public.account_erasure_resolve_owner(v_mode,v_resource) owner
			LOOP v_owners:=array_append(v_owners,v_owner); END LOOP; END IF;
		END LOOP;
	END LOOP;
	FOR v_owner IN SELECT x.owner FROM (SELECT DISTINCT unnest(v_owners) owner) x
		LEFT JOIN public.accounts a ON a.id=x.owner ORDER BY CASE WHEN a.type='user' THEN 0 ELSE 1 END,x.owner
	LOOP
		IF public.account_erasure_restore_authorized()
			OR (v_unclaimed_allowed AND public.account_erasure_unclaimed_seal_matches(v_owner)) THEN CONTINUE; END IF;
		PERFORM public.account_erasure_assert_account_writable(v_owner);
	END LOOP;
	IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Provider-started outbound effects can become terminal after Tx1 wins the
-- account lock. Only the attested ordinary runtime may record exact provider
-- truth, and only against the immutable intent owned by the active job.
CREATE OR REPLACE FUNCTION public.account_erasure_record_stripe_checkout_terminal(
	p_account uuid,p_intent uuid,p_state text,p_session_id text,p_error_code text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_updated uuid;
BEGIN
	IF NOT pg_has_role(session_user,'eden3_erasure_terminal_writer','member') THEN
		RAISE EXCEPTION 'provider terminal evidence requires the trusted application role' USING ERRCODE='42501';
	END IF;
	IF NOT ((p_state='created' AND p_session_id ~ '^cs_[A-Za-z0-9_]{3,252}$' AND p_error_code IS NULL)
		OR (p_state='failed' AND p_session_id IS NULL
			AND p_error_code IN ('erasure_cancelled_before_provider','provider_confirmed_failed')))
	THEN RETURN false; END IF;
	UPDATE public.stripe_checkout_intents i SET state=p_state,stripe_session_id=p_session_id,
		last_error_code=p_error_code,updated_at=statement_timestamp()
	WHERE i.id=p_intent AND i.account_id=p_account
		AND ((i.state='preparing' AND p_state='failed' AND p_error_code='erasure_cancelled_before_provider')
			OR (i.state='provider_started' AND NOT (p_state='failed'
				AND p_error_code='erasure_cancelled_before_provider')))
		AND EXISTS (SELECT 1 FROM public.account_erasure_jobs j
			WHERE j.account_id=p_account AND j.state<>'succeeded')
	RETURNING i.id INTO v_updated;
	RETURN v_updated IS NOT NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.account_erasure_record_stripe_checkout_terminal(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT SELECT,UPDATE ON public.stripe_checkout_intents TO eden3_erasure_guard;
GRANT EXECUTE ON FUNCTION public.account_erasure_record_stripe_checkout_terminal(uuid,uuid,text,text,text)
	TO eden3_erasure_terminal_writer;
ALTER FUNCTION public.account_erasure_record_stripe_checkout_terminal(uuid,uuid,text,text,text)
	OWNER TO eden3_erasure_guard;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_record_outbound_post_terminal(
	p_account uuid,p_intent uuid,p_state text,p_provider_post_id text,p_error_code text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_updated uuid;
BEGIN
	IF NOT pg_has_role(session_user,'eden3_erasure_terminal_writer','member') THEN
		RAISE EXCEPTION 'provider terminal evidence requires the trusted application role' USING ERRCODE='42501';
	END IF;
	IF NOT ((p_state='succeeded' AND p_provider_post_id ~ '^[A-Za-z0-9_:-]{1,255}$' AND p_error_code IS NULL)
		OR (p_state='failed' AND p_provider_post_id IS NULL
			AND p_error_code IN ('erasure_cancelled_before_provider','invalid_credentials','revoked',
				'rate_limited','operator_confirmed_failed')))
	THEN RETURN false; END IF;
	UPDATE public.channel_outbound_post_intents i SET state=p_state,
		provider_post_id=p_provider_post_id,last_error_code=p_error_code,
		updated_at=statement_timestamp()
	WHERE i.id=p_intent AND i.account_id=p_account
		AND ((i.state='preparing' AND p_state='failed' AND p_error_code='erasure_cancelled_before_provider')
			OR (i.state='provider_started' AND NOT (p_state='failed'
				AND p_error_code='erasure_cancelled_before_provider')))
		AND EXISTS (SELECT 1 FROM public.account_erasure_jobs j
			WHERE j.account_id=p_account AND j.state<>'succeeded')
	RETURNING i.id INTO v_updated;
	RETURN v_updated IS NOT NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.account_erasure_record_outbound_post_terminal(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT SELECT,UPDATE ON public.channel_outbound_post_intents TO eden3_erasure_guard;
GRANT EXECUTE ON FUNCTION public.account_erasure_record_outbound_post_terminal(uuid,uuid,text,text,text)
	TO eden3_erasure_terminal_writer;
ALTER FUNCTION public.account_erasure_record_outbound_post_terminal(uuid,uuid,text,text,text)
	OWNER TO eden3_erasure_guard;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_record_provider_terminal_no_output(p_turn uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_updated uuid;
BEGIN
	UPDATE public.usage_events u SET status='error',manna=0,
		error_code='provider_terminal_no_output',error_message=NULL,metadata=NULL
	FROM public.turn_authorizations a
	JOIN public.turn_provider_runs r ON r.turn_id=a.turn_id
	JOIN public.manna_transactions mt ON mt.id=a.reservation_tx_id
	WHERE u.turn_id=p_turn AND a.turn_id=u.turn_id AND a.state='reserved'
		AND u.status='provider_admitted' AND r.usable_output_at IS NULL
		AND u.event_type=CASE WHEN mt.type='spend:memory-dream' THEN 'memory_dream'
			WHEN mt.type='spend:chat:channel' THEN 'channel_chat' ELSE 'chat_turn' END
		AND u.user_id IS NOT DISTINCT FROM a.account_id
		AND u.agent_id IS NOT DISTINCT FROM a.agent_account_id
		AND u.session_id IS NOT DISTINCT FROM a.session_id
		AND u.provider=a.provider AND u.model=a.model AND u.pricing_basis=a.pricing_basis
		AND u.message_id IS NULL AND u.prompt_tokens IS NULL AND u.completion_tokens IS NULL
		AND u.cached_tokens IS NULL AND u.cache_write_tokens IS NULL AND u.total_tokens IS NULL
		AND u.cost_usd IS NULL AND u.manna IS NULL AND u.latency_ms IS NULL
		AND u.error_code IS NULL AND u.error_message IS NULL AND u.metadata IS NULL
		AND public.account_erasure_principal_has_active_job(COALESCE(a.agent_account_id,a.account_id))
	RETURNING u.id INTO v_updated;
	RETURN v_updated IS NOT NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.account_erasure_record_provider_terminal_no_output(uuid) FROM PUBLIC;
GRANT SELECT ON turn_authorizations,turn_provider_runs,manna_transactions,agents
	TO eden3_erasure_guard;
GRANT SELECT,UPDATE ON accounts,account_erasure_jobs TO eden3_erasure_guard;
GRANT SELECT,UPDATE ON usage_events TO eden3_erasure_guard;
GRANT EXECUTE ON FUNCTION public.account_erasure_record_provider_terminal_no_output(uuid)
	TO eden3_erasure_terminal_writer;
ALTER FUNCTION public.account_erasure_record_provider_terminal_no_output(uuid) OWNER TO eden3_erasure_guard;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_record_generation_terminal_no_output(
	p_turn uuid,p_event_type text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_updated uuid; v_output_kind text;
BEGIN
	IF p_event_type NOT IN ('studio_generation','chat_media') THEN RETURN false; END IF;
	SELECT CASE
		WHEN p_event_type='studio_generation' THEN CASE u.metadata->>'tool'
			WHEN 'image_generate' THEN 'image' WHEN 'video_generate' THEN 'video'
			WHEN 'music_generate' THEN 'audio' WHEN 'tts' THEN 'audio' ELSE NULL END
		ELSE CASE u.metadata->>'action'
			WHEN 'image' THEN 'image' WHEN 'video' THEN 'video'
			WHEN 'music' THEN 'audio' WHEN 'tts' THEN 'audio' ELSE u.metadata->>'outputKind' END
	END INTO v_output_kind FROM public.usage_events u
	WHERE u.turn_id=p_turn AND u.event_type=p_event_type AND u.status='provider_admitted'
		AND jsonb_typeof(u.metadata)='object'
		AND jsonb_typeof(u.metadata->'reservation')='object';
	IF v_output_kind NOT IN ('image','video','audio') THEN RETURN false; END IF;
	UPDATE public.usage_events u SET status='refund_pending',error_code='refund_pending',error_message=NULL,
		metadata=u.metadata || jsonb_build_object(
			'failureCode','provider_terminal_no_output',
			'terminalEvidence',jsonb_build_object('version',1,'code','provider_terminal_no_output'),
			'outputQuarantine',jsonb_build_object('version',1,'outputKind',v_output_kind))
	WHERE u.turn_id=p_turn AND u.event_type=p_event_type AND u.status='provider_admitted'
		AND u.manna IS NOT NULL
		AND public.account_erasure_principal_has_active_job(COALESCE(u.agent_id,u.user_id))
	RETURNING u.id INTO v_updated;
	RETURN v_updated IS NOT NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.account_erasure_record_generation_terminal_no_output(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_erasure_record_generation_terminal_no_output(uuid,text)
	TO eden3_erasure_terminal_writer;
ALTER FUNCTION public.account_erasure_record_generation_terminal_no_output(uuid,text) OWNER TO eden3_erasure_guard;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_reversal_authorized(
	p_reservation uuid,p_amount numeric,p_subscription numeric
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
	WITH original AS (
		SELECT t.id,t.amount,t.manna_account_id,e.reserved_subscription_manna,
			COALESCE((SELECT sum(r.amount) FROM public.manna_transactions r
				WHERE r.refunds_transaction_id=t.id),0) refunded
		FROM public.manna_transactions t JOIN LATERAL (
			SELECT a.reserved_subscription_manna FROM public.turn_authorizations a
				WHERE a.reservation_tx_id=t.id AND a.state='reserved'
			UNION ALL
			SELECT COALESCE(nullif(u.metadata#>>'{reservation,subscriptionManna}','')::numeric,0)
				FROM public.usage_events u WHERE nullif(u.metadata#>>'{reservation,transactionId}','')::uuid=t.id
				AND u.status IN ('pending','refund_pending')
			LIMIT 1
		) e ON true
		JOIN public.manna_accounts m ON m.id=t.manna_account_id
		JOIN public.account_erasure_jobs j ON j.id=public.account_erasure_current_seal_job()
		WHERE t.id=p_reservation
			AND public.account_erasure_principal_matches(j.account_id,m.account_id)
	)
	SELECT EXISTS (SELECT 1 FROM original o
		WHERE p_amount=greatest(0,(-o.amount)-o.refunded)
		AND p_subscription=least(greatest(o.reserved_subscription_manna,0),p_amount)
		AND p_amount>0)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_reverse_reservation(
	p_job uuid,p_reservation uuid,p_subscription numeric,p_refund_type text
) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_account uuid; v_tx public.manna_transactions%ROWTYPE; v_owner uuid;
	v_refunded numeric; v_remainder numeric; v_subscription numeric; v_existing public.manna_transactions%ROWTYPE;
BEGIN
	SELECT account_id INTO v_account FROM public.account_erasure_jobs
	WHERE id=p_job AND id=public.account_erasure_current_seal_job();
	IF v_account IS NULL THEN RAISE EXCEPTION 'reversal requires exact sealing job'; END IF;
	SELECT t.* INTO v_tx FROM public.manna_transactions t WHERE t.id=p_reservation FOR UPDATE;
	SELECT account_id INTO v_owner FROM public.manna_accounts WHERE id=v_tx.manna_account_id FOR UPDATE;
	IF NOT FOUND OR NOT public.account_erasure_principal_matches(v_account,v_owner)
		OR v_tx.amount >= 0 OR v_tx.idempotency_key IS NULL
	THEN RAISE EXCEPTION 'reservation provenance mismatch'; END IF;
	SELECT COALESCE(sum(amount),0) INTO v_refunded FROM public.manna_transactions
	WHERE refunds_transaction_id=v_tx.id;
	v_remainder:=greatest(0,(-v_tx.amount)-v_refunded);
	IF v_remainder=0 THEN RETURN; END IF;
	v_subscription:=least(greatest(COALESCE(p_subscription,0),0),v_remainder);
	PERFORM set_config('eden3.erasure_reversal_reservation',v_tx.id::text,true);
	PERFORM set_config('eden3.erasure_reversal_amount',v_remainder::text,true);
	PERFORM set_config('eden3.erasure_reversal_subscription',v_subscription::text,true);
	SELECT * INTO v_existing FROM public.manna_transactions
	WHERE idempotency_key='refund:'||v_tx.idempotency_key FOR UPDATE;
	IF FOUND THEN
		IF v_existing.refunds_transaction_id IS DISTINCT FROM v_tx.id
			OR v_existing.amount IS DISTINCT FROM v_remainder
		THEN RAISE EXCEPTION 'existing refund provenance mismatch'; END IF;
		RETURN;
	END IF;
	UPDATE public.manna_accounts SET balance=balance+v_remainder,
		subscription_balance=subscription_balance+v_subscription,updated_at=statement_timestamp()
	WHERE id=v_tx.manna_account_id;
	INSERT INTO public.manna_transactions(manna_account_id,amount,type,idempotency_key,refunds_transaction_id)
	VALUES(v_tx.manna_account_id,v_remainder,p_refund_type,'refund:'||v_tx.idempotency_key,v_tx.id);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_reverse_generation_reservation(
	p_job uuid,p_usage uuid
) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_usage public.usage_events%ROWTYPE; v_tx public.manna_transactions%ROWTYPE;
	v_account uuid; v_action text; v_key text; v_reserved numeric;
	v_subscription numeric; v_durable numeric;
BEGIN
	SELECT * INTO v_usage FROM public.usage_events WHERE id=p_usage FOR UPDATE;
	SELECT account_id INTO v_account FROM public.account_erasure_jobs
		WHERE id=p_job AND id=public.account_erasure_current_seal_job();
	IF v_account IS NULL OR v_usage.event_type NOT IN ('studio_generation','chat_media')
		OR NOT public.account_erasure_principal_matches(v_account,COALESCE(v_usage.agent_id,v_usage.user_id))
		OR jsonb_typeof(v_usage.metadata)<>'object'
		OR jsonb_typeof(v_usage.metadata->'quote')<>'object'
		OR jsonb_typeof(v_usage.metadata->'reservation')<>'object'
	THEN RAISE EXCEPTION 'generation reservation evidence mismatch'; END IF;
	v_action:=COALESCE(v_usage.metadata->>'action',v_usage.metadata#>>'{quote,action}');
	v_key:=v_usage.metadata#>>'{reservation,idempotencyKey}';
	v_reserved:=COALESCE(nullif(v_usage.metadata#>>'{reservation,reservedManna}','')::numeric,
		nullif(v_usage.metadata#>>'{quote,manna}','')::numeric);
	v_subscription:=nullif(v_usage.metadata#>>'{reservation,subscriptionManna}','')::numeric;
	v_durable:=nullif(v_usage.metadata#>>'{reservation,durableManna}','')::numeric;
	SELECT * INTO v_tx FROM public.manna_transactions
		WHERE id=nullif(v_usage.metadata#>>'{reservation,transactionId}','')::uuid FOR UPDATE;
	IF NOT FOUND OR v_action IS NULL OR v_key IS NULL OR v_reserved IS NULL
		OR v_subscription IS NULL OR v_durable IS NULL
		OR v_subscription<0 OR v_durable<0 OR v_subscription+v_durable<>v_reserved
		OR v_usage.manna IS DISTINCT FROM v_reserved::integer
		OR v_tx.amount IS DISTINCT FROM -v_reserved OR v_tx.type IS DISTINCT FROM 'spend:'||v_action
		OR v_tx.idempotency_key IS DISTINCT FROM v_key
		OR v_usage.provider IS DISTINCT FROM v_usage.metadata#>>'{quote,provider}'
		OR v_usage.model IS DISTINCT FROM v_usage.metadata#>>'{quote,model}'
		OR v_usage.table_version IS DISTINCT FROM v_usage.metadata#>>'{quote,tableVersion}'
		OR (v_usage.event_type='studio_generation' AND v_key IS DISTINCT FROM 'studio:'||v_usage.turn_id::text||':reserve')
		OR (v_usage.event_type='chat_media' AND v_key IS DISTINCT FROM 'chat-media:'||v_usage.turn_id::text)
		OR (v_usage.status='pending' AND v_usage.event_type<>'studio_generation')
		OR (v_usage.status='refund_pending' AND (
			v_usage.metadata#>>'{terminalEvidence,code}' IS DISTINCT FROM 'provider_terminal_no_output'
			OR v_usage.metadata#>>'{outputQuarantine,version}' IS DISTINCT FROM '1'))
		OR v_usage.status NOT IN ('pending','refund_pending')
		OR NOT EXISTS (SELECT 1 FROM public.manna_accounts m WHERE m.id=v_tx.manna_account_id
			AND m.account_id=v_usage.user_id
			AND public.account_erasure_principal_matches(v_account,m.account_id))
	THEN RAISE EXCEPTION 'generation reservation evidence mismatch'; END IF;
	PERFORM public.account_erasure_reverse_reservation(p_job,v_tx.id,v_subscription,'refund:account_erasure');
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.account_erasure_reverse_generation_reservation(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_reconcile_open_work(p_job uuid)
RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_job public.account_erasure_jobs%ROWTYPE; v_auth record; v_usage record;
	v_count integer:=0; v_rows integer:=0;
BEGIN
	SELECT * INTO v_job FROM public.account_erasure_jobs WHERE id=p_job FOR UPDATE;
	IF NOT FOUND OR p_job<>public.account_erasure_current_seal_job()
	THEN RAISE EXCEPTION 'reconciliation requires exact live sealing tuple'; END IF;

	FOR v_auth IN
		WITH principals AS (SELECT v_job.account_id id UNION SELECT account_id FROM public.agents WHERE owner_id=v_job.account_id)
		SELECT a.*,r.provider_started_at,r.usable_output_at
		FROM public.turn_authorizations a LEFT JOIN public.turn_provider_runs r ON r.turn_id=a.turn_id
		WHERE a.state='reserved'
			AND EXISTS (SELECT 1 FROM principals p WHERE p.id IN (a.account_id,a.agent_account_id))
		ORDER BY a.turn_id FOR UPDATE OF a
	LOOP
		IF v_auth.provider_started_at IS NULL OR (v_auth.usable_output_at IS NULL AND EXISTS (
			SELECT 1 FROM public.usage_events u WHERE u.turn_id=v_auth.turn_id AND u.status='error'
				AND u.error_code='provider_terminal_no_output' AND u.error_message IS NULL
				AND COALESCE(u.manna,0)=0 AND u.metadata IS NULL
		)) THEN
			PERFORM public.account_erasure_reverse_reservation(p_job,v_auth.reservation_tx_id,
				v_auth.reserved_subscription_manna,'refund:account_erasure');
			UPDATE public.turn_authorizations SET state='reversed',updated_at=statement_timestamp()
			WHERE turn_id=v_auth.turn_id AND state='reserved'; v_count:=v_count+1;
		ELSIF v_auth.usable_output_at IS NOT NULL THEN
			-- Provider output is billable: the already-debited full reserve settles;
			-- erasure never turns usable output into a refund.
			UPDATE public.turn_authorizations SET state='settled',charged_manna=authorized_max_manna,
				overrun=false,updated_at=statement_timestamp()
			WHERE turn_id=v_auth.turn_id AND state='reserved'; v_count:=v_count+1;
		END IF;
	END LOOP;

	UPDATE public.channel_turns c SET status=CASE a.state WHEN 'settled' THEN 'settled' ELSE 'refunded' END,
		error_code=CASE a.state WHEN 'settled' THEN NULL ELSE 'account_erasure_reconciled' END,
		completed_at=statement_timestamp(),updated_at=statement_timestamp()
	FROM public.turn_authorizations a WHERE a.turn_id=c.turn_id AND a.state IN ('settled','reversed','reaped')
		AND c.status IN ('reserving','reserved','settling','refunding','delivery_pending','error')
		AND public.account_erasure_principal_matches(v_job.account_id,COALESCE(c.account_id,c.agent_id));
	GET DIAGNOSTICS v_rows=ROW_COUNT; v_count:=v_count+v_rows;

	FOR v_usage IN
		WITH principals AS (SELECT v_job.account_id id UNION SELECT account_id FROM public.agents WHERE owner_id=v_job.account_id)
		SELECT u.id,u.status,u.turn_id,u.metadata,
			nullif(u.metadata#>>'{reservation,transactionId}','')::uuid reservation_id,
			COALESCE(nullif(u.metadata#>>'{reservation,subscriptionManna}','')::numeric,0) subscription_manna
		FROM public.usage_events u
		LEFT JOIN public.turn_authorizations a ON a.turn_id=u.turn_id
		WHERE u.status IN ('pending','refund_pending') AND a.turn_id IS NULL
			AND EXISTS (SELECT 1 FROM principals p WHERE p.id IN (u.user_id,u.agent_id))
		ORDER BY u.id FOR UPDATE OF u
	LOOP
		IF v_usage.reservation_id IS NULL THEN CONTINUE; END IF;
		PERFORM public.account_erasure_reverse_generation_reservation(p_job,v_usage.id);
		UPDATE public.usage_events SET status='error',error_code='account_erasure_reconciled',error_message=NULL
		WHERE id=v_usage.id; v_count:=v_count+1;
	END LOOP;

	UPDATE public.usage_events u SET status=CASE a.state WHEN 'settled' THEN 'completed' ELSE 'error' END,
		manna=CASE a.state WHEN 'settled' THEN a.authorized_max_manna::integer ELSE 0 END,
		metadata=CASE a.state WHEN 'settled' THEN jsonb_set(COALESCE(u.metadata,'{}'::jsonb),
			'{partialOutputSettlement}',jsonb_build_object(
				'rule','full-reserve-v1','chargedManna',a.authorized_max_manna::integer),true)
			ELSE NULL END,
		error_code=CASE a.state WHEN 'settled' THEN NULL ELSE 'account_erasure_reconciled' END,
		error_message=NULL
	FROM public.turn_authorizations a WHERE a.turn_id=u.turn_id AND a.state IN ('settled','reversed','reaped')
		AND u.status IN ('pending','provider_admitted','running','refund_pending','error')
		AND public.account_erasure_principal_matches(v_job.account_id,COALESCE(u.user_id,u.agent_id));

	UPDATE public.memory_dream_runs SET status='error',error=NULL,claim_token=NULL,lease_expires_at=NULL,
		completed_at=statement_timestamp()
	WHERE public.account_erasure_principal_matches(v_job.account_id,agent_account_id)
		AND status IN ('running','recovery_pending')
		AND (provider_status='not_started' OR (provider_status='terminal' AND completed_at IS NOT NULL));
	-- Respect the pre-existing pending->running->terminal catalog state machine:
	-- provider-free pending work receives an erasure-owned synthetic claim first.
	UPDATE public.agent_provision_jobs q SET state='running',next_attempt_at=NULL,
		claim_token=gen_random_uuid(),claim_expires_at=statement_timestamp()+interval '1 minute',
		attempt_count=attempt_count+1,last_error_code='account_erasure_reconciled',
		updated_at=statement_timestamp()
	WHERE public.account_erasure_principal_matches(v_job.account_id,q.agent_account_id)
		AND q.state='pending';
	UPDATE public.agent_provision_jobs q SET state='failed',next_attempt_at=NULL,claim_token=NULL,
		claim_expires_at=NULL,last_error_code='account_erasure_reconciled',
		completed_at=statement_timestamp(),updated_at=statement_timestamp()
	WHERE public.account_erasure_principal_matches(v_job.account_id,q.agent_account_id)
		AND q.state='running' AND (q.last_error_code='account_erasure_reconciled'
			OR q.claim_expires_at<=statement_timestamp());
	UPDATE public.triggers t SET pending_occurrence_id=NULL,pending_occurrence_kind=NULL,
		pending_occurrence_at=NULL,pending_occurrence_claim_id=NULL,
		status='inactive',last_error=NULL,deleted=true,updated_at=statement_timestamp()
	WHERE public.account_erasure_principal_matches(v_job.account_id,COALESCE(t.user_id,t.agent_id))
		AND t.pending_occurrence_id IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM public.usage_events u WHERE u.metadata->>'occurrenceId'=t.pending_occurrence_id::text
			AND u.status IN ('pending','provider_admitted','running','refund_pending'));
	RETURN v_count;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.account_erasure_assert_no_open_work(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF EXISTS (
		WITH principals AS (SELECT p_account_id id UNION SELECT account_id FROM public.agents WHERE owner_id=p_account_id)
		SELECT 1 FROM public.turn_authorizations a JOIN principals p ON p.id IN (a.account_id,a.agent_account_id) WHERE a.state='reserved'
		UNION ALL SELECT 1 FROM public.channel_turns c JOIN principals p ON p.id IN (c.account_id,c.agent_id)
			WHERE c.status IN ('reserving','reserved','settling','refunding','delivery_pending','error')
		UNION ALL SELECT 1 FROM public.memory_dream_runs r JOIN principals p ON p.id=r.agent_account_id
			WHERE r.status IN ('running','recovery_pending') OR r.provider_status IN ('started','indeterminate')
		UNION ALL SELECT 1 FROM public.usage_events u JOIN principals p ON p.id IN (u.user_id,u.agent_id)
			WHERE u.status IN ('pending','provider_admitted','running','refund_pending')
		UNION ALL SELECT 1 FROM public.agent_provision_jobs q JOIN principals p ON p.id=q.agent_account_id
			WHERE q.state IN ('pending','running')
		UNION ALL SELECT 1 FROM public.storage_uploads u JOIN principals p ON p.id=u.owner_account_id
			WHERE u.state IN ('initiated','uploading') OR u.cleanup_state IN ('pending','claimed','failed')
		UNION ALL SELECT 1 FROM public.stripe_checkout_intents c JOIN principals p ON p.id=c.account_id
			WHERE c.state IN ('preparing','provider_started')
		UNION ALL SELECT 1 FROM public.channel_outbound_post_intents o JOIN principals p ON p.id=o.account_id
			WHERE o.state IN ('preparing','provider_started')
		UNION ALL SELECT 1 FROM public.triggers t JOIN principals p ON p.id IN (t.user_id,t.agent_id)
			WHERE t.pending_occurrence_id IS NOT NULL
	) THEN RAISE EXCEPTION 'open money, provider, or multipart work blocks erasure completion' USING ERRCODE='55000'; END IF;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.account_erasure_begin_operation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.account_erasure_reverse_reservation(uuid,uuid,numeric,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.account_erasure_reverse_generation_reservation(uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.account_erasure_reconcile_open_work(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_erasure_begin_operation() TO eden3_erasure_operator;
GRANT EXECUTE ON FUNCTION public.account_erasure_reverse_reservation(uuid,uuid,numeric,text) TO eden3_erasure_operator;
GRANT EXECUTE ON FUNCTION public.account_erasure_reverse_generation_reservation(uuid,uuid) TO eden3_erasure_operator;
GRANT EXECUTE ON FUNCTION public.account_erasure_reconcile_open_work(uuid) TO eden3_erasure_operator;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE
	account_erasure_jobs,account_erasure_targets,account_erasure_message_tombstones,
	account_erasure_target_requeues,accounts,agents,sessions,session_users,session_agents,
	session_share_links,messages,creations,media_assets,storage_objects,storage_uploads,
	storage_policy_events,billing_subscriptions,stripe_checkout_intents,manna_accounts,manna_transactions,
	turn_authorizations,turn_provider_runs,usage_events,channel_connections,channel_turns,
	channel_outbound_post_intents,stripe_checkout_intents,
	channel_onboarding_intents,channel_external_identities,channel_pairing_requests,
	concepts,concept_images,collections,skill_definitions,etl_social_edges,distill_state,
	memory_revisions,memory_retrieval_probes,memory_dream_runs,memory_dream_sweeps,
	secret_access_audit_events,claude_session_turn_claims,
	app_notifications,triggers,agent_provision_jobs,content_reports,creation_likes,
	agent_likes,collection_creations,agent_skills
TO eden3_erasure_operator;

-- 0040 installed several still-active guards before the dedicated operator
-- role existed. Pin every inherited boundary to the trusted catalog path as
-- part of this replacement migration; caller search_path/pg_temp objects must
-- never redirect an owner, claim, source, restore, or transition lookup.
ALTER FUNCTION public.account_erasure_principal_matches(uuid,uuid)
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_legacy_media_owned(uuid,uuid)
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_job_claim_matches(uuid)
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_restore_authorized()
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_target_claim_tuple_matches(uuid,text,uuid)
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_resolve_owner(text,uuid)
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_job_guard()
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_target_guard()
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_target_requeue_guard()
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_message_tombstone_guard()
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_storage_source_guard()
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_legacy_source_guard()
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_snapshot_guard()
	SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.account_erasure_statement_lock()
	SET search_path TO pg_catalog, public, pg_temp;
