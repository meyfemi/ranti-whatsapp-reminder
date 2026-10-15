CREATE TABLE "digest_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "digest_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_id" integer NOT NULL,
	"week_key" text NOT NULL,
	"slot_local" timestamp NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"status" "occurrence_status" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "digest_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "digest_weekday" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "digest_time" text DEFAULT '08:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "digest_post_empty" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "digest_runs" ADD CONSTRAINT "digest_runs_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "digest_runs_group_week_uq" ON "digest_runs" USING btree ("group_id","week_key");--> statement-breakpoint
CREATE INDEX "digest_runs_status_fire_at_idx" ON "digest_runs" USING btree ("status","fire_at");