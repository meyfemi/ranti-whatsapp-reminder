CREATE TYPE "public"."creation_policy" AS ENUM('anyone', 'admins');--> statement-breakpoint
CREATE TABLE "groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"platform" text NOT NULL,
	"platform_group_id" text NOT NULL,
	"name" text,
	"timezone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"creation_policy" "creation_policy" DEFAULT 'anyone' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_id" integer NOT NULL,
	"platform_user_id" text NOT NULL,
	"last_known_display_name" text
);
--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "groups_platform_group_uq" ON "groups" USING btree ("platform","platform_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_group_user_uq" ON "members" USING btree ("group_id","platform_user_id");