-- Human account profile photos use the same immutable, erasure-inventoried
-- custody table as agent avatars. The self-owned shape is intentionally only
-- valid for a live user account; ordinary agent rows retain the original
-- owner/agent relationship check.
CREATE OR REPLACE FUNCTION public.account_erasure_avatar_asset_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM public.agents ag
		WHERE ag.account_id=NEW.agent_account_id
			AND coalesce(ag.owner_id,ag.account_id)=NEW.owner_account_id
	) AND NOT EXISTS (
		SELECT 1 FROM public.accounts a
		WHERE a.id=NEW.agent_account_id
			AND NEW.owner_account_id=NEW.agent_account_id
			AND a.type='user' AND a.deleted=false
	) THEN RAISE EXCEPTION 'avatar asset must match its durable account owner'; END IF;
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
REVOKE EXECUTE ON FUNCTION public.account_erasure_avatar_asset_guard() FROM PUBLIC;
ALTER FUNCTION public.account_erasure_avatar_asset_guard() OWNER TO eden3_erasure_guard;
