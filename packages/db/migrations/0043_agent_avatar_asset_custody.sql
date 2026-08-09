CREATE TABLE "agent_avatar_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"agent_account_id" uuid NOT NULL,
	"url" text NOT NULL,
	"local_path" text,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint,
	"state" text DEFAULT 'current' NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_avatar_assets_sha_check" CHECK ("agent_avatar_assets"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_avatar_assets_url_check" CHECK ("agent_avatar_assets"."url" ~ '^/media/[0-9a-f]{64}[.][a-z0-9]{1,10}$'),
	CONSTRAINT "agent_avatar_assets_path_check" CHECK ("agent_avatar_assets"."local_path" is null or length("agent_avatar_assets"."local_path") between 1 and 4096),
	CONSTRAINT "agent_avatar_assets_mime_check" CHECK ("agent_avatar_assets"."mime" in ('image/png','image/jpeg','image/webp')),
	CONSTRAINT "agent_avatar_assets_size_check" CHECK ("agent_avatar_assets"."size_bytes" is null or "agent_avatar_assets"."size_bytes" between 1 and 8388608),
	CONSTRAINT "agent_avatar_assets_state_check" CHECK ("agent_avatar_assets"."state" in ('current','retired')),
	CONSTRAINT "agent_avatar_assets_retired_shape_check" CHECK (("agent_avatar_assets"."state"='current' and "agent_avatar_assets"."retired_at" is null) or ("agent_avatar_assets"."state"='retired' and "agent_avatar_assets"."retired_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "account_erasure_targets" DROP CONSTRAINT "account_erasure_targets_kind_check";--> statement-breakpoint
ALTER TABLE "agent_avatar_assets" ADD CONSTRAINT "agent_avatar_assets_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_avatar_assets" ADD CONSTRAINT "agent_avatar_assets_agent_account_id_accounts_id_fk" FOREIGN KEY ("agent_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_avatar_assets_one_current_uq" ON "agent_avatar_assets" USING btree ("agent_account_id") WHERE "agent_avatar_assets"."state" = 'current';--> statement-breakpoint
CREATE INDEX "agent_avatar_assets_owner_state_idx" ON "agent_avatar_assets" USING btree ("owner_account_id","state","created_at");--> statement-breakpoint
CREATE INDEX "agent_avatar_assets_content_idx" ON "agent_avatar_assets" USING btree ("sha256","url");--> statement-breakpoint
ALTER TABLE "account_erasure_targets" ADD CONSTRAINT "account_erasure_targets_kind_check" CHECK ("account_erasure_targets"."kind" in ('storage_object', 'legacy_media_asset', 'legacy_concept_asset', 'legacy_avatar_asset', 'agent_runtime', 'channel_runtime', 'clerk_identity', 'stripe_customer', 'backup_tombstone'));
--> statement-breakpoint

INSERT INTO public.agent_avatar_assets
  (owner_account_id,agent_account_id,url,local_path,sha256,mime,size_bytes,state)
SELECT coalesce(ag.owner_id,ag.account_id),ag.account_id,a.user_image,null,
  substring(a.user_image from '^/media/([0-9a-f]{64})[.]'),
  CASE lower(substring(a.user_image from '[.]([a-z0-9]{1,10})$'))
    WHEN 'png' THEN 'image/png'
    WHEN 'webp' THEN 'image/webp'
    ELSE 'image/jpeg'
  END,
  null,'current'
FROM public.agents ag JOIN public.accounts a ON a.id=ag.account_id
WHERE a.user_image ~ '^/media/[0-9a-f]{64}[.](png|jpe?g|webp)$';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_avatar_asset_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM public.agents ag
		WHERE ag.account_id=NEW.agent_account_id
			AND coalesce(ag.owner_id,ag.account_id)=NEW.owner_account_id
	) THEN RAISE EXCEPTION 'avatar asset must match its durable agent owner'; END IF;
	IF TG_OP='INSERT' THEN
		IF NEW.state<>'current' OR NEW.retired_at IS NOT NULL THEN
			RAISE EXCEPTION 'avatar asset must begin current';
		END IF;
		PERFORM public.account_erasure_assert_account_writable(NEW.owner_account_id);
		RETURN NEW;
	END IF;
	IF NEW.id<>OLD.id OR NEW.owner_account_id<>OLD.owner_account_id
		OR NEW.agent_account_id<>OLD.agent_account_id OR NEW.url<>OLD.url
		OR NEW.local_path IS DISTINCT FROM OLD.local_path OR NEW.sha256<>OLD.sha256
		OR NEW.mime<>OLD.mime OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
		OR NEW.created_at<>OLD.created_at
	THEN RAISE EXCEPTION 'avatar asset identity is immutable'; END IF;
	IF NOT (OLD.state='current' AND NEW.state='retired'
		AND OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL)
	THEN RAISE EXCEPTION 'invalid avatar asset transition'; END IF;
	PERFORM public.account_erasure_assert_account_writable(NEW.owner_account_id);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.account_erasure_avatar_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM public.account_erasure_targets t
		JOIN public.account_erasure_jobs j ON j.id=t.job_id
		WHERE t.kind='legacy_avatar_asset' AND t.resource_id=OLD.id
			AND t.state<>'succeeded' AND j.state<>'succeeded'
	) THEN
		RETURN OLD;
	END IF;
	IF NOT public.account_erasure_target_claim_matches(
		OLD.owner_account_id,'legacy_avatar_asset',OLD.id)
	THEN RAISE EXCEPTION 'avatar asset deletion requires exact live erasure target claim'; END IF;
	IF nullif(current_setting('eden3.erasure_external_absence_id',true),'')
		IS DISTINCT FROM OLD.id::text
	THEN RAISE EXCEPTION 'positive storage absence must precede avatar source disposal'; END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER a_account_erasure_statement_lock
BEFORE INSERT OR UPDATE OR DELETE ON public.agent_avatar_assets
FOR EACH STATEMENT EXECUTE FUNCTION public.account_erasure_statement_lock();
--> statement-breakpoint
CREATE TRIGGER account_erasure_avatar_asset_guard
BEFORE INSERT OR UPDATE ON public.agent_avatar_assets
FOR EACH ROW EXECUTE FUNCTION public.account_erasure_avatar_asset_guard();
--> statement-breakpoint
CREATE TRIGGER account_erasure_avatar_source_guard
BEFORE DELETE ON public.agent_avatar_assets
FOR EACH ROW EXECUTE FUNCTION public.account_erasure_avatar_source_guard();
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
		WHEN 'legacy_avatar_asset' THEN RETURN EXISTS (
			SELECT 1 FROM public.agent_avatar_assets av
			WHERE av.id=p_resource_id AND av.owner_account_id=v_account_id);
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
		LEFT JOIN public.agent_avatar_assets av ON t.kind='legacy_avatar_asset' AND av.id=t.resource_id
		WHERE t.state <> 'succeeded' AND j.state <> 'succeeded'
		AND (v_sha IS NOT NULL AND v_sha IN (m.sha256,i.sha256,av.sha256)
			OR v_old_sha IS NOT NULL AND v_old_sha IN (m.sha256,i.sha256,av.sha256)
			OR v_url IS NOT NULL AND v_url IN (m.url,i.url,av.url)
			OR v_old_url IS NOT NULL AND v_old_url IN (m.url,i.url,av.url)
			OR v_alt_url IS NOT NULL AND v_alt_url IN (m.url,i.url,av.url)
			OR v_old_alt_url IS NOT NULL AND v_old_alt_url IN (m.url,i.url,av.url)
			OR v_url IS NOT NULL AND m.local_path IS NOT NULL
				AND v_url='/media/'||regexp_replace(m.local_path,'^.*/','')
			OR v_alt_url IS NOT NULL AND m.local_path IS NOT NULL
				AND v_alt_url='/media/'||regexp_replace(m.local_path,'^.*/','')
			OR v_path IS NOT NULL AND v_path IN (m.local_path,m.source_path,i.local_path,av.local_path)
			OR v_alt_path IS NOT NULL AND v_alt_path IN (m.local_path,m.source_path,i.local_path,av.local_path)
			OR v_old_path IS NOT NULL AND v_old_path IN (m.local_path,m.source_path,i.local_path,av.local_path)
			OR v_old_alt_path IS NOT NULL AND v_old_alt_path IN (m.local_path,m.source_path,i.local_path,av.local_path))
	) THEN RAISE EXCEPTION 'legacy content is fenced by active erasure'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER zz_account_erasure_avatar_ingest_fence
