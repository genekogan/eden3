CREATE TABLE "concept_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concept_id" uuid NOT NULL,
	"url" text NOT NULL,
	"local_path" text,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"size_bytes" bigint,
	"filename" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"instructions" text,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "concept_images" ADD CONSTRAINT "concept_images_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_agent_id_accounts_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concept_images_concept_position_idx" ON "concept_images" USING btree ("concept_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_agent_slug_uq" ON "concepts" USING btree ("agent_id","slug") WHERE "concepts"."deleted" = false;--> statement-breakpoint
CREATE INDEX "concepts_agent_created_idx" ON "concepts" USING btree ("agent_id","created_at" DESC NULLS LAST);