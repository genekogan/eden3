CREATE TABLE "direct_voice_jobs" (
	"message_id" uuid PRIMARY KEY NOT NULL REFERENCES "messages"("id") ON DELETE cascade,
	"owner_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE restrict,
	"session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE cascade,
	"agent_account_id" uuid REFERENCES "accounts"("id") ON DELETE set null,
	"voice_id" text NOT NULL,
	"text_sha256" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"execution_id" uuid REFERENCES "voice_executions"("id") ON DELETE set null,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "direct_voice_jobs_mode_chk" CHECK ("mode" in ('on_demand','always')),
	CONSTRAINT "direct_voice_jobs_status_chk" CHECK ("status" in ('queued','generating','attachment_pending','completed','failed')),
	CONSTRAINT "direct_voice_jobs_hash_chk" CHECK ("text_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "direct_voice_jobs_generation_chk" CHECK ("generation" between 0 and 100),
	CONSTRAINT "direct_voice_jobs_terminal_chk" CHECK (("status"='completed')=("completed_at" is not null)),
	CONSTRAINT "direct_voice_jobs_execution_chk" CHECK (("status" in ('attachment_pending','completed'))=("execution_id" is not null)),
	CONSTRAINT "direct_voice_jobs_error_chk" CHECK ("last_error_code" is null or "last_error_code" ~ '^[a-z0-9_]{1,100}$')
);
CREATE UNIQUE INDEX "direct_voice_jobs_execution_uq" ON "direct_voice_jobs" ("execution_id") WHERE "execution_id" is not null;
CREATE INDEX "direct_voice_jobs_reconcile_idx" ON "direct_voice_jobs" ("status","updated_at","message_id") WHERE "status" in ('queued','generating','attachment_pending');
--> statement-breakpoint

CREATE TRIGGER a_account_erasure_statement_lock BEFORE INSERT OR UPDATE OR DELETE ON "direct_voice_jobs"
FOR EACH STATEMENT EXECUTE FUNCTION public.account_erasure_statement_lock();
CREATE TRIGGER z_account_erasure_fence BEFORE INSERT OR UPDATE OR DELETE ON "direct_voice_jobs"
FOR EACH ROW EXECUTE FUNCTION public.voice_account_erasure_write_fence();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.account_erasure_assert_no_open_work(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
	IF EXISTS (
		WITH principals AS (SELECT p_account_id id UNION SELECT account_id FROM public.agents WHERE owner_id=p_account_id)
		SELECT 1 FROM public.turn_authorizations a JOIN principals p ON p.id IN (a.account_id,a.agent_account_id) WHERE a.state='reserved'
		UNION ALL SELECT 1 FROM public.channel_turns c JOIN principals p ON p.id IN (c.account_id,c.agent_id) WHERE c.status IN ('reserving','reserved','settling','refunding','delivery_pending','error')
		UNION ALL SELECT 1 FROM public.voice_executions v JOIN principals p ON p.id IN (v.owner_account_id,v.agent_account_id) WHERE v.status IN ('pending','provider_started','transcoding','refund_pending','artifact_cleanup_pending')
		UNION ALL SELECT 1 FROM public.direct_voice_jobs v JOIN principals p ON p.id IN (v.owner_account_id,v.agent_account_id) WHERE v.status IN ('queued','generating','attachment_pending')
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
	ELSIF TG_TABLE_NAME IN ('voice_quotes','direct_voice_jobs') THEN
		v_owner:=COALESCE((v_old->>'owner_account_id')::uuid,(v_new->>'owner_account_id')::uuid);
	END IF;
	IF TG_OP='DELETE' AND (
		public.account_erasure_unclaimed_seal_matches(v_owner) OR
		(TG_TABLE_NAME='direct_voice_jobs' AND public.account_erasure_job_claim_tuple_matches(v_owner))
	) AND (
		TG_TABLE_NAME IN ('agent_voice_assignments','voice_quotes','direct_voice_jobs') OR
		(TG_TABLE_NAME='voice_executions' AND v_old->>'status'<>'completed')
	) THEN RETURN OLD; END IF;
	PERFORM public.account_erasure_assert_account_writable(v_owner);
	IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 0047 predates the physically separate erasure operator and therefore did
-- not extend its least-privilege table allowlist. Account erasure inventories,
-- reconciles, and physically scrubs these rows through that dedicated login;
-- grant only the exact voice tables it touches. Ordinary application roles do
-- not receive eden3_erasure_operator and gain no authority from this grant.
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE
	agent_voice_assignments,voice_clones,voice_clone_clips,voice_quotes,
	voice_executions,direct_voice_jobs
TO eden3_erasure_operator;
