CREATE TABLE "agent_likes" (
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_likes_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "creation_likes" (
	"user_id" uuid NOT NULL,
	"creation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creation_likes_user_id_creation_id_pk" PRIMARY KEY("user_id","creation_id")
);
--> statement-breakpoint
ALTER TABLE "agent_likes" ADD CONSTRAINT "agent_likes_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_likes" ADD CONSTRAINT "agent_likes_agent_id_accounts_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creation_likes" ADD CONSTRAINT "creation_likes_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creation_likes" ADD CONSTRAINT "creation_likes_creation_id_creations_id_fk" FOREIGN KEY ("creation_id") REFERENCES "public"."creations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_likes_agent_idx" ON "agent_likes" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "creation_likes_creation_idx" ON "creation_likes" USING btree ("creation_id");