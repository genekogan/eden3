CREATE TABLE "transcription_chunks" (
	"session_id" uuid NOT NULL,
	"chunk_number" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"sha256" text NOT NULL,
	"relative_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcription_chunks_session_id_chunk_number_pk" PRIMARY KEY("session_id","chunk_number"),
	CONSTRAINT "transcription_chunks_number_check" CHECK ("transcription_chunks"."chunk_number">=0),
	CONSTRAINT "transcription_chunks_size_check" CHECK ("transcription_chunks"."size_bytes" between 320 and 320000 and "transcription_chunks"."size_bytes"%320=0 and "transcription_chunks"."duration_ms"="transcription_chunks"."size_bytes"/32),
	CONSTRAINT "transcription_chunks_sha_check" CHECK ("transcription_chunks"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "transcription_chunks_path_check" CHECK ("transcription_chunks"."relative_path" ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9]+-[0-9a-f-]{36}[.]pcm$')
);
--> statement-breakpoint
CREATE TABLE "transcription_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"create_idempotency_key" uuid NOT NULL,
	"finalize_idempotency_key" uuid,
	"status" text DEFAULT 'uploading' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"encoding" text DEFAULT 'pcm_s16le' NOT NULL,
	"sample_rate_hz" integer DEFAULT 16000 NOT NULL,
	"channels" integer DEFAULT 1 NOT NULL,
	"acknowledged_through" integer DEFAULT -1 NOT NULL,
	"next_chunk_number" integer DEFAULT 0 NOT NULL,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"received_duration_ms" bigint DEFAULT 0 NOT NULL,
	"max_duration_ms" integer DEFAULT 600000 NOT NULL,
	"final_chunk_number" integer,
	"provider" text,
	"provider_model" text,
	"provider_request_id" text,
	"provider_started_at" timestamp with time zone,
	"provider_completed_at" timestamp with time zone,
	"transcript" text,
	"error_code" text,
	"quoted_cost_usd" numeric(20, 8),
	"quoted_manna" integer,
	"table_version" text,
	"reservation_transaction_id" uuid,
	"usage_event_id" uuid,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"delete_requested_at" timestamp with time zone,
	"audio_deleted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "transcription_sessions_status_check" CHECK ("transcription_sessions"."status" in ('uploading','reserving','queued','processing','completed','failed','deleted','expired')),
	CONSTRAINT "transcription_sessions_format_check" CHECK ("transcription_sessions"."language"='en' and "transcription_sessions"."encoding"='pcm_s16le' and "transcription_sessions"."sample_rate_hz"=16000 and "transcription_sessions"."channels"=1),
	CONSTRAINT "transcription_sessions_duration_check" CHECK ("transcription_sessions"."max_duration_ms" between 1000 and 600000 and "transcription_sessions"."received_duration_ms" between 0 and "transcription_sessions"."max_duration_ms" and "transcription_sessions"."received_bytes"="transcription_sessions"."received_duration_ms"*32),
	CONSTRAINT "transcription_sessions_checkpoint_check" CHECK ("transcription_sessions"."acknowledged_through"="transcription_sessions"."next_chunk_number"-1 and "transcription_sessions"."next_chunk_number">=0 and ("transcription_sessions"."final_chunk_number" is null or "transcription_sessions"."final_chunk_number"="transcription_sessions"."acknowledged_through")),
	CONSTRAINT "transcription_sessions_claim_check" CHECK (("transcription_sessions"."claim_token" is null and "transcription_sessions"."claim_expires_at" is null) or ("transcription_sessions"."status"='processing' and "transcription_sessions"."claim_token" is not null and "transcription_sessions"."claim_expires_at" is not null)),
	CONSTRAINT "transcription_sessions_quote_check" CHECK (("transcription_sessions"."quoted_manna" is null and "transcription_sessions"."quoted_cost_usd" is null and "transcription_sessions"."table_version" is null and "transcription_sessions"."reservation_transaction_id" is null and "transcription_sessions"."usage_event_id" is null) or ("transcription_sessions"."quoted_manna">0 and "transcription_sessions"."quoted_cost_usd">0 and "transcription_sessions"."table_version" is not null and "transcription_sessions"."reservation_transaction_id" is not null and "transcription_sessions"."usage_event_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "transcription_chunks" ADD CONSTRAINT "transcription_chunks_session_id_transcription_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."transcription_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_sessions" ADD CONSTRAINT "transcription_sessions_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_sessions" ADD CONSTRAINT "transcription_sessions_reservation_transaction_id_manna_transactions_id_fk" FOREIGN KEY ("reservation_transaction_id") REFERENCES "public"."manna_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_sessions" ADD CONSTRAINT "transcription_sessions_usage_event_id_usage_events_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transcription_chunks_path_uq" ON "transcription_chunks" USING btree ("relative_path");--> statement-breakpoint
CREATE UNIQUE INDEX "transcription_sessions_owner_create_key_uq" ON "transcription_sessions" USING btree ("owner_account_id","create_idempotency_key");--> statement-breakpoint
CREATE INDEX "transcription_sessions_owner_created_idx" ON "transcription_sessions" USING btree ("owner_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transcription_sessions_worker_idx" ON "transcription_sessions" USING btree ("status","claim_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "transcription_sessions_expiry_idx" ON "transcription_sessions" USING btree ("expires_at");
--> statement-breakpoint
-- Extend the existing erasure reservation verifier with exact STT provenance.
-- The generic open-work reconciler already dispatches pending/refund_pending
-- usage without a turn_authorization through this function, so accepting the
-- new event here prevents queued dictation from blocking account erasure while
-- continuing to reject provider-admitted work without terminal evidence.
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
	IF v_account IS NULL OR v_usage.event_type NOT IN ('studio_generation','chat_media','speech_transcription')
		OR NOT public.account_erasure_principal_matches(v_account,COALESCE(v_usage.agent_id,v_usage.user_id))
		OR jsonb_typeof(v_usage.metadata)<>'object'
		OR jsonb_typeof(v_usage.metadata->'quote')<>'object'
		OR jsonb_typeof(v_usage.metadata->'reservation')<>'object'
	THEN RAISE EXCEPTION 'generation reservation evidence mismatch'; END IF;
	v_action:=COALESCE(v_usage.metadata->>'action',v_usage.metadata#>>'{quote,action}',
		CASE WHEN v_usage.event_type='speech_transcription' THEN 'transcription' END);
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
		OR (v_usage.event_type='speech_transcription' AND (
			v_key IS DISTINCT FROM 'transcription:'||v_usage.turn_id::text
			OR v_usage.metadata->>'version' IS DISTINCT FROM '1'
			OR v_usage.metadata->>'transcriptionId' IS DISTINCT FROM v_usage.turn_id::text
			OR NOT EXISTS (
				SELECT 1 FROM public.transcription_sessions s
				WHERE s.id=v_usage.turn_id AND s.owner_account_id=v_usage.user_id
					AND s.usage_event_id=v_usage.id AND s.transcript IS NULL
					AND ((v_usage.status='pending' AND s.status IN ('reserving','queued','processing')
						AND s.provider_started_at IS NULL)
						OR (v_usage.status='refund_pending' AND s.status IN ('failed','deleted','expired')))
			)))
		OR (v_usage.status='pending' AND v_usage.event_type NOT IN ('studio_generation','speech_transcription'))
		OR (v_usage.status='refund_pending' AND v_usage.event_type<>'speech_transcription' AND (
			v_usage.metadata#>>'{terminalEvidence,code}' IS DISTINCT FROM 'provider_terminal_no_output'
			OR v_usage.metadata#>>'{outputQuarantine,version}' IS DISTINCT FROM '1'))
		OR v_usage.status NOT IN ('pending','refund_pending')
		OR NOT EXISTS (SELECT 1 FROM public.manna_accounts m WHERE m.id=v_tx.manna_account_id
			AND m.account_id=v_usage.user_id
			AND public.account_erasure_principal_matches(v_account,m.account_id))
	THEN RAISE EXCEPTION 'generation reservation evidence mismatch'; END IF;
	PERFORM public.account_erasure_reverse_reservation(p_job,v_tx.id,v_subscription,'refund:account_erasure');
	IF v_usage.event_type='speech_transcription' THEN
		UPDATE public.usage_events SET manna=0,cost_usd=NULL
		WHERE id=v_usage.id AND status IN ('pending','refund_pending');
	END IF;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.account_erasure_reverse_generation_reservation(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
-- The dedicated erasure operator may remove private checkpoint metadata only
-- after its pre-seal reconciler has physically deleted every relative audio
-- locator. Ordinary API credentials never inherit this role.
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE
	public.transcription_sessions,public.transcription_chunks
TO eden3_erasure_operator;
