CREATE TABLE "agent_voice_assignments" (
	"agent_account_id" uuid PRIMARY KEY NOT NULL REFERENCES "agents"("account_id") ON DELETE restrict,
	"voice_id" text NOT NULL,
	"chat_mode" text DEFAULT 'on_demand' NOT NULL,
	"discord_mode" text DEFAULT 'off' NOT NULL,
	"telegram_mode" text DEFAULT 'off' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_voice_assignments_voice_id_chk" CHECK ("voice_id" ~ '^(?:[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*:v[1-9][0-9]*|clone:[0-9a-f-]{36})$'),
	CONSTRAINT "agent_voice_assignments_modes_chk" CHECK ("chat_mode" in ('off','on_demand','always') and "discord_mode" in ('off','on_demand','always') and "telegram_mode" in ('off','on_demand','always'))
);
--> statement-breakpoint
CREATE TABLE "voice_clones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE restrict,
	"voice_id" text GENERATED ALWAYS AS ('clone:' || "id"::text) STORED NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"provider_voice_id" text,
	"provider_request_id" text,
	"status" text DEFAULT 'pending_validation' NOT NULL,
	"consent_version" text NOT NULL,
	"consent_attested_at" timestamp with time zone NOT NULL,
	"clip_manifest_sha256" text NOT NULL,
	"request_sha256" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"quarantine_code" text,
	"failure_code" text,
	"consent_revoked_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"provider_deleted_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_clones_voice_id_uq" UNIQUE("voice_id"),
	CONSTRAINT "voice_clones_owner_idempotency_uq" UNIQUE("owner_account_id","idempotency_key"),
	CONSTRAINT "voice_clones_provider_chk" CHECK ("provider"='cartesia'),
	CONSTRAINT "voice_clones_status_chk" CHECK ("status" in ('pending_validation','quarantined','cloning','provider_create_ambiguous','moderation','ready','failed','revoked','provider_delete_pending','provider_delete_failed','deleted')),
	CONSTRAINT "voice_clones_hashes_chk" CHECK ("clip_manifest_sha256" ~ '^[0-9a-f]{64}$' and "request_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "voice_clones_idempotency_chk" CHECK (length("idempotency_key") between 8 and 200),
	CONSTRAINT "voice_clones_codes_chk" CHECK (("quarantine_code" is null or "quarantine_code" ~ '^[a-z0-9_]{1,100}$') and ("failure_code" is null or "failure_code" ~ '^[a-z0-9_]{1,100}$')),
	CONSTRAINT "voice_clones_terminal_shape_chk" CHECK (("status" in ('revoked','provider_delete_pending','provider_delete_failed','deleted'))=("revoked_at" is not null) and ("status"='deleted')=("deleted_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "voice_clones_provider_voice_uq" ON "voice_clones" ("provider","provider_voice_id") WHERE "provider_voice_id" is not null;
CREATE INDEX "voice_clones_owner_status_idx" ON "voice_clones" ("owner_account_id","status","created_at");
--> statement-breakpoint
CREATE TABLE "voice_clone_clips" (
	"clone_id" uuid NOT NULL REFERENCES "voice_clones"("id") ON DELETE cascade,
	"object_id" uuid NOT NULL REFERENCES "storage_objects"("id") ON DELETE restrict,
	"position" integer NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_clone_clips_pk" PRIMARY KEY("clone_id","object_id"),
	CONSTRAINT "voice_clone_clips_position_uq" UNIQUE("clone_id","position"),
	CONSTRAINT "voice_clone_clips_hash_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "voice_clone_clips_mime_chk" CHECK ("mime" in ('audio/wav','audio/mpeg')),
	CONSTRAINT "voice_clone_clips_size_chk" CHECK ("size_bytes" between 1 and 20971520),
	CONSTRAINT "voice_clone_clips_duration_chk" CHECK ("duration_ms" between 100 and 30000)
);
--> statement-breakpoint
CREATE TABLE "voice_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE restrict,
	"operation" text NOT NULL,
	"voice_id" text NOT NULL,
	"text_sha256" text NOT NULL,
	"character_count" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" numeric(20,10) NOT NULL,
	"manna" numeric(20,4) NOT NULL,
	"table_version" text NOT NULL,
	"pricing_effective_date" date NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_quotes_operation_chk" CHECK ("operation" in ('preview','chat','discord','telegram')),
	CONSTRAINT "voice_quotes_hash_chk" CHECK ("text_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "voice_quotes_values_chk" CHECK ("character_count" between 1 and 4000 and "cost_usd">=0 and "manna">=0 and "expires_at">"created_at")
);
CREATE INDEX "voice_quotes_owner_expiry_idx" ON "voice_quotes" ("owner_account_id","expires_at");
--> statement-breakpoint
CREATE TABLE "voice_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE restrict,
	"agent_account_id" uuid REFERENCES "accounts"("id") ON DELETE set null,
	"session_id" uuid REFERENCES "sessions"("id") ON DELETE set null,
	"message_id" uuid REFERENCES "messages"("id") ON DELETE set null,
	"channel_turn_id" uuid REFERENCES "channel_turns"("turn_id") ON DELETE set null,
	"purpose" text NOT NULL,
	"voice_id" text NOT NULL,
	"text_sha256" text NOT NULL,
	"request_sha256" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"character_count" integer NOT NULL,
	"billed_character_count" integer,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"provider_request_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reserved_manna" numeric(20,4) NOT NULL,
	"reserved_subscription_manna" numeric(20,4) NOT NULL,
	"cost_usd" numeric(20,10) NOT NULL,
	"table_version" text NOT NULL,
	"output_url" text,
	"output_local_path" text,
	"output_sha256" text,
	"output_mime" text,
	"output_size_bytes" bigint,
	"output_duration_ms" integer,
	"waveform" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "voice_executions_owner_idempotency_uq" UNIQUE("owner_account_id","purpose","idempotency_key"),
	CONSTRAINT "voice_executions_purpose_chk" CHECK ("purpose" in ('preview','chat','discord','telegram')),
	CONSTRAINT "voice_executions_status_chk" CHECK ("status" in ('pending','provider_started','transcoding','completed','refund_pending','artifact_cleanup_pending','failed')),
	CONSTRAINT "voice_executions_hashes_chk" CHECK ("text_sha256" ~ '^[0-9a-f]{64}$' and "request_sha256" ~ '^[0-9a-f]{64}$' and ("output_sha256" is null or "output_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "voice_executions_values_chk" CHECK ("character_count" between 1 and 4000 and ("billed_character_count" is null or "billed_character_count" between 1 and 8000) and "reserved_manna">=0 and "reserved_subscription_manna" between 0 and "reserved_manna" and "cost_usd">=0 and "attempt_count" between 0 and 1 and length("idempotency_key") between 8 and 200),
	CONSTRAINT "voice_executions_output_shape_chk" CHECK (("status"='completed')=("completed_at" is not null) and ("status"<>'completed' or ("output_url" is not null and "output_sha256" is not null and "output_mime" is not null and "output_size_bytes">0 and "output_duration_ms">0))),
	CONSTRAINT "voice_executions_error_chk" CHECK ("last_error_code" is null or "last_error_code" ~ '^[a-z0-9_]{1,100}$')
);
--> statement-breakpoint
CREATE INDEX "voice_executions_owner_created_idx" ON "voice_executions" ("owner_account_id","created_at");
CREATE UNIQUE INDEX "voice_executions_channel_turn_uq" ON "voice_executions" ("channel_turn_id") WHERE "channel_turn_id" is not null;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.voice_clone_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF TG_OP='INSERT' THEN
		IF NEW.status NOT IN ('pending_validation','cloning') OR NEW.provider_voice_id IS NOT NULL
		THEN RAISE EXCEPTION 'voice clone must begin before provider identity'; END IF;
		RETURN NEW;
	END IF;
	IF TG_OP='DELETE' THEN RETURN OLD; END IF;
	IF NEW.id<>OLD.id OR NEW.owner_account_id<>OLD.owner_account_id OR NEW.voice_id<>OLD.voice_id
		OR NEW.name<>OLD.name OR NEW.provider<>OLD.provider OR NEW.consent_version<>OLD.consent_version
		OR NEW.consent_attested_at<>OLD.consent_attested_at OR NEW.clip_manifest_sha256<>OLD.clip_manifest_sha256
		OR NEW.request_sha256<>OLD.request_sha256 OR NEW.idempotency_key<>OLD.idempotency_key
		OR NEW.created_at<>OLD.created_at OR (OLD.provider_voice_id IS NOT NULL AND NEW.provider_voice_id IS DISTINCT FROM OLD.provider_voice_id)
		OR (OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id)
		OR (OLD.consent_revoked_at IS NOT NULL AND NEW.consent_revoked_at IS DISTINCT FROM OLD.consent_revoked_at)
	THEN RAISE EXCEPTION 'voice clone consent identity is immutable'; END IF;
	IF OLD.status='deleted' OR NOT (
		(OLD.status='pending_validation' AND NEW.status IN ('quarantined','cloning')) OR
		(OLD.status='quarantined' AND NEW.status IN ('cloning','revoked')) OR
		(OLD.status='cloning' AND NEW.status IN ('ready','failed','provider_create_ambiguous','provider_delete_pending','revoked')) OR
		(OLD.status='moderation' AND NEW.status IN ('ready','failed','provider_delete_pending')) OR
		(OLD.status='ready' AND NEW.status='provider_delete_pending') OR
		(OLD.status IN ('failed','provider_create_ambiguous') AND NEW.status IN ('revoked','provider_delete_pending')) OR
		(OLD.status='provider_create_ambiguous' AND NEW.status='provider_create_ambiguous'
			AND OLD.consent_revoked_at IS NULL AND NEW.consent_revoked_at IS NOT NULL) OR
		(OLD.status='revoked' AND NEW.status IN ('provider_delete_pending','deleted')) OR
		(OLD.status='provider_delete_pending' AND NEW.status IN ('provider_delete_failed','deleted')) OR
		(OLD.status='provider_delete_failed' AND NEW.status IN ('provider_delete_pending','deleted'))
	) THEN RAISE EXCEPTION 'invalid voice clone lifecycle transition'; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER voice_clone_guard BEFORE INSERT OR UPDATE OR DELETE ON "voice_clones"
FOR EACH ROW EXECUTE FUNCTION public.voice_clone_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.voice_clone_clip_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF TG_OP='DELETE' THEN RETURN OLD; END IF;
	IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'voice clone clips are immutable'; END IF;
	IF NOT EXISTS (
		SELECT 1 FROM public.voice_clones vc JOIN public.storage_objects o ON o.id=NEW.object_id
		WHERE vc.id=NEW.clone_id AND vc.status='cloning' AND o.owner_account_id=vc.owner_account_id
			AND o.purpose='voice-clip' AND o.state='available' AND o.verified_sha256=NEW.sha256
			AND o.verified_mime=NEW.mime AND o.verified_size_bytes=NEW.size_bytes
	) THEN RAISE EXCEPTION 'voice clone clip must match one exact verified voice-clip object'; END IF;
	RETURN NEW;
END;
$$;
CREATE TRIGGER voice_clone_clip_guard BEFORE INSERT OR UPDATE OR DELETE ON "voice_clone_clips"
FOR EACH ROW EXECUTE FUNCTION public.voice_clone_clip_guard();
--> statement-breakpoint

ALTER TABLE "account_erasure_targets" DROP CONSTRAINT "account_erasure_targets_kind_check";
ALTER TABLE "account_erasure_targets" ADD CONSTRAINT "account_erasure_targets_kind_check" CHECK ("kind" in ('storage_object','legacy_media_asset','legacy_concept_asset','legacy_avatar_asset','voice_output','voice_clone','agent_runtime','channel_runtime','clerk_identity','stripe_customer','backup_tombstone'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.account_erasure_target_owned(p_job_id uuid,p_kind text,p_resource_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_account_id uuid;
BEGIN
	SELECT account_id INTO v_account_id FROM public.account_erasure_jobs WHERE id=p_job_id;
	IF v_account_id IS NULL THEN RETURN false; END IF;
	CASE p_kind
		WHEN 'backup_tombstone' THEN RETURN p_resource_id=p_job_id;
		WHEN 'storage_object' THEN RETURN EXISTS (SELECT 1 FROM public.storage_objects o WHERE o.id=p_resource_id AND public.account_erasure_principal_matches(v_account_id,o.owner_account_id));
		WHEN 'legacy_media_asset' THEN RETURN public.account_erasure_legacy_media_owned(p_job_id,p_resource_id);
		WHEN 'legacy_concept_asset' THEN RETURN EXISTS (SELECT 1 FROM public.concept_images i JOIN public.concepts c ON c.id=i.concept_id JOIN public.agents a ON a.account_id=c.agent_id WHERE i.id=p_resource_id AND a.owner_id=v_account_id);
		WHEN 'legacy_avatar_asset' THEN RETURN EXISTS (SELECT 1 FROM public.agent_avatar_assets av WHERE av.id=p_resource_id AND av.owner_account_id=v_account_id);
		WHEN 'voice_output' THEN RETURN EXISTS (SELECT 1 FROM public.voice_executions ve WHERE ve.id=p_resource_id AND ve.owner_account_id=v_account_id AND ve.status='completed');
		WHEN 'voice_clone' THEN RETURN EXISTS (SELECT 1 FROM public.voice_clones vc WHERE vc.id=p_resource_id AND vc.owner_account_id=v_account_id);
		WHEN 'agent_runtime' THEN RETURN EXISTS (SELECT 1 FROM public.agents WHERE account_id=p_resource_id AND owner_id=v_account_id);
		WHEN 'channel_runtime' THEN RETURN EXISTS (SELECT 1 FROM public.channel_connections WHERE id=p_resource_id AND account_id=v_account_id);
		WHEN 'clerk_identity' THEN RETURN p_resource_id=v_account_id AND EXISTS (SELECT 1 FROM public.accounts WHERE id=v_account_id AND clerk_user_id IS NOT NULL);
		WHEN 'stripe_customer' THEN RETURN p_resource_id=v_account_id AND (EXISTS (SELECT 1 FROM public.billing_subscriptions WHERE account_id=v_account_id) OR EXISTS (SELECT 1 FROM public.stripe_checkout_intents WHERE account_id=v_account_id) OR EXISTS (SELECT 1 FROM public.manna_transactions t JOIN public.manna_accounts m ON m.id=t.manna_account_id WHERE m.account_id=v_account_id AND t.type IN ('credit:stripe','credit:subscription')));
		ELSE RETURN false;
	END CASE;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.account_erasure_assert_no_open_work(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF EXISTS (
		WITH principals AS (SELECT p_account_id id UNION SELECT account_id FROM public.agents WHERE owner_id=p_account_id)
		SELECT 1 FROM public.turn_authorizations a JOIN principals p ON p.id IN (a.account_id,a.agent_account_id) WHERE a.state='reserved'
		UNION ALL SELECT 1 FROM public.channel_turns c JOIN principals p ON p.id IN (c.account_id,c.agent_id) WHERE c.status IN ('reserving','reserved','settling','refunding','delivery_pending','error')
		UNION ALL SELECT 1 FROM public.voice_executions v JOIN principals p ON p.id IN (v.owner_account_id,v.agent_account_id) WHERE v.status IN ('pending','provider_started','transcoding','refund_pending','artifact_cleanup_pending')
		UNION ALL SELECT 1 FROM public.voice_clones v JOIN principals p ON p.id=v.owner_account_id WHERE v.status IN ('pending_validation','cloning','provider_create_ambiguous','provider_delete_pending','provider_delete_failed')
		UNION ALL SELECT 1 FROM public.memory_dream_runs r JOIN principals p ON p.id=r.agent_account_id WHERE r.status IN ('running','recovery_pending') OR r.provider_status IN ('started','indeterminate')
		UNION ALL SELECT 1 FROM public.usage_events u JOIN principals p ON p.id IN (u.user_id,u.agent_id) WHERE u.status IN ('pending','provider_admitted','running','refund_pending')
		UNION ALL SELECT 1 FROM public.agent_provision_jobs q JOIN principals p ON p.id=q.agent_account_id WHERE q.state IN ('pending','running')
		UNION ALL SELECT 1 FROM public.storage_uploads u JOIN principals p ON p.id=u.owner_account_id WHERE u.state IN ('initiated','uploading') OR u.cleanup_state IN ('pending','claimed','failed')
		UNION ALL SELECT 1 FROM public.stripe_checkout_intents c JOIN principals p ON p.id=c.account_id WHERE c.state IN ('preparing','provider_started')
		UNION ALL SELECT 1 FROM public.channel_outbound_post_intents o JOIN principals p ON p.id=o.account_id WHERE o.state IN ('preparing','provider_started')
		UNION ALL SELECT 1 FROM public.triggers t JOIN principals p ON p.id IN (t.user_id,t.agent_id) WHERE t.pending_occurrence_id IS NOT NULL
	) THEN RAISE EXCEPTION 'open money, provider, or multipart work blocks erasure completion' USING ERRCODE='55000'; END IF;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "agent_voice_assignments" FOR EACH STATEMENT EXECUTE FUNCTION public.account_erasure_statement_lock();
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "agent_voice_assignments" FOR EACH ROW EXECUTE FUNCTION public.account_erasure_write_fence('agent:agent_account_id');
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "voice_clones" FOR EACH STATEMENT EXECUTE FUNCTION public.account_erasure_statement_lock();
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "voice_clones" FOR EACH ROW EXECUTE FUNCTION public.account_erasure_write_fence('account:owner_account_id');
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "voice_clone_clips" FOR EACH STATEMENT EXECUTE FUNCTION public.account_erasure_statement_lock();
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "voice_executions" FOR EACH STATEMENT EXECUTE FUNCTION public.account_erasure_statement_lock();
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "voice_executions" FOR EACH ROW EXECUTE FUNCTION public.account_erasure_write_fence('account:owner_account_id');
CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "voice_quotes" FOR EACH STATEMENT EXECUTE FUNCTION public.account_erasure_statement_lock();
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "voice_quotes" FOR EACH ROW EXECUTE FUNCTION public.account_erasure_write_fence('account:owner_account_id');
--> statement-breakpoint

-- Voice tables need narrower erasure exceptions than the generic 0041 fence:
-- only the active seal may discard unclaimed ephemeral state, and only an
-- exact claimed target may remove a durable clone/output or its assignment.
CREATE OR REPLACE FUNCTION public.voice_account_erasure_write_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
	v_old jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
	v_new jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
	v_owner uuid; v_clone uuid;
BEGIN
	IF TG_TABLE_NAME='agent_voice_assignments' THEN
		SELECT owner_id INTO v_owner FROM public.agents
		WHERE account_id=COALESCE((v_old->>'agent_account_id')::uuid,(v_new->>'agent_account_id')::uuid);
		IF TG_OP='DELETE' AND v_old->>'voice_id' ~ '^clone:[0-9a-f-]{36}$' THEN
			v_clone:=substring(v_old->>'voice_id' from 7)::uuid;
			IF public.account_erasure_target_claim_matches(v_owner,'voice_clone',v_clone) THEN RETURN OLD; END IF;
		END IF;
	ELSIF TG_TABLE_NAME='voice_clones' THEN
		v_owner:=COALESCE((v_old->>'owner_account_id')::uuid,(v_new->>'owner_account_id')::uuid);
		IF TG_OP='DELETE' AND public.account_erasure_target_claim_matches(v_owner,'voice_clone',(v_old->>'id')::uuid) THEN RETURN OLD; END IF;
	ELSIF TG_TABLE_NAME='voice_executions' THEN
		v_owner:=COALESCE((v_old->>'owner_account_id')::uuid,(v_new->>'owner_account_id')::uuid);
		IF TG_OP='DELETE' AND v_old->>'status'='completed'
			AND public.account_erasure_target_claim_matches(v_owner,'voice_output',(v_old->>'id')::uuid) THEN RETURN OLD; END IF;
	ELSIF TG_TABLE_NAME='voice_quotes' THEN
		v_owner:=COALESCE((v_old->>'owner_account_id')::uuid,(v_new->>'owner_account_id')::uuid);
	END IF;
	IF TG_OP='DELETE' AND public.account_erasure_unclaimed_seal_matches(v_owner) AND (
		TG_TABLE_NAME IN ('agent_voice_assignments','voice_quotes') OR
		(TG_TABLE_NAME='voice_executions' AND v_old->>'status'<>'completed')
	) THEN RETURN OLD; END IF;
	PERFORM public.account_erasure_assert_account_writable(v_owner);
	IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER z_account_erasure_fence ON "agent_voice_assignments";
DROP TRIGGER z_account_erasure_fence ON "voice_clones";
DROP TRIGGER z_account_erasure_fence ON "voice_executions";
DROP TRIGGER z_account_erasure_fence ON "voice_quotes";
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "agent_voice_assignments" FOR EACH ROW EXECUTE FUNCTION public.voice_account_erasure_write_fence();
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "voice_clones" FOR EACH ROW EXECUTE FUNCTION public.voice_account_erasure_write_fence();
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "voice_executions" FOR EACH ROW EXECUTE FUNCTION public.voice_account_erasure_write_fence();
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "voice_quotes" FOR EACH ROW EXECUTE FUNCTION public.voice_account_erasure_write_fence();
