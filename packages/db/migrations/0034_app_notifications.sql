CREATE TABLE "agent_provision_jobs" (
	"agent_account_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_provision_jobs_state_check" CHECK ("agent_provision_jobs"."state" in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "agent_provision_jobs_attempt_check" CHECK ("agent_provision_jobs"."attempt_count" >= 0),
	CONSTRAINT "agent_provision_jobs_claim_shape_check" CHECK (("agent_provision_jobs"."state" = 'running' and "agent_provision_jobs"."claim_token" is not null and "agent_provision_jobs"."claim_expires_at" is not null) or ("agent_provision_jobs"."state" <> 'running' and "agent_provision_jobs"."claim_token" is null and "agent_provision_jobs"."claim_expires_at" is null)),
	CONSTRAINT "agent_provision_jobs_schedule_shape_check" CHECK (("agent_provision_jobs"."state" = 'pending' and "agent_provision_jobs"."next_attempt_at" is not null) or ("agent_provision_jobs"."state" <> 'pending' and "agent_provision_jobs"."next_attempt_at" is null)),
	CONSTRAINT "agent_provision_jobs_completion_shape_check" CHECK (("agent_provision_jobs"."state" in ('succeeded', 'failed') and "agent_provision_jobs"."completed_at" is not null) or ("agent_provision_jobs"."state" not in ('succeeded', 'failed') and "agent_provision_jobs"."completed_at" is null)),
	CONSTRAINT "agent_provision_jobs_error_code_check" CHECK ("agent_provision_jobs"."last_error_code" is null or "agent_provision_jobs"."last_error_code" ~ '^[a-z0-9_:-]{1,100}$')
);
--> statement-breakpoint
CREATE TABLE "app_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"target_path" text,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_notifications_kind_check" CHECK ("app_notifications"."kind" in ('agent_build_ready', 'agent_build_failed')),
	CONSTRAINT "app_notifications_build_source_check" CHECK ("app_notifications"."source_agent_id" is not null),
	CONSTRAINT "app_notifications_target_path_check" CHECK ("app_notifications"."target_path" is null or "app_notifications"."target_path" ~ '^/agents/[a-z0-9][a-z0-9_-]{2,31}$'),
	CONSTRAINT "app_notifications_read_at_check" CHECK ("app_notifications"."read_at" is null or "app_notifications"."read_at" >= "app_notifications"."created_at"),
	CONSTRAINT "app_notifications_dismissed_at_check" CHECK ("app_notifications"."dismissed_at" is null or ("app_notifications"."read_at" is not null and "app_notifications"."dismissed_at" >= "app_notifications"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "agent_provision_jobs" ADD CONSTRAINT "agent_provision_jobs_agent_account_id_agents_account_id_fk" FOREIGN KEY ("agent_account_id") REFERENCES "public"."agents"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_source_agent_id_agents_account_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_provision_jobs_due_idx" ON "agent_provision_jobs" USING btree ("next_attempt_at") WHERE "agent_provision_jobs"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "agent_provision_jobs_claim_expiry_idx" ON "agent_provision_jobs" USING btree ("claim_expires_at") WHERE "agent_provision_jobs"."state" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "app_notifications_build_once_uq" ON "app_notifications" USING btree ("account_id","kind","source_agent_id");--> statement-breakpoint
CREATE INDEX "app_notifications_account_created_idx" ON "app_notifications" USING btree ("account_id","created_at" DESC NULLS LAST) WHERE "app_notifications"."dismissed_at" is null;--> statement-breakpoint
CREATE INDEX "app_notifications_account_unread_idx" ON "app_notifications" USING btree ("account_id","created_at" DESC NULLS LAST) WHERE "app_notifications"."read_at" is null and "app_notifications"."dismissed_at" is null;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_notifications_guard() RETURNS trigger AS $$
DECLARE
  actual_owner uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT owner_id INTO actual_owner FROM agents WHERE account_id = NEW.source_agent_id FOR KEY SHARE;
    IF actual_owner IS NULL OR actual_owner <> NEW.account_id THEN
      RAISE EXCEPTION 'notification source agent must belong to recipient';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id OR NEW.kind <> OLD.kind
     OR NEW.source_agent_id <> OLD.source_agent_id
     OR NEW.target_path IS DISTINCT FROM OLD.target_path OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'notification identity is immutable';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'notification read state is irreversible';
  END IF;
  IF OLD.dismissed_at IS NOT NULL AND NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at THEN
    RAISE EXCEPTION 'notification dismissal is irreversible';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER app_notifications_guard_trigger
BEFORE INSERT OR UPDATE ON app_notifications
FOR EACH ROW EXECUTE FUNCTION app_notifications_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_provision_jobs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.attempt_count <> 0 THEN
      RAISE EXCEPTION 'provision job must start pending and unattempted';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.agent_account_id <> OLD.agent_account_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'provision job identity is immutable';
  END IF;
  IF OLD.state IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'terminal provision job is immutable';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'provision attempt count is monotonic';
  END IF;
  IF OLD.state = 'pending' AND NEW.state <> 'running' THEN
    RAISE EXCEPTION 'invalid provision job transition';
  END IF;
  IF OLD.state = 'running' AND NEW.state NOT IN ('pending', 'running', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'invalid provision job transition';
  END IF;
  IF OLD.state = 'running' AND NEW.state = 'running' THEN
    IF NEW.claim_token IS DISTINCT FROM OLD.claim_token
       AND (OLD.claim_expires_at IS NULL OR OLD.claim_expires_at > now()) THEN
      RAISE EXCEPTION 'active provision claim cannot be replaced';
    END IF;
    IF NEW.claim_token = OLD.claim_token AND NEW.claim_expires_at < OLD.claim_expires_at THEN
      RAISE EXCEPTION 'provision claim lease cannot shrink';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER agent_provision_jobs_guard_trigger
BEFORE INSERT OR UPDATE ON agent_provision_jobs
FOR EACH ROW EXECUTE FUNCTION agent_provision_jobs_guard();
