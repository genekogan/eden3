CREATE TABLE IF NOT EXISTS "distill_state" (
	"openclaw_id" text PRIMARY KEY NOT NULL,
	"agent_account_id" uuid,
	"username" "citext" NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sessions_sampled" integer DEFAULT 0 NOT NULL,
	"messages_sampled" integer DEFAULT 0 NOT NULL,
	"map_chunks" integer,
	"memory_chars" integer,
	"model" text,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "distill_state" ADD COLUMN IF NOT EXISTS "agent_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "distill_state" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "distill_state" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "distill_state" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
UPDATE "distill_state" SET "username" = "openclaw_id" WHERE "username" IS NULL;
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "username" TYPE "citext" USING "username"::"citext";
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "username" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "status" SET DEFAULT 'pending';
--> statement-breakpoint
UPDATE "distill_state" SET "status" = 'pending' WHERE "status" IS NULL;
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "status" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "sessions_sampled" SET DEFAULT 0;
--> statement-breakpoint
UPDATE "distill_state" SET "sessions_sampled" = 0 WHERE "sessions_sampled" IS NULL;
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "sessions_sampled" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "messages_sampled" SET DEFAULT 0;
--> statement-breakpoint
UPDATE "distill_state" SET "messages_sampled" = 0 WHERE "messages_sampled" IS NULL;
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "messages_sampled" SET NOT NULL;
--> statement-breakpoint
UPDATE "distill_state" SET "updated_at" = now() WHERE "updated_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "updated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "updated_at" SET NOT NULL;
--> statement-breakpoint
UPDATE "distill_state" SET "created_at" = "updated_at" WHERE "created_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "created_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "distill_state" ALTER COLUMN "created_at" SET NOT NULL;
--> statement-breakpoint
UPDATE "distill_state"
SET "completed_at" = "updated_at"
WHERE "completed_at" IS NULL AND "status" = 'done';
--> statement-breakpoint
UPDATE "distill_state" d
SET "agent_account_id" = g."account_id"
FROM "agents" g
WHERE d."agent_account_id" IS NULL
  AND g."openclaw_id" = d."openclaw_id";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "distill_state" ADD CONSTRAINT "distill_state_agent_account_id_accounts_id_fk" FOREIGN KEY ("agent_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "distill_state_agent_idx" ON "distill_state" USING btree ("agent_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "distill_state_status_idx" ON "distill_state" USING btree ("status","updated_at" DESC NULLS LAST);