BEFORE INSERT OR UPDATE ON public.agent_avatar_assets
FOR EACH ROW EXECUTE FUNCTION public.account_erasure_legacy_content_ingest_fence();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_avatar_target_success_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF OLD.state='claimed' AND NEW.state='succeeded' AND NEW.kind='legacy_avatar_asset'
		AND (nullif(current_setting('eden3.erasure_external_absence_id',true),'')
			IS DISTINCT FROM NEW.resource_id::text
			OR EXISTS (SELECT 1 FROM public.agent_avatar_assets WHERE id=NEW.resource_id))
	THEN RAISE EXCEPTION 'positive avatar asset absence must precede source disposal'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_erasure_avatar_target_success_guard
BEFORE UPDATE ON public.account_erasure_targets FOR EACH ROW
EXECUTE FUNCTION public.account_erasure_avatar_target_success_guard();
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.account_erasure_avatar_asset_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.account_erasure_avatar_source_guard() FROM PUBLIC;
GRANT SELECT ON public.agent_avatar_assets TO eden3_erasure_guard;
ALTER FUNCTION public.account_erasure_avatar_asset_guard() OWNER TO eden3_erasure_guard;
ALTER FUNCTION public.account_erasure_avatar_source_guard() OWNER TO eden3_erasure_guard;
ALTER FUNCTION public.account_erasure_legacy_content_ingest_fence() OWNER TO eden3_erasure_guard;
