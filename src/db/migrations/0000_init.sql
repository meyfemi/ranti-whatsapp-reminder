CREATE TYPE "public"."creation_policy" AS ENUM('anyone', 'admins');--> statement-breakpoint
CREATE TYPE "public"."interaction_kind" AS ENUM('clarify', 'undo', 'choose');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."reminder_kind" AS ENUM('birthday', 'anniversary', 'event', 'generic');--> statement-breakpoint
CREATE TABLE "groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"platform" text NOT NULL,
	"platform_group_id" text NOT NULL,
	"name" text,
	"timezone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"creation_policy" "creation_policy" DEFAULT 'anyone' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"next_short_id" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_id" integer NOT NULL,
	"platform_user_id" text NOT NULL,
	"alt_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_known_display_name" text
);
--> statement-breakpoint
CREATE TABLE "occurrences" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "occurrences_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"reminder_id" integer NOT NULL,
	"offset_minutes" integer NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"status" "occurrence_status" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_interactions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pending_interactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"kind" "interaction_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reminders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_id" integer NOT NULL,
	"short_id" integer NOT NULL,
	"title" text NOT NULL,
	"kind" "reminder_kind" NOT NULL,
	"start_local" timestamp NOT NULL,
	"rrule" text,
	"timezone" text NOT NULL,
	"offsets_minutes" integer[] DEFAULT '{0}'::int[] NOT NULL,
	"subject_member_id" integer,
	"message_style" text,
	"created_by_member_id" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD CONSTRAINT "pending_interactions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD CONSTRAINT "pending_interactions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_subject_member_id_members_id_fk" FOREIGN KEY ("subject_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "groups_platform_group_uq" ON "groups" USING btree ("platform","platform_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_group_user_uq" ON "members" USING btree ("group_id","platform_user_id");--> statement-breakpoint
CREATE INDEX "members_alt_ids_idx" ON "members" USING gin ("alt_user_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_reminder_fire_offset_uq" ON "occurrences" USING btree ("reminder_id","fire_at","offset_minutes");--> statement-breakpoint
CREATE INDEX "occurrences_status_fire_at_idx" ON "occurrences" USING btree ("status","fire_at");--> statement-breakpoint
CREATE INDEX "pending_interactions_lookup_idx" ON "pending_interactions" USING btree ("group_id","member_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_group_short_id_uq" ON "reminders" USING btree ("group_id","short_id");--> statement-breakpoint
CREATE INDEX "reminders_group_active_idx" ON "reminders" USING btree ("group_id","active");