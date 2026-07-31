CREATE TABLE "etl_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_database" text NOT NULL,
	"mode" text NOT NULL,
	"document_limit" integer,
	"selected_collections" jsonb NOT NULL,
	"source_cutoffs" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "etl_runs_mode_check" CHECK ("etl_runs"."mode" in ('full', 'delta')),
	CONSTRAINT "etl_runs_status_check" CHECK ("etl_runs"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "etl_runs_limit_check" CHECK ("etl_runs"."document_limit" is null or "etl_runs"."document_limit" > 0),
	CONSTRAINT "etl_runs_terminal_shape_check" CHECK (("etl_runs"."status" = 'running' and "etl_runs"."finished_at" is null) or ("etl_runs"."status" in ('completed', 'failed') and "etl_runs"."finished_at" is not null))
);
--> statement-breakpoint
CREATE INDEX "etl_runs_latest_idx" ON "etl_runs" USING btree ("started_at");