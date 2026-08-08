-- T08-U02 (2026-08-08): turn economic-authorization state machine (MVP gap 42).
-- Additive DDL only: one new empty table + FKs + index. No existing table is
-- altered and no data is touched (D-003). FK validation scans only the new
-- (empty) table, so shared-DB application is a journaled quiet-moment migrate.
CREATE TABLE "turn_authorizations" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_account_id" uuid,
	"session_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"pricing_basis" text NOT NULL,
	"ceiling_table_version" text NOT NULL,
	"authorized_max_manna" numeric(20, 4) NOT NULL,
	"reserved_subscription_manna" numeric(20, 4) NOT NULL,
	"reservation_tx_id" uuid NOT NULL,
	"state" text NOT NULL,
	"charged_manna" numeric(20, 4),
	"overrun" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turn_authorizations" ADD CONSTRAINT "turn_authorizations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_authorizations" ADD CONSTRAINT "turn_authorizations_agent_account_id_accounts_id_fk" FOREIGN KEY ("agent_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_authorizations" ADD CONSTRAINT "turn_authorizations_reservation_tx_id_manna_transactions_id_fk" FOREIGN KEY ("reservation_tx_id") REFERENCES "public"."manna_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_authorizations_state_created_idx" ON "turn_authorizations" USING btree ("state","created_at");